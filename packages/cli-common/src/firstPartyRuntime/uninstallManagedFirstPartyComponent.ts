import { removeHappierCliPathExposure } from './ensureHappierCliPathExposure.js';
import { access, rm } from 'node:fs/promises';

import { PUBLIC_RELEASE_RING_IDS, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import type { FirstPartyComponentId } from './componentCatalog.js';
import { resolveFirstPartyInstallLayout } from './installLayout.js';
import { resolveInstalledFirstPartyComponentPaths } from './resolveInstalledComponentPaths.js';
import { withFirstPartyActivationLock, withFirstPartyPayloadMutationLock } from './withFirstPartyPayloadMutationLock.js';
import { resolveDesiredShimTargets } from './resolveDesiredShimTargets.js';
import { syncInstalledFirstPartyShims } from './syncInstalledFirstPartyShims.js';
import { releaseDesktopResourceUse, withDesktopResourceOwnership } from './desktopResourceOwnership.js';
import { doesCliLauncherUseInstallation } from './managedCliShimInstall.js';
import {
  readDefaultManagedReleaseChannel, resolveDefaultManagedReleaseChannelStatePath,
  shouldPersistDefaultManagedReleaseChannel, writeDefaultManagedReleaseChannel,
} from './defaultReleaseChannelState.js';

export type UninstallManagedFirstPartyComponentResult = Readonly<{ removedPaths: string[] }>;

/** Managed payload/shim removal owner; Desktop cleanup only supplies provenance and dependencies. */
export async function uninstallManagedFirstPartyComponent(params: Readonly<{
  componentId: FirstPartyComponentId;
  channel?: PublicReleaseRingId;
  releaseRing?: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
  desktopBundleId?: string;
  remainingServiceLaunchers?: readonly (readonly string[])[];
}>): Promise<UninstallManagedFirstPartyComponentResult> {
  const layout = resolveFirstPartyInstallLayout(params);
  return await withFirstPartyPayloadMutationLock({
    layout,
    operation: async () => await withFirstPartyActivationLock({
      happyHomeDir: layout.happyHomeDir,
      operation: async () => {
        const remove = async (): Promise<string[]> => {
          const paths = resolveInstalledFirstPartyComponentPaths(params);
          const shimTargets = await resolveDesiredShimTargets(params);
          const removesDefault = shouldPersistDefaultManagedReleaseChannel(params.componentId)
            && await readDefaultManagedReleaseChannel({ processEnv: params.processEnv }) === layout.channel;
          if (params.desktopBundleId && params.componentId === 'happier-cli') {
            let otherInstalledRoot = false;
            for (const channel of PUBLIC_RELEASE_RING_IDS) {
              if (channel === layout.channel) continue;
              try {
                await access(resolveFirstPartyInstallLayout({ ...params, channel, releaseRing: undefined }).installRoot);
                otherInstalledRoot = true;
                break;
              } catch (error) {
                if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
              }
            }
            if (!otherInstalledRoot) {
              const exposure = await removeHappierCliPathExposure({ processEnv: params.processEnv ?? process.env, binDir: layout.shimDir });
              if (exposure.failure) throw new Error(exposure.failure);
            }
          }
          await rm(paths.installRoot, { recursive: true, force: true });
          for (const { shimPath } of shimTargets) await rm(shimPath, { recursive: true, force: true });
          if (removesDefault) {
            let fallback: PublicReleaseRingId | null = null;
            for (const channel of PUBLIC_RELEASE_RING_IDS) {
              if (channel === layout.channel) continue;
              const candidate = resolveInstalledFirstPartyComponentPaths({ ...params, channel, releaseRing: undefined });
              try {
                await access(candidate.resolvedBinaryPath ?? candidate.binaryPath);
                fallback = channel;
                break;
              } catch (error) {
                if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
              }
            }
            if (fallback) {
              await writeDefaultManagedReleaseChannel({ releaseChannel: fallback, processEnv: params.processEnv });
              await syncInstalledFirstPartyShims({ ...params, channel: fallback, releaseRing: undefined });
            } else {
              await rm(resolveDefaultManagedReleaseChannelStatePath({ processEnv: params.processEnv }), { force: true });
            }
          }
          return [paths.installRoot, ...shimTargets.map(({ shimPath }) => shimPath)];
        };
        if (!params.desktopBundleId) {
          return await withDesktopResourceOwnership({
            resourcePath: layout.installRoot,
            operation: async () => ({ value: { removedPaths: await remove() }, created: false }),
          });
        }
        let removedPaths: string[] = [];
        await releaseDesktopResourceUse({
          resourcePath: layout.installRoot,
          bundleId: params.desktopBundleId,
          retainResource: params.remainingServiceLaunchers?.some((launcher) => doesCliLauncherUseInstallation({
            launcher, installationRoots: [layout.installRoot],
          })) ?? false,
          remove: async () => { removedPaths = await remove(); },
        });
        return { removedPaths };
      },
    }),
  });
}

/** Called by hsetup only after the canonical service-cleanup child has exited (Windows exe lock). */
export async function uninstallDesktopOwnedCli(params: Readonly<{
  bundleId: string;
  processEnv?: NodeJS.ProcessEnv;
  remainingServiceLaunchers: readonly (readonly string[])[];
}>): Promise<UninstallManagedFirstPartyComponentResult> {
  const removedPaths: string[] = [];
  for (const channel of PUBLIC_RELEASE_RING_IDS) {
    const removed = await uninstallManagedFirstPartyComponent({
      componentId: 'happier-cli', channel, processEnv: params.processEnv,
      desktopBundleId: params.bundleId, remainingServiceLaunchers: params.remainingServiceLaunchers,
    });
    removedPaths.push(...removed.removedPaths);
  }
  return { removedPaths };
}
