import { readFileSync } from 'node:fs';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import type { InstalledDaemonServiceEntry } from './discoverInstalledDaemonServiceEntries';
import type { DaemonServiceMode, DaemonServiceTargetMode } from './plan';

export type DaemonServiceInstallStrategy = 'require-explicit' | 'add' | 'replace-ring' | 'replace-all';

export type DaemonServiceInstallTarget = Readonly<{
  platform: InstalledDaemonServiceEntry['platform'];
  mode?: DaemonServiceMode | null;
  targetMode: DaemonServiceTargetMode;
  ring: PublicReleaseRingId | null;
  instanceId: string | null;
  happierHomeDir: string | null;
}>;

export type DaemonServiceInstallConflictPlan = Readonly<{
  exactTargetExists: boolean;
  competingServices: readonly InstalledDaemonServiceEntry[];
  servicesToRemove: readonly InstalledDaemonServiceEntry[];
}>;

function matchesTarget(service: InstalledDaemonServiceEntry, target: DaemonServiceInstallTarget): boolean {
  if (service.platform !== target.platform) {
    return false;
  }
  if (target.mode && service.mode && service.mode !== target.mode) {
    return false;
  }
  if (service.targetMode !== target.targetMode) {
    return false;
  }
  if (normalizeHomeDir(service.happierHomeDir) !== normalizeHomeDir(target.happierHomeDir)) {
    return false;
  }
  if (target.targetMode === 'default-following') {
    return service.releaseChannel === target.ring;
  }
  return service.releaseChannel === target.ring && service.serverId === target.instanceId;
}

function matchesInstalledDefinitionContents(params: Readonly<{
  service: InstalledDaemonServiceEntry;
  expectedContents: string | null | undefined;
}>): boolean {
  if (params.expectedContents === null || params.expectedContents === undefined) {
    return true;
  }

  try {
    const installedContents = readFileSync(params.service.path, 'utf8').trim();
    return installedContents === String(params.expectedContents).trim();
  } catch {
    return false;
  }
}

function normalizeHomeDir(value: string | null | undefined): string | null {
  const trimmed = String(value ?? '').trim();
  return trimmed || null;
}

function resolveTupleKey(service: InstalledDaemonServiceEntry): string {
  return [
    service.platform,
    service.mode ?? '',
    service.targetMode,
    service.releaseChannel,
    service.serverId,
  ].join(':');
}

function isCompetingService(service: InstalledDaemonServiceEntry, target: DaemonServiceInstallTarget): boolean {
  if (matchesTarget(service, target)) {
    return false;
  }
  if (service.platform !== target.platform) {
    return false;
  }
  if (target.mode && service.mode && service.mode !== target.mode) {
    return false;
  }
  if (target.targetMode === 'default-following') {
    return true;
  }
  if (service.serverId === target.instanceId) {
    return true;
  }
  return service.releaseChannel === target.ring;
}

export function resolveDaemonServiceInstallConflictPlan(params: Readonly<{
  target: DaemonServiceInstallTarget;
  strategy: DaemonServiceInstallStrategy;
  services: readonly InstalledDaemonServiceEntry[];
  expectedInstalledDefinitionContents?: string | null;
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

  const exactTargetExists = params.services.some((service) =>
    matchesTarget(service, params.target)
    && matchesInstalledDefinitionContents({
      service,
      expectedContents: params.expectedInstalledDefinitionContents,
    }),
  );
  const competingServices = params.services.filter((service) =>
    isCompetingService(service, params.target) || duplicateTupleKeys.has(resolveTupleKey(service)),
  );

  const resolveServicesToRemove = (): readonly InstalledDaemonServiceEntry[] => {
    if (params.strategy === 'replace-all') {
      return competingServices;
    }
    if (params.strategy === 'replace-ring') {
      return competingServices.filter((service) => service.releaseChannel === params.target.ring);
    }
    return [];
  };

  return {
    exactTargetExists,
    competingServices,
    servicesToRemove: resolveServicesToRemove(),
  };
}
