import { randomUUID } from 'node:crypto';
import { copyFile, cp, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { copyDirectoryTreePreservingSymlinks } from './copyDirectoryTreePreservingSymlinks.js';
import { toRuntimeFsPath } from './runtimeFsPath.js';

export { toWindowsExtendedLengthPathForFs } from './runtimeFsPath.js';

const BACKUP_CLEANUP_MAX_ATTEMPTS = 6;
const BACKUP_CLEANUP_RETRY_DELAY_MS = 25;

function shouldSkipPayloadPath(pathLike: string): boolean {
  const segments = pathLike.split(/[\\/]/).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.startsWith('._')) {
      return true;
    }
    if (segment === '.bin' && segments[index - 1] === 'node_modules') {
      return true;
    }
  }
  return false;
}

async function copyDirectoryContentsRecursively(sourceDir: string, destinationDir: string): Promise<void> {
  await copyDirectoryTreePreservingSymlinks({
    sourceDir,
    destinationDir,
    shouldSkipRelativePath: shouldSkipPayloadPath,
  });
}

function readErrorCode(error: unknown): string | null {
    if (typeof error !== 'object' || error === null || !('code' in error)) {
        return null;
  }
  return typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : null;
}

function isRetryableRenameError(error: unknown): boolean {
    const code = readErrorCode(error);
    return code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupBackupPathBestEffort(backupPath: string): Promise<void> {
  for (let attempt = 1; attempt <= BACKUP_CLEANUP_MAX_ATTEMPTS; attempt += 1) {
    try {
      await rm(toRuntimeFsPath(backupPath), { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isRetryableRenameError(error)) {
        throw error;
      }
      if (attempt === BACKUP_CLEANUP_MAX_ATTEMPTS) {
        return;
      }
      await sleep(BACKUP_CLEANUP_RETRY_DELAY_MS);
    }
  }
}

async function pruneSkippedPayloadPathsRecursively(rootDir: string, currentDir: string = rootDir): Promise<void> {
  const entries = await readdir(toRuntimeFsPath(currentDir), { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = join(currentDir, entry.name);
    const relativePath = entryPath.slice(rootDir.length).replace(/^[/\\]+/, '');

    if (shouldSkipPayloadPath(relativePath)) {
      await rm(toRuntimeFsPath(entryPath), { recursive: true, force: true });
      continue;
    }

    if (entry.isDirectory()) {
      await pruneSkippedPayloadPathsRecursively(rootDir, entryPath);
    }
  }
}

async function promoteStagedRuntimePayload(params: Readonly<{
    tempPath: string;
    destinationPath: string;
}>): Promise<void> {
    if (process.platform !== 'win32') {
        await rename(toRuntimeFsPath(params.tempPath), toRuntimeFsPath(params.destinationPath));
        return;
    }

    for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
            await rename(toRuntimeFsPath(params.tempPath), toRuntimeFsPath(params.destinationPath));
            return;
        } catch (error) {
            if (!isRetryableRenameError(error)) {
                throw error;
            }
            if (attempt < 3) {
                await sleep(25 * (attempt + 1));
                continue;
            }
        }
    }

    await rm(toRuntimeFsPath(params.destinationPath), { recursive: true, force: true }).catch(() => undefined);
    try {
        await copyDirectoryContentsRecursively(params.tempPath, params.destinationPath);
        await rm(toRuntimeFsPath(params.tempPath), { recursive: true, force: true });
    } catch (error) {
        await rm(toRuntimeFsPath(params.destinationPath), { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
}

export async function replaceRuntimePayloadTree(params: Readonly<{
  sourcePath: string;
  destinationPath: string;
  consumeSourcePath?: boolean;
  onTempReady?: (tempPath: string) => Promise<void> | void;
}>): Promise<void> {
  const destinationPath = params.destinationPath;
  const destinationParent = dirname(destinationPath);
  const destinationBasename = basename(destinationPath);
  const tempPath = join(destinationParent, `.${destinationBasename}.tmp-${process.pid}-${randomUUID()}`);
  const backupPath = join(destinationParent, `.${destinationBasename}.bak-${process.pid}-${randomUUID()}`);
  const destinationExists = await lstat(toRuntimeFsPath(destinationPath))
    .then(() => true)
    .catch(() => false);
  const shouldConsumeSourcePath = params.consumeSourcePath === true;
  let movedSourceIntoTemp = false;

  await rm(toRuntimeFsPath(tempPath), { recursive: true, force: true });
  await rm(toRuntimeFsPath(backupPath), { recursive: true, force: true });

  try {
    await mkdir(toRuntimeFsPath(destinationParent), { recursive: true });

    if (shouldConsumeSourcePath) {
      try {
        await rename(toRuntimeFsPath(params.sourcePath), toRuntimeFsPath(tempPath));
        movedSourceIntoTemp = true;
      } catch (error) {
        const code = readErrorCode(error);
        if (code !== 'EXDEV' && !isRetryableRenameError(error)) {
          throw error;
        }
      }
    }

    if (!movedSourceIntoTemp && process.platform === 'win32') {
      await copyDirectoryContentsRecursively(params.sourcePath, tempPath);
    } else if (!movedSourceIntoTemp) {
      await cp(toRuntimeFsPath(params.sourcePath), toRuntimeFsPath(tempPath), {
        recursive: true,
        filter: (sourcePath) => !shouldSkipPayloadPath(sourcePath),
      });
    } else {
      await pruneSkippedPayloadPathsRecursively(tempPath);
    }

    await params.onTempReady?.(tempPath);

    if (destinationExists) {
      await rename(toRuntimeFsPath(destinationPath), toRuntimeFsPath(backupPath));
    }

        await promoteStagedRuntimePayload({
            tempPath,
            destinationPath,
        });

    if (destinationExists) {
      await cleanupBackupPathBestEffort(backupPath);
    }
  } catch (error) {
    if (movedSourceIntoTemp) {
      const sourceExists = await lstat(toRuntimeFsPath(params.sourcePath))
        .then(() => true)
        .catch(() => false);
      if (!sourceExists) {
        await rename(toRuntimeFsPath(tempPath), toRuntimeFsPath(params.sourcePath)).catch(() => undefined);
      }
    } else {
      await rm(toRuntimeFsPath(tempPath), { recursive: true, force: true }).catch(() => undefined);
    }

    const backupExists = await lstat(toRuntimeFsPath(backupPath))
      .then(() => true)
      .catch(() => false);
    if (backupExists) {
      const destinationStillExists = await lstat(toRuntimeFsPath(destinationPath))
        .then(() => true)
        .catch(() => false);
      if (!destinationStillExists) {
        await rename(toRuntimeFsPath(backupPath), toRuntimeFsPath(destinationPath)).catch(() => undefined);
      }
    }

    throw error;
  }
}
