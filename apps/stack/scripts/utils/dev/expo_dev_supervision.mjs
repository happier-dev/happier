const DEFAULT_MAX_RESTART_ATTEMPTS = 3;
const DEFAULT_RESTART_BASE_DELAY_MS = 1_000;
const DEFAULT_RESTART_MAX_DELAY_MS = 30_000;
const MAX_RECENT_OUTPUT_LINES = 80;

const OOM_LINE_REGEX =
  /(?:fatal error: .*javascript heap out of memory|fatalprocessoutofmemory|reached heap limit|ineffective mark-compacts near heap limit)/i;

function parseBooleanOverride(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return null;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  return null;
}

function parseNonNegativeInteger(raw, fallback) {
  const value = String(raw ?? '').trim();
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function parsePositiveInteger(raw, fallback) {
  const value = String(raw ?? '').trim();
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function resolveExpoRestartPolicy({ env = process.env, stackMode = false } = {}) {
  const enabledOverride = parseBooleanOverride(env.HAPPIER_STACK_EXPO_SUPERVISE_RESTARTS);
  const enabled = enabledOverride ?? Boolean(stackMode || String(env.HAPPIER_STACK_TUI ?? '').trim() === '1');
  const maxAttempts = parseNonNegativeInteger(
    env.HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS,
    DEFAULT_MAX_RESTART_ATTEMPTS
  );
  const baseDelayMs = parsePositiveInteger(
    env.HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS,
    DEFAULT_RESTART_BASE_DELAY_MS
  );
  const maxDelayMs = parsePositiveInteger(
    env.HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS,
    DEFAULT_RESTART_MAX_DELAY_MS
  );

  return {
    enabled,
    maxAttempts,
    baseDelayMs,
    maxDelayMs: Math.max(baseDelayMs, maxDelayMs),
  };
}

export function createExpoCrashOutputTracker({ maxLines = MAX_RECENT_OUTPUT_LINES } = {}) {
  const recentLines = [];
  let sawHeapOutOfMemory = false;

  return {
    observeLine: ({ line }) => {
      const text = String(line ?? '');
      if (!text) return;
      recentLines.push(text);
      while (recentLines.length > maxLines) recentLines.shift();
      if (OOM_LINE_REGEX.test(text)) {
        sawHeapOutOfMemory = true;
      }
    },
    sawHeapOutOfMemory: () => sawHeapOutOfMemory,
    recentLines: () => [...recentLines],
  };
}

export function isIntentionalExpoTermination({ code, signal } = {}) {
  if (code === 0) return true;
  if (code === 130 || code === 143) return true;
  return signal === 'SIGINT' || signal === 'SIGTERM' || signal === 'SIGKILL';
}

export function describeExpoTermination({ code, signal, outputTracker } = {}) {
  if (outputTracker?.sawHeapOutOfMemory?.()) {
    return 'probable Node heap out-of-memory';
  }
  if (signal) return `signal ${signal}`;
  return `exit code ${code ?? 'null'}`;
}

export function computeExpoRestartDelayMs({ attempt, policy } = {}) {
  const n = Number(attempt);
  const safeAttempt = Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
  const baseDelayMs = parsePositiveInteger(policy?.baseDelayMs, DEFAULT_RESTART_BASE_DELAY_MS);
  const maxDelayMs = parsePositiveInteger(policy?.maxDelayMs, DEFAULT_RESTART_MAX_DELAY_MS);
  return Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, safeAttempt - 1)));
}
