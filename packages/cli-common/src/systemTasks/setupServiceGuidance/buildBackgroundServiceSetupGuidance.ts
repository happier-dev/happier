import {
  resolvePublicReleaseRingIdForLabel,
  resolvePublicReleaseRingLabelForId,
  type PublicReleaseRingId,
  type PublicReleaseRingLabel,
} from '@happier-dev/release-runtime/releaseRings';

import type { ManagedReleaseChannelInventory } from '../../happierRuntime/deriveManagedReleaseChannelInventory.js';
import {
  resolveDaemonServiceInstallConflictPlan,
  type DaemonServiceInstallTarget,
} from '../../happierRuntime/daemonInstallConflict.js';
import type { HappierService, HappierServiceBackend, HappierServicePlatform, HappierServiceTargetMode } from '../../happierRuntime/types.js';

export type BackgroundServiceSetupGuidanceService = Readonly<{
  label: string;
  releaseChannel: PublicReleaseRingLabel | null;
  targetMode: HappierServiceTargetMode | null;
  running: boolean;
  serverUrl: string | null;
}>;

export type BackgroundServiceSetupGuidance = Readonly<{
  targetReleaseChannel: PublicReleaseRingLabel;
  targetServerUrl: string | null;
  currentDefaultReleaseChannel: PublicReleaseRingLabel;
  managedReleaseChannels: ManagedReleaseChannelInventory['managedReleaseChannels'];
  exactDefaultServiceExists: boolean;
  conflictingServices: readonly BackgroundServiceSetupGuidanceService[];
  shouldOfferDefaultReleaseChannelSwitch: boolean;
  shouldPromptForServiceReplacement: boolean;
}>;

function normalizeServiceSummary(service: HappierService): BackgroundServiceSetupGuidanceService | null {
  if (service.serviceType !== 'daemon') {
    return null;
  }

  const label = String(service.label ?? '').trim();
  if (!label) {
    return null;
  }

  const releaseChannel = service.ring === 'stable' || service.ring === 'preview' || service.ring === 'dev'
    ? service.ring
    : null;
  const targetMode = service.targetMode === 'default-following' || service.targetMode === 'pinned'
    ? service.targetMode
    : null;
  const serverUrl = typeof service.serverUrl === 'string' && service.serverUrl.trim()
    ? service.serverUrl.trim()
    : null;

  return {
    label,
    releaseChannel,
    targetMode,
    running: service.running === true,
    serverUrl,
  };
}

function resolveDaemonServiceBackend(platform: HappierServicePlatform, mode: 'user' | 'system'): HappierServiceBackend {
  if (platform === 'darwin') return 'launchd';
  if (platform === 'win32') return mode === 'system' ? 'schtasks-system' : 'schtasks-user';
  return mode === 'system' ? 'systemd-system' : 'systemd-user';
}

function resolveReleaseChannelLabel(value: PublicReleaseRingId | PublicReleaseRingLabel): PublicReleaseRingLabel {
  return value === 'stable' || value === 'preview' || value === 'dev'
    ? value
    : resolvePublicReleaseRingLabelForId(value);
}

export function buildBackgroundServiceSetupGuidance(params: Readonly<{
  targetReleaseChannel: PublicReleaseRingId | PublicReleaseRingLabel;
  targetServerUrl?: string | null;
  managedReleaseChannelInventory: ManagedReleaseChannelInventory;
  services: readonly HappierService[];
  platform: HappierServicePlatform;
  mode: 'user' | 'system';
}>): BackgroundServiceSetupGuidance {
  const targetReleaseChannel = resolveReleaseChannelLabel(params.targetReleaseChannel);
  const currentDefaultReleaseChannel = resolvePublicReleaseRingLabelForId(
    params.managedReleaseChannelInventory.defaultReleaseChannel,
  );
  const target: DaemonServiceInstallTarget = {
    platform: params.platform,
    backend: resolveDaemonServiceBackend(params.platform, params.mode),
    targetMode: 'default-following',
    ring: null,
    instanceId: null,
    serverUrl: null,
  };
  const conflictPlan = resolveDaemonServiceInstallConflictPlan({
    target,
    strategy: 'require-explicit',
    services: params.services,
  });
  const conflictingServices = conflictPlan.competingServices
    .map((service) => normalizeServiceSummary(service))
    .filter((service): service is BackgroundServiceSetupGuidanceService => service != null);

  return {
    targetReleaseChannel,
    targetServerUrl: typeof params.targetServerUrl === 'string' && params.targetServerUrl.trim()
      ? params.targetServerUrl.trim()
      : null,
    currentDefaultReleaseChannel,
    managedReleaseChannels: params.managedReleaseChannelInventory.managedReleaseChannels,
    exactDefaultServiceExists: conflictPlan.exactTargetExists,
    conflictingServices,
    shouldOfferDefaultReleaseChannelSwitch:
      currentDefaultReleaseChannel !== targetReleaseChannel
      && params.managedReleaseChannelInventory.managedReleaseChannels.some((entry) => (
        resolveReleaseChannelLabel(entry.releaseChannel) === targetReleaseChannel
      )),
    shouldPromptForServiceReplacement: conflictingServices.length > 0,
  };
}
