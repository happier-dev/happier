import { randomUUID } from 'node:crypto';
import { copyFile, cp, lstat, mkdir, open, readdir, readlink, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { copyDirectoryTreePreservingSymlinks } from './copyDirectoryTreePreservingSymlinks.js';
import { toRuntimeFsPath } from './runtimeFsPath.js';

export { toWindowsExtendedLengthPathForFs } from './runtimeFsPath.js';

const BACKUP_CLEANUP_MAX_ATTEMPTS = 6;
const BACKUP_CLEANUP_RETRY_DELAY_MS = 25;
const PAYLOAD_COMPARISON_BUFFER_SIZE = 64 * 1024;

export class FirstPartyVersionIdConflictError extends Error {
  readonly code = 'FIRST_PARTY_VERSION_ID_CONFLICT';
  readonly destinationPath: string;

  constructor(destinationPath: string) {
    super(`Refusing to replace immutable first-party payload version at '${destinationPath}' with different bytes.`);
    this.name = 'FirstPartyVersionIdConflictError';
    this.destinationPath = destinationPath;
  }
}

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

async function fileContentsMatch(params: Readonly<{
  leftPath: string;
  rightPath: string;
  size: number;
}>): Promise<boolean> {
  const leftHandle = await open(toRuntimeFsPath(params.leftPath), 'r');
  let rightHandle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    rightHandle = await open(toRuntimeFsPath(params.rightPath), 'r');
    const leftBuffer = Buffer.allocUnsafe(PAYLOAD_COMPARISON_BUFFER_SIZE);
    const rightBuffer = Buffer.allocUnsafe(PAYLOAD_COMPARISON_BUFFER_SIZE);
    let position = 0;
    while (position < params.size) {
      const bytesToRead = Math.min(PAYLOAD_COMPARISON_BUFFER_SIZE, params.size - position);
      const [leftRead, rightRead] = await Promise.all([
        leftHandle.read(leftBuffer, 0, bytesToRead, position),
        rightHandle.read(rightBuffer, 0, bytesToRead, position),
      ]);
      if (
        leftRead.bytesRead !== bytesToRead
        || rightRead.bytesRead !== bytesToRead
        || !leftBuffer.subarray(0, bytesToRead).equals(rightBuffer.subarray(0, bytesToRead))
      ) {
        return false;
      }
      position += bytesToRead;
    }
    return true;
  } finally {
    await Promise.allSettled([
      leftHandle.close(),
      ...(rightHandle ? [rightHandle.close()] : []),
    ]);
  }
}

async function runtimePayloadTreesMatch(leftPath: string, rightPath: string): Promise<boolean> {
  const [leftStats, rightStats] = await Promise.all([
    lstat(toRuntimeFsPath(leftPath)),
    lstat(toRuntimeFsPath(rightPath)),
  ]);

  if (leftStats.isSymbolicLink() || rightStats.isSymbolicLink()) {
    if (!leftStats.isSymbolicLink() || !rightStats.isSymbolicLink()) {
      return false;
    }
    const [leftTarget, rightTarget] = await Promise.all([
      readlink(toRuntimeFsPath(leftPath)),
      readlink(toRuntimeFsPath(rightPath)),
    ]);
    return leftTarget === rightTarget;
  }

  if (leftStats.isDirectory() || rightStats.isDirectory()) {
    if (!leftStats.isDirectory() || !rightStats.isDirectory()) {
      return false;
    }
    const [leftNames, rightNames] = await Promise.all([
      readdir(toRuntimeFsPath(leftPath)),
      readdir(toRuntimeFsPath(rightPath)),
    ]);
    leftNames.sort();
    rightNames.sort();
    if (
      leftNames.length !== rightNames.length
      || leftNames.some((name, index) => name !== rightNames[index])
    ) {
      return false;
    }
    for (const name of leftNames) {
      if (!await runtimePayloadTreesMatch(join(leftPath, name), join(rightPath, name))) {
        return false;
      }
    }
    return true;
  }

  if (!leftStats.isFile() || !rightStats.isFile()) {
    return false;
  }
  if (
    leftStats.size !== rightStats.size
    || (process.platform !== 'win32' && (leftStats.mode & 0o111) !== (rightStats.mode & 0o111))
  ) {
    return false;
  }
  return await fileContentsMatch({
    leftPath,
    rightPath,
    size: leftStats.size,
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

export async function removeRuntimePayloadPath(path: string): Promise<void> {
    for (let attempt = 1; attempt <= BACKUP_CLEANUP_MAX_ATTEMPTS; attempt += 1) {
        try {
            await rm(toRuntimeFsPath(path), { recursive: true, force: true });
            return;
        } catch (error) {
            if (!isRetryableRenameError(error) || attempt === BACKUP_CLEANUP_MAX_ATTEMPTS) {
                throw error;
            }
            await sleep(BACKUP_CLEANUP_RETRY_DELAY_MS);
        }
    }
}

async function cleanupBackupPathBestEffort(backupPath: string): Promise<void> {
    await removeRuntimePayloadPath(backupPath).catch(() => undefined);
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
  sourcePathAlreadyFiltered?: boolean;
  existingDestinationPolicy?: 'replace' | 'require-identical';
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
    } else if (!params.sourcePathAlreadyFiltered) {
      await pruneSkippedPayloadPathsRecursively(tempPath);
    }

    await params.onTempReady?.(tempPath);

    if (destinationExists && params.existingDestinationPolicy === 'require-identical') {
      if (!await runtimePayloadTreesMatch(destinationPath, tempPath)) {
        throw new FirstPartyVersionIdConflictError(destinationPath);
      }
      await rm(toRuntimeFsPath(tempPath), { recursive: true, force: true });
      return;
    }

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
