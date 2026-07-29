import { rm } from 'node:fs/promises';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import type { FirstPartyComponentId } from './componentCatalog.js';
import { resolveFirstPartyInstallLayout } from './installLayout.js';
import { resolveInstalledFirstPartyComponentPaths } from './resolveInstalledComponentPaths.js';
import { withFirstPartyPayloadMutationLock } from './withFirstPartyPayloadMutationLock.js';

export type UninstallManagedFirstPartyComponentResult = Readonly<{
  removedPaths: string[];
}>;

export async function uninstallManagedFirstPartyComponent(params: Readonly<{
  componentId: FirstPartyComponentId;
  channel?: PublicReleaseRingId;
  releaseRing?: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<UninstallManagedFirstPartyComponentResult> {
  const layout = resolveFirstPartyInstallLayout({
    componentId: params.componentId,
    channel: params.channel,
    releaseRing: params.releaseRing,
    processEnv: params.processEnv,
  });
  return await withFirstPartyPayloadMutationLock({
    layout,
    operation: async () => {
      const paths = resolveInstalledFirstPartyComponentPaths({
        componentId: params.componentId,
        channel: params.channel,
        releaseRing: params.releaseRing,
        processEnv: params.processEnv,
      });

      await rm(paths.installRoot, { recursive: true, force: true });
      await Promise.all(paths.shimPaths.map(async (shimPath) => {
        await rm(shimPath, { recursive: true, force: true });
      }));

      return {
        removedPaths: [paths.installRoot, ...paths.shimPaths],
      };
    },
  });
}
