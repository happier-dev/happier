import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function replaceDirectoryAtomically(params: Readonly<{
  stagedDir: string;
  targetDir: string;
}>): Promise<void> {
  await mkdir(dirname(params.targetDir), { recursive: true });
  const backupDir = `${params.targetDir}.previous-${randomUUID()}`;
  let hasBackup = false;
  try {
    await rename(params.targetDir, backupDir);
    hasBackup = true;
  } catch {
    hasBackup = false;
  }
  try {
    await rename(params.stagedDir, params.targetDir);
    if (hasBackup) {
      await rm(backupDir, { recursive: true, force: true });
    }
  } catch (error) {
    if (hasBackup) {
      await rename(backupDir, params.targetDir).catch(() => {});
    }
    throw error;
  }
}
