import { setTimeout as delay } from 'node:timers/promises';

export function getServerComponentName({ kv } = {}) {
  const fromArgRaw = kv?.get('--server')?.trim() ? kv.get('--server').trim() : '';
  const fromEnvRaw = process.env.HAPPIER_STACK_SERVER_COMPONENT?.trim() ? process.env.HAPPIER_STACK_SERVER_COMPONENT.trim() : '';
  const raw = fromArgRaw || fromEnvRaw || 'happier-server-light';
  const v = raw.toLowerCase();
  if (v === 'light' || v === 'server-light' || v === 'happier-server-light' || v === 'happy-server-light') {
    return 'happier-server-light';
  }
  if (v === 'server' || v === 'full' || v === 'happier-server' || v === 'happy-server') {
    return 'happier-server';
  }
  if (v === 'both') {
    return 'both';
  }
  // Allow explicit component dir names (advanced).
  return raw;
}

export async function fetchHappierHealth(baseUrl) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 1500);
  try {
    const url = baseUrl.replace(/\/+$/, '') + '/health';
    const res = await fetch(url, { method: 'GET', signal: ctl.signal });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, text };
  } catch {
    return { ok: false, status: null, json: null, text: null };
  } finally {
    clearTimeout(t);
  }
}

export async function isHappierServerRunning(baseUrl) {
  const health = await fetchHappierHealth(baseUrl);
  if (!health.ok) return false;
  // Both happier-server and happier-server-light use `service: 'happier-server'` today.
  // Treat any ok health response as "running" to avoid duplicate spawns.
  const svc = typeof health.json?.service === 'string' ? health.json.service : '';
  const status = typeof health.json?.status === 'string' ? health.json.status : '';
  if (svc && svc !== 'happier-server') {
    return false;
  }
  if (status && status !== 'ok') {
    return false;
  }
  return true;
}

export async function waitForHappierHealthOk(baseUrl, { timeoutMs = 60_000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const health = await fetchHappierHealth(baseUrl);
    if (health.ok) return true;
    // eslint-disable-next-line no-await-in-loop
    await delay(intervalMs);
  }
  return false;
}

export async function waitForServerReady(url) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' });
      const text = await res.text();
      if (res.ok && text.includes('Welcome to Happier Server!')) {
        return;
      }
    } catch {
      // ignore
    }
    await delay(300);
  }
  throw new Error(`Timed out waiting for server at ${url}`);
}

// Used for UI readiness checks (Expo / gateway / server). Treat any HTTP response as "up".
export async function waitForHttpOk(url, { timeoutMs = 15_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), Math.min(2500, Math.max(250, intervalMs)));
      try {
        const res = await fetch(url, { method: 'GET', signal: ctl.signal });
        if (res.status >= 100 && res.status < 600) {
          return;
        }
      } finally {
        clearTimeout(t);
      }
    } catch {
      // ignore
    }
    // eslint-disable-next-line no-await-in-loop
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for HTTP response from ${url} after ${timeoutMs}ms`);
}
