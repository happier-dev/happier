import { copyFile, mkdir, rm, symlink } from 'node:fs/promises';
import { dirname, relative } from 'node:path';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import type { FirstPartyComponentId } from './componentCatalog.js';
import { resolveDesiredShimTargets } from './resolveDesiredShimTargets.js';

export interface SyncInstalledFirstPartyShimsResult {
  shimPaths: string[];
}

export async function syncInstalledFirstPartyShims(params: Readonly<{
  componentId: FirstPartyComponentId;
  channel?: PublicReleaseRingId;
  releaseRing?: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<SyncInstalledFirstPartyShimsResult> {
  const targets = await resolveDesiredShimTargets({
    componentId: params.componentId,
    channel: params.channel,
    releaseRing: params.releaseRing,
    processEnv: params.processEnv,
  });

  await Promise.all(targets.map(async ({ shimPath, binaryPath }) => {
    await mkdir(dirname(shimPath), { recursive: true });
    await rm(shimPath, { force: true, recursive: true });

    if (process.platform === 'win32') {
      await copyFile(binaryPath, shimPath);
      return;
    }

    await symlink(relative(dirname(shimPath), binaryPath), shimPath);
  }));

  return {
    shimPaths: targets.map((target) => target.shimPath),
  };
}
