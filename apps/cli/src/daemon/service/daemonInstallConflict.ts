import {
  daemonServiceMatchesInstallTarget as daemonServiceMatchesCanonicalInstallTarget,
  resolveDaemonServiceInstallConflictPlan as resolveCanonicalDaemonServiceInstallConflictPlan,
  type DaemonServiceInstallStrategy,
  type DaemonServiceInstallTarget as CanonicalDaemonServiceInstallTarget,
  type HappierService,
  type HappierServiceBackend,
} from '@happier-dev/cli-common/happierRuntime';
import { resolvePublicReleaseRingLabelForId } from '@happier-dev/release-runtime/releaseRings';

import type { InstalledDaemonServiceEntry } from './discoverInstalledDaemonServiceEntries';
import type { DaemonServiceMode, DaemonServiceTargetMode } from './plan';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

export type { DaemonServiceInstallStrategy };

export type DaemonServiceInstallTarget = Readonly<{
  platform: InstalledDaemonServiceEntry['platform'];
  mode: DaemonServiceMode;
  targetMode: DaemonServiceTargetMode;
  ring: PublicReleaseRingId | null;
  instanceId: string | null;
  happierHomeDir: string | null;
  /** Pinned targets: the relay the service is pinned to, so other Homes' services never compete. */
  serverUrl?: string | null;
  /** Default-following targets: the server the service follows (the active server). */
  followedServerId?: string | null;
}>;

export type DaemonServiceInstallConflictPlan = Readonly<{
  exactTargetExists: boolean;
  exactTargetIsConverged: boolean;
  competingServices: readonly InstalledDaemonServiceEntry[];
  foreignHomeConflicts: readonly InstalledDaemonServiceEntry[];
  servicesToRemove: readonly InstalledDaemonServiceEntry[];
}>;

function resolveBackend(platform: InstalledDaemonServiceEntry['platform'], mode: DaemonServiceMode): HappierServiceBackend {
  if (platform === 'darwin') return 'launchd';
  if (platform === 'win32') return mode === 'system' ? 'schtasks-system' : 'schtasks-user';
  return mode === 'system' ? 'systemd-system' : 'systemd-user';
}

function toCanonicalTarget(target: DaemonServiceInstallTarget): CanonicalDaemonServiceInstallTarget {
  return {
    platform: target.platform,
    backend: resolveBackend(target.platform, target.mode),
    targetMode: target.targetMode,
    ring: target.ring === null ? null : resolvePublicReleaseRingLabelForId(target.ring),
    instanceId: target.instanceId,
    serverUrl: target.targetMode === 'pinned' ? target.serverUrl ?? null : null,
    followedServerId: target.targetMode === 'default-following' ? target.followedServerId ?? null : null,
    happierHomeDir: target.happierHomeDir,
  };
}

function toCanonicalService(service: InstalledDaemonServiceEntry): HappierService {
  return {
    id: service.path,
    serviceType: 'daemon',
    platform: service.platform,
    backend: resolveBackend(service.platform, service.mode ?? 'user'),
    label: service.label,
    targetMode: service.targetMode,
    verification: service.verification,
    ring: resolvePublicReleaseRingLabelForId(service.releaseChannel),
    instanceId: service.serverId,
    scope: service.mode ?? 'user',
    definitionPath: service.path,
    executablePath: null,
    happierHomeDir: service.happierHomeDir,
    serverUrl: service.relayUrl,
    publicServerUrl: service.relayUrl,
    installed: true,
    running: false,
  };
}

export function daemonServiceMatchesInstallTarget(
  service: InstalledDaemonServiceEntry,
  target: DaemonServiceInstallTarget,
): boolean {
  return daemonServiceMatchesCanonicalInstallTarget(toCanonicalService(service), toCanonicalTarget(target));
}

export function resolveDaemonServiceInstallConflictPlan(params: Readonly<{
  target: DaemonServiceInstallTarget;
  strategy: DaemonServiceInstallStrategy;
  services: readonly InstalledDaemonServiceEntry[];
}>): DaemonServiceInstallConflictPlan {
  const servicesById = new Map(params.services.map((service) => [service.path, service] as const));
  const plan = resolveCanonicalDaemonServiceInstallConflictPlan({
    target: toCanonicalTarget(params.target),
    strategy: params.strategy,
    services: params.services.map(toCanonicalService),
  });
  const restoreService = (service: HappierService): InstalledDaemonServiceEntry => {
    const installed = servicesById.get(service.id);
    if (!installed) throw new Error(`Unknown installed daemon service ${service.id}`);
    return installed;
  };

  return {
    exactTargetExists: plan.exactTargetExists,
    exactTargetIsConverged: plan.exactTargetIsConverged,
    competingServices: plan.competingServices.map(restoreService),
    foreignHomeConflicts: plan.foreignHomeConflicts.map(restoreService),
    servicesToRemove: plan.servicesToRemove.map(restoreService),
  };
}
