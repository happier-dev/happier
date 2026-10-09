import { realpath } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

import {
  isCanonicalAbsolutePathInsideRoot,
  resolveCanonicalAbsolutePath,
} from '@/utils/path/expandHomeDirPath';

export class DirectoryInCheckoutError extends Error {
  readonly code = 'directory_outside_checkout';

  constructor() {
    super('The selected directory is outside the materialized checkout');
    this.name = 'DirectoryInCheckoutError';
  }
}

/** Maps a selected source subdirectory into the SCM-owned materialized checkout. */
export async function resolveDirectoryInCheckout(input: Readonly<{
  sourceDirectory: string;
  sourceRootPath: string | undefined;
  checkoutRootPath: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}>): Promise<string> {
  const platform = input.platform ?? process.platform;
  const sourceRoot = input.sourceRootPath
    ? resolveCanonicalAbsolutePath(input.sourceRootPath, {
        env: input.env,
        platform,
      })
    : null;
  const sourceDirectory = resolveCanonicalAbsolutePath(input.sourceDirectory, {
    env: input.env,
    platform,
  });
  const checkoutRoot = resolveCanonicalAbsolutePath(input.checkoutRootPath, {
    env: input.env,
    platform,
  });
  if (!sourceRoot || !sourceDirectory || !checkoutRoot) {
    return checkoutRoot?.path ?? input.checkoutRootPath;
  }

  const resolveExistingPath = async (path: string) => {
    try {
      return await realpath(path);
    } catch {
      return path;
    }
  };
  const [existingSourceRoot, existingSourceDirectory] = await Promise.all([
    resolveExistingPath(sourceRoot.path),
    resolveExistingPath(sourceDirectory.path),
  ]);
  if (!isCanonicalAbsolutePathInsideRoot(existingSourceRoot, existingSourceDirectory, { platform })) {
    return checkoutRoot.path;
  }

  const pathApi = platform === 'win32' ? win32 : posix;
  const relativeSourcePath = pathApi.relative(existingSourceRoot, existingSourceDirectory);
  if (!relativeSourcePath) return checkoutRoot.path;
  const candidate = resolveCanonicalAbsolutePath(
    pathApi.resolve(checkoutRoot.path, relativeSourcePath),
    { env: input.env, platform },
  );
  if (!candidate || !isCanonicalAbsolutePathInsideRoot(checkoutRoot.path, candidate.path, { platform })) {
    throw new DirectoryInCheckoutError();
  }

  // Missing descendants may be created later. Resolve their nearest existing
  // ancestor so a symlink cannot hide an escape behind a missing leaf.
  const resolvePhysicalPath = async (path: string): Promise<string> => {
    let ancestor = path;
    const suffix: string[] = [];
    for (;;) {
      try {
        return pathApi.join(await realpath(ancestor), ...suffix);
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
        const parent = pathApi.dirname(ancestor);
        if (parent === ancestor) return path;
        suffix.unshift(pathApi.basename(ancestor));
        ancestor = parent;
      }
    }
  };
  const [physicalRoot, physicalDirectory] = await Promise.all([
    resolvePhysicalPath(checkoutRoot.path),
    resolvePhysicalPath(candidate.path),
  ]);
  if (!isCanonicalAbsolutePathInsideRoot(physicalRoot, physicalDirectory, { platform })) {
    throw new DirectoryInCheckoutError();
  }
  return candidate.path;
}
