import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_SERVER_MIGRATION_TIMEOUT_MS = 30 * 60_000;
const MAX_SERVER_MIGRATION_TIMEOUT_MS = 24 * 60 * 60_000;

function isCanonicalHappierHealthPayload(payload) {
  return payload?.service === 'happier-server' && payload?.status === 'ok';
}

function isServerStartupHealthPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (isCanonicalHappierHealthPayload(payload)) return true;
  return payload?.status === 'ok';
}

async function fetchHappierMonitoringEndpoint(baseUrl, endpoint) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 1500);
  try {
    const url = baseUrl.replace(/\/+$/, '') + endpoint;
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
      ready: res.ok && isServerStartupHealthPayload(json),
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
  return await fetchHappierMonitoringEndpoint(baseUrl, '/health');
}

export async function fetchHappierReadiness(baseUrl) {
  return await fetchHappierMonitoringEndpoint(baseUrl, '/ready');
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

export function resolveServerMigrationTimeoutMs({ env = process.env } = {}) {
  const configured = Number.parseInt(String(env?.HAPPIER_STACK_SERVER_MIGRATION_TIMEOUT_MS ?? '').trim(), 10);
  if (Number.isFinite(configured) && configured >= 1_000 && configured <= MAX_SERVER_MIGRATION_TIMEOUT_MS) {
    return configured;
  }
  // Large SQLite schema changes can legitimately exceed ordinary startup readiness.
  // Keep that lifetime finite by default while allowing operators to tune it for their database.
  return DEFAULT_SERVER_MIGRATION_TIMEOUT_MS;
}

export function createServerReadinessDeadline({
  readinessTimeoutMs,
  migrationTimeoutMs,
  nowImpl = Date.now,
} = {}) {
  const rawReadyMs = Number(readinessTimeoutMs);
  const rawMigrationMs = Number(migrationTimeoutMs);
  const readyMs = Number.isFinite(rawReadyMs) && rawReadyMs > 0 ? Math.trunc(rawReadyMs) : 60_000;
  const migrationMs = Number.isFinite(rawMigrationMs) && rawMigrationMs > 0
    ? Math.min(Math.trunc(rawMigrationMs), MAX_SERVER_MIGRATION_TIMEOUT_MS)
    : DEFAULT_SERVER_MIGRATION_TIMEOUT_MS;
  let phase = 'pending';
  let deadlineMs = null;
  let migrationStarted = false;
  let migrationCompleted = false;
  const now = () => {
    const value = Number(nowImpl?.());
    return Number.isFinite(value) ? value : Date.now();
  };

  const startReadiness = () => {
    if (deadlineMs === null) {
      phase = 'readiness';
      deadlineMs = now() + readyMs;
    }
    return deadlineMs;
  };

  const observeSignal = (signal) => {
    if (signal === 'migration_started' && !migrationStarted) {
      migrationStarted = true;
      phase = 'migration';
      deadlineMs = now() + migrationMs;
    } else if (signal === 'migration_completed' && migrationStarted && !migrationCompleted) {
      migrationCompleted = true;
      phase = 'readiness';
      deadlineMs = now() + readyMs;
    }
    return signal;
  };

  return {
    startReadiness,
    observeSignal,
    observeLine({ line } = {}) {
      let signal = null;
      try {
        signal = JSON.parse(String(line ?? ''))?.happierStackTransition ?? null;
      } catch {
        return null;
      }
      return observeSignal(signal);
    },
    getDeadlineMs() {
      return startReadiness();
    },
    getPhase() {
      return phase;
    },
    extendCurrentPhase() {
      deadlineMs = now() + (phase === 'migration' ? migrationMs : readyMs);
      return deadlineMs;
    },
    isExpired() {
      return now() >= startReadiness();
    },
  };
}

export async function waitForServerReady(url, {
  timeoutMs = 60_000,
  intervalMs = 300,
  childProcess = null,
  startupDeadline = null,
  continueWhileChildAlive = process.env.HAPPIER_STACK_TUI === '1',
  onTimeoutCheckpoint = ({ phase }) => {
    console.warn(`[stack] server ${phase} is still in progress at ${url}; continuing to wait (TUI is attended)`);
  },
} = {}) {
  const deadline = startupDeadline ?? createServerReadinessDeadline({
    readinessTimeoutMs: timeoutMs,
    migrationTimeoutMs: timeoutMs,
  });
  deadline.startReadiness();
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
    while (true) {
      if (earlyExitError) {
        throw earlyExitError;
      }
      if (deadline.isExpired()) {
        const childAlive = childProcess
          && childProcess.exitCode == null
          && childProcess.signalCode == null;
        if (!continueWhileChildAlive || !childAlive) break;
        onTimeoutCheckpoint?.({ phase: deadline.getPhase(), timeoutMs, url });
        deadline.extendCurrentPhase();
      }
      // Runtime-backed stacks and modern server builds expose startup readiness on /ready.
      // Promotion must not accept root-page liveness because the app shell can serve before DB readiness.
      // eslint-disable-next-line no-await-in-loop
      const readiness = await fetchHappierReadiness(url);
      if (earlyExitError) {
        throw earlyExitError;
      }
      if (readiness.ready) {
        return;
      }
      await delay(intervalMs);
    }
    if (earlyExitError) {
      throw earlyExitError;
    }
    if (deadline.getPhase() === 'migration') {
      throw new Error(`Server migration timed out before readiness at ${url}`);
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
