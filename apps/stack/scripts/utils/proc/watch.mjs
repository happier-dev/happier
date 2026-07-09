import { watch } from 'node:fs';

function safeWatch(path, handler, watchImpl = watch) {
  try {
    // Node supports recursive watching on macOS and Windows. On Linux this may throw; we fail closed by returning null.
    return watchImpl(path, { recursive: true }, handler);
  } catch {
    try {
      return watchImpl(path, {}, handler);
    } catch {
      return null;
    }
  }
}

/**
 * Very small, dependency-free debounced watcher.
 * Intended for dev ergonomics (rebuild/restart), not for correctness-critical logic.
 */
export function watchDebounced({
  paths,
  debounceMs = 500,
  onChange,
  readSignature = null,
  pollIntervalMs = 0,
  watchImpl = watch,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  const list = Array.isArray(paths) ? paths.filter(Boolean) : [];
  if (!list.length) return null;
  if (typeof onChange !== 'function') return null;

  let closed = false;
  let t = null;
  const watchers = [];
  let lastSignature = null;
  if (typeof readSignature === 'function') {
    try {
      lastSignature = readSignature();
    } catch {
      lastSignature = null;
    }
  }

  const trigger = (eventType, filename) => {
    if (closed) return;
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      try {
        onChange({ eventType, filename });
      } catch {
        // ignore
      }
    }, debounceMs);
  };

  for (const p of list) {
    const w = safeWatch(p, trigger, watchImpl);
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
        const nextSignature = readSignature();
        if (nextSignature !== lastSignature) {
          lastSignature = nextSignature;
          trigger('poll', null);
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
      if (t) clearTimeout(t);
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
