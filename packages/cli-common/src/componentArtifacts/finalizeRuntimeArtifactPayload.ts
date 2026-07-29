import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  utimes,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

async function removePackageManagerBinDirectories(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });

  await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.name === '.bin') {
      await rm(path, { recursive: true, force: true });
      return;
    }
    if (entry.isDirectory()) {
      await removePackageManagerBinDirectories(path);
    }
  }));
}

type PayloadTopology = Readonly<{
  hardlinkedFiles: readonly string[];
  symlinks: readonly string[];
}>;

const PAYLOAD_TOPOLOGY_INSPECTION_CONCURRENCY = 128;

function isWithinDirectory(directory: string, candidate: string): boolean {
  const relativeCandidate = relative(directory, candidate);
  return relativeCandidate === ''
    || (
      relativeCandidate !== '..'
      && !relativeCandidate.startsWith(`..${sep}`)
      && !isAbsolute(relativeCandidate)
    );
}

function displayPayloadPath(payloadDir: string, path: string): string {
  return relative(payloadDir, path) || '.';
}

async function inspectPayloadTopology(
  payloadDir: string,
  payloadRealPath: string,
  options: Readonly<{ allowPackageManagerBinRemovalLeaves?: boolean }> = {},
): Promise<PayloadTopology> {
  const symlinks: string[] = [];
  const hardlinkedFiles: string[] = [];
  const nodeModulesDir = join(payloadDir, 'node_modules');

  async function inspectPath(path: string): Promise<readonly string[]> {
    const entryStats = await lstat(path);
    if (
      options.allowPackageManagerBinRemovalLeaves === true
      && basename(path) === '.bin'
      && isWithinDirectory(nodeModulesDir, path)
    ) {
      return [];
    }
    if (entryStats.isDirectory()) {
      return (await readdir(path))
        .sort()
        .map((entry) => join(path, entry));
    }
    if (entryStats.isFile()) {
      if (entryStats.nlink > 1) hardlinkedFiles.push(path);
      return [];
    }
    if (entryStats.isSymbolicLink()) {
      let resolvedTarget: string;
      try {
        resolvedTarget = await realpath(path);
      } catch (error) {
        throw new Error(
          `[component-artifacts] runtime payload symlink cannot be resolved: ${displayPayloadPath(payloadDir, path)}`,
          { cause: error },
        );
      }
      if (!isWithinDirectory(payloadRealPath, resolvedTarget)) {
        throw new Error(
          `[component-artifacts] runtime payload symlink escapes the artifact: ${displayPayloadPath(payloadDir, path)} -> ${resolvedTarget}`,
        );
      }

      const targetStats = await stat(path);
      if (!targetStats.isDirectory() && !targetStats.isFile()) {
        throw new Error(
          `[component-artifacts] runtime payload symlink targets an unsupported file type: ${displayPayloadPath(payloadDir, path)}`,
        );
      }
      if (targetStats.isDirectory() && isWithinDirectory(resolvedTarget, path)) {
        throw new Error(
          `[component-artifacts] runtime payload symlink forms a directory cycle: ${displayPayloadPath(payloadDir, path)}`,
        );
      }
      symlinks.push(path);
      return [];
    }
    throw new Error(
      `[component-artifacts] runtime payload contains an unsupported file type: ${displayPayloadPath(payloadDir, path)}`,
    );
  }

  let pendingPaths = (await readdir(payloadDir))
    .sort()
    .map((entry) => join(payloadDir, entry));
  while (pendingPaths.length > 0) {
    const nextPaths: string[] = [];
    for (
      let offset = 0;
      offset < pendingPaths.length;
      offset += PAYLOAD_TOPOLOGY_INSPECTION_CONCURRENCY
    ) {
      const paths = pendingPaths.slice(offset, offset + PAYLOAD_TOPOLOGY_INSPECTION_CONCURRENCY);
      const results = await Promise.allSettled(paths.map(inspectPath));
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
        nextPaths.push(...result.value);
      }
    }
    pendingPaths = nextPaths;
  }
  return {
    hardlinkedFiles: hardlinkedFiles.sort(),
    symlinks: symlinks.sort(),
  };
}

async function materializeSymlink(path: string): Promise<void> {
  const temporaryDirectory = await mkdtemp(join(dirname(path), '.happier-materialize-link-'));
  const stagedPath = join(temporaryDirectory, 'entry');
  const originalPath = join(temporaryDirectory, 'original');
  let originalMoved = false;
  try {
    await cp(path, stagedPath, {
      dereference: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      recursive: true,
    });
    await rename(path, originalPath);
    originalMoved = true;
    try {
      await rename(stagedPath, path);
      originalMoved = false;
    } catch (error) {
      await rename(originalPath, path);
      originalMoved = false;
      throw error;
    }
  } finally {
    if (!originalMoved) {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  }
}

async function breakHardlink(path: string): Promise<void> {
  const entryStats = await stat(path);
  const temporaryDirectory = await mkdtemp(join(dirname(path), '.happier-break-hardlink-'));
  const stagedPath = join(temporaryDirectory, 'entry');
  const originalPath = join(temporaryDirectory, 'original');
  let originalMoved = false;
  try {
    await copyFile(path, stagedPath, fsConstants.COPYFILE_EXCL);
    await chmod(stagedPath, entryStats.mode & 0o7777);
    await utimes(stagedPath, entryStats.atime, entryStats.mtime);
    await rename(path, originalPath);
    originalMoved = true;
    try {
      await rename(stagedPath, path);
      originalMoved = false;
    } catch (error) {
      await rename(originalPath, path);
      originalMoved = false;
      throw error;
    }
  } finally {
    if (!originalMoved) {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  }
}

export async function finalizeRuntimeArtifactPayload(payloadDir: string): Promise<void> {
  const payloadStats = await lstat(payloadDir);
  if (!payloadStats.isDirectory() || payloadStats.isSymbolicLink()) {
    throw new Error('[component-artifacts] runtime payload root must be a physical directory');
  }

  const payloadRealPath = await realpath(payloadDir);
  await inspectPayloadTopology(payloadDir, payloadRealPath, {
    allowPackageManagerBinRemovalLeaves: true,
  });
  await removePackageManagerBinDirectories(join(payloadDir, 'node_modules'));
  const topology = await inspectPayloadTopology(payloadDir, payloadRealPath);
  const symlinksDeepestFirst = [...topology.symlinks]
    .sort((left, right) => right.split(sep).length - left.split(sep).length);
  for (const path of symlinksDeepestFirst) {
    await materializeSymlink(path);
  }
  for (const path of topology.hardlinkedFiles) {
    await breakHardlink(path);
  }

  // A materialized directory link can introduce package-manager shims that were not
  // traversable during the initial cleanup.
  await removePackageManagerBinDirectories(join(payloadDir, 'node_modules'));

  const finalizedTopology = await inspectPayloadTopology(payloadDir, payloadRealPath);
  if (finalizedTopology.symlinks.length > 0 || finalizedTopology.hardlinkedFiles.length > 0) {
    throw new Error('[component-artifacts] runtime payload finalization left linked entries behind');
  }
}
