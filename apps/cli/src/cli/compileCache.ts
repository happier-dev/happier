import { accessSync, chmodSync, constants as fsConstants, lstatSync, mkdirSync } from 'node:fs';
import { constants, enableCompileCache } from 'node:module';
import { isAbsolute } from 'node:path';

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
    reportUnavailable(`Stack QA directory ${directory}: ${String(error)}`);
    return undefined;
  }
}

function reportUnavailable(reason: string): void {
  // The packaged Node launcher disables Node warnings. Keep this startup diagnostic visible.
  console.error(`HAPPIER_COMPILE_CACHE_UNAVAILABLE: ${reason}`);
}

function resolveIdentityCompileCache(): string {
  const directory = resolveCliHomeStoragePaths(resolveCliHappyHomeDir(process.env)).compileCacheDir;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const entry = lstatSync(directory);
  const uid = process.getuid?.();
  if (!entry.isDirectory() || (uid !== undefined && entry.uid !== uid)) {
    throw new Error(`Expected an owned compile cache directory at ${directory}`);
  }
  // Earlier releases let Node create this directory with the process umask.
  if (uid !== undefined && (entry.mode & 0o077) !== 0) chmodSync(directory, 0o700);
  accessSync(directory, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
  return directory;
}

/** Enable Node's cache before loading the CLI command graph, including daemon-hosted roles. */
export function enableCliCompileCache(): void {
  if (!isNode() || process.env.NODE_DISABLE_COMPILE_CACHE === '1') return;
  try {
    const directory = process.env.NODE_COMPILE_CACHE?.trim()
      || resolvePrivateQaCompileCache()
      || resolveIdentityCompileCache();
    const result = enableCompileCache(directory);
    if (result.status === constants.compileCacheStatus.FAILED) {
      reportUnavailable(`${result.directory ?? directory}: ${result.message ?? 'unknown failure'}`);
    }
  } catch (error) {
    reportUnavailable(String(error));
  }
}
