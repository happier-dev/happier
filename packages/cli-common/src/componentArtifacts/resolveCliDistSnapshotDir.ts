import { existsSync } from 'node:fs';
import { cp, mkdtemp, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

function isRetryableSnapshotRenameError(error: unknown): boolean {
  const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : null;
  return code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

async function snapshotCliDistDir(params: Readonly<{ cliDir: string; distDir: string }>): Promise<string> {
  const snapshotDir = await mkdtemp(join(params.cliDir, '.dist.hstack-snapshot-'));
  let liveDistRenamed = false;
  try {
    await rename(params.distDir, snapshotDir);
    liveDistRenamed = true;
    await cp(snapshotDir, params.distDir, { recursive: true });
    return snapshotDir;
  } catch (error) {
    if (!liveDistRenamed && existsSync(params.distDir) && isRetryableSnapshotRenameError(error)) {
      try {
        await cp(params.distDir, snapshotDir, { recursive: true });
        return snapshotDir;
      } catch (copyError) {
        await rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
        throw copyError;
      }
    }
    if (liveDistRenamed && !existsSync(params.distDir) && existsSync(snapshotDir)) {
      await rename(snapshotDir, params.distDir).catch(() => {});
    }
    await rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function resolveCliDistSnapshotDir({
  cliDir,
  distDir,
  distBackupDir,
  distEntrypointPath,
  reuseExistingDistSnapshot = false,
  buildDist,
}: Readonly<{
  cliDir: string;
  distDir: string;
  distBackupDir: string;
  distEntrypointPath: string;
  reuseExistingDistSnapshot?: boolean;
  buildDist: () => Promise<void>;
}>): Promise<string> {
  if (!existsSync(distDir) && existsSync(distBackupDir)) {
    await rename(distBackupDir, distDir);
  }

  if (reuseExistingDistSnapshot && existsSync(distEntrypointPath)) {
    return await snapshotCliDistDir({ cliDir, distDir });
  }

  const hadDistBeforeBuild = existsSync(distDir);
  if (hadDistBeforeBuild) {
    await rm(distBackupDir, { recursive: true, force: true });
    await rename(distDir, distBackupDir);
  }

  try {
    await buildDist();
    if (hadDistBeforeBuild) {
      await rm(distBackupDir, { recursive: true, force: true });
    }
  } catch (error) {
    if (hadDistBeforeBuild && existsSync(distBackupDir)) {
      await rm(distDir, { recursive: true, force: true });
      await rename(distBackupDir, distDir);
    }
    throw error;
  }

  return await snapshotCliDistDir({ cliDir, distDir });
}
