import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, rename, rm, symlink } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

import { readProcessInstanceFingerprintSync } from '../../processInstance.mjs';
import { withWorkspaceBundleLock } from '../../workspaceBundleLock.mjs';

const MANAGED_INSTALL_COMMIT_LOCK_TIMEOUT_MS = 60_000;
const MANAGED_INSTALL_LOCK_PLATFORM = process.platform;
const MANAGED_INSTALL_BACKUP_DIRECTORY_PATTERN =
  /^\.current\.backup-[1-9][0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MANAGED_VERSIONED_RELEASE_DIRECTORY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function pathExists(path: string): Promise<boolean> {
  return await lstat(path)
    .then(() => true)
    .catch(() => false);
}

function reportManagedInstallWarningBestEffort(
  reportWarning: ((message: string) => void) | undefined,
  message: string,
): void {
  if (reportWarning) {
    try {
      reportWarning(message);
      return;
    } catch (error) {
      try {
        console.warn(`[managed-install] ${message} (install log unavailable: ${String(error)})`);
        return;
      } catch {
        return;
      }
    }
  }

  try {
    console.warn(`[managed-install] ${message}`);
  } catch {
    // Cleanup reporting must never change a successful promotion into a failure.
  }
}

async function cleanupRetiredManagedInstallDirectories(params: Readonly<{
  installRoot: string;
  reportWarning?: (message: string) => void;
}>): Promise<void> {
  let entries;
  try {
    entries = await readdir(params.installRoot, { withFileTypes: true });
  } catch (error) {
    reportManagedInstallWarningBestEffort(
      params.reportWarning,
      `retired managed install cleanup scan deferred: ${String(error)}`,
    );
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !MANAGED_INSTALL_BACKUP_DIRECTORY_PATTERN.test(entry.name)) continue;
    const retiredPath = join(params.installRoot, entry.name);
    try {
      await rm(retiredPath, { recursive: true, force: true });
    } catch (error) {
      reportManagedInstallWarningBestEffort(
        params.reportWarning,
        `retired managed install cleanup deferred for ${retiredPath}: ${String(error)}`,
      );
    }
  }
}

async function cleanupRetiredManagedVersionedReleases(params: Readonly<{
  releasesDir: string;
  activeReleaseDir: string;
  reportWarning?: (message: string) => void;
}>): Promise<void> {
  let entries;
  try {
    entries = await readdir(params.releasesDir, { withFileTypes: true });
  } catch (error) {
    reportManagedInstallWarningBestEffort(
      params.reportWarning,
      `retired managed release cleanup scan deferred: ${String(error)}`,
    );
    return;
  }

  const activeReleaseName = basename(params.activeReleaseDir);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === activeReleaseName || !MANAGED_VERSIONED_RELEASE_DIRECTORY_PATTERN.test(entry.name)) continue;
    const retiredPath = join(params.releasesDir, entry.name);
    try {
      await rm(retiredPath, { recursive: true, force: true });
    } catch (error) {
      reportManagedInstallWarningBestEffort(
        params.reportWarning,
        `retired managed release cleanup deferred for ${retiredPath}: ${String(error)}`,
      );
    }
  }
}

async function promoteVersionedManagedInstallCandidate(params: Readonly<{
  installRoot: string;
  candidatePath: string;
  reportWarning?: (message: string) => void;
}>): Promise<void> {
  const releasesDir = join(params.installRoot, '.releases');
  const activePath = join(params.installRoot, 'active');
  const releaseName = randomUUID();
  const activeReleaseDir = join(releasesDir, releaseName);
  const pendingActivePath = join(params.installRoot, `.active-${releaseName}`);

  await mkdir(releasesDir, { recursive: true });
  await rename(params.candidatePath, activeReleaseDir);
  try {
    // POSIX symlink replacement is atomic: launches observe a complete release, never a mixed current directory.
    await symlink(relative(params.installRoot, activeReleaseDir), pendingActivePath);
    await rename(pendingActivePath, activePath);
  } catch (error) {
    await rm(pendingActivePath, { force: true });
    await rm(activeReleaseDir, { recursive: true, force: true });
    throw error;
  }

  await cleanupRetiredManagedVersionedReleases({
    releasesDir,
    activeReleaseDir,
    reportWarning: params.reportWarning,
  });
}

export async function promoteManagedCurrentInstall(params: Readonly<{
  installRoot: string;
  candidatePath?: string;
  currentPath?: string;
  reportWarning?: (message: string) => void;
  activateVersionedRelease?: boolean;
}>): Promise<void> {
  const candidatePath = params.candidatePath ?? join(params.installRoot, 'next');
  const currentPath = params.currentPath ?? join(params.installRoot, 'current');
  const activePath = join(params.installRoot, 'active');

  await mkdir(params.installRoot, { recursive: true });
  await lstat(candidatePath);

  let didReportWait = false;
  await withWorkspaceBundleLock(async () => {
    if (
      params.activateVersionedRelease
      && process.platform !== 'win32'
      && (await pathExists(currentPath) || await pathExists(activePath))
    ) {
      await promoteVersionedManagedInstallCandidate({
        installRoot: params.installRoot,
        candidatePath,
        reportWarning: params.reportWarning,
      });
      return;
    }

    const backupPath = join(params.installRoot, `.current.backup-${process.pid}-${randomUUID()}`);
    const hadCurrent = await pathExists(currentPath);
    if (hadCurrent) {
      await rename(currentPath, backupPath);
    }

    try {
      await rename(candidatePath, currentPath);
    } catch (promotionError) {
      if (hadCurrent) {
        const currentExists = await pathExists(currentPath);
        const backupExists = await pathExists(backupPath);
        if (!currentExists && backupExists) {
          try {
            await rename(backupPath, currentPath);
          } catch (restoreError) {
            throw new Error(
              `Managed install promotion failed and the previous current install could not be restored: ${String(restoreError)}`,
              { cause: promotionError },
            );
          }
        }
      }
      throw promotionError;
    }

    await cleanupRetiredManagedInstallDirectories({
      installRoot: params.installRoot,
      reportWarning: params.reportWarning,
    });
  }, {
    lockPath: join(params.installRoot, '.lock', 'install.lock'),
    timeoutMs: MANAGED_INSTALL_COMMIT_LOCK_TIMEOUT_MS,
    staleAfterMs: MANAGED_INSTALL_COMMIT_LOCK_TIMEOUT_MS,
    platform: MANAGED_INSTALL_LOCK_PLATFORM,
    readProcessInstanceFingerprintSyncImpl: (pid) => readProcessInstanceFingerprintSync(pid, {
      platform: MANAGED_INSTALL_LOCK_PLATFORM,
    }),
    errorLabel: 'managed install commit lock',
    onWait: () => {
      if (didReportWait) return;
      didReportWait = true;
      reportManagedInstallWarningBestEffort(
        params.reportWarning,
        `waiting for another managed install transaction for ${params.installRoot}`,
      );
    },
  });
}
