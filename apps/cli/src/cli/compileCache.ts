import { lstatSync, mkdirSync } from 'node:fs';
import { constants, enableCompileCache } from 'node:module';
import { isAbsolute } from 'node:path';

import { isDaemonHostedCliInvocation } from './readStartedByArg';
import { isNode } from '../utils/runtime';
import { resolveCliHappyHomeDir } from '../configuration/resolveCliHappyHomeDir';
import { resolveCliHomeStoragePaths } from '../configuration/homeStoragePaths';

function resolvePrivateQaCompileCache(): string | undefined {
  const directory = process.env.HAPPIER_STACK_QA_CLI_COMPILE_CACHE_DIR?.trim();
  const uid = process.getuid?.();
  if (!directory || uid === undefined) return undefined;
  try {
    if (!isAbsolute(directory)) throw new Error('expected an absolute path');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const entry = lstatSync(directory);
    if (!entry.isDirectory() || entry.uid !== uid || (entry.mode & 0o777) !== 0o700) {
      throw new Error('expected an owned directory with mode 0700');
    }
    return directory;
  } catch (error) {
    process.emitWarning(`Stack QA compile cache unavailable at ${directory}: ${String(error)}`,
      { code: 'HAPPIER_COMPILE_CACHE_UNAVAILABLE' });
    return undefined;
  }
}

/**
 * Node-hosted short-lived commands reuse V8 code compiled by earlier runs (Node validates entries
 * against the source). The cache lives in this user's Happier home, never Node's shared OS-temp
 * default, and an unusable directory is reported, not swallowed. Daemon-hosted roles stay
 * uncached: the daemon, its background worker and daemon-started runners gain no start CPU
 * from it and would keep ~25–30 MiB more resident. Shipped binaries run on Bun and skip this.
 * Named QA identities may use a private cache shared by their host UID.
 * An operator's `NODE_COMPILE_CACHE` keeps precedence.
 */
export function enableShortLivedCliCompileCache(args: readonly string[]): void {
  if (!isNode()) return;
  if (isDaemonHostedCliInvocation(args)) return;
  const directory = process.env.NODE_COMPILE_CACHE?.trim()
    || resolvePrivateQaCompileCache()
    || resolveCliHomeStoragePaths(resolveCliHappyHomeDir(process.env)).compileCacheDir;
  const result = enableCompileCache(directory);
  if (result.status === constants.compileCacheStatus.FAILED) {
    process.emitWarning(`Node compile cache unavailable at ${result.directory ?? directory}: ${result.message ?? 'unknown failure'}`,
      { code: 'HAPPIER_COMPILE_CACHE_UNAVAILABLE' });
  }
}
