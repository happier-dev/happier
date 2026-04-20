import { copyFileSync, linkSync, mkdirSync, rmSync } from 'node:fs';
import { mkdir, rm, symlink } from 'node:fs/promises';
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
  defaultReleaseChannelOverride?: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<SyncInstalledFirstPartyShimsResult> {
  const targets = await resolveDesiredShimTargets({
    componentId: params.componentId,
    channel: params.channel,
    defaultReleaseChannelOverride: params.defaultReleaseChannelOverride,
    releaseRing: params.releaseRing,
    processEnv: params.processEnv,
  });

  if (process.platform === 'win32') {
    for (const { shimPath, binaryPath } of targets) {
      mkdirSync(dirname(shimPath), { recursive: true });
      rmSync(shimPath, { force: true, recursive: true });
      try {
        linkSync(binaryPath, shimPath);
      } catch {
        copyFileSync(binaryPath, shimPath);
      }
    }
    return {
      shimPaths: targets.map((target) => target.shimPath),
    };
  }

  await Promise.all(targets.map(async ({ shimPath, binaryPath }) => {
    await mkdir(dirname(shimPath), { recursive: true });
    await rm(shimPath, { force: true, recursive: true });
    await symlink(relative(dirname(shimPath), binaryPath), shimPath);
  }));

  return {
    shimPaths: targets.map((target) => target.shimPath),
  };
}
