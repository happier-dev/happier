import { chmod, lstat, mkdir } from 'node:fs/promises';

import {
  ensureProtectedLocalStateDirectory,
  type ProtectedLocalStateOptions,
} from '@/utils/fs/protectedLocalState';

type MaterializedRootStat = Readonly<{
  dev: number;
  ino: number;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
  mode: number;
  uid: number;
}>;

export function isPrivateConnectedServiceMaterializedRootStat(
  stat: MaterializedRootStat,
  currentUid: number | null,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return !stat.isSymbolicLink()
    && stat.isDirectory()
    && (
      platform === 'win32'
      || (
        (stat.mode & 0o777) === 0o700
        && (currentUid === null || stat.uid === currentUid)
      )
    );
}

export async function ensurePrivateConnectedServiceMaterializedRoot(
  path: string,
  options: ProtectedLocalStateOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    try {
      await ensureProtectedLocalStateDirectory(path, options);
    } catch {
      throw new Error('connected_service_materialization_root_unsafe');
    }
    const privateStat = await lstat(path);
    if (!isPrivateConnectedServiceMaterializedRootStat(privateStat, null, platform)) {
      throw new Error('connected_service_materialization_root_unsafe');
    }
    return;
  }

  await mkdir(path, { recursive: true, mode: 0o700 });
  const initialStat = await lstat(path);
  const currentUid = options.expectedUid
    ?? (typeof process.getuid === 'function' ? process.getuid() : null);
  if (
    initialStat.isSymbolicLink()
    || !initialStat.isDirectory()
    || (
      currentUid !== null
      && initialStat.uid !== currentUid
    )
  ) {
    throw new Error('connected_service_materialization_root_unsafe');
  }
  if ((initialStat.mode & 0o777) !== 0o700) {
    await chmod(path, 0o700);
  }
  try {
    await ensureProtectedLocalStateDirectory(path, options);
  } catch {
    throw new Error('connected_service_materialization_root_unsafe');
  }
  const privateStat = await lstat(path);
  if (
    !isPrivateConnectedServiceMaterializedRootStat(privateStat, currentUid, platform)
    || (initialStat.dev !== 0 && privateStat.dev !== 0 && initialStat.dev !== privateStat.dev)
    || (initialStat.ino !== 0 && privateStat.ino !== 0 && initialStat.ino !== privateStat.ino)
  ) {
    throw new Error('connected_service_materialization_root_unsafe');
  }
}
