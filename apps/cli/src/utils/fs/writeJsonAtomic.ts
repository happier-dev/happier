/**
 * Atomic JSON writer
 *
 * Used for updating runtime auth stores (OpenCode/Pi/Codex) so consumers never read a partially-written file.
 */

import { mkdir, rename, writeFile, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';

async function bestEffortChmod0600(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  await chmod(path, 0o600).catch(() => {});
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  await writeFile(tmpPath, JSON.stringify(value, null, 2), { mode: 0o600 });
  await bestEffortChmod0600(tmpPath);
  await rename(tmpPath, path);
  await bestEffortChmod0600(path);
}

