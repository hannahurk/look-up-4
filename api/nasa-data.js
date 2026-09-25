// Vercel serverless function — the only place the real NASA API key is used.
// Fetches NeoWs (today), DONKI FLR/CME/GST (trailing ~7 days), and today's
// APOD, normalizing all of it into a small shape the client can render
// from. Never forwards the key or the raw NASA payloads to the browser.

const NEO_URL = 'https://api.nasa.gov/neo/rest/v1/feed';
const FLR_URL = 'https://api.nasa.gov/DONKI/FLR';
const CME_URL = 'https://api.nasa.gov/DONKI/CME';
const GST_URL = 'https://api.nasa.gov/DONKI/GST';
// NASA moved APOD to a new WordPress-based endpoint on 2026-09-10. The old
// one is still answering but goes offline 2026-12-01, so the new one is tried
// first and the old one is kept as a backup until it disappears.
const APOD_URL = 'https://science.nasa.gov/wp-json/wp/v2/apod-basic/';
const APOD_LEGACY_URL = 'https://api.nasa.gov/planetary/apod';

const FLARE_CLASS_BASE = { A: 1, B: 10, C: 100, M: 1000, X: 10000 };

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function dateRange(daysBack) {
  const end = new Date();
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - daysBack);
  return { startDate: isoDate(start), endDate: isoDate(end) };
}

async function fetchJSON(url, apiKey) {
  if (!apiKey) throw new Error('NASA_API_KEY is not configured');
  const res = await fetch(url + (url.includes('?') ? '&' : '?') + `api_key=${apiKey}`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${body ? ' — ' + body.slice(0, 300) : ''}`);
  }
  return res.json();
}

function flareIntensity(flares) {
  let max = 0;
  for (const flare of flares) {
    const classType = flare && flare.classType;
    if (!classType) continue;
    const letter = classType[0].toUpperCase();
    const base = FLARE_CLASS_BASE[letter];
    if (!base) continue;
    const magnitude = parseFloat(classType.slice(1));
    const value = base * (Number.isFinite(magnitude) ? magnitude : 1);
    if (value > max) max = value;
  }
  return max;
}

function averageCMESpeed(cmes) {
  const speeds = [];
  for (const cme of cmes) {
    const analyses = cme && cme.cmeAnalyses;
    if (!Array.isArray(analyses)) continue;
    for (const analysis of analyses) {
      if (analysis && typeof analysis.speed === 'number') speeds.push(analysis.speed);
    }
  }
  if (speeds.length === 0) return 0;
  return speeds.reduce((sum, v) => sum + v, 0) / speeds.length;
}

function maxKpIndex(storms) {
  let max = 0;
  for (const storm of storms) {
    const kpList = storm && storm.allKpIndex;
    if (!Array.isArray(kpList)) continue;
    for (const entry of kpList) {
      if (entry && typeof entry.kpIndex === 'number' && entry.kpIndex > max) {
        max = entry.kpIndex;
      }
    }
  }
  return max;
}

// The new endpoint returns a list of recent days (newest published first).
// `url` is now a web *page*, and `hdurl` is the actual picture — on video
// days too, where it's a still frame — so `hdurl` is always what we show.
function normalizeAPODNew(list) {
  const entries = Array.isArray(list) ? list : list ? [list] : [];
  const latest = entries
    .filter((entry) => entry && entry.hdurl)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0];
  if (!latest) return null;
  return {
    title: latest.title || '',
    mediaType: 'image',
    imageUrl: latest.hdurl,
    fallbackImageUrl: '',
    videoUrl: '',
  };
}

async function fetchAPOD(apiKey) {
  try {
    const fromNew = normalizeAPODNew(await fetchJSON(APOD_URL, apiKey));
    if (fromNew) return fromNew;
    console.error('nasa-data: apod (new endpoint) returned no usable picture');
  } catch (err) {
    console.error('nasa-data: apod (new endpoint) failed —', err && err.message);
  }
  return normalizeAPOD(await fetchJSON(APOD_LEGACY_URL, apiKey));
}

function normalizeAPOD(data) {
  if (!data) return null;
  return {
    title: data.title || '',
    mediaType: data.media_type || 'other',
    imageUrl: data.hdurl || data.url || '',
    // NASA's HD file is sometimes missing (404) while the standard-size one
    // is fine, so the page falls back to this one if the HD picture fails.
    fallbackImageUrl: data.media_type === 'image' && data.hdurl && data.url && data.url !== data.hdurl ? data.url : '',
    videoUrl: data.media_type === 'video' ? data.url || '' : '',
  };
}

function normalizeAsteroids(neoFeed) {
  const byDate = (neoFeed && neoFeed.near_earth_objects) || {};
  const all = Object.values(byDate).flat();
  return all.map((obj) => {
    const approach = Array.isArray(obj.close_approach_data) ? obj.close_approach_data[0] : null;
    const diameterRange = obj.estimated_diameter && obj.estimated_diameter.meters;
    const diameter = diameterRange
      ? (diameterRange.estimated_diameter_min + diameterRange.estimated_diameter_max) / 2
      : 0;
    const velocity = approach ? parseFloat(approach.relative_velocity.kilometers_per_hour) : 0;
    const missDistance = approach ? parseFloat(approach.miss_distance.kilometers) : 0;

    return {
      id: obj.id || '',
      name: obj.name || '',
      diameter: Number.isFinite(diameter) ? diameter : 0,
      velocity: Number.isFinite(velocity) ? velocity : 0,
      missDistance: Number.isFinite(missDistance) ? missDistance : 0,
      hazardous: Boolean(obj.is_potentially_hazardous_asteroid),
    };
  });
}

// Boils a DONKI CME record down to what the sign shows: when it erupted, how
// fast it's moving, and whether an Earth impact is predicted. "Predicted"
// means a model run gives an Earth arrival time; "not-expected" means a model
// run exists but shows no Earth impact; "unknown" means no model run at all.
// A glancing blow counts as predicted even when no arrival time is given.
function summarizeCME(cme) {
  const analyses = Array.isArray(cme.cmeAnalyses) ? cme.cmeAnalyses : [];
  const analysis = analyses.find((a) => a && a.isMostAccurate) || analyses[0] || null;
  const speed = analysis && typeof analysis.speed === 'number' ? analysis.speed : null;
  const models = analysis && Array.isArray(analysis.enlilList) ? analysis.enlilList : [];

  let arrivalTime = null;
  let glancing = false;
  for (const model of models) {
    if (!model) continue;
    if (model.estimatedShockArrivalTime && !arrivalTime) arrivalTime = model.estimatedShockArrivalTime;
    if (model.isEarthGB) glancing = true;
    for (const impact of Array.isArray(model.impactList) ? model.impactList : []) {
      if (impact && /earth/i.test(impact.location || '')) {
        if (!arrivalTime) arrivalTime = impact.arrivalTime || null;
        if (impact.isGlancingBlow) glancing = true;
      }
    }
  }

  return {
    startTime: cme.startTime || null,
    speed,
    earth: arrivalTime || glancing ? 'predicted' : models.length > 0 ? 'not-expected' : 'unknown',
    arrivalTime,
    glancing,
  };
}

// Three to show: any eruption still expected to reach Earth comes first
// (soonest arrival first, so an older one isn't cut off), then the most recent.
function recentCMEs(cmes) {
  const now = Date.now();
  const all = cmes.map(summarizeCME);
  const upcoming = all
    .filter((c) => c.earth === 'predicted' && (!c.arrivalTime || new Date(c.arrivalTime).getTime() > now))
    .sort((a, b) => new Date(a.arrivalTime || 8.64e15) - new Date(b.arrivalTime || 8.64e15));
  const rest = all
    .filter((c) => !upcoming.includes(c))
    .sort((a, b) => new Date(b.startTime || 0) - new Date(a.startTime || 0));
  return [...upcoming, ...rest].slice(0, 3);
}

module.exports = async (req, res) => {
  const apiKey = process.env.NASA_API_KEY;
  const today = isoDate(new Date());
  const { startDate, endDate } = dateRange(7);

  const [neoResult, flrResult, cmeResult, gstResult, apodResult] = await Promise.allSettled([
    fetchJSON(`${NEO_URL}?start_date=${today}&end_date=${today}`, apiKey),
    fetchJSON(`${FLR_URL}?startDate=${startDate}&endDate=${endDate}`, apiKey),
    fetchJSON(`${CME_URL}?startDate=${startDate}&endDate=${endDate}`, apiKey),
    fetchJSON(`${GST_URL}?startDate=${startDate}&endDate=${endDate}`, apiKey),
    fetchAPOD(apiKey),
  ]);

  const labeled = {
    neo: neoResult,
    flares: flrResult,
    cmes: cmeResult,
    storms: gstResult,
    apod: apodResult,
  };
  for (const [name, result] of Object.entries(labeled)) {
    if (result.status === 'rejected') {
      console.error(`nasa-data: ${name} failed —`, result.reason && result.reason.message);
    }
  }

  const neo = neoResult.status === 'fulfilled' ? neoResult.value : null;
  const flares = flrResult.status === 'fulfilled' && Array.isArray(flrResult.value) ? flrResult.value : [];
  const cmes = cmeResult.status === 'fulfilled' && Array.isArray(cmeResult.value) ? cmeResult.value : [];
  const storms = gstResult.status === 'fulfilled' && Array.isArray(gstResult.value) ? gstResult.value : [];

  const kpIndex = maxKpIndex(storms);

  const payload = {
    timestamp: new Date().toISOString(),
    sourceStatus: {
      neo: neoResult.status === 'fulfilled' ? 'live' : 'unavailable',
      flares: flrResult.status === 'fulfilled' ? 'live' : 'unavailable',
      cmes: cmeResult.status === 'fulfilled' ? 'live' : 'unavailable',
      storms: gstResult.status === 'fulfilled' ? 'live' : 'unavailable',
      apod: apodResult.status === 'fulfilled' && apodResult.value ? 'live' : 'unavailable',
    },
    spaceWeather: {
      flareCount: flares.length,
      flareIntensity: flareIntensity(flares),
      cmeCount: cmes.length,
      cmeSpeed: averageCMESpeed(cmes),
      geomagneticIntensity: Math.min(kpIndex / 9, 1),
      kpIndex,
      stormCount: storms.length,
    },
    cmes: recentCMEs(cmes),
    asteroids: neo ? normalizeAsteroids(neo) : [],
    apod: apodResult.status === 'fulfilled' ? apodResult.value : null,
  };

  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
  res.status(200).json(payload);
};
