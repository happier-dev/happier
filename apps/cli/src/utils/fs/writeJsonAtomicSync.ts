import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { chmodSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { readdir, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

function bestEffortChmod0600Sync(path: string): void {
  if (process.platform === 'win32') return;
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort
  }
}

function isAtomicWriteTempFileName(fileName: string, path: string): boolean {
  const tempPrefix = `${basename(path)}.tmp`;
  return fileName === tempPrefix || fileName.startsWith(`${tempPrefix}-`);
}

function resolveAtomicWriteTempPath(path: string): string {
  return join(dirname(path), `${basename(path)}.tmp-${process.pid}-${randomUUID()}`);
}

export function writeJsonAtomicSync(path: string, value: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmpPath = resolveAtomicWriteTempPath(path);
  try {
    writeFileSync(tmpPath, JSON.stringify(value, null, 2), { encoding: 'utf-8', mode: 0o600 });
    bestEffortChmod0600Sync(tmpPath);
    try {
      renameSync(tmpPath, path);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code !== 'EEXIST' && err?.code !== 'EPERM') {
        throw error;
      }
      try {
        unlinkSync(path);
      } catch (unlinkError) {
        const unlinkErr = unlinkError as NodeJS.ErrnoException;
        if (unlinkErr?.code !== 'ENOENT') {
          throw unlinkError;
        }
      }
      renameSync(tmpPath, path);
    }
    bestEffortChmod0600Sync(path);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw error;
  }
}

export function cleanupAtomicWriteTempFilesSync(path: string): void {
  const dir = dirname(path);
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !isAtomicWriteTempFileName(entry.name, path)) {
      continue;
    }
    try {
      unlinkSync(join(dir, entry.name));
    } catch {
      // best-effort
    }
  }
}

export async function cleanupAtomicWriteTempFiles(path: string): Promise<void> {
  const dir = dirname(path);
  let entries: Dirent<string>[];
  try {
    entries = await readdir(dir, { encoding: 'utf8', withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !isAtomicWriteTempFileName(entry.name, path)) {
      continue;
    }
    await unlink(join(dir, entry.name)).catch(() => {});
  }
}
