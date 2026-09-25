// Space, Translated — a ceiling sign cycling through NASA's Astronomy
// Picture of the Day, a live Earth image, a Cosmic Meteorology key to the
// artwork, and a generative canvas reading of the same live data ("Algorithm Art").
//
// /api/nasa-data (a serverless proxy holding the real NASA key) supplies
// APOD, space weather, and near-Earth objects. EPIC and NOAA solar wind
// need no key, so this file fetches those two directly. This file never
// sees or requests a NASA key itself.

(function () {
  'use strict';

  const REFRESH_MS = 60 * 60 * 1000; // APOD/EPIC/space-weather roll over slowly
  const WIND_REFRESH_MS = 60 * 1000; // NOAA solar wind updates about once a minute
  const KM_S_TO_MPH = 2236.94;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const canvas = document.getElementById('art');
  const ctx = canvas.getContext('2d');
  const cmeBg = document.getElementById('cme-bg');
  const cmeBgCtx = cmeBg.getContext('2d');
  const statusEl = document.getElementById('status');
  const statusText = document.getElementById('status-text');

  let width = 0;
  let height = 0;
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  let ui = 1; // size scale so the art stays readable from across a room on big screens

  // ---------- small math helpers ----------

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function mapRange(v, inMin, inMax, outMin, outMax) {
    if (inMax === inMin) return outMin;
    const t = clamp((v - inMin) / (inMax - inMin), 0, 1);
    return outMin + t * (outMax - outMin);
  }

  function logMapRange(v, inMin, inMax, outMin, outMax) {
    const lv = Math.log10(Math.max(v, 1));
    const lMin = Math.log10(Math.max(inMin, 1));
    const lMax = Math.log10(Math.max(inMax, 1));
    return mapRange(lv, lMin, lMax, outMin, outMax);
  }

  function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function makeRandom(seed) {
    let s = seed || 1;
    return function () {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      s = s >>> 0;
      return s / 4294967295;
    };
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  // ---------- APOD (image/video backdrop) ----------

  function youtubeEmbedUrl(url) {
    const match = (url || '').match(
      /(?:youtube\.com\/(?:embed\/|watch\?v=)|youtu\.be\/)([\w-]+)/
    );
    if (!match) return null;
    const id = match[1];
    return `https://www.youtube.com/embed/${id}?autoplay=1&mute=1&loop=1&playlist=${id}&controls=0&modestbranding=1&rel=0`;
  }

  function renderAPOD(apod) {
    const oculus = document.getElementById('oculus');
    oculus.classList.remove('is-loading', 'show-video', 'show-video-frame', 'show-fallback');

    if (!apod) {
      oculus.classList.add('show-fallback');
      return;
    }

    const imgEl = document.getElementById('oculus-image');
    const videoEl = document.getElementById('oculus-video');
    const frameEl = document.getElementById('oculus-video-frame');

    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();
    frameEl.src = '';

    if (apod.mediaType === 'image') {
      imgEl.src = apod.imageUrl;
      imgEl.alt = apod.title;
    } else if (apod.mediaType === 'video') {
      const embedUrl = youtubeEmbedUrl(apod.videoUrl);
      if (embedUrl) {
        frameEl.src = embedUrl;
        frameEl.title = apod.title;
        oculus.classList.add('show-video-frame');
      } else {
        videoEl.src = apod.videoUrl;
        videoEl.play().catch(() => {});
        oculus.classList.add('show-video');
      }
    } else {
      oculus.classList.add('show-fallback');
    }
  }

  function renderAPODError() {
    const oculus = document.getElementById('oculus');
    oculus.classList.remove('is-loading');
    oculus.classList.add('show-fallback');
  }

  // ---------- EPIC (Earth Polychromatic Imaging Camera) ----------
  //
  // EPIC's own API host, not proxied through api.nasa.gov — no key needed.

  const EPIC_URL = 'https://epic.gsfc.nasa.gov/api/natural';

  async function loadEPIC() {
    try {
      const res = await fetch(EPIC_URL);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) throw new Error('No EPIC images available');
      renderEPIC(data[data.length - 1]);
    } catch (err) {
      console.error('EPIC fetch failed:', err);
    }
  }

  function renderEPIC(entry) {
    const [datePart] = entry.date.split(' ');
    const [year, month, day] = datePart.split('-');
    const img = document.getElementById('epic-image');
    img.src = `https://epic.gsfc.nasa.gov/archive/natural/${year}/${month}/${day}/jpg/${entry.image}.jpg`;
    img.alt = `Earth, photographed from space on ${datePart}`;
  }

  // ---------- Solar wind (NOAA SWPC — near-real-time, no key required) ----------
  //
  // Speed and field tilt (Bz) drive the wind streaks and the aurora in the
  // art, and are reported on the Cosmic Meteorology slide. A reading older
  // than WIND_MAX_AGE_MS is ignored rather than shown as if it were current.

  const WIND_MAX_AGE_MS = 30 * 60 * 1000;
  let latestWind = null; // { kms, mph, bz, at }

  function currentWind() {
    return latestWind && Date.now() - latestWind.at < WIND_MAX_AGE_MS ? latestWind : null;
  }

  async function loadSolarWind() {
    try {
      const [magRes, speedRes] = await Promise.all([
        fetch('https://services.swpc.noaa.gov/products/summary/solar-wind-mag-field.json'),
        fetch('https://services.swpc.noaa.gov/products/summary/solar-wind-speed.json'),
      ]);
      if (!magRes.ok || !speedRes.ok) throw new Error('HTTP ' + magRes.status + '/' + speedRes.status);
      const [mag] = await magRes.json();
      const [speed] = await speedRes.json();
      const kms = Number(speed.proton_speed);
      const bz = Number(mag.bz_gsm);
      if (!Number.isFinite(kms) || !Number.isFinite(bz)) throw new Error('Unexpected solar wind data');
      latestWind = { kms, mph: Math.round(kms * KM_S_TO_MPH), bz, at: Date.now() };
      paintArtKey();
    } catch (err) {
      console.error('Solar wind fetch failed:', err);
    }
  }

  // ---------- small formatting helpers ----------

  function strongestFlareClass(intensity) {
    if (!(intensity > 0)) return null;
    const classes = [['X', 10000], ['M', 1000], ['C', 100], ['B', 10], ['A', 1]];
    for (const [letter, base] of classes) {
      if (intensity >= base) return letter + (intensity / base).toFixed(1);
    }
    return null;
  }

  // The shooting stars in the art: one for every storm and every solar event
  // (flare or coronal mass ejection) logged this week — the same two numbers
  // the Geomagnetic Activity card shows. The ceiling only stops an extreme
  // week from making the sky unreadable.
  const MAX_SHOOTING_STARS = 60;

  function stormCountOf(sw) {
    return Number.isFinite(sw.stormCount) ? sw.stormCount : sw.kpIndex > 0 ? 1 : 0;
  }

  function shootingStarCount(sw) {
    return Math.min(stormCountOf(sw) + sw.flareCount + sw.cmeCount, MAX_SHOOTING_STARS);
  }

  // NASA logs Kp in thirds (5.67, 6.33, 7.33), so show one decimal at most.
  function kpLabel(kp) {
    return Number.isInteger(kp) ? String(kp) : kp.toFixed(1);
  }

  function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
  }

  // The artwork key slide: one card per element of the artwork, showing what
  // it's doing right now. A card or row is skipped when its source isn't live, so the key never claims
  // "quiet" for data it doesn't have.
  let keyCardCount = 0;
  let keySignature = '';

  // Only the card for the current Cosmic Meteorology slide is shown.
  function showKeyCard() {
    const index = mode.startsWith('key:') ? Number(mode.slice(4)) : -1;
    let activeIsCme = false;
    document.querySelectorAll('#key-cards .fc-day').forEach((card) => {
      const isActive = Number(card.dataset.i) === index;
      card.classList.toggle('is-active', isActive);
      if (isActive && card.dataset.kind === 'ring') activeIsCme = true;
    });
    if (activeIsCme) startCmeBg();
    else stopCmeBg();
  }

  function paintArtKey() {
    const box = document.getElementById('key-cards');
    if (!box) return;

    const sw = latestData && latestData.spaceWeather;
    const status = (latestData && latestData.sourceStatus) || {};
    const eventsLive = status.flares === 'live' && status.cmes === 'live';
    const cards = [];

    // Same shape as the solar flare strength card: the strongest reading as the
    // big value, and rows that are always there, even in a quiet week.
    if (sw && status.storms === 'live') {
      const stormCount = stormCountOf(sw);
      const rows = [['Storms this week', String(stormCount)]];
      if (eventsLive) rows.push(['Solar events', String(sw.flareCount + sw.cmeCount)]);
      cards.push({
        label: 'Geomagnetic Activity', glyph: 'streak',
        value: sw.kpIndex > 0 ? `Storm Level ${kpLabel(sw.kpIndex)} of 9` : stormCount > 0 ? 'Storm Logged' : 'No Storms',
        rows,
      });
    }
    const wind = currentWind();
    if (wind) {
      const pace = wind.kms < 350 ? 'Gentle' : wind.kms < 500 ? 'Steady' : wind.kms < 700 ? 'Brisk' : 'Fast';
      cards.push({
        label: 'Solar wind', glyph: 'wind',
        value: `${wind.mph.toLocaleString('en-US')} Miles Per Hour`,
        rows: [['Streaming pace', pace]],
      });
    }
    if (sw && status.cmes === 'live' && Array.isArray(latestData.cmes)) {
      const heading = latestData.cmes.filter((c) => c.earth === 'predicted').length;
      cards.push({
        label: 'Coronal mass ejections', glyph: 'ring', glyphWarn: heading > 0,
        value: sw.cmeCount === 0 ? 'None This Week' : `${plural(sw.cmeCount, 'Ejection', 'Ejections')} This Week`,
        rows: sw.cmeCount === 0 ? [] : [
          ['Rings shown', String(latestData.cmes.length)],
          ['Heading for Earth', String(heading), heading > 0],
        ],
      });
    }
    if (wind) {
      cards.push({
        label: 'Aurora glow', glyph: 'aurora',
        value: wind.bz < -2 ? 'Aurora Watch' : 'Quiet',
        rows: [['Magnetic field tilt', `${wind.bz > 0 ? '+' : ''}${wind.bz} nanotesla`]],
      });
    }
    if (sw && status.flares === 'live') {
      const strongest = strongestFlareClass(sw.flareIntensity);
      cards.push({
        label: 'Solar flare strength', glyph: 'core',
        value: strongest ? `${strongest} Flare` : 'No Flares',
        rows: [['Flares this week', String(sw.flareCount)]],
      });
    }
    if (status.neo === 'live' && latestData.asteroids) {
      const count = latestData.asteroids.length;
      const hazardous = latestData.asteroids.filter((a) => a.hazardous).length;
      cards.push({
        label: 'Asteroid tracker', glyph: 'orbit',
        value: count === 0 ? 'None Today' : String(count),
        rows: count === 0 ? [] : [['Potentially hazardous', String(hazardous), hazardous > 0]],
      });
    }

    // Each card is its own slide, so the number of slides follows the cards.
    // Repaint only when something changed, so a slide doesn't re-animate every
    // time the wind reading refreshes.
    const signature = JSON.stringify(cards);
    keyCardCount = cards.length;
    if (signature === keySignature) {
      showKeyCard();
      return;
    }
    keySignature = signature;

    box.textContent = '';
    cards.forEach((c, i) => {
      const card = document.createElement('div');
      card.className = 'fc-day';
      card.dataset.i = String(i);
      card.dataset.kind = c.glyph;

      const label = document.createElement('div');
      label.className = 'fc-date';
      label.textContent = c.label;
      card.appendChild(label);

      if (c.value) {
        const cond = document.createElement('div');
        cond.className = 'fc-cond';
        const glyph = document.createElement('span');
        glyph.className = 'key-glyph is-' + c.glyph + (c.glyphWarn ? ' is-warn' : '');
        glyph.setAttribute('aria-hidden', 'true');
        cond.append(glyph, c.value);
        card.appendChild(cond);
      }

      c.rows.forEach(([name, value, warn]) => {
        const row = document.createElement('div');
        row.className = 'fc-row' + (warn ? ' is-warn' : '');
        const n = document.createElement('span');
        n.textContent = name;
        const v = document.createElement('b');
        v.textContent = value;
        row.append(n, v);
        card.appendChild(row);
      });
      box.appendChild(card);
    });
    showKeyCard();
  }

  // ---------- unified NASA data (APOD, space weather, NEO) ----------

  const FALLBACK_DATA = {
    timestamp: null,
    sourceStatus: {
      neo: 'unavailable', flares: 'unavailable', cmes: 'unavailable',
      storms: 'unavailable', apod: 'unavailable',
    },
    spaceWeather: { flareCount: 0, flareIntensity: 0, cmeCount: 0, cmeSpeed: 0, geomagneticIntensity: 0, kpIndex: 0 },
    cmes: [],
    asteroids: [],
    apod: null,
  };

  let latestData = FALLBACK_DATA;

  // Smoothed, currently-displayed values feeding the artwork — these ease
  // toward latestData's numbers rather than jumping, so a data refresh
  // never looks abrupt.
  const shown = { flareIntensity: 0, geomagneticIntensity: 0, windKms: 400, aurora: 0 };

  function isAnyLive(sourceStatus) {
    return Object.values(sourceStatus).some((s) => s === 'live');
  }

  function updateStatus() {
    const live = isAnyLive(latestData.sourceStatus);
    statusEl.classList.toggle('is-live', live);
    statusText.textContent = live
      ? 'Live data connected.'
      : 'Live data unavailable — showing a quiet fallback state.';
  }

  let fetchInFlight = false;

  async function fetchData() {
    if (fetchInFlight) return; // guards against overlapping calls racing each other
    fetchInFlight = true;
    try {
      const res = await fetch('/api/nasa-data');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      latestData = data;
      rebuildOrbits(data.asteroids || []);
      rebuildCMERings(data.cmes);
      renderAPOD(data.apod);
      paintArtKey();
    } catch (err) {
      // Keep whatever we last had (or the fallback) and just reflect the
      // degraded state in the status dot — the sign keeps running. Only
      // fall back the APOD image if we never had one to begin with.
      latestData = { ...latestData, sourceStatus: FALLBACK_DATA.sourceStatus };
      if (document.getElementById('oculus').classList.contains('is-loading')) {
        renderAPODError();
      }
      console.error('nasa-data fetch failed:', err);
    } finally {
      fetchInFlight = false;
    }
    updateStatus();
  }

  // ---------- Algorithm Art: scene state ----------

  let stars = [];
  let orbits = [];
  let fineParticles = [];
  let windParticles = [];
  let cmeRings = [];

  // WCAG non-text contrast (1.4.11): every meaningful mark clears 3:1 against
  // the --ink background (rgb(10,11,14)) at its *blended* strength, not just
  // at full color. The alphas chosen for orbit lines, the core, the aurora, the
  // CME arcs and the wind streaks are the ones that keep it there. Twinkling
  // background stars and soft halos are decorative.
  const palette = {
    core: [99, 179, 255],
    amber: [251, 191, 36],
    star: [250, 250, 255],
    aurora: [110, 235, 170],
    cme: [200, 150, 255],
  };

  function mix(c1, c2, t) {
    return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
  }

  function rgba(c, a) {
    return `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${a})`;
  }

  function buildStars() {
    const count = Math.round((width * height) / 9000);
    const rand = makeRandom(42);
    stars = [];
    for (let i = 0; i < count; i++) {
      stars.push({
        x: rand() * width,
        y: rand() * height,
        r: (0.9 + rand() * 1.6) * ui,
        base: 0.5 + rand() * 0.5,
        phase: rand() * Math.PI * 2,
        speed: 0.15 + rand() * 0.25,
      });
    }
  }

  function coreCenter() {
    // Off-centre on tall/square screens; centred on a wide (horizontal) sign.
    const wide = clamp((width / height - 1) / 0.78, 0, 1);
    return { x: width * (0.44 + 0.06 * wide), y: height * 0.47 };
  }

  // On a wide sign the orbits are stretched sideways so they use the width
  // instead of huddling in the middle.
  let orbitStretch = 1;

  function rebuildOrbits(asteroids) {
    const maxRadius = Math.min(width, height) * 0.46;
    const c = coreCenter();
    orbitStretch = clamp((0.92 * Math.min(c.x, width - c.x)) / maxRadius, 1, 1.8);
    const minRadius = Math.min(width, height) * 0.14;

    const missDistances = asteroids.map((a) => a.missDistance).filter((v) => v > 0);
    const minMiss = missDistances.length ? Math.min(...missDistances) : 1;
    const maxMiss = missDistances.length ? Math.max(...missDistances) : 1;

    orbits = asteroids.map((a) => {
      const rand = makeRandom(hashString(a.id || a.name || String(Math.random())));
      const radius = a.missDistance > 0
        ? logMapRange(a.missDistance, Math.max(minMiss, 1), Math.max(maxMiss, minMiss + 1), minRadius, maxRadius)
        : lerp(minRadius, maxRadius, rand());
      const bodyRadius = a.diameter > 0 ? logMapRange(a.diameter, 5, 2000, 4, 11) * ui : 6 * ui;
      // Radians per second: one lap every ~1-5 minutes, slow enough to read as drifting.
      const angularSpeed = a.velocity > 0 ? mapRange(a.velocity, 3000, 120000, 0.022, 0.11) : 0.055;

      return {
        radius,
        eccentricity: 0.55 + rand() * 0.25,
        tilt: rand() * Math.PI,
        angle: rand() * Math.PI * 2,
        angularSpeed: angularSpeed * (rand() < 0.5 ? -1 : 1),
        bodyRadius,
        hazardous: Boolean(a.hazardous),
      };
    });
  }

  function makeFineParticle() {
    // A shooting star: a fixed diagonal heading and a brief straight streak
    // with a bright head and a fading tail, entering from an edge. Its size
    // is set by geomagnetic activity at draw time (see drawFineParticle);
    // sizeFactor is just per-particle organic variation around that.
    const angle = Math.PI * 0.15 + (Math.random() - 0.5) * 0.4;
    const fromLeft = Math.random() < 0.5;
    return {
      x: fromLeft ? -20 * ui : Math.random() * width,
      y: fromLeft ? Math.random() * height * 0.6 : -20 * ui,
      angle,
      sizeFactor: 0.75 + Math.random() * 0.5,
      life: 0,
      maxLife: 260 + Math.random() * 160, // frames; slow streaks need time to cross
    };
  }

  function rebuildParticles() {
    fineParticles = [];
    windParticles = [];
  }

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    ui = clamp(Math.min(width, height) / 750, 1, 2.2);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    buildStars();
    rebuildOrbits(latestData.asteroids || []);
    rebuildParticles();
    resizeCmeBg();
  }

  // ---------- coronal mass ejections card: decorative purple arcs ----------
  //
  // Same shape, easing and speed math as the real CME arcs in Algorithm Art
  // (drawCMEs) — just fed a fixed set of made-up rings instead of live data,
  // since this is a background flourish for the card, not a data display.

  let cmeBgWidth = 0;
  let cmeBgHeight = 0;

  function resizeCmeBg() {
    cmeBgWidth = cmeBg.clientWidth;
    cmeBgHeight = cmeBg.clientHeight;
    const bgDpr = Math.min(window.devicePixelRatio || 1, 2);
    cmeBg.width = cmeBgWidth * bgDpr;
    cmeBg.height = cmeBgHeight * bgDpr;
    cmeBgCtx.setTransform(bgDpr, 0, 0, bgDpr, 0, 0);
  }

  const decorativeRings = (() => {
    const rand = makeRandom(hashString('cme-bg-decorative'));
    const count = 4;
    return Array.from({ length: count }, (_, i) => ({
      t: i / count,
      angle: rand() * Math.PI * 2,
      half: 0.6 + rand() * 0.4,
      kms: 400 + rand() * 1000,
    }));
  })();

  function drawCmeBg(dt) {
    const w = cmeBgWidth;
    const h = cmeBgHeight;
    if (!w || !h) return;
    cmeBgCtx.clearRect(0, 0, w, h);

    const center = { x: w / 2, y: h / 2 };
    const startR = Math.min(w, h) * 0.08;
    const endR = Math.hypot(Math.max(center.x, w - center.x), Math.max(center.y, h - center.y));
    const bgUi = clamp(Math.min(w, h) / 750, 1, 2.2);

    cmeBgCtx.lineCap = 'round';
    for (const ring of decorativeRings) {
      const period = mapRange(ring.kms, 300, 2000, 5400, 1800);
      ring.t += (dt / period) * (reduceMotion ? 0.15 : 1);
      if (ring.t >= 1) ring.t -= 1;

      const alpha = 0.8 * Math.min(ring.t / 0.06, 1) * (1 - Math.max((ring.t - 0.85) / 0.15, 0));
      if (alpha <= 0) continue;
      const r = startR + ring.t * (endR - startR);
      const a0 = ring.angle - ring.half;
      const a1 = ring.angle + ring.half;

      cmeBgCtx.strokeStyle = rgba(palette.cme, alpha * 0.3);
      cmeBgCtx.lineWidth = (8 + ring.t * 16) * bgUi;
      cmeBgCtx.beginPath();
      cmeBgCtx.arc(center.x, center.y, r, a0, a1);
      cmeBgCtx.stroke();

      cmeBgCtx.strokeStyle = rgba(palette.cme, alpha);
      cmeBgCtx.lineWidth = (2.5 + ring.t * 2.5) * bgUi;
      cmeBgCtx.beginPath();
      cmeBgCtx.arc(center.x, center.y, r, a0, a1);
      cmeBgCtx.stroke();
    }
    cmeBgCtx.lineCap = 'butt';
  }

  let cmeBgRunning = false;
  let cmeBgLastTime = 0;

  function cmeBgFrame(now) {
    if (!cmeBgRunning) return;
    const dt = clamp(now - cmeBgLastTime, 0, 64) / 16.6667;
    cmeBgLastTime = now;
    drawCmeBg(dt);
    requestAnimationFrame(cmeBgFrame);
  }

  function startCmeBg() {
    cmeBg.classList.add('is-active');
    if (cmeBgRunning) return;
    cmeBgRunning = true;
    cmeBgLastTime = performance.now();
    requestAnimationFrame(cmeBgFrame);
  }

  function stopCmeBg() {
    cmeBgRunning = false;
    cmeBg.classList.remove('is-active');
  }

  // ---------- Algorithm Art: drawing ----------

  function drawBackdrop() {
    ctx.fillStyle = '#0a0b0e';
    ctx.fillRect(0, 0, width, height);
  }

  function drawStars(t) {
    for (const s of stars) {
      const twinkle = 0.8 + 0.2 * Math.sin(t * s.speed + s.phase);
      ctx.beginPath();
      ctx.fillStyle = rgba(palette.star, s.base * twinkle);
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawCore(t, center, elevated) {
    const intensity = shown.flareIntensity;
    const normalized = clamp(logMapRange(intensity, 1, 10000, 0, 1), 0, 1);
    const radius = mapRange(normalized, 0, 1, Math.min(width, height) * 0.045, Math.min(width, height) * 0.08);
    const brightness = mapRange(normalized, 0, 1, 0.6, 0.85);
    const breathe = 1 + Math.sin(t * 0.12) * 0.04;

    const color = elevated ? mix(palette.core, palette.amber, 0.22) : palette.core;
    const outerRadius = radius * breathe * 2.4;
    const gradient = ctx.createRadialGradient(
      center.x, center.y, 0,
      center.x, center.y, outerRadius
    );
    gradient.addColorStop(0, rgba(color, brightness));
    gradient.addColorStop(0.35, rgba(color, brightness * 0.45));
    gradient.addColorStop(0.7, rgba(color, brightness * 0.12));
    gradient.addColorStop(1, rgba(color, 0));

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(center.x, center.y, outerRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  function orbitPosition(orbit, center) {
    const x0 = Math.cos(orbit.angle) * orbit.radius;
    const y0 = Math.sin(orbit.angle) * orbit.radius * orbit.eccentricity;
    const cos = Math.cos(orbit.tilt);
    const sin = Math.sin(orbit.tilt);
    return {
      x: center.x + (x0 * cos - y0 * sin) * orbitStretch,
      y: center.y + x0 * sin + y0 * cos,
    };
  }

  function drawOrbits(center, elevated) {
    for (const orbit of orbits) {
      ctx.save();
      ctx.translate(center.x, center.y);
      ctx.scale(orbitStretch, 1);
      ctx.rotate(orbit.tilt);
      ctx.scale(1, orbit.eccentricity);
      ctx.beginPath();
      ctx.arc(0, 0, orbit.radius, 0, Math.PI * 2);
      ctx.strokeStyle = orbit.hazardous && elevated
        ? rgba(palette.amber, 0.55)
        : rgba(palette.star, 0.45);
      ctx.lineWidth = 3 * ui;
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawBodies(dt, center, elevated) {
    for (const orbit of orbits) {
      orbit.angle += orbit.angularSpeed * (dt / 60) * (reduceMotion ? 0.15 : 1); // dt is in 60fps frames
      const pos = orbitPosition(orbit, center);
      const color = orbit.hazardous ? mix(palette.amber, palette.core, elevated ? 0.25 : 0.5) : palette.core;
      const alpha = orbit.hazardous ? 0.85 : 0.75;

      const glow = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, orbit.bodyRadius * 2.6);
      glow.addColorStop(0, rgba(color, alpha));
      glow.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, orbit.bodyRadius * 2.6, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.fillStyle = rgba(color, Math.min(alpha + 0.25, 1));
      ctx.arc(pos.x, pos.y, orbit.bodyRadius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Shooting stars are a single fading tail segment, not a growing history
  // of points — cheap to draw, and their size/speed are recomputed live
  // from geomagnetic activity every frame rather than fixed at spawn, so
  // they visibly react as the Kp index eases toward a new value.

  function stepFineParticle(p, speed) {
    p.x += Math.cos(p.angle) * speed;
    p.y += Math.sin(p.angle) * speed;
    p.life++;
    return (
      p.life > p.maxLife || p.x < -60 || p.x > width + 60 || p.y < -60 || p.y > height + 60
    );
  }

  function drawFineParticle(p, elevated, geo) {
    const lifeFrac = p.life / p.maxLife;
    const fadeIn = Math.min(lifeFrac / 0.12, 1);
    const fadeOut = 1 - Math.max((lifeFrac - 0.75) / 0.25, 0);
    const alpha = Math.min(fadeIn, fadeOut);
    if (alpha <= 0) return;

    const length = mapRange(geo, 0, 1, 60, 200) * p.sizeFactor * ui;
    const dx = Math.cos(p.angle);
    const dy = Math.sin(p.angle);
    const tailX = p.x - dx * length;
    const tailY = p.y - dy * length;
    const color = elevated ? mix(palette.star, palette.amber, 0.3) : palette.star;

    const gradient = ctx.createLinearGradient(tailX, tailY, p.x, p.y);
    gradient.addColorStop(0, rgba(color, 0));
    gradient.addColorStop(1, rgba(color, alpha));
    ctx.strokeStyle = gradient;
    ctx.lineWidth = mapRange(geo, 0, 1, 2.5, 6) * ui;
    ctx.beginPath();
    ctx.moveTo(tailX, tailY);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();

    ctx.beginPath();
    ctx.fillStyle = rgba(color, alpha);
    ctx.arc(p.x, p.y, mapRange(geo, 0, 1, 3, 6.5) * ui, 0, Math.PI * 2);
    ctx.fill();
  }

  // Solar wind: faint dots streaming radially outward from the glowing core.
  // Their speed follows the live solar wind speed (NOAA, ~250-900 km/s), so a
  // faster wind visibly streams faster. Distinct from the shooting stars,
  // which are larger streaks driven by geomagnetic activity.
  function drawWind(dt, center) {
    const startR = Math.min(width, height) * 0.06;
    const endR = Math.hypot(Math.max(center.x, width - center.x), Math.max(center.y, height - center.y));
    const span = endR - startR;
    const target = Math.round(clamp((width * height) / 36000, 16, 48));

    while (windParticles.length < target) {
      windParticles.push({ angle: Math.random() * Math.PI * 2, t: Math.random(), size: 1.6 + Math.random() * 1.0 });
    }
    windParticles.length = target;

    const speed = mapRange(shown.windKms, 250, 900, 0.18, 1.1) * ui * (reduceMotion ? 0.15 : 1);
    const color = mix(palette.core, palette.star, 0.6);
    const trail = (14 + speed * 8) * ui;

    ctx.lineCap = 'round';
    for (const p of windParticles) {
      p.t += (speed * dt) / span;
      if (p.t >= 1) {
        p.t = 0;
        p.angle = Math.random() * Math.PI * 2;
      }
      const alpha = 0.9 * Math.min(p.t / 0.05, 1) * (1 - Math.max((p.t - 0.88) / 0.12, 0));
      if (alpha <= 0) continue;
      const r = startR + p.t * span;
      const dx = Math.cos(p.angle);
      const dy = Math.sin(p.angle);
      ctx.strokeStyle = rgba(color, alpha);
      ctx.lineWidth = p.size * ui;
      ctx.beginPath();
      ctx.moveTo(center.x + dx * Math.max(r - trail, startR), center.y + dy * Math.max(r - trail, startR));
      ctx.lineTo(center.x + dx * r, center.y + dy * r);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }

  // Coronal mass ejections: each recent eruption is a wide, soft arc that
  // expands outward from the core, like a cloud thrown off the Sun. A faster
  // eruption crosses the screen sooner. Ones predicted to reach Earth are amber.
  function rebuildCMERings(cmes) {
    const list = Array.isArray(cmes) ? cmes : [];
    cmeRings = list.map((c, i) => {
      const rand = makeRandom(hashString(String(c.startTime || i)));
      return {
        t: i / Math.max(list.length, 1), // staggered so they don't all start together
        angle: rand() * Math.PI * 2,
        half: 0.6 + rand() * 0.4,
        kms: c.speed || 600,
        earth: c.earth === 'predicted',
      };
    });
  }

  function drawCMEs(dt, center) {
    if (cmeRings.length === 0) return;
    const startR = Math.min(width, height) * 0.08;
    const endR = Math.hypot(Math.max(center.x, width - center.x), Math.max(center.y, height - center.y));

    ctx.lineCap = 'round';
    for (const ring of cmeRings) {
      const period = mapRange(ring.kms, 300, 2000, 5400, 1800); // frames to cross the screen (~30-90 s)
      ring.t += (dt / period) * (reduceMotion ? 0.15 : 1);
      if (ring.t >= 1) ring.t -= 1;

      const alpha = 0.8 * Math.min(ring.t / 0.06, 1) * (1 - Math.max((ring.t - 0.85) / 0.15, 0));
      if (alpha <= 0) continue;
      const color = ring.earth ? palette.amber : palette.cme;
      const r = startR + ring.t * (endR - startR);
      const a0 = ring.angle - ring.half;
      const a1 = ring.angle + ring.half;

      ctx.strokeStyle = rgba(color, alpha * 0.3);
      ctx.lineWidth = (8 + ring.t * 16) * ui;
      ctx.beginPath();
      ctx.arc(center.x, center.y, r, a0, a1);
      ctx.stroke();

      ctx.strokeStyle = rgba(color, alpha);
      ctx.lineWidth = (2.5 + ring.t * 2.5) * ui;
      ctx.beginPath();
      ctx.arc(center.x, center.y, r, a0, a1);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }

  // Aurora watch: when the solar wind's magnetic field tilts south (Bz below
  // -2 nT, the same test as the weather screen's badge), a green glow with
  // swaying edges hangs from the top of the sky. The further south, the
  // stronger and deeper it gets.
  function drawAurora(t) {
    const a = shown.aurora;
    if (a < 0.02) return;
    const maxH = height * (0.14 + 0.14 * a);
    const step = Math.max(6, Math.round(width / 160));
    const topAlpha = mapRange(a, 0.35, 1, 0.55, 0.85);

    // Thin vertical curtains, each fading to nothing at its own sway-driven
    // height, so the lower edge is soft rather than a hard outline.
    for (let layer = 0; layer < 2; layer++) {
      const color = layer === 0 ? palette.aurora : mix(palette.aurora, palette.core, 0.55);
      for (let x = 0; x < width; x += step) {
        const sway = 0.55 + 0.3 * Math.sin(x * 0.011 + t * 1.4 + layer * 2) + 0.15 * Math.sin(x * 0.027 - t * 0.9);
        const h = maxH * (layer ? 0.7 : 1) * sway;
        const gradient = ctx.createLinearGradient(0, 0, 0, h);
        gradient.addColorStop(0, rgba(color, topAlpha));
        gradient.addColorStop(0.45, rgba(color, topAlpha * 0.4));
        gradient.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = gradient;
        ctx.fillRect(x, 0, step + 1, h);
      }
    }
  }

  function drawParticles(elevated) {
    const geo = shown.geomagneticIntensity;
    const speed = mapRange(geo, 0, 1, 0.6, 2.2) * ui * (reduceMotion ? 0.3 : 1);

    const targetFine = shootingStarCount(latestData.spaceWeather);
    while (fineParticles.length < targetFine) fineParticles.push(makeFineParticle());
    while (fineParticles.length > targetFine) fineParticles.pop();

    for (let i = fineParticles.length - 1; i >= 0; i--) {
      const p = fineParticles[i];
      const dead = stepFineParticle(p, speed);
      drawFineParticle(p, elevated, geo);
      if (dead) fineParticles[i] = makeFineParticle();
    }
  }

  // ---------- Algorithm Art: animation loop ----------

  let lastTime = performance.now();
  let clock = 0;

  function frame(now) {
    const dtMs = clamp(now - lastTime, 0, 64);
    lastTime = now;
    const dt = dtMs / 16.6667;
    clock += dt * (reduceMotion ? 0.002 : 0.006);

    shown.flareIntensity = lerp(shown.flareIntensity, latestData.spaceWeather.flareIntensity, 0.01);
    shown.geomagneticIntensity = lerp(shown.geomagneticIntensity, latestData.spaceWeather.geomagneticIntensity, 0.01);
    const wind = currentWind();
    if (wind) shown.windKms = lerp(shown.windKms, wind.kms, 0.01);
    const auroraTarget = wind && wind.bz < -2 ? mapRange(-wind.bz, 2, 12, 0.35, 1) : 0;
    shown.aurora = lerp(shown.aurora, auroraTarget, 0.02);

    const elevated =
      latestData.spaceWeather.flareIntensity >= 1000 || latestData.spaceWeather.kpIndex >= 5;

    const center = coreCenter();

    drawBackdrop();
    drawStars(clock * 8);
    drawAurora(clock * 0.4);
    drawWind(dt, center);
    drawCMEs(dt, center);
    drawParticles(elevated);
    drawCore(clock * 8, center, elevated);
    drawOrbits(center, elevated);
    drawBodies(dt, center, elevated);

    requestAnimationFrame(frame);
  }

  // ---------- slide cycle ----------
  //
  // Each slide holds for 12-15 seconds (random within that range), except the
  // artwork, which always holds a full 20 seconds, then the sign moves to the
  // next one:
  // APOD photo → EPIC Earth image → one Cosmic Meteorology slide per card
  // (geomagnetic activity, solar wind, coronal mass ejections, aurora, solar flare strength,
  // asteroid tracker) → Algorithm Art → back to APOD. A card whose data source
  // isn't live has no slide. Movement cuts in early: when the camera (see startCameraMotion) sees a new visitor — motion
  // after a few seconds of stillness — the sign advances right away and the
  // timer restarts. Continuous movement doesn't skip screens. Mouse/touch/
  // keyboard activity counts as movement too, for desks and testing.

  const SLIDE_DWELL_MIN_MS = 12000; // every slide holds 12-15 s unless a visitor arrives
  const SLIDE_DWELL_MAX_MS = 15000;
  const ART_DWELL_MS = 20000; // the artwork always gets a full 20 s
  // Every other slide is a random 12-15 s.
  const nextDwell = () =>
    mode === 'art' ? ART_DWELL_MS : SLIDE_DWELL_MIN_MS + Math.random() * (SLIDE_DWELL_MAX_MS - SLIDE_DWELL_MIN_MS);
  let dwellTimer;
  let mode = 'apod';

  function slideSequence() {
    const sequence = ['apod', 'epic'];
    for (let i = 0; i < keyCardCount; i++) sequence.push('key:' + i);
    sequence.push('art');
    return sequence;
  }

  function advance() {
    const sequence = slideSequence();
    mode = sequence[(sequence.indexOf(mode) + 1) % sequence.length];
    document.body.classList.remove('mode-key', 'mode-epic', 'mode-art');
    if (mode.startsWith('key:')) document.body.classList.add('mode-key');
    else if (mode !== 'apod') document.body.classList.add('mode-' + mode);
    showKeyCard();
    clearTimeout(dwellTimer);
    dwellTimer = setTimeout(advance, nextDwell());
  }

  function startSlideCycle() {
    ['mousemove', 'touchstart', 'touchmove', 'keydown', 'click', 'scroll'].forEach((evt) => {
      window.addEventListener(evt, onMotion, { passive: true });
    });
    dwellTimer = setTimeout(advance, nextDwell());
  }

  // ---------- camera motion ----------
  //
  // Frame differencing on a tiny downscaled copy of the webcam feed. Frames
  // are compared and thrown away in the browser — nothing is recorded or sent
  // anywhere. If the camera is missing or permission is denied, the sign just
  // keeps using the mouse/touch fallback above and the timer.

  const MOTION_SAMPLE_MS = 120;
  const MOTION_QUIET_MS = 3000; // stillness needed before movement counts as a new visitor
  const PIXEL_DELTA = 28; // per-pixel brightness change (0-255) that counts as "changed"
  const MOTION_MIN_FRACTION = 0.015; // share of pixels changed to count as movement
  const MOTION_MAX_FRACTION = 0.6; // above this it's a lighting/exposure shift, not a person
  const SAMPLE_W = 32;
  const SAMPLE_H = 24;

  let lastMotionAt = 0;

  function onMotion() {
    const now = performance.now();
    const isNewVisitor = now - lastMotionAt > MOTION_QUIET_MS;
    lastMotionAt = now;
    if (isNewVisitor) advance();
  }

  async function startCameraMotion() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 }, audio: false });
    } catch (err) {
      console.info('camera motion unavailable — using mouse/touch instead:', err && err.name);
      return;
    }

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    try {
      await video.play();
    } catch (err) {
      return;
    }

    const sample = document.createElement('canvas');
    sample.width = SAMPLE_W;
    sample.height = SAMPLE_H;
    const sctx = sample.getContext('2d', { willReadFrequently: true });
    let previous = null;

    setInterval(() => {
      if (video.readyState < 2) return;
      sctx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);
      const { data } = sctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
      const current = new Uint8Array(SAMPLE_W * SAMPLE_H);
      for (let i = 0; i < current.length; i++) {
        current[i] = data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114;
      }
      if (previous) {
        let changed = 0;
        for (let i = 0; i < current.length; i++) {
          if (Math.abs(current[i] - previous[i]) > PIXEL_DELTA) changed++;
        }
        const fraction = changed / current.length;
        if (fraction >= MOTION_MIN_FRACTION && fraction <= MOTION_MAX_FRACTION) onMotion();
      }
      previous = current;
    }, MOTION_SAMPLE_MS);
  }

  // ---------- boot ----------

  window.addEventListener('resize', resize);
  resize();
  resizeCmeBg();
  ctx.fillStyle = 'rgb(10, 11, 14)';
  ctx.fillRect(0, 0, width, height);

  loadEPIC();
  loadSolarWind();
  fetchData();
  setInterval(loadEPIC, REFRESH_MS);
  setInterval(loadSolarWind, WIND_REFRESH_MS);
  setInterval(fetchData, REFRESH_MS);
  startSlideCycle();
  startCameraMotion();

  requestAnimationFrame(frame);
})();
