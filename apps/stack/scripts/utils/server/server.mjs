import { setTimeout as delay } from 'node:timers/promises';

function isCanonicalHappierHealthPayload(payload) {
  return payload?.service === 'happier-server' && payload?.status === 'ok';
}

function isServerStartupReadyHealthPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (isCanonicalHappierHealthPayload(payload)) return true;
  return payload?.status === 'ok';
}

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
    return {
      ok: res.ok && isCanonicalHappierHealthPayload(json),
      ready: res.ok && isServerStartupReadyHealthPayload(json),
      status: res.status,
      json,
      text,
    };
  } catch {
    return { ok: false, ready: false, status: null, json: null, text: null };
  } finally {
    clearTimeout(t);
  }
}

export async function isHappierServerRunning(baseUrl) {
  const health = await fetchHappierHealth(baseUrl);
  return health.ok;
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

function formatServerReadyEarlyExit(url, code, signal) {
  const suffix = [
    code !== null && code !== undefined ? `code=${code}` : null,
    signal ? `signal=${signal}` : null,
  ].filter(Boolean).join(', ');
  return suffix
    ? `Server process exited before becoming ready at ${url} (${suffix})`
    : `Server process exited before becoming ready at ${url}`;
}

export function resolveServerReadyTimeoutMs({ serverComponentName = '', env = process.env } = {}) {
  const configured = Number.parseInt(String(env?.HAPPIER_STACK_SERVER_READY_TIMEOUT_MS ?? '').trim(), 10);
  if (Number.isFinite(configured) && configured >= 1_000) {
    return configured;
  }
  return serverComponentName === 'happier-server-light' ? 120_000 : 60_000;
}

export async function waitForServerReady(url, { timeoutMs = 60_000, intervalMs = 300, childProcess = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  let earlyExitError = null;
  const onExit = (code, signal) => {
    earlyExitError = new Error(formatServerReadyEarlyExit(url, code, signal));
  };

  if (childProcess && typeof childProcess.once === 'function') {
    if (childProcess.exitCode !== null && childProcess.exitCode !== undefined) {
      throw new Error(formatServerReadyEarlyExit(url, childProcess.exitCode, null));
    }
    childProcess.once('exit', onExit);
  }

  try {
    while (Date.now() < deadline) {
      if (earlyExitError) {
        throw earlyExitError;
      }
      // Runtime-backed stacks and modern server builds expose readiness on /health even when
      // the root route serves the app shell instead of the legacy welcome page.
      // Prefer that contract, but keep the older root-page probe as a fallback for source/dev flows.
      // eslint-disable-next-line no-await-in-loop
      const health = await fetchHappierHealth(url);
      if (health.ready) {
        return;
      }
      try {
        const res = await fetch(url, { method: 'GET' });
        const text = await res.text();
        if (res.ok && text.includes('Welcome to Happier Server!')) {
          return;
        }
      } catch {
        // ignore
      }
      await delay(intervalMs);
    }
    if (earlyExitError) {
      throw earlyExitError;
    }
    throw new Error(`Timed out waiting for server at ${url}`);
  } finally {
    if (childProcess && typeof childProcess.off === 'function') {
      childProcess.off('exit', onExit);
    } else if (childProcess && typeof childProcess.removeListener === 'function') {
      childProcess.removeListener('exit', onExit);
    }
  }
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
