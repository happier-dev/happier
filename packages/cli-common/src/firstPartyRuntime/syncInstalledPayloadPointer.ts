import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm, symlink } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';

import type { FirstPartyInstallLayout } from './installLayout.js';
import { replaceRuntimePayloadTree } from './copyRuntimePayloadTree.js';

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object'
    && error != null
    && 'code' in error
    && (error as any).code === 'ENOENT';
}

async function atomicReplaceSymlink(params: Readonly<{
  linkPath: string;
  target: string;
  type: Parameters<typeof symlink>[2];
}>): Promise<void> {
  const linkPath = params.linkPath;
  const linkParent = dirname(linkPath);
  const linkBasename = basename(linkPath);
  const tempPath = join(linkParent, `.${linkBasename}.tmp-${process.pid}-${randomUUID()}`);
  const backupPath = join(linkParent, `.${linkBasename}.bak-${process.pid}-${randomUUID()}`);
  const linkExisted = await lstat(linkPath).then(() => true).catch(() => false);

  await rm(tempPath, { recursive: true, force: true });
  await rm(backupPath, { recursive: true, force: true });
  await mkdir(linkParent, { recursive: true });

  try {
    await symlink(params.target, tempPath, params.type);

    if (linkExisted) {
      await rename(linkPath, backupPath).catch((error) => {
        if (isMissingPathError(error)) {
          return;
        }
        throw error;
      });
    }

    await rename(tempPath, linkPath);

    if (linkExisted) {
      await rm(backupPath, { recursive: true, force: true });
    }
  } catch (error) {
    await rm(tempPath, { recursive: true, force: true }).catch(() => undefined);

    const backupExists = await lstat(backupPath).then(() => true).catch(() => false);
    if (backupExists) {
      const linkStillExists = await lstat(linkPath).then(() => true).catch(() => false);
      if (!linkStillExists) {
        await rename(backupPath, linkPath).catch(() => undefined);
      }
    }

    throw error;
  }
}

export async function syncInstalledPayloadPointer(params: Readonly<{
  layout: FirstPartyInstallLayout;
  pointerPath: string;
  versionPath: string;
}>): Promise<void> {
  if (process.platform === 'win32') {
    try {
      await atomicReplaceSymlink({
        linkPath: params.pointerPath,
        target: params.versionPath,
        type: 'junction',
      });
      return;
    } catch {
      await replaceRuntimePayloadTree({
        sourcePath: params.versionPath,
        destinationPath: params.pointerPath,
      });
    }
    return;
  }

  const relativeTarget = relative(params.layout.installRoot, params.versionPath);
  await atomicReplaceSymlink({
    linkPath: params.pointerPath,
    target: relativeTarget,
    type: 'dir',
  });
}
