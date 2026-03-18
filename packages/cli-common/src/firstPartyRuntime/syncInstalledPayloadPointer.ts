import { cp, mkdir, rm, symlink } from 'node:fs/promises';
import { relative } from 'node:path';

import type { FirstPartyInstallLayout } from './installLayout.js';

export async function syncInstalledPayloadPointer(params: Readonly<{
  layout: FirstPartyInstallLayout;
  pointerPath: string;
  versionPath: string;
}>): Promise<void> {
  await rm(params.pointerPath, { recursive: true, force: true });

  if (process.platform === 'win32') {
    await mkdir(params.pointerPath, { recursive: true });
    await cp(params.versionPath, params.pointerPath, { recursive: true });
    return;
  }

  const relativeTarget = relative(params.layout.installRoot, params.versionPath);
  await symlink(relativeTarget, params.pointerPath, 'dir');
}
