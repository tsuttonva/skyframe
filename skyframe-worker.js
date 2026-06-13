/**
 * SkyFrame Cloudflare Worker
 * Proxies ADS-B and flight data to bypass iOS Safari tracking prevention.
 * Deploy at: https://dash.cloudflare.com → Workers → Create Worker
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

export default {
  async fetch(request, env, ctx) {

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // ── GET /flights?lat=XX&lon=YY&dist=ZZ ──
    // Fetches live aircraft from adsb.lol
    if (path === '/flights' && request.method === 'GET') {
      const lat  = url.searchParams.get('lat');
      const lon  = url.searchParams.get('lon');
      const dist = url.searchParams.get('dist') || '150';

      if (!lat || !lon) {
        return json({ error: 'lat and lon required' }, 400);
      }

      // Try adsb.lol first
      try {
        const resp = await fetch(
          `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${dist}`,
          { headers: { 'User-Agent': 'SkyFrame/1.0' }, cf: { cacheTtl: 20 } }
        );
        if (resp.ok) {
          const data = await resp.json();
          return json({ source: 'adsb.lol', ...data });
        }
      } catch(e) {}

      // Fallback: adsb.one
      try {
        const resp = await fetch(
          `https://api.adsb.one/v2/point/${lat}/${lon}/${dist}`,
          { headers: { 'User-Agent': 'SkyFrame/1.0' }, cf: { cacheTtl: 20 } }
        );
        if (resp.ok) {
          const data = await resp.json();
          return json({ source: 'adsb.one', ...data });
        }
      } catch(e) {}

      // Fallback: OpenSky Network
      try {
        const margin = parseFloat(dist) * 1.852 / 111;
        const osk = `https://opensky-network.org/api/states/all` +
          `?lamin=${(parseFloat(lat)-margin).toFixed(4)}` +
          `&lomin=${(parseFloat(lon)-margin).toFixed(4)}` +
          `&lamax=${(parseFloat(lat)+margin).toFixed(4)}` +
          `&lomax=${(parseFloat(lon)+margin).toFixed(4)}`;
        const resp = await fetch(osk, {
          headers: { 'User-Agent': 'SkyFrame/1.0' },
          cf: { cacheTtl: 20 }
        });
        if (resp.ok) {
          const data = await resp.json();
          // Normalize to adsb.lol format
          const ac = (data.states || []).map(s => ({
            hex: s[0], flight: (s[1]||'').trim(), lat: s[6], lon: s[5],
            alt_baro: s[7] ? Math.round(s[7] * 3.28084) : null,
            gs: s[9] ? Math.round(s[9] * 1.94384) : null,
            track: s[10], baro_rate: s[11], squawk: s[14],
            gnd: s[8], cou: s[2],
          })).filter(a => a.lat && a.lon);
          return json({ source: 'opensky', ac });
        }
      } catch(e) {}

      return json({ error: 'All sources failed', ac: [] }, 503);
    }

    // ── GET /aircraft?icao=XXXXXX ──
    // Fetches aircraft type + registration
    if (path === '/aircraft' && request.method === 'GET') {
      const icao = url.searchParams.get('icao');
      if (!icao) return json({ error: 'icao required' }, 400);

      try {
        const resp = await fetch(`https://api.adsb.lol/v2/icao/${icao}`, {
          cf: { cacheTtl: 3600 } // cache aircraft info for 1hr
        });
        if (resp.ok) {
          const data = await resp.json();
          return json(data);
        }
      } catch(e) {}

      try {
        const resp = await fetch(`https://www.adsbdb.com/api/aircraft/${icao}`, {
          cf: { cacheTtl: 3600 }
        });
        if (resp.ok) {
          const data = await resp.json();
          return json(data);
        }
      } catch(e) {}

      return json({ error: 'Not found' }, 404);
    }

    // ── POST /route ──
    // Fetches flight route origin/dest
    if (path === '/route' && request.method === 'POST') {
      try {
        const body = await request.json();
        const resp = await fetch('https://api.adsb.lol/api/0/routeset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          cf: { cacheTtl: 300 }
        });
        if (resp.ok) {
          const data = await resp.json();
          return json(data);
        }
      } catch(e) {}
      return json({ error: 'Route lookup failed' }, 503);
    }

    // ── GET /health ──
    if (path === '/health') {
      return json({ status: 'ok', version: '1.0', ts: Date.now() });
    }

    return json({ error: 'Unknown endpoint', paths: ['/flights', '/aircraft', '/route', '/health'] }, 404);
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS_HEADERS,
  });
}
