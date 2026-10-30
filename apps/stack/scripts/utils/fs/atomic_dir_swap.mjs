import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

import { publishStagedDirectoryMountedSync } from '@happier-dev/cli-common/workspaceRuntimeDependencies';
import { readProcessHostIdentitySync, readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';

import { reclaimAbandonedBuildStaging } from './abandoned_build_staging.mjs';

const WINDOWS_TRANSIENT_RENAME_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);

function rand() {
  return Math.random().toString(16).slice(2);
}

async function renameForPublication(
  from,
  to,
  { platform, renameImpl, waitImpl, maxRetries = 8 },
) {
  let retry = 0;
  while (true) {
    try {
      await renameImpl(from, to);
      return;
    } catch (error) {
      if (
        platform !== 'win32'
        || !WINDOWS_TRANSIENT_RENAME_CODES.has(error?.code)
        || retry >= maxRetries
      ) {
        throw error;
      }
      await waitImpl(Math.min(25 * (2 ** retry), 400));
      retry += 1;
    }
  }
}

export async function buildIntoTempThenReplace(
  targetDir,
  buildFn,
  {
    platform = process.platform,
    renameImpl = rename,
    waitImpl = wait,
    preserveDestinationPath = false,
    pruneStale = true,
  } = {},
) {
  const outDir = String(targetDir ?? '').trim();
  if (!outDir) throw new Error('[fs] buildIntoTempThenReplace: missing targetDir');
  if (typeof buildFn !== 'function') throw new Error('[fs] buildIntoTempThenReplace: buildFn must be a function');

  const parent = dirname(outDir);
  await mkdir(parent, { recursive: true });
  const host = readProcessHostIdentitySync();
  // A killed build cannot run finally; its next sibling build owns reclamation.
  await reclaimAbandonedBuildStaging(parent, host);
  const tmpDir = join(parent, `.tmp.${Date.now()}.${process.pid}.${rand()}`);
  const ownerFile = `${tmpDir}.owner.json`;

  // Publish identity before the directory becomes visible to concurrent builds.
  await writeFile(ownerFile, JSON.stringify({
    v: 1,
    pid: process.pid,
    host,
    processInstanceFingerprint: readProcessInstanceFingerprintSync(process.pid),
  }), { flag: 'wx' });
  try {
    await mkdir(tmpDir);
  } catch (error) {
    await rm(ownerFile, { force: true }).catch(() => {});
    throw error;
  }

  try {
    await buildFn(tmpDir);

    // Swap only after a successful build.
    const backupDir = join(parent, `.backup.${Date.now()}.${process.pid}.${rand()}`);
    if (preserveDestinationPath) {
      publishStagedDirectoryMountedSync({
        stagedDir: tmpDir,
        liveDir: outDir,
        rollbackDir: backupDir,
        pruneStale,
      });
      // The mounted publisher owns rollback cleanup, including retained
      // recovery backups when restoration fails.
      return;
    }

    let hadExisting = false;
    try {
      await renameForPublication(outDir, backupDir, { platform, renameImpl, waitImpl });
      hadExisting = true;
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }

    try {
      await renameForPublication(tmpDir, outDir, { platform, renameImpl, waitImpl });
    } catch (err) {
      if (hadExisting) {
        await renameForPublication(backupDir, outDir, { platform, renameImpl, waitImpl }).catch((restoreErr) => {
          if (err && typeof err === 'object') {
            err.restoreError = restoreErr;
          }
        });
      }
      throw err;
    }

    if (hadExisting) {
      await rm(backupDir, { recursive: true, force: true }).catch(() => {});
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    await rm(ownerFile, { force: true }).catch(() => {});
  }
}
