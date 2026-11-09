import { watch, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

function skipWatchSubpathError(error, watchPath, logger) {
  if (!['EACCES', 'ENOENT', 'EPERM'].includes(error?.code)) return false;
  const failedPath = error?.path ?? error?.filename;
  if (typeof failedPath !== 'string') return false;
  const subpath = relative(resolve(watchPath), resolve(failedPath));
  if (!subpath || subpath === '..' || subpath.startsWith(`..${sep}`) || isAbsolute(subpath)) return false;
  logger.warn?.(`[local] watch: skipping subpath ${failedPath} (${error.code}).`);
  return true;
}

function safeWatch(path, handler, { watchImpl, ignorePath, logger, persistent, recursive }) {
  let watcher;
  try {
    watcher = watchImpl(path, { recursive, persistent, ...(ignorePath ? { ignore: ignorePath } : {}) }, handler);
  } catch (error) {
    // Retain the non-recursive fallback only for unsupported recursion or a skipped
    // descendant. Resource exhaustion and failure of the watched root are fatal.
    if (error?.code !== 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' && !skipWatchSubpathError(error, path, logger)) throw error;
    try {
      watcher = watchImpl(path, { persistent, ...(ignorePath ? { ignore: ignorePath } : {}) }, handler);
    } catch (fallbackError) {
      if (!skipWatchSubpathError(fallbackError, path, logger)) throw fallbackError;
      return null;
    }
  }
  watcher.on?.('error', (error) => {
    if (!skipWatchSubpathError(error, path, logger)) throw error;
  });
  return watcher;
}

/**
 * Very small, dependency-free debounced watcher.
 * Intended for dev ergonomics (rebuild/restart), not for correctness-critical logic.
 */
export function watchDebounced({
  paths,
  debounceMs = 500,
  shouldObserve = null,
  ignorePath = null,
  logger = console,
  onObservation = null,
  onSourceEvent = null,
  onChange,
  readSignature = null,
  recoverSignature = readSignature,
  queueCapacity = process.platform === 'linux'
    ? Number(readFileSync('/proc/sys/fs/inotify/max_queued_events', 'utf8')) : 0,
  shouldPoll = null,
  pollIntervalMs = 0,
  persistent = true,
  recursive = true,
  watchImpl = watch,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const list = Array.isArray(paths) ? paths.filter(Boolean) : [];
  if (!list.length) return null;
  if (typeof onChange !== 'function') return null;

  let closed = false;
  let t = null;
  let burstTimer = null;
  let burstEvents = 0;
  let pendingSignatureInitializedAtObservation = null;
  let pendingObservationHandled = false;
  const watchers = [];
  let lastSignature = null;
  let signatureInitialized = false;
  let initialSignaturePromise = null;
  if (typeof readSignature === 'function') {
    try {
      const initialSignature = readSignature();
      if (initialSignature && typeof initialSignature.then === 'function') {
        initialSignaturePromise = Promise.resolve(initialSignature).then((signature) => {
          if (closed) return;
          lastSignature = signature;
          signatureInitialized = true;
        }).catch(() => {
          // The first successful poll establishes the baseline.
        });
      } else {
        lastSignature = initialSignature;
        signatureInitialized = true;
      }
    } catch {
      lastSignature = null;
    }
  }

  const trigger = (eventType, filename, details = {}) => {
    if (closed) return;
    if (filename != null && ignorePath?.(String(filename))) return;
    const observation = { eventType, filename, ...details };
    if (typeof shouldObserve === 'function' && !shouldObserve(observation)) return;
    try {
      pendingObservationHandled = onObservation?.({
        ...observation,
        signatureInitializedAtObservation: signatureInitialized,
      }) === true || pendingObservationHandled;
    } catch {
      // The debounced change remains the recovery path.
    }
    pendingSignatureInitializedAtObservation = pendingSignatureInitializedAtObservation === false
      ? false
      : signatureInitialized;
    if (t) clearTimeoutImpl(t);
    t = setTimeoutImpl(() => {
      t = null;
      const signatureInitializedAtObservation = pendingSignatureInitializedAtObservation;
      const observationHandled = pendingObservationHandled;
      pendingSignatureInitializedAtObservation = null;
      pendingObservationHandled = false;
      try {
        onChange({ ...observation, signatureInitializedAtObservation, observationHandled });
      } catch {
        // ignore
      }
    }, debounceMs);
  };

  // Count before reload filtering: ignored events can occupy the same kernel
  // queue as source events. Half the actual capacity leaves room for undelivered
  // callbacks; a saturated queue must still deliver enough evidence to recrawl.
  const observeNativeEvent = (eventType, filename, watchPath) => {
    if (closed) return;
    onSourceEvent?.({ eventType, filename, watchPath });
    if (queueCapacity > 0) {
      burstEvents++;
      if (burstTimer) clearTimeoutImpl(burstTimer);
      // Wall-clock gaps can include process/VM suspension while the native
      // queue is still draining. Only an event-loop quiet turn ends the burst.
      burstTimer = setTimeoutImpl(() => {
        burstTimer = null;
        const risksQueueLoss = burstEvents >= Math.ceil(queueCapacity / 2);
        burstEvents = 0;
        if (closed || !risksQueueLoss) return;
        logger.warn?.('[local] watch: native event burst risks queue loss; reconciling source inputs.');
        onSourceEvent?.({ eventType: 'recrawl', filename: null });
        trigger('recrawl', null);
      }, debounceMs);
    }
    trigger(eventType, filename, { watchPath });
  };
  try {
    for (const p of list) {
      const w = safeWatch(
        p,
        (eventType, filename) => observeNativeEvent(eventType, filename, p),
        { watchImpl, ignorePath, logger, persistent, recursive },
      );
      if (w) watchers.push(w);
    }
  } catch (error) {
    closed = true;
    if (t) clearTimeoutImpl(t);
    if (burstTimer) clearTimeoutImpl(burstTimer);
    for (const w of watchers) w.close();
    throw error;
  }

  const pollMs = Number(pollIntervalMs);
  let pollTimer = null;
  let polling = false;
  if (typeof readSignature === 'function' && Number.isFinite(pollMs) && pollMs > 0 && typeof setIntervalImpl === 'function') {
    const pollForSignatureChange = async () => {
      if (closed || polling || shouldPoll?.() === false) return;
      polling = true;
      try {
        if (initialSignaturePromise) {
          await initialSignaturePromise;
          initialSignaturePromise = null;
          if (closed) return;
        }
        const nextSignature = await recoverSignature();
        if (!signatureInitialized) {
          lastSignature = nextSignature;
          signatureInitialized = true;
          return;
        }
        if (nextSignature !== lastSignature) {
          lastSignature = nextSignature;
          trigger('poll', null, { signature: nextSignature });
        }
      } catch {
        // ignore; fs.watch remains the fast path and the next poll can recover
      } finally {
        polling = false;
      }
    };
    pollTimer = setIntervalImpl(pollForSignatureChange, pollMs);
    pollTimer?.unref?.();
  }

  if (!watchers.length && !pollTimer) return null;

  return {
    close() {
      closed = true;
      if (t) clearTimeoutImpl(t);
      if (burstTimer) clearTimeoutImpl(burstTimer);
      pendingSignatureInitializedAtObservation = null;
      pendingObservationHandled = false;
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // ignore
        }
      }
      if (pollTimer && typeof clearIntervalImpl === 'function') {
        try {
          clearIntervalImpl(pollTimer);
        } catch {
          // ignore
        }
      }
    },
  };
}
