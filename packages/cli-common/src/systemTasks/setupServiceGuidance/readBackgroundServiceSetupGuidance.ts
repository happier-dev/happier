import {
  deriveManagedReleaseChannelInventory,
  discoverHappierInstallations,
  discoverHappierServices,
} from '../../happierRuntime/index.js';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { resolveHappyHomeDirFromEnvironment } from '../../agents/resolveHappyHomeDir.js';

import {
  buildBackgroundServiceSetupGuidance,
  type BackgroundServiceSetupGuidance,
} from './buildBackgroundServiceSetupGuidance.js';
import type { MachineDaemonOwnershipMetadata } from '@happier-dev/protocol';

function resolveCurrentHappierServicePlatform(): 'darwin' | 'linux' | 'win32' {
  return process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32'
    ? process.platform
    : 'darwin';
}

export async function readBackgroundServiceSetupGuidance(params: Readonly<{
  targetReleaseChannel: PublicReleaseRingId;
  targetServerUrl: string;
  currentRelayOwner?: Pick<MachineDaemonOwnershipMetadata, 'serviceManaged' | 'publicReleaseChannel' | 'cliVersion'> | null;
  mode?: 'user' | 'system';
}>): Promise<BackgroundServiceSetupGuidance> {
  const platform = resolveCurrentHappierServicePlatform();
  const inventory = await discoverHappierInstallations({
    processEnv: process.env,
    invokedPath: process.execPath,
  });
  const managedReleaseChannelInventory = await deriveManagedReleaseChannelInventory({
    inventory,
    processEnv: process.env,
  });
  const serviceInventory = await discoverHappierServices({
    processEnv: process.env,
    platform,
  });

  return buildBackgroundServiceSetupGuidance({
    targetReleaseChannel: params.targetReleaseChannel,
    targetServerUrl: params.targetServerUrl,
    currentHappierHomeDir: resolveHappyHomeDirFromEnvironment(process.env),
    managedReleaseChannelInventory,
    services: serviceInventory.services,
    currentRelayOwner: params.currentRelayOwner,
    platform,
    mode: params.mode ?? 'user',
  });
}
