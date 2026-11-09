import { existsSync, watch } from 'node:fs';
import { dirname } from 'node:path';

import { findExistingStackCredentialPath, resolveStackCredentialPaths } from './credentials_paths.mjs';

/** A controller login can arrive after a retained native runtime attaches.
 * Observe its existing auth paths; the auth-path owner still selects the file.
 */
export async function waitForStackCredentialPath({ cliHomeDir, serverUrl = '', env = process.env, signal }) {
  signal.throwIfAborted();
  serverUrl = String(serverUrl).trim() || String(env.HAPPIER_SERVER_URL ?? '').trim();
  const watchers = new Map();
  let onAbort;
  let settled = false;
  try {
    return await new Promise((resolve, reject) => {
      const fail = error => { settled = true; reject(error); };
      const inspect = () => {
        if (settled) return;
        try {
          // Subscribe before reading, including when login creates missing
          // server-profile directories or atomically replaces its auth file.
          const roots = new Set([cliHomeDir, ...resolveStackCredentialPaths({ cliHomeDir, serverUrl, env }).paths.map(dirname)]
            .map(path => {
              while (!existsSync(path)) path = dirname(path);
              return path;
            }));
          for (const root of roots) {
            if (!watchers.has(root)) watchers.set(root, watch(root, inspect).on('error', fail));
          }
          for (const [root, watcher] of watchers) {
            if (!roots.has(root)) { watcher.close(); watchers.delete(root); }
          }
          const path = findExistingStackCredentialPath({ cliHomeDir, serverUrl, env });
          if (path) { settled = true; resolve(path); }
        } catch (error) { fail(error); }
      };
      onAbort = () => fail(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      inspect();
    });
  } finally {
    signal.removeEventListener('abort', onAbort);
    for (const watcher of watchers.values()) watcher.close();
  }
}
