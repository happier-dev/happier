import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

async function pathExists(path: string): Promise<boolean> {
  return await lstat(path)
    .then(() => true)
    .catch(() => false);
}

export async function promoteManagedCurrentInstall(params: Readonly<{
  installRoot: string;
  candidatePath?: string;
  currentPath?: string;
}>): Promise<void> {
  const candidatePath = params.candidatePath ?? join(params.installRoot, 'next');
  const currentPath = params.currentPath ?? join(params.installRoot, 'current');
  const backupPath = join(params.installRoot, `.current.backup-${process.pid}-${randomUUID()}`);

  await mkdir(params.installRoot, { recursive: true });
  await lstat(candidatePath);
  await rm(backupPath, { recursive: true, force: true });

  const hadCurrent = await pathExists(currentPath);
  if (hadCurrent) {
    await rename(currentPath, backupPath);
  }

  try {
    await rename(candidatePath, currentPath);
  } catch (error) {
    if (hadCurrent) {
      const currentExists = await pathExists(currentPath);
      const backupExists = await pathExists(backupPath);
      if (!currentExists && backupExists) {
        await rename(backupPath, currentPath).catch(() => undefined);
      }
    }
    throw error;
  }

  if (hadCurrent) {
    await rm(backupPath, { recursive: true, force: true }).catch(() => undefined);
  }
}
