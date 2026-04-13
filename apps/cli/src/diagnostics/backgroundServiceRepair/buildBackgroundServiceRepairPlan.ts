import {
  buildBackgroundServiceRepairPlan as buildSharedBackgroundServiceRepairPlan,
  type HappierService,
} from '@happier-dev/cli-common/happierRuntime';
import { getReleaseRingCatalogEntry, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import type { DaemonServiceListEntry } from '@/daemon/service/cli';
import type { DaemonServiceMode } from '@/daemon/service/plan';
import type { BackgroundServiceRepairPlan } from './types';

function resolveServiceBackend(entry: DaemonServiceListEntry): HappierService['backend'] {
  if (entry.platform === 'darwin') return 'launchd';
  if (entry.platform === 'win32') return entry.mode === 'system' ? 'schtasks-system' : 'schtasks-user';
  return entry.mode === 'system' ? 'systemd-system' : 'systemd-user';
}

function mapListEntryToHappierService(entry: DaemonServiceListEntry): HappierService {
  return {
    id: `${entry.mode ?? 'user'}:${entry.label}`,
    serviceType: 'daemon',
    platform: entry.platform,
    backend: resolveServiceBackend(entry),
    label: entry.label,
    verification: 'verified',
    targetMode: entry.targetMode,
    ring: getReleaseRingCatalogEntry(entry.releaseChannel).publicLabel,
    instanceId: entry.serverId,
    scope: entry.mode === 'system' ? 'system' : 'user',
    definitionPath: entry.path,
    executablePath: null,
    installed: entry.installed,
    running: false,
  };
}

function isCurrentServerPinnedService(entry: DaemonServiceListEntry, currentServerId: string): boolean {
  return entry.targetMode === 'pinned' && entry.serverId === currentServerId;
}

export function buildBackgroundServiceRepairPlan(params: Readonly<{
  currentReleaseChannel: PublicReleaseRingId;
  currentServerId: string;
  preferredMode: DaemonServiceMode;
  services: readonly DaemonServiceListEntry[];
}>): BackgroundServiceRepairPlan {
  const repairableServices = params.services.filter((service) => (
    service.targetMode === 'default-following'
    || isCurrentServerPinnedService(service, params.currentServerId)
  ));
  const sharedPlan = buildSharedBackgroundServiceRepairPlan({
    currentReleaseChannel: params.currentReleaseChannel,
    preferredMode: params.preferredMode,
    services: repairableServices.map(mapListEntryToHappierService),
  });

  return {
    currentReleaseChannel: params.currentReleaseChannel,
    existingServices: [...params.services],
    actions: sharedPlan.actions.map((action) => action.kind === 'remove-service'
      ? {
        kind: 'remove-service' as const,
        service: {
          id: action.service.id,
          label: action.service.label,
          platform: action.service.platform,
          backend: action.service.backend,
          scope: action.service.scope,
          definitionPath: action.service.definitionPath,
          installedPath: action.service.definitionPath,
          mode: action.service.scope,
          releaseChannel: action.service.releaseChannel,
          targetMode: action.service.targetMode,
          instanceId: action.service.instanceId,
        },
      }
      : action),
    manualWarnings: [],
  };
}
