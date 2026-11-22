import { randomUUID } from 'node:crypto';
import { rmdirSync, unlinkSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  createProtectedLocalStateDirectory,
  createProtectedLocalStateFileExclusive,
  ensureProtectedLocalStateDirectory,
  readProtectedLocalStateFile,
  type ProtectedLocalStateOptions,
} from '@/utils/fs/protectedLocalState';

const ownedConfigs = new Set<string>();

function cleanupOwnedConfigsOnExit(): void {
  for (const path of ownedConfigs) {
    try {
      removeWrittenMcpRuntimeConfigFile(path, true);
    } catch {
      process.stderr.write('[happier-mcp] Could not remove a temporary runtime config\n');
    }
  }
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}

/** Retire a path returned by this writer once its owning MCP configuration is done. */
export function removeWrittenMcpRuntimeConfigFile(configPath: string, ownsBaseDir: boolean): void {
  try { unlinkSync(configPath); } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
  }
  if (ownsBaseDir) {
    try { rmdirSync(dirname(configPath)); } catch (error) {
      if (!isErrnoException(error) || (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY')) throw error;
    }
    ownedConfigs.delete(configPath);
    if (ownedConfigs.size === 0) process.off('exit', cleanupOwnedConfigsOnExit);
  }
}

export async function writeSecureMcpRuntimeConfigFile(params: Readonly<{
  prefix: string;
  tmpDir: string | null;
  payload: unknown;
}>, deps: Readonly<{
  protectedLocalStateOptions?: ProtectedLocalStateOptions;
}> = {}): Promise<string> {
  const protectedLocalStateOptions = deps.protectedLocalStateOptions ?? {};
  const json = JSON.stringify(params.payload);
  const ownsBaseDir = params.tmpDir === null;
  const baseDir = params.tmpDir === null
    ? await createProtectedLocalStateDirectory(join(tmpdir(), `${params.prefix}-`), protectedLocalStateOptions)
    : params.tmpDir;

  if (!ownsBaseDir) {
    await ensureProtectedLocalStateDirectory(baseDir, protectedLocalStateOptions);
  }

  try {
    // A config file path is part of a runtime security boundary (it can contain env headers, bearer tokens, etc).
    // Write with:
    // - a UUID final name (unguessable)
    // - an exclusive temp file write (avoid clobbering / symlink surprises)
    // - an atomic publication step (final path appears only when content is complete)
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const id = randomUUID();
      const ownershipSegment = ownsBaseDir ? '.owned' : '';
      const finalPath = join(baseDir, `${params.prefix}${ownershipSegment}.${id}.json`);
      const tempPath = join(baseDir, `${params.prefix}.${id}.${randomUUID()}.tmp`);

      try {
        await createProtectedLocalStateFileExclusive(tempPath, json, protectedLocalStateOptions);
        await rename(tempPath, finalPath);
        await readProtectedLocalStateFile(finalPath, protectedLocalStateOptions);
        if (ownsBaseDir) {
          if (ownedConfigs.size === 0) process.once('exit', cleanupOwnedConfigsOnExit);
          ownedConfigs.add(finalPath);
        }
        return finalPath;
      } catch (err) {
        await rm(tempPath, { force: true }).catch(() => {});
        await rm(finalPath, { force: true }).catch(() => {});
        if (isErrnoException(err) && err.code === 'EEXIST') continue;
        throw err;
      }
    }

    throw new Error('Failed to write MCP runtime config file after multiple attempts');
  } catch (error) {
    if (ownsBaseDir) {
      await rm(baseDir, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
}
