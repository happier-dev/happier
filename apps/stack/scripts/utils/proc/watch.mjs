import { watch } from 'node:fs';
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

function safeWatch(path, handler, { watchImpl, ignorePath, logger }) {
  let watcher;
  try {
    watcher = watchImpl(path, { recursive: true, ...(ignorePath ? { ignore: ignorePath } : {}) }, handler);
  } catch (error) {
    // Retain the non-recursive fallback only for unsupported recursion or a skipped
    // descendant. Resource exhaustion and failure of the watched root are fatal.
    if (error?.code !== 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' && !skipWatchSubpathError(error, path, logger)) throw error;
    try {
      watcher = watchImpl(path, ignorePath ? { ignore: ignorePath } : {}, handler);
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
  onChange,
  readSignature = null,
  pollIntervalMs = 0,
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

  for (const p of list) {
    const w = safeWatch(
      p,
      (eventType, filename) => trigger(eventType, filename, { watchPath: p }),
      { watchImpl, ignorePath, logger },
    );
    if (w) watchers.push(w);
  }

  const pollMs = Number(pollIntervalMs);
  let pollTimer = null;
  let polling = false;
  if (typeof readSignature === 'function' && Number.isFinite(pollMs) && pollMs > 0 && typeof setIntervalImpl === 'function') {
    const pollForSignatureChange = async () => {
      if (closed || polling) return;
      polling = true;
      try {
        if (initialSignaturePromise) {
          await initialSignaturePromise;
          initialSignaturePromise = null;
          if (closed) return;
        }
        const nextSignature = await readSignature();
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
