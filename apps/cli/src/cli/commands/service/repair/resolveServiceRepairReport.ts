import {
  buildHappierRuntimeWarnings,
  discoverHappierInstallations,
  discoverHappierServices,
  type HappierService,
} from '@happier-dev/cli-common/happierRuntime';
import { createRelayHostEngine } from '@happier-dev/cli-common/relayHost';
import { normalizePublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { validateStoredAuthTokenAgainstActiveServer } from '@/auth/validateStoredAuthTokenAgainstActiveServer';
import { resolveInvokerName } from '@/cli/runtime/resolveInvokerName';
import { listDaemonStatusesForAllKnownServers, type DaemonStatusEntry } from '@/daemon/multiDaemon';
import { readBackgroundServiceHealth } from '@/daemon/service/readBackgroundServiceHealth';
import { readDaemonStatusSnapshot } from '@/daemon/statusSnapshot';
import { resolveBackgroundServiceRepairPlanForCurrentRuntime } from '@/diagnostics/backgroundServiceRepair/resolveBackgroundServiceRepairPlanForCurrentRuntime';
import type { DaemonServiceMode } from '@/daemon/service/plan';
import { readStoredCredentials } from '@/persistence';

import { buildServiceRepairReport } from './buildServiceRepairReport';
import type {
  AuthProfileEntry,
  BackgroundServiceHealthSummary,
  LocalRelayEntry,
  RunningDaemonEntry,
  ServiceRepairDaemonStatusSnapshot,
  ServiceRepairResolution,
  StackEntry,
} from './types';

type LocalRelayChannel = 'stable' | 'preview' | 'dev';

const LOCAL_RELAY_CHANNELS: readonly LocalRelayChannel[] = ['stable', 'preview', 'dev'];

function readInjectedDaemonStatus(raw: unknown): ServiceRepairDaemonStatusSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const snapshot = raw as Readonly<Record<string, unknown>>;
  if (!snapshot.daemon || typeof snapshot.daemon !== 'object') return null;
  return snapshot as ServiceRepairDaemonStatusSnapshot;
}

function normalizeReleaseChannel(value: unknown): LocalRelayChannel | null {
  const normalized = String(value ?? '').trim();
  if (normalized === 'stable' || normalized === 'preview' || normalized === 'dev') {
    return normalized;
  }
  if (normalized === 'publicdev') {
    return 'dev';
  }
  return null;
}

function normalizeReleaseChannelForComparison(value: unknown): string | null {
  const publicReleaseRingId = normalizePublicReleaseRingId(value);
  if (publicReleaseRingId) {
    return publicReleaseRingId;
  }
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function releaseChannelsMatch(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizeReleaseChannelForComparison(left);
  const normalizedRight = normalizeReleaseChannelForComparison(right);
  return normalizedLeft !== null && normalizedRight !== null && normalizedLeft === normalizedRight;
}

function createLocalRelayLookupEngine() {
  return createRelayHostEngine({
    installRemoteComponent: async () => {
      throw new Error('Remote component installation is not available for service repair local relay inventory.');
    },
    resolveRemoteReleaseTarget: async () => {
      throw new Error('Remote target resolution is not available for service repair local relay inventory.');
    },
    runRemoteText: async () => {
      throw new Error('Remote execution is not available for service repair local relay inventory.');
    },
    copyLocalDirectoryToRemote: async () => {
      throw new Error('Remote copy is not available for service repair local relay inventory.');
    },
  });
}

async function readLocalRelayInventory(currentReleaseChannel: string): Promise<readonly LocalRelayEntry[]> {
  const currentChannel = normalizeReleaseChannel(currentReleaseChannel);
  const engine = createLocalRelayLookupEngine();
  const entries = await Promise.all(LOCAL_RELAY_CHANNELS.map(async (channel): Promise<LocalRelayEntry | null> => {
    const status = await engine.readStatus({
      target: { kind: 'local' },
      channel,
      mode: 'user',
    }).catch(() => null);
    if (!status) {
      return null;
    }
    if (!status.installed && channel !== currentChannel) {
      return null;
    }
    const diagnostic = status.warnings && status.warnings.length > 0
      ? status.warnings.join('; ')
      : null;
    return {
      id: `local-relay-${channel}`,
      releaseChannel: channel,
      url: status.baseUrl,
      active: channel === currentChannel && status.installed === true,
      installed: status.installed,
      running: status.service.active,
      healthy: status.healthy ?? null,
      version: status.version,
      versionStale: diagnostic ? /legacy|stale|stranded/iu.test(diagnostic) : null,
      diagnostic,
    };
  }));
  return entries.filter((entry): entry is LocalRelayEntry => entry !== null);
}

function buildAuthProfilesFromDaemonStatuses(statuses: readonly DaemonStatusEntry[] | null): readonly AuthProfileEntry[] | undefined {
  if (!statuses) {
    return undefined;
  }
  return statuses.map((status) => {
    const authenticated = status.auth?.authenticated ?? null;
    return {
      id: status.serverId,
      active: status.drift?.matchesActiveRelay === true,
      authenticated,
      authState: authenticated === true ? 'authenticated' : authenticated === false ? 'missing' : 'unknown',
      machineRegistered: status.auth?.machineRegistered ?? null,
    };
  });
}

async function resolveAuthProfilesFromDaemonStatuses(
  statuses: readonly DaemonStatusEntry[] | null,
): Promise<readonly AuthProfileEntry[] | undefined> {
  const profiles = buildAuthProfilesFromDaemonStatuses(statuses);
  const activeProfile = profiles?.find((profile) => profile.active) ?? null;
  if (!profiles || !activeProfile) {
    return profiles;
  }

  const credentials = await readStoredCredentials().catch(() => null);
  const token = String(credentials?.token ?? '').trim();
  if (!token) {
    return profiles;
  }

  const validation = await validateStoredAuthTokenAgainstActiveServer(token).catch(() => null);
  if (!validation || validation.state === 'unknown') {
    return profiles;
  }

  return profiles.map((profile) => {
    if (!profile.active) {
      return profile;
    }
    if (validation.state === 'invalid') {
      return {
        ...profile,
        authenticated: true,
        authState: 'expired',
      };
    }
    return {
      ...profile,
      authenticated: true,
      authState: 'authenticated',
    };
  });
}

function buildStacksFromDaemonStatuses(params: Readonly<{
  statuses: readonly DaemonStatusEntry[] | null;
  services: readonly HappierService[];
  repairServices: ServiceRepairResolution['plan']['existingServices'];
  currentReleaseChannel: string;
}>): readonly StackEntry[] | undefined {
  if (!params.statuses) {
    return undefined;
  }
  const releaseChannelsByServerId = new Map<string, Set<string>>();
  const addReleaseChannel = (serverId: unknown, releaseChannel: unknown): void => {
    const normalizedServerId = String(serverId ?? '').trim();
    const normalizedReleaseChannel = normalizeReleaseChannelForComparison(releaseChannel);
    if (!normalizedServerId || !normalizedReleaseChannel) {
      return;
    }
    releaseChannelsByServerId.set(
      normalizedServerId,
      new Set([...(releaseChannelsByServerId.get(normalizedServerId) ?? []), normalizedReleaseChannel]),
    );
  };

  for (const service of params.services) {
    if (service.serviceType !== 'daemon') {
      continue;
    }
    addReleaseChannel(service.instanceId, service.ring);
  }
  for (const service of params.repairServices) {
    addReleaseChannel(service.serverId, service.releaseChannel);
  }

  const releaseChannelByServerId = new Map(
    [...releaseChannelsByServerId.entries()].flatMap(([serverId, releaseChannels]) =>
      releaseChannels.size === 1 ? [[serverId, [...releaseChannels][0]!] as const] : []),
  );

  return params.statuses.map((status) => ({
    id: status.serverId,
    releaseChannel: releaseChannelByServerId.get(status.serverId)
      ?? (status.drift?.matchesActiveRelay === true ? params.currentReleaseChannel : null),
    active: status.drift?.matchesActiveRelay === true,
  }));
}

function buildRunningDaemonsFromDaemonStatuses(statuses: readonly DaemonStatusEntry[] | null): readonly RunningDaemonEntry[] | undefined {
  if (!statuses) {
    return undefined;
  }
  return statuses
    .filter((status) => status.daemon.running)
    .map((status) => ({
      label: status.serverId,
      releaseChannel: null,
      version: null,
      serviceManaged: status.service.running ?? null,
      managedByEntryId: null,
      profileId: status.serverId,
    }));
}

function findServiceForHealth(params: Readonly<{
  services: readonly HappierService[];
  daemonStatus: ServiceRepairDaemonStatusSnapshot | null;
  currentReleaseChannel: string;
}>): HappierService | null {
  const serviceLabel = String(params.daemonStatus?.daemon.serviceLabel ?? '').trim();
  if (serviceLabel) {
    const matchingLabel = params.services.find((service) => service.serviceType === 'daemon' && service.label === serviceLabel);
    if (matchingLabel) {
      return matchingLabel;
    }
  }
  return params.services.find((service) =>
    service.serviceType === 'daemon'
    && service.installed
    && (
      service.targetMode === 'default-following'
      || releaseChannelsMatch(service.ring, params.currentReleaseChannel)
    )) ?? null;
}

function readServiceHealth(params: Readonly<{
  runtime: ServiceRepairResolution['runtime'];
  services: readonly HappierService[];
  daemonStatus: ServiceRepairDaemonStatusSnapshot | null;
}>): BackgroundServiceHealthSummary | null {
  const service = findServiceForHealth({
    services: params.services,
    daemonStatus: params.daemonStatus,
    currentReleaseChannel: String(params.runtime.channel ?? '').trim(),
  });
  if (!service) {
    return null;
  }
  const health = readBackgroundServiceHealth({
    platform: service.platform,
    label: service.label,
    uid: params.runtime.uid,
    errLogPath: null,
    mode: service.scope === 'system' ? 'system' : 'user',
  });
  return {
    status: health.isCrashLooping
      ? 'crash_looping'
      : service.running
        ? 'running'
        : service.installed
          ? 'stopped'
          : 'unknown',
    reason: health.lastErrorLine ?? health.suspectedCause,
    details: {
      restartCount: health.runs,
      lastExitStatus: health.lastExitCode,
    },
  };
}

export async function resolveServiceRepairReport(params: Readonly<{
  preferredMode: DaemonServiceMode;
  includeAllModes: boolean;
  systemUser: string;
}>): Promise<ServiceRepairResolution> {
  const repairResolution = await resolveBackgroundServiceRepairPlanForCurrentRuntime(params);
  const injectedWarnings = (repairResolution as Readonly<{ warnings?: unknown }>).warnings;
  const injectedWarningsArray = Array.isArray(injectedWarnings) ? injectedWarnings : null;
  const injectedDaemonStatus = readInjectedDaemonStatus((repairResolution as Readonly<{ daemonStatus?: unknown }>).daemonStatus);

  const [installations, services, daemonStatus, daemonStatuses, localRelays] = injectedWarningsArray
    ? [null, null, injectedDaemonStatus, null, []] as const
    : await Promise.all([
        discoverHappierInstallations({
          processEnv: process.env,
          invokedPath: String(process.env.HAPPIER_CLI_INVOKED_PATH ?? process.argv[1] ?? '').trim() || null,
          invokerName: resolveInvokerName(),
        }).catch(() => null),
        discoverHappierServices({ processEnv: process.env }).catch(() => null),
        readDaemonStatusSnapshot().catch(() => null),
        listDaemonStatusesForAllKnownServers().catch(() => null),
        readLocalRelayInventory(String(repairResolution.runtime.channel ?? '')).catch(() => []),
      ]);
  const warnings = injectedWarningsArray
    ? injectedWarningsArray
    : installations && services
      ? buildHappierRuntimeWarnings({
          installations,
          services,
          ...(daemonStatus ? { daemonStatus } : {}),
        })
      : [];
  const discoveredServices = services?.services ?? [];
  const backgroundServiceHealth = readServiceHealth({
    runtime: repairResolution.runtime,
    services: discoveredServices,
    daemonStatus,
  });
  const authProfiles = await resolveAuthProfilesFromDaemonStatuses(daemonStatuses);
  const report = buildServiceRepairReport({
    runtime: repairResolution.runtime,
    plan: repairResolution.plan,
    warnings,
    discoveredServices,
    daemonStatus,
    backgroundServiceHealth,
    runningDaemons: buildRunningDaemonsFromDaemonStatuses(daemonStatuses),
    localRelays,
    authProfiles,
    stacks: buildStacksFromDaemonStatuses({
      statuses: daemonStatuses,
      services: discoveredServices,
      repairServices: repairResolution.plan.existingServices,
      currentReleaseChannel: String(repairResolution.runtime.channel ?? ''),
    }),
  });

  return {
    runtime: repairResolution.runtime,
    plan: repairResolution.plan,
    report,
  };
}
