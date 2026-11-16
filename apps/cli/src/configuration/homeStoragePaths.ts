import { join } from 'node:path';

/** Canonical Home-local paths shared by configuration and information pages. */
export function resolveCliHomeStoragePaths(happyHomeDir: string) {
  return {
    logsDir: join(happyHomeDir, 'logs'),
    settingsFile: join(happyHomeDir, 'settings.json'),
    serversDir: join(happyHomeDir, 'servers'),
    // Per user, never the OS temp default: a shared /tmp/node-compile-cache created by another user
    // makes Node's cache fail for everyone else.
    compileCacheDir: join(happyHomeDir, 'cache', 'node-compile-cache'),
  };
}
