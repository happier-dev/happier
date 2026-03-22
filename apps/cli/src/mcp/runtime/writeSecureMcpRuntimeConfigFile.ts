import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}

async function bestEffortChmod(path: string, mode: number): Promise<void> {
  await chmod(path, mode).catch(() => {});
}

export async function writeSecureMcpRuntimeConfigFile(params: Readonly<{
  prefix: string;
  tmpDir: string | null;
  payload: unknown;
}>): Promise<string> {
  const baseDir = params.tmpDir ?? join(tmpdir(), params.prefix);

  await mkdir(baseDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  await bestEffortChmod(baseDir, PRIVATE_DIR_MODE);

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
      await writeFile(tempPath, json, { mode: PRIVATE_FILE_MODE, flag: 'wx' });
      await bestEffortChmod(tempPath, PRIVATE_FILE_MODE);

      await rename(tempPath, finalPath);
      await bestEffortChmod(finalPath, PRIVATE_FILE_MODE);
      return finalPath;
    } catch (err) {
      await unlink(tempPath).catch(() => {});
      if (isErrnoException(err) && err.code === 'EEXIST') continue;
      throw err;
    }
  }

  throw new Error('Failed to write MCP runtime config file after multiple attempts');
}
