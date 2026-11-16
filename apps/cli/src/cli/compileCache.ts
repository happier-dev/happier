import { constants, enableCompileCache } from 'node:module';

import { readStartedByArg } from './readStartedByArg';
import { isNode } from '../utils/runtime';
import { resolveCliHappyHomeDir } from '../configuration/resolveCliHappyHomeDir';
import { resolveCliHomeStoragePaths } from '../configuration/homeStoragePaths';

/**
 * Node-hosted short-lived commands reuse V8 code compiled by earlier runs (Node validates entries
 * against the source). The cache lives in this user's Happier home, never Node's shared OS-temp
 * default, and an unusable directory is reported, not swallowed. Daemon-hosted roles stay
 * uncached: the daemon, its background worker and daemon-started runners gain no start CPU
 * from it and would keep ~25–30 MiB more resident. Shipped binaries run on Bun and skip this.
 * An operator's `NODE_COMPILE_CACHE` keeps precedence.
 */
export function enableShortLivedCliCompileCache(args: readonly string[]): void {
  if (!isNode()) return;
  if (args[0] === 'daemon' && (args[1] === 'start-sync' || args[1] === 'background-service-worker')) return;
  if (readStartedByArg(args).value === 'daemon') return;
  const directory = process.env.NODE_COMPILE_CACHE?.trim()
    || resolveCliHomeStoragePaths(resolveCliHappyHomeDir(process.env)).compileCacheDir;
  const result = enableCompileCache(directory);
  if (result.status === constants.compileCacheStatus.FAILED) {
    process.emitWarning(`Node compile cache unavailable at ${result.directory ?? directory}: ${result.message ?? 'unknown failure'}`,
      { code: 'HAPPIER_COMPILE_CACHE_UNAVAILABLE' });
  }
}
