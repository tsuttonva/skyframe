# SkyFrame — Requirements Specification

**Document purpose:** This is a complete, build-ready requirements specification for SkyFrame, a live aircraft-tracking radar display. It is written so that a competent software developer or AI coding agent could reproduce an application functionally equivalent to the original without access to the original source code. It describes *what the system must do and why*, not a line-by-line reproduction. Where a specific value, threshold, or algorithm is important to the behavior, it is stated explicitly.

**What SkyFrame is, in one sentence:** A single-page web application that displays nearby aircraft on an air-traffic-control-style radar scope, centered on a user-chosen location, with audio/visual alerts when aircraft enter a configurable radius, special recognition of rare/military/legendary aircraft, and a self-contained demo mode — built to run essentially for free on static hosting plus a serverless proxy.

**Origin context (non-functional, for tone):** The original was built as a personal gift for an air-traffic-control student. It targets being visually striking, "rock solid" reliable, and delightful when something rare flies over. Keep that spirit: reliability and correctness over cleverness, and a few moments of genuine delight.

---

## 1. High-Level Architecture

The system has three deployable pieces. Keep them separate; do not collapse them into one server.

1. **Static frontend** — A single self-contained HTML file (HTML + CSS + JavaScript inline) plus one static JSON data file. Served from any static host (the original uses GitHub Pages). No build step, no framework required. Must run by opening the URL.

2. **Serverless proxy ("the Worker")** — A single serverless function (the original uses a Cloudflare Worker) that sits between the frontend and the upstream data providers. It exists to: bypass browser CORS restrictions, hide API keys, cache aggressively, enforce hard spending caps on the paid API, and tag military aircraft server-side. It has a small key-value store attached for counters and a cached military-aircraft database.

3. **Static county-name dataset** — A JSON file mapping US county FIPS codes to human-readable county names, fetched once by the frontend and cached.

**Critical architectural principle:** The frontend must never depend on the Worker being up. The Worker is the *preferred* data path, not a required one. If the Worker is unreachable, the app must transparently fall back to other data sources and continue working. This drove many design decisions below and must be preserved.

**Cost target:** The entire system must be operable within the free tiers of its services (static hosting, serverless function with generous free request allowance, free-tier flight-data APIs, free-tier transactional email). The only paid dependency is an optional flight-route API, which must be hard-capped so it can never generate a surprise bill. Steady-state cost target: approximately $0/month.

---

## 2. Core Display: The Radar Scope

### 2.1 Visual concept
A circular radar scope rendered on an HTML canvas, dark background, glowing green primary color, with the user's location fixed at the center. The aesthetic is "modern ATC scope": concentric range rings, a sweeping radar line that rotates continuously, crosshairs, and aircraft drawn as small directional icons with text data blocks.

### 2.2 Radar elements that must be present
- **Concentric range rings** (the original uses 3) with distance labels in nautical miles (e.g., "8 nm", "17 nm", "25 nm") scaled to the current radar radius.
- **A rotating sweep line** that advances a fixed amount each animation frame (continuous, smooth, never stops). It is decorative — it does NOT gate which aircraft are visible (all in-range aircraft are always drawn).
- **Crosshair lines** through the center.
- **A center dot** marking the user's location.
- **An inner "alert ring"** drawn as a dashed circle at the configurable alert radius (see §4). This ring must never be drawn larger than the radar scope itself; if the alert radius exceeds the radar radius, clamp it.
- **County outlines** (US) drawn when zoomed in (radar radius ≤ 75 nm). **State/country outlines** drawn at wider zoom. These come from public TopoJSON datasets (us-atlas counties, world-atlas countries) loaded from a CDN.

### 2.3 The animation loop vs. the data loop (important behavioral detail)
There are two independent cadences and they must not be conflated:
- **The render/animation loop** runs continuously via `requestAnimationFrame` (~60fps). It redraws the radar background, advances the sweep, and repaints aircraft at their *current stored* positions.
- **The data refresh loop** runs every **30 seconds**. It fetches fresh aircraft positions and replaces the stored positions.

**Consequence to preserve:** With real data, aircraft icons jump to new positions every 30 seconds; they do not glide between fetches. (A future enhancement — dead-reckoning interpolation using each aircraft's heading and speed to smoothly advance position between fetches — is explicitly a known backlog item, not current behavior. See §15.) Note that demo mode *does* move aircraft smoothly because its simulation recalculates positions every second; this asymmetry is expected.

### 2.4 Aircraft rendering
Each aircraft is drawn as:
- **A directional icon** rotated to its heading (`true_track`), shaped by aircraft category (see §6).
- **A data block** (small text label) next to the icon showing callsign, a flight-level/altitude figure, and speed, e.g. `SWA1156 / FL223→ 270kt`. Trend arrows (climbing/descending/level) may be shown.
- **Color coding** by state: normal (green), selected (blue), tracked (amber), military (gold), emergency (flashing red), plus special colors for rare aircraft (see §6).

### 2.5 Coordinate projection
Aircraft lat/lon are projected to canvas x/y using a simple equirectangular projection centered on the user's position, scaled so the radar radius maps to the scope edge. Longitude must be corrected by `cos(latitude)` to avoid east-west distortion. The exact transform:
- `latRange = RADIUS_KM / 111`
- `lonRange = RADIUS_KM / (111 * cos(myLat in radians))`
- `x = centerX + ((lon - myLon) / lonRange) * maxRadiusPixels`
- `y = centerY - ((lat - myLat) / latRange) * maxRadiusPixels`

---

## 3. Location Handling

### 3.1 Setting location
- The app is centered on a user location (lat/lon + a display label like "Bealeton, VA").
- A sensible default location is compiled in via a config block.
- The user can change location via:
  - **Browser geolocation** (the device's GPS / location services), and
  - **A manual location entry / search** path.
- On obtaining device coordinates, perform **reverse geocoding** (the original uses OpenStreetMap Nominatim) to derive a readable label (city/town/village/county + state). Strip prefixes like "City of", "Town of", "Village of", "Township of". Fall back to showing coordinates if no name resolves.
- Persist the chosen location (lat, lon, label) in `localStorage` so it survives reloads.

### 3.2 Behavior on location change
- Changing location must **immediately** clear the current aircraft list and enrichment cache, fire a fresh fetch right away, and reset the 30-second timer (do not make the user wait up to 30s for the new location's data).

### 3.3 Robustness
- Geolocation permission may be denied or unavailable; handle gracefully and fall back to manual entry / default.
- Do not block app startup on geolocation. The loading screen must not hang waiting for location (a real bug in development was the app freezing on "Acquiring location"; startup must be resilient to every failure path).

---

## 4. Configurable Radii and Header Controls

### 4.1 Two distinct radii
- **Radar radius** — the outer scope range. Adjustable **5 nm to 300 nm**. Default 50 nm. Persisted.
- **Alert radius** (a.k.a. chime radius) — the inner ring; aircraft crossing inside it trigger alerts. Adjustable **1 nm to 20 nm**. Default 15 nm. Persisted.

### 4.2 Radar radius stepping
The +/- controls must use **variable step sizes** so the control is usable across the whole range:
- Below 25 nm: step by **5 nm**.
- 25–100 nm: step by **25 nm**.
- Above 100 nm: step by **50 nm**.

### 4.3 Radius-change behavior (performance-sensitive)
- **Shrinking the radar radius**: re-filter the already-held aircraft list client-side instantly (no network fetch). Reset the refresh timer.
- **Expanding the radar radius**: requires more data, so reset the source preference and fire an immediate fetch, then resume the timer.
- **If shrinking the radar radius below the current alert radius**, automatically clamp the alert radius down to match (the alert ring can never exceed the scope).

### 4.4 Header stats (live, derived from current aircraft set)
The header displays, at minimum:
- **Overhead** — count of aircraft currently in range.
- **Highest ft** — highest altitude among current aircraft.
- **Fastest kts** — fastest groundspeed among current aircraft.
- **Radar radius** control (with +/-).
- **Alert radius** control (with +/-).
- **Location** label (tap to change).
- **A flight/tail search box** (see §8).
- **A clock** showing local time and UTC ("Zulu") time.

The header must be horizontally scrollable / responsive so it works on a phone screen.

---

## 5. Data Sources, Fetching, and Failover

### 5.1 Aircraft position data
Primary upstream source is a free ADS-B aggregator (the original uses **adsb.lol**, with **adsb.one** and **OpenSky Network** as secondary/tertiary). ADS-B is the broadcast system by which aircraft transmit their identity, position, altitude, velocity, and heading.

### 5.2 The failover chain (must be preserved in order)
On each refresh, attempt sources in priority order until one returns valid data:
1. **The Worker** (`/flights` endpoint) — preferred; it adds military tagging and caching. 20-second timeout.
2. **Direct adsb.lol** — bypasses the Worker if it is struggling. 10-second timeout.
3. **OpenSky Network** — last-resort public source. 10-second timeout.

Additional rules:
- **Source stickiness:** once a source succeeds, prefer it on subsequent refreshes rather than always restarting from the top.
- **Worker fail tracking:** count consecutive Worker failures; after **2** consecutive failures, deprioritize the Worker temporarily so the app stops waiting on it.
- **Suspicious-empty guard:** if a source returns 0 aircraft but the previous good result had many (>20), treat the empty result as suspect and try the next source instead of believing it.
- **Stale-data hold:** if all sources fail but we have a previous good result, keep displaying it (clearly indicating staleness) rather than going blank.

### 5.3 First-load reliability (must-have)
A cold start can transiently fail (the Worker waking up, slow DNS, etc.). To avoid dropping straight into demo mode on a brief blip:
- If the entire source chain fails, **wait ~2 seconds and retry the whole chain once** before concluding real data is unavailable.
- Only after that second failure (and with no stale data to show) does the app enter **fallback demo mode** (see §9).

### 5.4 Aircraft data fields consumed
At minimum, normalize each aircraft to: `icao24` (hex id), `callsign`, `lat`, `lon`, `baro_alt` (barometric altitude ft), `velocity` (knots), `true_track` (heading degrees), `vert_rate` (climb/descent), `squawk` (transponder code), `aircraft_type` (ICAO type code when available), `is_military` (boolean, see §7), and a computed `dist_km` from the user. Different sources have different shapes; each source needs its own parser that produces this normalized object.

### 5.5 Display contract for the aircraft list
The "nearby flights" list and the radar must show **only aircraft within the current radar radius**, sorted **nearest-to-farthest**. This filtering+sorting is part of the data contract and must be applied identically for real data and demo data. (A real bug was demo data bypassing this; do not repeat it.)

---

## 6. Aircraft Categories and Icons

Aircraft are classified by `getAircraftCategory()` into a category that determines icon shape and color. Classification is by ICAO type code (and, for a few special cases, callsign or hex id). Categories:

| Category | How detected | Icon character | Color |
|---|---|---|---|
| **balloon** | callsign starts with `HBAL` OR type `BALL` | round envelope + basket, no heading rotation | violet |
| **u2** (legendary) | type `U2`/`TU2` | long thin glider wings | pulsing gold→white |
| **af1** (legendary) | type `VC25` OR hex `adf9d2`/`adf9d7` | 747 silhouette with 4 engine pods | presidential cyan |
| **b52** (legendary) | type `B52`/`B52H` | swept wings, 8 engine marks | burnt orange |
| **awacs** (legendary) | type `E3`/`E3B`/`E3C`/`E3CF`/`E3TF` | jet body + rotodome disc | bright green |
| **helo** | type starts with `H` or matches common helo prefixes (EC, S76, S92, R22, R44, AS3, AW1, BK1, CH4, CH5, UH6) | helicopter shape | normal |
| **heavy** | widebody prefixes (B74, B77, B78, B76, A38, A34, A35, A33, A30, IL7, AN1, MD1) | large wings + engine pods | normal |
| **ga** | small-piston prefixes (Cessna C1xx/C2xx, Piper PA-series, Cirrus SR, Beech BE3/4/5/6, etc.) | small single | normal |
| **turbo** | regional turboprop prefixes (AT4, AT7, DH8, DHC, SF3, SB2, L41, BE19/20, PC1, JS3/4) | turboprop shape | normal |
| **jet** | default fallback | generic jet | normal |

**Detection rule for special aircraft must avoid false positives.** Use only verifiable signals (exact type codes, known tail/hex numbers, dedicated callsign prefixes). Do NOT infer "rare aircraft" from altitude or speed alone (a U-2 and a balloon both fly very high; do not guess). This was a firm design principle.

**ICAO type → friendly name lookup:** Maintain an embedded table mapping ICAO type codes to readable names (e.g., `A321` → "Airbus A321", `P28A` → "Piper PA-28 Cherokee/Archer", `EPIC` → "Epic E1000"). The table should cover common airliners, business jets, general-aviation singles (Piper/Cessna/Cirrus/Beech/Mooney/Van's RV), turboprops, and helicopters. When a code is not in the table, show the bare code rather than nothing, and allow the backend enrichment (§11) to backfill a better name.

---

## 7. Military Detection

- Military aircraft get a distinct gold icon, a "MIL" badge in the list, and special audio (see §8).
- **Primary detection is server-side in the Worker** using a database of known military ICAO hex codes (the original sources this from the Mictronics `tar1090-db` project — roughly 8,000+ hex codes). The Worker tags each aircraft with `is_military` before returning it.
- **Client-side fallback:** if the Worker's military database is unavailable, the client may fall back to detecting military by callsign prefix patterns. The app must still function (untagged is acceptable; a wrong "everything is military" is not).
- The military hex database is stored in the Worker's KV store and refreshed on a schedule (weekly), loaded into Worker memory on cold start in the background so it never blocks a flight response.

---

## 8. Alerts: Audio and Visual

### 8.1 Trigger
When an aircraft **first** crosses inside the **alert radius**, fire an alert. Track which aircraft (by `icao24`) have already alerted this session so each alerts only once; expire that record when the aircraft leaves the radius (with a small hysteresis margin, ~1.2x, to avoid flapping at the boundary).

### 8.2 Audio components
- **A chime** — a short two-tone beep generated with the Web Audio API (oscillators), volume configurable.
- **A spoken announcement** (text-to-speech via the Web Speech API) describing the aircraft: callsign (or "military aircraft"), type, distance, and altitude, e.g. "Delta 18-87, Airbus A321, 8 miles, 35,000 feet."
- **Military aircraft** additionally play a fun audio easter-egg (`military.mp3`, with a spoken fallback) **followed by** the normal informative announcement. The easter egg alone is not enough — it must always be followed by the actual identifying info so the listener knows what flew over.
- **Rare/legendary aircraft** get escalated treatment (see §8.5).

### 8.3 Critical audio reliability requirements (these were hard-won bug fixes — do not regress)
- **AudioContext must be created/resumed inside a user gesture** and **the resume must be awaited** before scheduling any sound. iOS suspends the AudioContext aggressively (screen lock, backgrounding, brief inactivity); scheduling a beep on a not-yet-resumed context silently produces nothing or only partial sound. `getAudioCtx()` must be async and `await context.resume()` when the context is suspended, and callers must await it. (Symptom of the bug: "sometimes beeps twice, often beeps not at all.")
- **Web Speech must be "unlocked" by a user gesture** and **re-unlocked when the page returns to foreground.** Do NOT simply set a "not ready" flag on visibility change and wait for the next click — an alert can fire before any click and the spoken line will silently die in the queue (symptom: "beep beep with no words"). On `visibilitychange` to visible, proactively re-arm speech immediately (speak a near-silent priming utterance), and resume the AudioContext.
- **Speech is queued and spoken one utterance at a time** (cancel-then-speak races on iOS cause dropped speech). Maintain a small queue with a "busy" flag; drain it as each utterance ends.
- **The very first alert on a totally fresh page load, before any user interaction, may be silent** — this is an unavoidable browser autoplay restriction, not a bug. After the first interaction, audio must be reliable.
- **The hardware mute/ringer switch:** on iOS, Web Audio (oscillator) sound is suppressed when the ringer switch is set to silent, while HTML5 `<audio>` element playback is not. This is a documented WebKit behavior. Decide and document intended behavior. (The original treats this as acceptable; a known workaround is keeping a silent looping `<audio>` element playing to route Web Audio through the media channel. Optional.)

### 8.4 Visual alert: the alert toast
When any alert fires, show a brief on-screen toast (bottom-center of the radar) naming what triggered it: the identity/type, distance, and altitude. It must **linger ~5 seconds and fade**, because in motion (especially demo mode) the triggering aircraft may have already left the alert ring by the time the user looks — the toast lets them see what caused the alert after the fact. Position it so it never overlaps the demo banner (top) or the alert ring (center).

### 8.5 Legendary / rare aircraft escalation
For the "legendary" tier (U-2, Air Force One, B-52, AWACS) and for balloons, the alert fires **regardless of alert radius** (these are rare enough to always be worth surfacing). Each legendary aircraft gets:
- Its distinct icon and color (see §6).
- A **pulsing glow ring** around the icon.
- **Multiple chimes** (count scaled to prestige — e.g., U-2 gets 3).
- **A screen-shake animation** on the whole page (a CSS keyframe shake; intensity scaled to prestige). The U-2 gets the strongest shake — the original's stated intent was "shake the foundation of the house."
- **A dramatic spoken line** unique to the type (e.g., U-2: "Lockheed U-2. Dragon Lady. Altitude … miles out."; AF1: "VC-25. The President's aircraft. Air Force One."; B-52: "B-52 Stratofortress. Still flying after 70 years."; AWACS: "E-3 Sentry AWACS. Eyes in the sky.").
- A toast with a ★ marker and the identity/distance/altitude.

**Note on what is detectable:** Some "holy grail" aircraft never broadcast ADS-B and therefore can never trigger (B-2 stealth bomber, F-22/F-35 in normal ops, the retired SR-71). Do not build detection that can never fire. The legendary tier above is limited to aircraft that genuinely do appear on ADS-B.

### 8.6 Emergency squawks
Transponder squawk codes `7700` (general emergency), `7600` (radio failure), `7500` (hijack) must be detected and surfaced distinctly: the icon flashes red, the data block is styled as an alert, a rapid chime fires, and a spoken warning announces the condition, squawk, callsign, and distance. Track currently-flashing emergencies so the alert fires on transition into the state, not every frame.

---

## 9. Demo Mode (two distinct modes, one engine)

Demo mode exists both as a graceful failure state and as an intentional showcase. **Both render through the same pipeline as real data** (same filtering, sorting, icons, alerts) but differ in trigger, content, and exit behavior. A bold, **pulsing "DEMO MODE" banner** must be displayed across the top of the radar whenever any demo mode is active, so demo data can never be mistaken for real traffic.

### 9.1 Fallback demo (automatic, on data failure)
- Entered only after the full source chain fails twice (per §5.3) **and** there is no stale real data to show.
- Content is **deliberately boring: ambient civilian traffic only.** No military, no balloons, no legendary aircraft, no emergency squawks, no special chimes. (Rationale, stated firmly by the original author: if the app silently fell back to demo on someone's desk and then announced "an AWACS is overhead," it would be a thrilling lie. The rare/exciting moments must only ever happen on real data or on an intentionally-invoked showcase — never as a side effect of a network hiccup.)
- Banner text: **"DEMO MODE — Reconnecting…"**
- While in fallback demo, **keep retrying real data quietly in the background every ~4 seconds.** The instant a real fetch succeeds, **silently** swap back to live data with no user action. Provide simple ambient motion so the screen looks alive (it is effectively a fancy loading state).

### 9.2 Showcase demo (manual toggle)
- Triggered by a **DEMO button**. Real data fetching is **fully paused** while active.
- Runs a **randomized 3–5 minute "show"** with a choreographed-but-varied timeline of events so it is never the same twice:
  - Always at least one **military transit** crossing the scope.
  - ~60% chance of a second military transit later.
  - ~50% chance of a **balloon** drifting through.
  - ~35% chance of **exactly one** legendary aircraft (randomly U-2 / AF1 / B-52 / AWACS — never more than one per show; keep them special).
  - ~25% chance of one transient **emergency squawk** that appears and resolves after ~18 seconds (mutating an existing ambient flight, then clearing).
- Banner text: **"DEMO MODE"** (no "reconnecting" language — the user chose this).
- Exiting (tapping DEMO again) **immediately resumes real data** with a fresh fetch.

### 9.3 Demo simulation engine
- Ambient traffic is a rotating cast of ~10–25 aircraft with realistic callsigns (UAL, DAL, AAL, SWA, JBU, etc.), realistic altitudes/speeds/type codes.
- Each demo aircraft spawns just outside the scope edge and is given a **straight-line heading roughly across the scope** so motion looks natural (entering and exiting rather than popping in/out or orbiting).
- A **1 Hz simulation tick** advances each aircraft along its heading by speed-derived lat/lon deltas, recomputes distance, despawns aircraft well past the far edge (~1.6× radius), and replenishes ambient traffic to keep the scene populated. This per-second movement is why demo aircraft glide smoothly.
- The demo loop owns rendering while active; the normal 30s refresh timer must be cleared on entry and correctly restored on exit. Guard all the timer interactions (init, refresh, radius change, location change) so the two loops never run simultaneously or fight over state.
- Demo aircraft hex ids are randomized; AF1 in the showcase uses the real AF1 hex so it classifies correctly.

---

## 10. The Worker (Serverless Proxy) — Detailed Requirements

A single serverless function exposing these HTTP endpoints:

- **`GET /flights?lat=&lon=&dist=`** — Fetch aircraft near a point from the upstream ADS-B source, tag each with `is_military`, and return them. Cache the response in memory keyed by rounded lat/lon/dist for **25 seconds** to avoid hammering the upstream under load.
- **`GET /aircraft?icao=`** — Look up enrichment data (type, registration, description) for one aircraft. Cache **24 hours**.
- **`POST /route`** — Look up a flight's origin/destination route (uses the paid route API, see §11). Cache per callsign **1 hour**.
- **`GET /health`** — Return status JSON: version, timestamp, paid-API usage count and limit and percentage, and military-DB size and last-updated time. (This endpoint is the operational heartbeat — used to confirm deploys and diagnose issues. It must exist.)
- **`GET /usage`** — Return paid-API usage/limit/remaining and a status (OK / WARNING / LIMIT_REACHED).
- **`GET /refresh-mil-db`** — Manually trigger a rebuild of the military hex database.
- **A scheduled (cron) trigger** — Weekly, rebuild the military hex database from the upstream source into KV.

**Worker bindings / environment:**
- A **KV namespace** (`SKYFRAME_KV`) for: monthly paid-API usage counter, the military hex set, and its last-updated timestamp.
- Secrets/vars: the paid route API key, the transactional-email API key, and an alert email address.

**Military DB handling:** Load the hex set from KV into memory on first request; re-check KV hourly. On cold start, if not yet in memory, kick off a background load and serve the current request without military tagging rather than blocking (the next refresh will normalize). Store the set in KV with an ~8-day expiry so a missed weekly refresh doesn't instantly empty it.

**CORS:** The Worker must return permissive CORS headers so the static frontend (different origin) can call it from the browser.

---

## 11. Flight Enrichment and Cost Control

### 11.1 Enrichment
When an aircraft is selected, show a detail card with: callsign, **origin and destination** (FROM/TO, airport code + name + city), **aircraft type** (from the local table immediately, backfilled by the backend with a richer name), registration, altitude, speed, heading, vertical rate, squawk, and a flight-status note (only flag Delayed/Diverted/Cancelled/Landed/Return-to-Gate; "Scheduled"/normal is not noteworthy).

- The aircraft **type** should display immediately from the embedded ICAO table so the card is never blank while waiting on the network.
- **Balloons and legendary aircraft skip the route lookup** (they have no meaningful commercial route); show appropriate flavor text instead (e.g., balloon: "No fixed route / Drifting with wind"; AF1: "Joint Base Andrews / As directed").

### 11.2 Route data and the paid API (hard cost cap — must-have)
Origin/destination comes from a paid route API (the original uses FlightAware AeroAPI). It must be wrapped in **four layers of cost protection**:
1. **In-memory per-callsign cache** (~1 hour) so the same flight is never looked up repeatedly.
2. **A hard monthly call cap** (the original caps at **800 calls/month**, ~20% under the paid tier's billing threshold) enforced via a KV counter. When the cap is hit, **stop calling the paid API** and fall back to free route data.
3. **Graceful fallback** to a free routeset source when the cap is reached or the paid API errors — never crash, never show empty.
4. **Email alerts** (via a free transactional-email service, e.g. Resend) at **75%** and **100%** of the monthly cap, so the operator gets early warning.

This four-layer scheme is a hard requirement: the system must be structurally incapable of running up a surprise bill.

---

## 12. County / Region Identification

- When zoomed in (radar radius ≤ 75 nm), draw US **county outlines**; clicking empty radar space identifies the county under the click via point-in-polygon against the county TopoJSON, highlighting it (cyan fill/outline) and showing its name.
- **County names must come from an authoritative static dataset**, not be hand-coded. The original ships a `fips.json` mapping all ~3,143 US county FIPS codes to "County Name, ST" strings, fetched once and cached in `localStorage` (~90 days). (Hand-coding county names from memory produced repeated, embarrassing errors — e.g., labeling FIPS 51137 as "Lee, VA" when it is "Orange, VA." Use a complete authoritative table. If a live authoritative API is reachable at build time, generating the file from it is preferable to typing it.)
- The county-name label must render in a **fixed, always-on-screen position** (e.g., a pill at the bottom-center of the scope), not at the polygon centroid — centroid placement clips off-screen for partially-visible counties.
- Rounded-rectangle label backgrounds must be drawn with a **manual path helper** (moveTo/lineTo/arcTo), not `ctx.roundRect()`, for old-browser compatibility (see §13).

---

## 13. Browser Compatibility

- The app must run on **old iOS Safari (iOS 12.5.x)** in addition to current browsers. This is a hard constraint (a target device is an old iPad capped at iOS 12.5.8).
- Therefore: **do NOT use JavaScript syntax newer than ES2019.** Specifically, **no optional chaining (`?.`) and no nullish coalescing (`??`)** anywhere — Safari 12 throws a *syntax* error on encountering them, which aborts the entire script and the app silently fails to load. Use `&&`-guarded property access instead.
- **Do not use Canvas `ctx.roundRect()`** (too new); draw rounded rectangles manually.
- Preserve the `webkitAudioContext` fallback for AudioContext creation.
- **Recommended practice:** before shipping any change, run the script through a parser (e.g., Node's `new Function(scriptText)`) to catch syntax errors. Two separate production-breaking incidents were caused by a single bad token (an unescaped apostrophe inside a single-quoted string, and an optional-chaining operator). A pre-ship syntax check is cheap insurance and is expected.
- Be aware: the Web Speech API and AudioContext have genuine *capability* limits on old iOS that no code change fixes; degraded audio there is an OS ceiling, not necessarily a bug.

---

## 14. Persistence, Settings, and Misc UI

- Persist in `localStorage`: location (lat/lon/label), radar radius, alert radius, theme choice, the county-name dataset (with expiry), and the FIPS name cache.
- **Themes:** at least a primary "modern" green ATC theme. (The original also has a partially-implemented amber "retro" Solari-board theme that the author considered unsatisfying; a retro theme is optional and, if attempted, should be designed deliberately rather than bolted on.)
- **Footer controls** (at minimum): chime on/off toggle, alert-radius indicator, a **REFRESH** button (force an immediate data fetch + timer reset; ignored during showcase demo), the **DEMO** toggle, a theme toggle, and a **TEST** audio button (plays the chime + a sample spoken line; also serves to unlock audio).
- **Version string** must be displayed both in the header and **on the loading screen** (so a deploy can be confirmed at a glance before the app finishes loading — directly useful when verifying a fix shipped).
- **A "nearby flights" side list** showing each in-range aircraft (callsign, altitude, speed, heading, type, distance), sorted nearest-first, tappable to select/track.
- **Flight tracking / search:** a header search box to find a specific callsign/tail and lock the scope's attention to it (highlight + track), with a clear/untrack control.

---

## 15. Known Backlog (not yet built — include if scope allows)

These are explicitly *future* items, listed so a rebuilder knows they are intended directions, not current behavior:
1. **Dead-reckoning interpolation** — smoothly advance real aircraft positions between 30s fetches using heading + speed, reconciling to the authoritative position on each new fetch (so real traffic glides like demo traffic does).
2. **Pinch-to-zoom / pan** the radar (establish a rock-solid non-pinch baseline first).
3. **Bluetooth ESP32 LED hardware** companion (physical taxiway lights) — out of scope for the web app itself.
4. Display of additional ADS-B fields (autopilot/nav modes, selected altitude).
5. Fading icons for stale position reports.
6. A dedicated kiosk build (e.g., Raspberry Pi) — though a repurposed tablet is the pragmatic choice.

---

## 16. Non-Functional Requirements / Acceptance Criteria

A rebuild is acceptable if it satisfies all of the following:

1. **Loads and runs from a static URL** with no build step, on both a current desktop browser and old iOS Safari (12.5.x), without a blank/frozen screen.
2. **Displays real nearby aircraft** on a centered radar scope, refreshing every 30 seconds, projected correctly, sorted nearest-first, filtered to the radar radius.
3. **Survives the Worker being down** by failing over to direct sources, and survives total data loss by entering a clearly-labeled fallback demo that auto-recovers to live data when it returns.
4. **Never drops to demo on a single transient blip** (retries the chain once first).
5. **Alerts** fire once per aircraft on entering the alert radius, with a reliable chime and spoken identification, plus a lingering visual toast; reliability holds across screen lock / tab switching on mobile.
6. **Special aircraft** (military, balloons, U-2/AF1/B-52/AWACS, emergency squawks) are detected only by verifiable signals and given their distinct icons/colors/sounds/escalations; the legendary tier never triggers from a network hiccup.
7. **Showcase demo** runs a varied 3–5 minute show on demand, fully pausing real data and cleanly resuming on exit; fallback demo stays boring.
8. **County identification** works from an authoritative dataset with on-screen-safe labels.
9. **The paid route API can never exceed its monthly cap**, with email warnings at 75%/100% and graceful free fallback.
10. **The `/health` endpoint** reports accurate version, usage, and military-DB status.
11. Radii are adjustable within the specified ranges with sensible stepping, persisted across reloads, with the alert ring clamped within the scope.
12. **No ES2020+ syntax** anywhere in the frontend; script passes a syntax check before ship.

---

## 17. Suggested Build Order

1. Static shell: canvas radar, range rings, sweep, center, projection, with hardcoded fake aircraft.
2. Real data from one direct source (no Worker yet); 30s refresh; nearby list; selection.
3. Location handling (default + geolocation + reverse geocode + persistence).
4. Configurable radii + header stats + persistence.
5. The Worker: `/flights` proxy + `/health`; point the frontend at it with the direct source as fallback; build the full failover chain + first-load retry.
6. Aircraft categories, icons, the ICAO type table, and the detail card.
7. Military detection (Worker hex DB + KV + weekly cron) and the gold treatment.
8. Alerts: chime + speech + queue + unlock/visibility handling + toast (get the audio reliability right here — it is the hardest part).
9. Special aircraft: balloons, the legendary tier, emergency squawks.
10. Enrichment + the paid route API behind the four-layer cost cap + email alerts.
11. County dataset + click-to-identify.
12. The two-mode demo engine.
13. Old-Safari compatibility pass + pre-ship syntax check; cross-device testing.

---

*End of specification.*
