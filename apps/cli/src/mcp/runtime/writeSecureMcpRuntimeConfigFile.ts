import { randomUUID } from 'node:crypto';
import { rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createProtectedLocalStateFileExclusive,
  ensureProtectedLocalStateDirectory,
  readProtectedLocalStateFile,
  type ProtectedLocalStateOptions,
} from '@/utils/fs/protectedLocalState';

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}

export async function writeSecureMcpRuntimeConfigFile(params: Readonly<{
  prefix: string;
  tmpDir: string | null;
  payload: unknown;
}>, deps: Readonly<{
  protectedLocalStateOptions?: ProtectedLocalStateOptions;
}> = {}): Promise<string> {
  const baseDir = params.tmpDir ?? join(tmpdir(), params.prefix);
  const protectedLocalStateOptions = deps.protectedLocalStateOptions ?? {};
  await ensureProtectedLocalStateDirectory(baseDir, protectedLocalStateOptions);

  const json = JSON.stringify(params.payload);

  // A config file path is part of a runtime security boundary (it can contain env headers, bearer tokens, etc).
  // Write with:
  // - a UUID final name (unguessable)
  // - an exclusive temp file write (avoid clobbering / symlink surprises)
  // - an atomic publication step (final path appears only when content is complete)
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = randomUUID();
    const finalPath = join(baseDir, `${params.prefix}.${id}.json`);
    const tempPath = join(baseDir, `${params.prefix}.${id}.${randomUUID()}.tmp`);

    try {
      await createProtectedLocalStateFileExclusive(tempPath, json, protectedLocalStateOptions);
      await rename(tempPath, finalPath);
      await readProtectedLocalStateFile(finalPath, protectedLocalStateOptions);
      return finalPath;
    } catch (err) {
      await rm(tempPath, { force: true }).catch(() => {});
      await rm(finalPath, { force: true }).catch(() => {});
      if (isErrnoException(err) && err.code === 'EEXIST') continue;
      throw err;
    }
  }

  throw new Error('Failed to write MCP runtime config file after multiple attempts');
}
