function parsePositiveMs(raw, fallback) {
  const n = Number(String(raw ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function computeExponentialBackoffMs({ attempt, baseMs, maxMs }) {
  const a = Number(attempt);
  const base = Number(baseMs);
  const max = Number(maxMs);
  if (!Number.isFinite(a) || a <= 0) return max > 0 ? max : 0;
  if (!Number.isFinite(base) || base <= 0) return max > 0 ? max : 0;
  const factor = 2 ** Math.max(0, Math.min(30, a - 1));
  const next = base * factor;
  if (Number.isFinite(max) && max > 0) return Math.min(next, max);
  return next;
}

/**
 * Service-mode daemon autostart loop:
 * - Polls for credentials (to avoid crash loops when auth is missing).
 * - Starts the daemon once credentials appear.
 * - If daemon start fails, retries a small bounded number of times per credential fingerprint,
 *   with exponential backoff, then waits for credentials to change.
 *
 * This is intentionally conservative: repeated daemon start attempts can be noisy (daemon prints
 * auth diagnostics). When the credentials are invalid, the correct fix is usually "re-login",
 * not "keep retrying".
 */
export function createServiceDaemonAutostarter({
  enabled,
  isShuttingDown,
  isServerReady,
  pollMs,
  maxAttemptsPerCredentials,
  retryBaseMs,
  retryMaxMs,
  nowMs,
  schedule,
  cancel,
  getCredentialFingerprint,
  isDaemonRunning,
  startDaemon,
  logger = console,
} = {}) {
  const pollIntervalMs = parsePositiveMs(pollMs, 5_000);
  const maxAttempts = Math.max(1, Number(maxAttemptsPerCredentials) || 2);
  const retryBase = parsePositiveMs(retryBaseMs, 1_000);
  const retryMax = parsePositiveMs(retryMaxMs, 10 * 60_000);
  const clock = typeof nowMs === 'function' ? nowMs : () => Date.now();
  const scheduleImpl = typeof schedule === 'function' ? schedule : (fn, delay) => setTimeout(fn, delay);
  const cancelImpl = typeof cancel === 'function' ? cancel : (id) => clearTimeout(id);

  const isDown = typeof isShuttingDown === 'function' ? isShuttingDown : () => false;
  const serverReady = typeof isServerReady === 'function' ? isServerReady : async () => true;
  const creds = typeof getCredentialFingerprint === 'function' ? getCredentialFingerprint : async () => null;
  const daemonRunning = typeof isDaemonRunning === 'function' ? isDaemonRunning : () => false;
  const start = typeof startDaemon === 'function' ? startDaemon : async () => {};

  let running = false;
  let timerId = null;
  let lastFingerprint = null;
  let attemptsForFingerprint = 0;
  let inFlight = false;

  const stop = () => {
    running = false;
    inFlight = false;
    if (timerId != null) {
      try {
        cancelImpl(timerId);
      } catch {
        // ignore
      }
      timerId = null;
    }
  };

  const scheduleNext = (delayMs) => {
    if (!running) return;
    if (timerId != null) {
      try {
        cancelImpl(timerId);
      } catch {
        // ignore
      }
    }
    timerId = scheduleImpl(tick, Math.max(0, Number(delayMs) || 0));
  };

  const tick = async () => {
    if (!running) return;
    if (isDown()) return stop();
    if (daemonRunning()) return stop();
    if (inFlight) return;

    inFlight = true;
    try {
      const ready = await serverReady();
      if (!ready) {
        scheduleNext(pollIntervalMs);
        return;
      }

      const fingerprint = (await creds()) ?? null;
      if (!fingerprint) {
        lastFingerprint = null;
        attemptsForFingerprint = 0;
        scheduleNext(pollIntervalMs);
        return;
      }

      const changed = fingerprint !== lastFingerprint;
      if (changed) {
        lastFingerprint = fingerprint;
        attemptsForFingerprint = 0;
      }

      if (attemptsForFingerprint >= maxAttempts) {
        scheduleNext(pollIntervalMs);
        return;
      }

      try {
        attemptsForFingerprint += 1;
        await start();
        stop();
      } catch (e) {
        const delayMs = computeExponentialBackoffMs({
          attempt: attemptsForFingerprint,
          baseMs: retryBase,
          maxMs: retryMax,
        });
        if (attemptsForFingerprint >= maxAttempts) {
          try {
            logger.warn(
              `[service] daemon autostart: start failed (attempt ${attemptsForFingerprint}/${maxAttempts}); ` +
                `suspending retries until credentials change`
            );
          } catch {
            // ignore
          }
          // Still schedule a short backoff tick so we don't immediately fall into a tight poll loop
          // right after a noisy failure.
          scheduleNext(delayMs);
          return;
        }
        try {
          logger.warn(
            `[service] daemon autostart: start failed (attempt ${attemptsForFingerprint}/${maxAttempts}); ` +
              `retrying in ${Math.ceil(delayMs / 1000)}s`
          );
        } catch {
          // ignore
        }
        scheduleNext(delayMs);
      }
    } catch (e) {
      try {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn(`[service] daemon autostart: unexpected error (continuing): ${msg}`);
      } catch {
        // ignore
      }
      scheduleNext(pollIntervalMs);
    } finally {
      inFlight = false;
    }
  };

  const startLoop = () => {
    if (!enabled) return;
    if (running) return;
    running = true;
    scheduleNext(0);
  };

  return {
    start: startLoop,
    stop,
    get state() {
      return {
        running,
        lastFingerprint,
        attemptsForFingerprint,
        nextScheduled: timerId != null,
        nowMs: clock(),
      };
    },
  };
}
