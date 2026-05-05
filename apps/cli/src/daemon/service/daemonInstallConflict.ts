import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import type { InstalledDaemonServiceEntry } from './discoverInstalledDaemonServiceEntries';
import type { DaemonServiceMode, DaemonServiceTargetMode } from './plan';
import { resolveHappierHomeDirComparableKey } from '@/daemon/ownership/happierHomeDirComparableKey';

export type DaemonServiceInstallStrategy = 'require-explicit' | 'add' | 'replace-ring' | 'replace-all';

export type DaemonServiceInstallTarget = Readonly<{
  platform: InstalledDaemonServiceEntry['platform'];
  mode: DaemonServiceMode;
  targetMode: DaemonServiceTargetMode;
  ring: PublicReleaseRingId | null;
  instanceId: string | null;
  happierHomeDir: string | null;
}>;

export type DaemonServiceInstallConflictPlan = Readonly<{
  exactTargetExists: boolean;
  exactTargetIsConverged: boolean;
  competingServices: readonly InstalledDaemonServiceEntry[];
  foreignHomeConflicts: readonly InstalledDaemonServiceEntry[];
  servicesToRemove: readonly InstalledDaemonServiceEntry[];
}>;

function matchesTarget(service: InstalledDaemonServiceEntry, target: DaemonServiceInstallTarget): boolean {
  if (service.platform !== target.platform) {
    return false;
  }
  if ((service.mode ?? 'user') !== target.mode) {
    return false;
  }
  if (service.targetMode !== target.targetMode) {
    return false;
  }
  if (resolveHappierHomeDirComparableKey(service.happierHomeDir) !== resolveHappierHomeDirComparableKey(target.happierHomeDir)) {
    return false;
  }
  if (target.targetMode === 'default-following') {
    return service.releaseChannel === target.ring;
  }
  return service.releaseChannel === target.ring && service.serverId === target.instanceId;
}

function resolveTupleKey(service: InstalledDaemonServiceEntry): string {
  return [
    service.platform,
    service.mode ?? 'user',
    service.targetMode,
    service.releaseChannel,
    service.serverId,
    resolveHappierHomeDirComparableKey(service.happierHomeDir),
  ].join(':');
}

function isCompetingService(service: InstalledDaemonServiceEntry, target: DaemonServiceInstallTarget): boolean {
  if (matchesTarget(service, target)) {
    return false;
  }
  if (service.platform !== target.platform) {
    return false;
  }
  if (target.targetMode === 'default-following') {
    return service.targetMode === 'default-following';
  }
  if (service.serverId === target.instanceId) {
    return true;
  }
  return service.releaseChannel === target.ring;
}

function isForeignHomeConflict(service: InstalledDaemonServiceEntry, target: DaemonServiceInstallTarget): boolean {
  const serviceHomeDir = resolveHappierHomeDirComparableKey(service.happierHomeDir);
  const targetHomeDir = resolveHappierHomeDirComparableKey(target.happierHomeDir);
  if (serviceHomeDir === null || targetHomeDir === null) {
    return true;
  }
  return serviceHomeDir !== targetHomeDir;
}

function isReplaceAllAllowedForeignHomeCleanup(
  service: InstalledDaemonServiceEntry,
  target: DaemonServiceInstallTarget,
): boolean {
  return target.targetMode === 'default-following'
    && service.targetMode === 'default-following'
    && (service.mode ?? 'user') === target.mode
    && service.serverId === 'default';
}

export function resolveDaemonServiceInstallConflictPlan(params: Readonly<{
  target: DaemonServiceInstallTarget;
  strategy: DaemonServiceInstallStrategy;
  services: readonly InstalledDaemonServiceEntry[];
}>): DaemonServiceInstallConflictPlan {
  const duplicateTupleKeys = new Set<string>();
  const countsByTuple = new Map<string, number>();
  for (const service of params.services) {
    const tupleKey = resolveTupleKey(service);
    const nextCount = (countsByTuple.get(tupleKey) ?? 0) + 1;
    countsByTuple.set(tupleKey, nextCount);
    if (nextCount > 1) {
      duplicateTupleKeys.add(tupleKey);
    }
  }

  const exactTargetExists = params.services.some((service) => matchesTarget(service, params.target));
  const competingServices = params.services.filter((service) =>
    isCompetingService(service, params.target) || duplicateTupleKeys.has(resolveTupleKey(service)),
  );
  const foreignHomeConflicts = competingServices.filter((service) =>
    isForeignHomeConflict(service, params.target)
    && (
      params.strategy !== 'replace-all'
      || !isReplaceAllAllowedForeignHomeCleanup(service, params.target)
    ),
  );

  const resolveServicesToRemove = (): readonly InstalledDaemonServiceEntry[] => {
    if (params.strategy === 'replace-all') {
      return competingServices.filter((service) => !foreignHomeConflicts.includes(service));
    }
    if (params.strategy === 'replace-ring') {
      return competingServices.filter((service) =>
        !foreignHomeConflicts.includes(service)
        && service.releaseChannel === params.target.ring,
      );
    }
    return [];
  };
  const servicesToRemove = resolveServicesToRemove();
  const servicesToRemoveSet = new Set(servicesToRemove);
  const exactTargetIsConverged = exactTargetExists && (
    competingServices.length === 0
    || competingServices.every((service) => servicesToRemoveSet.has(service))
  );

  return {
    exactTargetExists,
    exactTargetIsConverged,
    competingServices,
    foreignHomeConflicts,
    servicesToRemove,
  };
}
