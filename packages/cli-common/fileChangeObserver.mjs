import { watch } from 'node:fs';

export const DEFAULT_FILE_CHANGE_CATCH_UP_MS = 1_000;

/** Shared notification mechanics only: each lock/admission owner supplies its
 * own meaningful snapshot and catch-up budget. Register before observing and
 * recheck after arming so a release between observation and sleep is not lost.
 */
export function createFileChangeObserver(directories, { isRelevant } = {}) {
  const watchers = new Map();
  let onChange = null;
  const observe = () => {
    for (const directory of directories) {
      if (watchers.has(directory)) continue;
      try {
        const watcher = watch(directory, { persistent: false }, (_event, filename) => {
          if (!isRelevant || isRelevant(directory, filename)) onChange?.();
        });
        watchers.set(directory, watcher);
        watcher.on('error', () => {
          watcher.close();
          watchers.delete(directory);
          onChange?.();
        });
      } catch {
        // Missing directories/unsupported watching use the owner's catch-up.
      }
    }
  };
  return {
    // wait arms before rechecking the snapshot. Uncontended reads must not
    // reconfigure native filesystem watching and interrupt Metro notifications.
    capture(readSnapshot) { return readSnapshot(); },
    async wait({ snapshot, readSnapshot, maxWaitMs, signal }) {
      signal?.throwIfAborted();
      await new Promise((resolve, reject) => {
        let timer;
        let settled = false;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          onChange = null;
          signal?.removeEventListener('abort', abort);
          if (error) reject(error);
          else resolve();
        };
        const abort = () => finish(signal.reason);
        const check = () => {
          try { if (readSnapshot() !== snapshot) finish(); }
          catch (error) { finish(error); }
        };
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(finish, Math.max(1, maxWaitMs));
        onChange = check;
        observe();
        check();
        if (signal?.aborted) abort();
      });
    },
    close() { for (const watcher of watchers.values()) watcher.close(); watchers.clear(); },
  };
}
