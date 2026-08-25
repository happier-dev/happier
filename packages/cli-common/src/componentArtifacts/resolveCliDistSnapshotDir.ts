import { existsSync, readdirSync } from 'node:fs';
import { cp, mkdtemp, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { isPidPresent } from '../process/processLiveness.js';

const CLI_DIST_SNAPSHOT_PREFIX = '.dist.hstack-snapshot-';

async function reclaimAbandonedCliDistSnapshots(
  cliDir: string,
  isProcessAliveImpl: (pid: number) => boolean,
): Promise<void> {
  let entries;
  try {
    entries = readdirSync(cliDir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory() || !entry.name.startsWith(CLI_DIST_SNAPSHOT_PREFIX)) return;
    const ownerPid = Number.parseInt(
      entry.name.slice(CLI_DIST_SNAPSHOT_PREFIX.length).split('-', 1)[0] ?? '',
      10,
    );
    if (!Number.isInteger(ownerPid) || ownerPid <= 1 || isProcessAliveImpl(ownerPid)) return;
    await rm(join(cliDir, entry.name), { recursive: true, force: true });
  }));
}

function isRetryableSnapshotRenameError(error: unknown): boolean {
  const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : null;
  return code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

async function snapshotCliDistDir(params: Readonly<{ cliDir: string; distDir: string }>): Promise<string> {
  const snapshotDir = await mkdtemp(join(params.cliDir, `${CLI_DIST_SNAPSHOT_PREFIX}${process.pid}-`));
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
  isProcessAliveImpl = isPidPresent,
  buildDist,
}: Readonly<{
  cliDir: string;
  distDir: string;
  distBackupDir: string;
  distEntrypointPath: string;
  reuseExistingDistSnapshot?: boolean;
  isProcessAliveImpl?: (pid: number) => boolean;
  buildDist: () => Promise<void>;
}>): Promise<string> {
  await reclaimAbandonedCliDistSnapshots(cliDir, isProcessAliveImpl);
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
