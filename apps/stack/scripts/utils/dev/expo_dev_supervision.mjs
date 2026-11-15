import { channel } from 'node:diagnostics_channel';
import { getHeapStatistics } from 'node:v8';

const DEFAULT_MAX_RESTART_ATTEMPTS = 3;
const DEFAULT_RESTART_BASE_DELAY_MS = 1_000;
const DEFAULT_RESTART_MAX_DELAY_MS = 30_000;
const DEFAULT_RESTART_STABILITY_WINDOW_MS = 60_000;
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
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
  const stabilityWindowMs = parsePositiveInteger(
    env.HAPPIER_STACK_EXPO_RESTART_STABILITY_WINDOW_MS,
    DEFAULT_RESTART_STABILITY_WINDOW_MS
  );

  return {
    enabled,
    maxAttempts,
    baseDelayMs,
    maxDelayMs: Math.max(baseDelayMs, maxDelayMs),
    stabilityWindowMs,
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

export const EXPO_HEAP_RECYCLE_PREFIX = 'HSTACK_EXPO_QUIET_HEAP_RECYCLE ';

/** Metro's Plugin UI watcher prints this after it publishes a changed inventory. */
export const PLUGIN_UI_PUBLISHED_LINE = '[source-ui] phase=plugin-ui-published';

/** Retire superseded Plugin UI graphs after each publication a live Metro
 * reports (owner ruling 2026-11-15, growth fixes). Passes run one at a time on
 * the supervisor, never on Metro's own loop; a pass is a /proc census. */
export function createPluginUiRetirement({ reap, onError = () => {} }) {
  let chain = Promise.resolve();
  const request = () => {
    chain = chain.then(() => reap()).catch(onError);
    return chain;
  };
  return {
    request,
    observeLine(line) { if (line === PLUGIN_UI_PUBLISHED_LINE) void request(); },
    idle: () => chain,
  };
}

export function startExpoHeapGuard({
  readHeapStatistics = getHeapStatistics,
  heapLimitBytes = null,
  intervalMs = DEFAULT_RESTART_BASE_DELAY_MS,
  onRecycle,
} = {}) {
  const servers = new Set();
  let activeRequests = 0;
  let recycling = false;
  const check = () => {
    if (recycling || activeRequests > 0 || servers.size === 0) return;
    const heap = readHeapStatistics();
    const limit = heapLimitBytes ?? heap.heap_size_limit;
    // Temporary leak mitigation: reserve the last 10% of the configured heap
    // for completing current requests. Remove this guard when the leak is fixed.
    const thresholdBytes = Math.floor(limit * 0.9);
    if (!(limit > 0) || heap.used_heap_size < thresholdBytes) return;
    recycling = true;
    // At this synchronous point no HTTP request is in flight. Stop accepting
    // more before notifying the owning supervisor to replace this process.
    for (const server of servers) server.close();
    onRecycle?.({ usedHeapBytes: heap.used_heap_size, heapLimitBytes: limit, thresholdBytes });
  };
  const requests = channel('http.server.request.start');
  const onRequest = ({ server, response }) => {
    servers.add(server);
    activeRequests++;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      activeRequests--;
      response.off('finish', finish);
      response.off('close', finish);
      check();
    };
    response.once('finish', finish);
    response.once('close', finish);
  };
  requests.subscribe(onRequest);
  const timer = setInterval(check, intervalMs);
  timer.unref?.();
  return { close() { recycling = true; clearInterval(timer); requests.unsubscribe(onRequest); } };
}
