# Space, Translated

A ceiling sign that cycles through four full-screen views of live space data: today's Astronomy Picture of the Day, a live Earth image, a series of "Cosmic Meteorology" slides that explain the artwork one element at a time, and "Algorithm Art" — a generative canvas piece that translates live space-weather and near-Earth-object data into slow, ambient motion (not a dashboard, not a literal solar-system diagram).

## What's driving it

A Vercel serverless function (`api/nasa-data.js`) is the only thing that holds the real NASA API key (`process.env.NASA_API_KEY`, never sent to the browser). It requests five endpoints in parallel with `Promise.allSettled` — so one failure never blocks the rest — and returns a small normalized payload:

- [`planetary/apod`](https://api.nasa.gov) — today's Astronomy Picture of the Day
- [`neo/rest/v1/feed`](https://api.nasa.gov) — today's near-Earth objects
- [`DONKI/FLR`](https://api.nasa.gov) — solar flares, trailing ~7 days
- [`DONKI/CME`](https://api.nasa.gov) — coronal mass ejections, trailing ~7 days (also passed through as the three most relevant recent eruptions, which the art draws as expanding arcs)
- [`DONKI/GST`](https://api.nasa.gov) — geomagnetic storms, trailing ~7 days

Some sources don't need a key at all, so `app.js` fetches them directly: [NASA's EPIC API](https://epic.gsfc.nasa.gov/) (Earth imagery) and [NOAA SWPC](https://www.swpc.noaa.gov/) (real-time solar wind speed and magnetic-field tilt). The browser never talks to `api.nasa.gov` itself — only `/api/nasa-data`, EPIC, and NOAA.

## The slides

Each slide holds for 15–18 seconds (a random time in that range) — except the art, which always holds the full 40 seconds — then the sign moves on to the next — and a camera detecting a new visitor (movement after a few seconds of stillness) advances it immediately, with a brief sideways motion blur (skipped if the device asks for reduced motion). The order: **APOD photo → EPIC Earth image → six Cosmic Meteorology slides → Algorithm Art → back to APOD.**

- **APOD** — full-bleed image or video, whichever picture NASA published today.
- **EPIC** — the most recent full-disk photo of Earth from the DSCOVR satellite.
- **Cosmic Meteorology (six slides)** — shown just before the art. Each slide is one large card in Title Case, with the live reading and an icon that matches that element of the art (all units and abbreviations are written out, e.g. "miles per hour", "nanotesla"): **geomagnetic activity** (the week's strongest storm out of 9, or "No Storms"; storms this week; solar events — and in the art, storms + solar events is exactly how many shooting stars there are), **solar wind** (speed in mph and its pace), **coronal mass ejections** (how many, how many arcs are shown, how many are heading for Earth), **aurora glow** (watch or quiet, and the field tilt, Bz), **solar flare strength** (strongest flare, flare count — shown in the art as the glowing core) and **asteroid tracker** (how many asteroids pass close today, shown in the art as the orbiting dots, and how many are potentially hazardous). A card or row is skipped if its data source isn't live, and a card with no live data has no slide.
- **Algorithm Art** — see below.

## How the data reads as motion (Algorithm Art)

- **Solar-flare intensity** (peak flare class × magnitude in the window) sets the atmospheric core's brightness and radius.
- **Geomagnetic intensity** (max Kp / 9) sets the shooting stars' size (tail length, stroke width, head size) and speed — calm conditions read as small, slow streaks; storm conditions read as long, fast, thick ones.
- **Solar wind speed** (live NOAA reading) sets how fast pale blue streaks flow outward from the glowing core — a faster wind visibly streams faster.
- **Coronal mass ejections** (the most relevant recent eruptions) each become a wide, soft arc that expands outward from the core, like a cloud thrown off the Sun. A faster eruption crosses the screen sooner, and one predicted to reach Earth is drawn in amber instead of violet.
- **Aurora watch** (the solar wind's magnetic field tilting south, Bz below −2 nT) hangs a green glow from the top of the sky; the further south the field, the stronger and deeper it gets. With the field northward there is no glow.
- **Storms this week + solar events** (flares + CMEs) is exactly how many shooting stars there are (capped at 60 so an extreme week stays readable). A quiet week with one flare has one shooting star.
- **Each tracked asteroid** becomes one orbiting body.
  - Diameter → body size
  - Velocity → orbital speed
  - Miss distance → orbital radius
- **Potentially hazardous asteroids**, and generally elevated conditions (an X-class flare or Kp ≥ 5), bring in a restrained amber tint — never a saturated warning color.

Motion is deliberately gentle so the piece is comfortable to look up at for a long time: the orbiting dots drift (one lap every one to five minutes), shooting stars and wind streaks move slowly, CME arcs take 30–90 seconds to cross, and the twinkle and aurora sway are slow and soft. Nothing flashes, and everything slows further under `prefers-reduced-motion`.

Contrast: every meaningful mark keeps at least 3:1 contrast against the background at its blended strength (WCAG 1.4.11) — the orbit lines, core, aurora, arcs and streaks hold their strength for most of their travel and only fade at the very end. The twinkling background stars and soft halos are decorative.

Displayed values ease toward the latest fetched numbers rather than snapping, so a data refresh never looks abrupt. The canvas keeps running continuously in the background even while a different screen is showing, so Algorithm Art is always mid-motion when the cycle reaches it.

## Camera motion

The sign asks for webcam access on load and uses simple frame differencing on a tiny (32×24) downscaled copy of the feed to detect movement. Frames are compared and discarded in the browser — nothing is recorded or sent anywhere. Motion detection runs at high sensitivity. Movement after about three seconds of stillness counts as a new visitor and advances to the next screen right away (and restarts the hold); continuous movement doesn't skip screens. Sudden whole-frame brightness changes (lights, auto-exposure) are ignored. If there's no camera or permission is denied, mouse/touch/keyboard activity counts as movement instead, and the timer still runs. For a kiosk, allow camera access for the site once in the browser's site settings so it never prompts.

## If NASA is unreachable

Every screen keeps running on whatever it last had (or a quiet neutral default on first load) — nothing blocks on the network or shows an error state. The only indicator is a single small dot in the bottom-right corner: dim gray when no source is live, soft teal when at least one is. There are no numeric error displays or panels.

## Files

- `index.html` — markup for the slides plus the canvas and status dot
- `style.css` — full-viewport layout, the Cosmic Meteorology card styles, the canvas/grain styling, and the cross-fade between screens
- `app.js` — fetches and renders APOD, EPIC and the solar wind; builds the Cosmic Meteorology cards; runs the Algorithm Art generative engine; and drives the timed slide cycle
- `api/nasa-data.js` — the Vercel serverless function that fetches and normalizes APOD, NEO, and DONKI data

No React, TypeScript, build tooling, or npm packages — plain HTML/CSS/JS, deployed as-is.

## Setup

Set `NASA_API_KEY` in the Vercel project's environment variables (Project Settings → Environment Variables) to your own key from [api.nasa.gov](https://api.nasa.gov). It's read only inside `api/nasa-data.js`; nothing in the repo needs to contain it.
