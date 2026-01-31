import { watch } from 'node:fs';

function safeWatch(path, handler) {
  try {
    // Node supports recursive watching on macOS and Windows. On Linux this may throw; we fail closed by returning null.
    return watch(path, { recursive: true }, handler);
  } catch {
    try {
      return watch(path, {}, handler);
    } catch {
      return null;
    }
  }
}

/**
 * Very small, dependency-free debounced watcher.
 * Intended for dev ergonomics (rebuild/restart), not for correctness-critical logic.
 */
export function watchDebounced({ paths, debounceMs = 500, onChange } = {}) {
  const list = Array.isArray(paths) ? paths.filter(Boolean) : [];
  if (!list.length) return null;
  if (typeof onChange !== 'function') return null;

  let closed = false;
  let t = null;
  const watchers = [];

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
    const w = safeWatch(p, trigger);
    if (w) watchers.push(w);
  }

  if (!watchers.length) return null;

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
    },
  };
}

