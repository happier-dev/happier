import {
  buildBackgroundServiceRepairPlan as buildSharedBackgroundServiceRepairPlan,
  type HappierService,
} from '@happier-dev/cli-common/happierRuntime';
import { getReleaseRingCatalogEntry, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import type { DaemonServiceListEntry } from '@/daemon/service/cli';
import type { DaemonServiceMode } from '@/daemon/service/plan';
import { resolveHappierHomeDirComparableKey } from '@/daemon/ownership/happierHomeDirComparableKey';
import type { BackgroundServiceRepairPlan } from './types';

const UNKNOWN_REPAIRABLE_HAPPIER_HOME_DIR = '__background_service_repair_unknown_home__';

function resolveServiceBackend(entry: DaemonServiceListEntry): HappierService['backend'] {
  if (entry.platform === 'darwin') return 'launchd';
  if (entry.platform === 'win32') return entry.mode === 'system' ? 'schtasks-system' : 'schtasks-user';
  return entry.mode === 'system' ? 'systemd-system' : 'systemd-user';
}

function resolveRepairPlannerHappierHomeDir(params: Readonly<{
  entry: DaemonServiceListEntry;
  currentHappierHomeDir?: string | null;
}>): string {
  const serviceHappierHomeDir = resolveHappierHomeDirComparableKey(
    params.entry.happierHomeDir,
    params.entry.platform,
  );
  if (serviceHappierHomeDir !== null) {
    return serviceHappierHomeDir;
  }

  const currentHappierHomeDir = resolveHappierHomeDirComparableKey(
    params.currentHappierHomeDir,
    params.entry.platform,
  );
  if (currentHappierHomeDir !== null) {
    return currentHappierHomeDir;
  }

  // The CLI wrapper already performs the foreign-home and unknown-home safety checks.
  // When the current runtime cannot identify its home, keep the shared repair planner
  // focused on duplicate/removal behavior instead of failing closed on missing metadata.
  return UNKNOWN_REPAIRABLE_HAPPIER_HOME_DIR;
}

function mapListEntryToHappierService(
  entry: DaemonServiceListEntry,
  currentHappierHomeDir?: string | null,
): HappierService {
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
    happierHomeDir: resolveRepairPlannerHappierHomeDir({
      entry,
      currentHappierHomeDir,
    }),
    installed: entry.installed,
    running: false,
  };
}

function isCurrentServerPinnedService(entry: DaemonServiceListEntry, currentServerId: string): boolean {
  return entry.targetMode === 'pinned' && entry.serverId === currentServerId;
}

function isForeignHomeService(params: Readonly<{
  entry: DaemonServiceListEntry;
  currentHappierHomeDir: string | null | undefined;
}>): boolean {
  const currentHappierHomeDir = resolveHappierHomeDirComparableKey(
    params.currentHappierHomeDir,
    params.entry.platform,
  );
  const serviceHappierHomeDir = resolveHappierHomeDirComparableKey(
    params.entry.happierHomeDir,
    params.entry.platform,
  );
  return currentHappierHomeDir !== null
    && serviceHappierHomeDir !== null
    && currentHappierHomeDir !== serviceHappierHomeDir;
}

function isSameModeDefaultFollowingService(
  entry: DaemonServiceListEntry,
  preferredMode: DaemonServiceMode,
): boolean {
  return entry.targetMode === 'default-following'
    && (entry.mode === 'system' ? 'system' : 'user') === preferredMode;
}

function resolveServiceFilename(path: string | null | undefined): string {
  const normalizedPath = String(path ?? '').trim();
  if (!normalizedPath) {
    return '';
  }
  const segments = normalizedPath.split(/[\\/]+/);
  return segments[segments.length - 1] ?? '';
}

function isCanonicalDefaultFollowingService(service: DaemonServiceListEntry): boolean {
  if (service.targetMode !== 'default-following') {
    return false;
  }

  const label = String(service.label ?? '').trim().toLowerCase();
  if (
    label === 'happier-daemon.default'
    || label === 'com.happier.cli.daemon.default'
    || label === 'happier\\happier-daemon.default'
  ) {
    return true;
  }

  const filename = resolveServiceFilename(service.path).toLowerCase();
  return filename === 'happier-daemon.default.service'
    || filename === 'com.happier.cli.daemon.default.plist'
    || filename === 'com.happier.cli.daemon.default'
    || filename === 'happier-daemon.default.ps1';
}

function isLegacyChannelScopedDefaultService(service: DaemonServiceListEntry): boolean {
  if (service.targetMode !== 'default-following') {
    return false;
  }

  const label = String(service.label ?? '').trim().toLowerCase();
  if (label.endsWith('.default') && !isCanonicalDefaultFollowingService(service)) {
    return true;
  }

  const filename = resolveServiceFilename(service.path).toLowerCase();
  return (
    (
      filename.endsWith('.default.service')
      || filename.endsWith('.default.plist')
      || filename.endsWith('.default.ps1')
    )
    && !isCanonicalDefaultFollowingService(service)
  );
}

function compareCompatibleDefaultServicePriority(
  left: DaemonServiceListEntry,
  right: DaemonServiceListEntry,
  preferredMode: DaemonServiceMode,
): number {
  const leftPreferredMode = left.mode === preferredMode;
  const rightPreferredMode = right.mode === preferredMode;
  if (leftPreferredMode !== rightPreferredMode) {
    return leftPreferredMode ? -1 : 1;
  }

  const leftCanonical = isCanonicalDefaultFollowingService(left);
  const rightCanonical = isCanonicalDefaultFollowingService(right);
  if (leftCanonical !== rightCanonical) {
    return leftCanonical ? -1 : 1;
  }

  const leftLegacyScoped = isLegacyChannelScopedDefaultService(left);
  const rightLegacyScoped = isLegacyChannelScopedDefaultService(right);
  if (leftLegacyScoped !== rightLegacyScoped) {
    return leftLegacyScoped ? 1 : -1;
  }

  return 0;
}

export function buildBackgroundServiceRepairPlan(params: Readonly<{
  currentReleaseChannel: PublicReleaseRingId;
  currentHappierHomeDir?: string | null;
  currentServerId: string;
  preferredMode: DaemonServiceMode;
  services: readonly DaemonServiceListEntry[];
}>): BackgroundServiceRepairPlan {
  const currentHappierHomeDir = resolveHappierHomeDirComparableKey(params.currentHappierHomeDir);
  const repairableExternalDefaultServices = currentHappierHomeDir
    ? params.services.filter((service) =>
      isSameModeDefaultFollowingService(service, params.preferredMode)
      && (
        resolveHappierHomeDirComparableKey(service.happierHomeDir, service.platform) === null
        || isForeignHomeService({
          entry: service,
          currentHappierHomeDir: params.currentHappierHomeDir,
        })
      ),
    )
    : [];
  const repairableExternalDefaultServicesSet = new Set(repairableExternalDefaultServices);
  const unknownHomeRepairableServices = currentHappierHomeDir
    ? params.services.filter((service) => {
      if (repairableExternalDefaultServicesSet.has(service)) {
        return false;
      }
      if (resolveHappierHomeDirComparableKey(service.happierHomeDir, service.platform) !== null) {
        return false;
      }
      if (service.targetMode === 'default-following' && service.releaseChannel === params.currentReleaseChannel) {
        return true;
      }
      return isCurrentServerPinnedService(service, params.currentServerId);
    })
    : [];

  if (unknownHomeRepairableServices.length > 0) {
    const described = unknownHomeRepairableServices
      .map((service) => String(service.path ?? '').trim())
      .filter(Boolean)
      .join(', ');
    return {
      currentReleaseChannel: params.currentReleaseChannel,
      existingServices: [...params.services],
      actions: [],
      manualWarnings: [
        `Detected background services with missing Happier home metadata (${described || 'unknown path'}). Automatic repair will not replace or remove them; remove the legacy service(s) from the owning installation first.`,
      ],
    };
  }

  const foreignHomeDefaultServices = params.services.filter((service) =>
    isForeignHomeService({
      entry: service,
      currentHappierHomeDir: params.currentHappierHomeDir,
    })
    && service.targetMode === 'default-following'
    && service.releaseChannel === params.currentReleaseChannel,
  ).filter((service) => !repairableExternalDefaultServicesSet.has(service));
  if (foreignHomeDefaultServices.length > 0) {
    return {
      currentReleaseChannel: params.currentReleaseChannel,
      existingServices: [...params.services],
      actions: [],
      manualWarnings: [
        `Detected default-following background services from another Happier home (${foreignHomeDefaultServices.map((service) => String(service.happierHomeDir ?? '').trim()).filter(Boolean).join(', ')}). Automatic repair will not replace or remove them; clean up the other installation first.`,
      ],
    };
  }

  const foreignHomePinnedCurrentServerServices = params.services.filter((service) =>
    isForeignHomeService({
      entry: service,
      currentHappierHomeDir: params.currentHappierHomeDir,
    })
    && isCurrentServerPinnedService(service, params.currentServerId),
  );
  if (foreignHomePinnedCurrentServerServices.length > 0) {
    return {
      currentReleaseChannel: params.currentReleaseChannel,
      existingServices: [...params.services],
      actions: [],
      manualWarnings: [
        `Detected pinned background services for the current server from another Happier home (${foreignHomePinnedCurrentServerServices.map((service) => String(service.happierHomeDir ?? '').trim()).filter(Boolean).join(', ')}). Automatic repair will not replace or remove them; clean up the other installation first.`,
      ],
    };
  }

  const repairableServices = params.services.filter((service) => (
    !repairableExternalDefaultServicesSet.has(service)
    &&
    !isForeignHomeService({
      entry: service,
      currentHappierHomeDir: params.currentHappierHomeDir,
    })
    && (
    service.targetMode === 'default-following'
    || isCurrentServerPinnedService(service, params.currentServerId)
  )));

  const compatibleDefaultServices = repairableServices.filter((service) =>
    service.targetMode === 'default-following'
    && service.releaseChannel === params.currentReleaseChannel
  );
  const otherRepairables = repairableServices.filter((service) => !compatibleDefaultServices.includes(service));
  const orderedRepairableServices = [
    ...[...compatibleDefaultServices].sort((left, right) =>
      compareCompatibleDefaultServicePriority(left, right, params.preferredMode)),
    ...otherRepairables,
  ];

  const sharedPlan = buildSharedBackgroundServiceRepairPlan({
    currentReleaseChannel: params.currentReleaseChannel,
    preferredMode: params.preferredMode,
    services: orderedRepairableServices.map((service) => mapListEntryToHappierService(
      service,
      params.currentHappierHomeDir,
    )),
  });

  const driftedCompatibleDefaultService = orderedRepairableServices.find((service) =>
    service.targetMode === 'default-following'
    && service.releaseChannel === params.currentReleaseChannel
    && service.installed === true
    && service.installedDefinitionMatchesExpected === false,
  ) ?? null;

  const shouldReinstallCompatibleDefaultService = driftedCompatibleDefaultService !== null;
  const shouldRemoveDriftedCompatibleDefaultService = driftedCompatibleDefaultService !== null
    && !isCanonicalDefaultFollowingService(driftedCompatibleDefaultService);

  const mappedActions = [
    ...repairableExternalDefaultServices.map((service) => {
      const sharedService = mapListEntryToHappierService(service, params.currentHappierHomeDir);
      return {
        kind: 'remove-service' as const,
        service: {
          id: sharedService.id,
          label: sharedService.label,
          platform: sharedService.platform,
          backend: sharedService.backend,
          scope: sharedService.scope,
          definitionPath: sharedService.definitionPath,
          installedPath: sharedService.definitionPath,
          mode: sharedService.scope,
          releaseChannel: service.releaseChannel,
          targetMode: service.targetMode,
          instanceId: service.serverId,
        },
      };
    }),
    ...sharedPlan.actions.map((action) => action.kind === 'remove-service'
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
  ];

  if (shouldRemoveDriftedCompatibleDefaultService) {
    const service = driftedCompatibleDefaultService;
    const alreadyScheduled = mappedActions.some((action) =>
      action.kind === 'remove-service'
      && action.service.definitionPath === service.path
    );
    if (!alreadyScheduled) {
      const sharedService = mapListEntryToHappierService(service);
      mappedActions.unshift({
        kind: 'remove-service',
        service: {
          id: sharedService.id,
          label: sharedService.label,
          platform: sharedService.platform,
          backend: sharedService.backend,
          scope: sharedService.scope,
          definitionPath: sharedService.definitionPath,
          installedPath: sharedService.definitionPath,
          mode: sharedService.scope,
          releaseChannel: service.releaseChannel,
          targetMode: service.targetMode,
          instanceId: service.serverId,
        },
      });
    }
  }

  if (shouldReinstallCompatibleDefaultService) {
    const reinstallMode: DaemonServiceMode = driftedCompatibleDefaultService?.mode === 'system' ? 'system' : 'user';
    const alreadyScheduled = mappedActions.some((action) =>
      action.kind === 'install-default-following-service'
      && action.releaseChannel === params.currentReleaseChannel
      && action.mode === reinstallMode
    );
    if (!alreadyScheduled) {
      mappedActions.push({
        kind: 'install-default-following-service',
        releaseChannel: params.currentReleaseChannel,
        mode: reinstallMode,
      });
    }
  }

  if (repairableExternalDefaultServices.length > 0 && compatibleDefaultServices.length === 0) {
    const alreadyScheduled = mappedActions.some((action) =>
      action.kind === 'install-default-following-service'
      && action.releaseChannel === params.currentReleaseChannel
      && action.mode === params.preferredMode
    );
    if (!alreadyScheduled) {
      mappedActions.push({
        kind: 'install-default-following-service',
        releaseChannel: params.currentReleaseChannel,
        mode: params.preferredMode,
      });
    }
  }

  return {
    currentReleaseChannel: params.currentReleaseChannel,
    existingServices: [...params.services],
    actions: mappedActions,
    manualWarnings: [],
  };
}
