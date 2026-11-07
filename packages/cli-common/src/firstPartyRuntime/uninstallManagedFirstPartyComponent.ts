import { removeHappierCliPathExposure } from './ensureHappierCliPathExposure.js';
import { releaseDesktopResourceUse, withDesktopResourceOwnership } from './desktopResourceOwnership.js';
import { doesCliLauncherUseInstallation } from './managedCliShimInstall.js';
import { access, rm } from 'node:fs/promises';

import { PUBLIC_RELEASE_RING_IDS, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import type { FirstPartyComponentId } from './componentCatalog.js';
import { resolveFirstPartyActivationLockTarget, resolveFirstPartyInstallLayout } from './installLayout.js';
import { resolveInstalledFirstPartyComponentPaths } from './resolveInstalledComponentPaths.js';
import { withFirstPartyActivationLock, withFirstPartyPayloadMutationLock } from './withFirstPartyPayloadMutationLock.js';
import { resolveDesiredShimTargets } from './resolveDesiredShimTargets.js';
import { syncInstalledFirstPartyShims } from './syncInstalledFirstPartyShims.js';
import {
  readDefaultManagedReleaseChannel,
  resolveDefaultManagedReleaseChannelStatePath,
  shouldPersistDefaultManagedReleaseChannel,
  writeDefaultManagedReleaseChannel,
} from './defaultReleaseChannelState.js';

export type UninstallManagedFirstPartyComponentResult = Readonly<{
  removedPaths: string[];
}>;

export async function uninstallManagedFirstPartyComponent(params: Readonly<{
  desktopBundleId?: string;
  remainingServiceLaunchers?: readonly (readonly string[])[];
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
      return await withFirstPartyActivationLock({
        activationLockTarget: resolveFirstPartyActivationLockTarget(layout),
        happyHomeDir: layout.happyHomeDir,
        operation: async () => {
          const remove = async (): Promise<UninstallManagedFirstPartyComponentResult> => {
            const paths = resolveInstalledFirstPartyComponentPaths({
              componentId: params.componentId,
              channel: params.channel,
              releaseRing: params.releaseRing,
              processEnv: params.processEnv,
            });

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
            await Promise.all(shimTargets.map(async ({ shimPath }) => {
              await rm(shimPath, { recursive: true, force: true });
            }));

            if (removesDefault) {
              let fallback: PublicReleaseRingId | null = null;
              for (const channel of PUBLIC_RELEASE_RING_IDS) {
                if (channel === layout.channel) continue;
                const candidate = resolveInstalledFirstPartyComponentPaths({ componentId: params.componentId, channel, processEnv: params.processEnv });
                try {
                  await access(candidate.resolvedBinaryPath ?? candidate.binaryPath);
                  fallback = channel;
                  break;
                } catch (error) {
                  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
                }
              }
              if (fallback) {
                await writeDefaultManagedReleaseChannel({ releaseChannel: fallback, processEnv: params.processEnv });
                await syncInstalledFirstPartyShims({ componentId: params.componentId, channel: fallback, processEnv: params.processEnv });
              } else {
                await rm(resolveDefaultManagedReleaseChannelStatePath({ processEnv: params.processEnv }), { force: true });
              }
            }

            return {
              removedPaths: [paths.installRoot, ...shimTargets.map(({ shimPath }) => shimPath)],
            };
          };
          if (!params.desktopBundleId) {
            return await withDesktopResourceOwnership({
              resourcePath: layout.installRoot,
              operation: async () => ({ value: await remove(), created: false }),
            });
          }
          let result: UninstallManagedFirstPartyComponentResult = { removedPaths: [] };
          await releaseDesktopResourceUse({
            resourcePath: layout.installRoot,
            bundleId: params.desktopBundleId,
            retainResource: params.remainingServiceLaunchers?.some((launcher) => doesCliLauncherUseInstallation({ launcher, installationRoots: [layout.installRoot] })) ?? false,
            remove: async () => { result = await remove(); },
          });
          return result;
        },
      });
    },
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
