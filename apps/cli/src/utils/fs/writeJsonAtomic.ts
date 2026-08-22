/**
 * Atomic file writer
 *
 * Used for replacing durable files so consumers never read partially-written content.
 */

import { mkdir, rename, unlink, writeFile, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const WINDOWS_RENAME_MAX_ATTEMPTS = 5;
const WINDOWS_RENAME_RETRY_DELAY_MS = 10;

async function bestEffortChmod0600(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  await chmod(path, 0o600).catch(() => {});
}

function isRetryableWindowsRenameError(error: unknown): boolean {
  if (process.platform !== 'win32') return false;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EBUSY' || code === 'EEXIST' || code === 'EPERM';
}

async function renameWithWindowsRetries(sourcePath: string, destinationPath: string): Promise<void> {
  for (let attempt = 1; attempt <= WINDOWS_RENAME_MAX_ATTEMPTS; attempt += 1) {
    try {
      await rename(sourcePath, destinationPath);
      return;
    } catch (error) {
      if (!isRetryableWindowsRenameError(error) || attempt === WINDOWS_RENAME_MAX_ATTEMPTS) {
        throw error;
      }
      await delay(WINDOWS_RENAME_RETRY_DELAY_MS * attempt);
    }
  }
}

export async function writeFileAtomically(input: Readonly<{
  path: string;
  writeTemporaryFile: (temporaryPath: string) => Promise<void>;
}>): Promise<void> {
  const path = input.path;
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  try {
    await input.writeTemporaryFile(tmpPath);
    await bestEffortChmod0600(tmpPath);
    await renameWithWindowsRetries(tmpPath, path);
    await bestEffortChmod0600(path);
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}

export async function writeBytesAtomic(path: string, value: Uint8Array): Promise<void> {
  await writeFileAtomically({
    path,
    writeTemporaryFile: async (temporaryPath) => {
      await writeFile(temporaryPath, value, { mode: 0o600 });
    },
  });
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeFileAtomically({
    path,
    writeTemporaryFile: async (temporaryPath) => {
      await writeFile(temporaryPath, JSON.stringify(value, null, 2), { mode: 0o600 });
    },
  });
}
