import { cp, lstat, mkdir, rename, rm, stat, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export type ConnectedServiceHomeEntryStat = Awaited<ReturnType<typeof stat>>;

export async function tryStatConnectedServiceHomeEntry(path: string): Promise<ConnectedServiceHomeEntryStat | null> {
  try {
    return await stat(path);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function removeLinkedConnectedServiceHomeEntries(
  destinationHome: string,
  entryNames: readonly string[],
): Promise<void> {
  for (const entryName of entryNames) {
    const destinationPath = join(destinationHome, entryName);
    let destinationStat;
    try {
      destinationStat = await lstat(destinationPath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code === 'ENOENT') continue;
      throw error;
    }
    if (destinationStat.isSymbolicLink()) {
      await rm(destinationPath, { recursive: true, force: true });
    }
  }
}

export async function moveConnectedServiceHomeEntryAside(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = `.local-${Date.now()}${attempt === 0 ? '' : `-${attempt}`}`;
    try {
      await rename(path, `${path}${suffix}`);
      return;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code === 'ENOENT') return;
      if (err?.code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new Error(`Unable to migrate existing connected-service home entry aside for ${path}`);
}

export async function prepareManagedConnectedServiceHomeDestination(destinationPath: string): Promise<void> {
  let destinationStat;
  try {
    destinationStat = await lstat(destinationPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') return;
    throw error;
  }
  if (destinationStat.isSymbolicLink()) {
    await rm(destinationPath, { recursive: true, force: true });
    return;
  }
  await moveConnectedServiceHomeEntryAside(destinationPath);
}

export async function copyConnectedServiceHomeEntry(sourcePath: string, destinationPath: string): Promise<void> {
  await mkdir(dirname(destinationPath), { recursive: true });
  await cp(sourcePath, destinationPath, {
    recursive: true,
    force: true,
    dereference: true,
    errorOnExist: false,
  });
}

export async function linkConnectedServiceHomeEntry(
  sourcePath: string,
  destinationPath: string,
  sourceStat: ConnectedServiceHomeEntryStat,
): Promise<void> {
  await mkdir(dirname(destinationPath), { recursive: true });
  const type = process.platform === 'win32'
    ? sourceStat.isDirectory()
      ? 'junction'
      : 'file'
    : sourceStat.isDirectory()
      ? 'dir'
      : 'file';
  await symlink(resolve(sourcePath), destinationPath, type);
}
