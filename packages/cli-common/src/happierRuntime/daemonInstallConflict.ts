import type {
    HappierService,
    HappierServiceBackend,
    HappierServicePlatform,
    HappierServiceTargetMode,
    HappierServiceVerification,
} from './types.js';
import type { PublicReleaseRingLabel } from '@happier-dev/release-runtime/releaseRings';
import { createServerUrlComparableKey } from '@happier-dev/protocol';

export type DaemonServiceInstallStrategy = 'require-explicit' | 'add' | 'replace-ring' | 'replace-all';

export type DaemonServiceInstallTarget = Readonly<{
    platform: HappierServicePlatform;
    backend: HappierServiceBackend;
    targetMode: HappierServiceTargetMode;
    ring: PublicReleaseRingLabel | null;
    instanceId: string | null;
    serverUrl: string | null;
    happierHomeDir?: string | null;
}>;

export type DaemonServiceInstallConflictPlan = Readonly<{
    exactTargetExists: boolean;
    competingServices: readonly HappierService[];
    foreignHomeConflicts: readonly HappierService[];
    servicesToRemove: readonly HappierService[];
}>;

function normalizeHomeDir(value: string | null | undefined): string | null {
    const trimmed = String(value ?? '').trim();
    return trimmed || null;
}

function matchesTarget(service: HappierService, target: DaemonServiceInstallTarget): boolean {
    const serviceTargetMode = service.targetMode ?? 'pinned';
    if (serviceTargetMode !== target.targetMode) {
        return false;
    }
    const targetHomeDir = normalizeHomeDir(target.happierHomeDir);
    const serviceHomeDir = normalizeHomeDir(service.happierHomeDir);
    if (targetHomeDir !== null && serviceHomeDir !== null && targetHomeDir !== serviceHomeDir) {
        return false;
    }
    if (target.targetMode === 'default-following') {
        return (
            service.serviceType === 'daemon' &&
            service.platform === target.platform &&
            service.backend === target.backend
        );
    }
    return (
        service.serviceType === 'daemon' &&
        service.platform === target.platform &&
        service.backend === target.backend &&
        service.ring === target.ring &&
        service.instanceId === target.instanceId
    );
}

function isVerifiedDaemonService(service: HappierService): boolean {
    return service.serviceType === 'daemon' && service.verification === 'verified';
}

function normalizeUrl(value: string | null | undefined): string {
    return String(value ?? '').trim().replace(/\/+$/u, '').toLowerCase();
}

function comparableServerUrl(value: string | null | undefined): string {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) return '';
    try {
        return createServerUrlComparableKey(trimmed);
    } catch {
        return '';
    }
}

function resolveTupleKey(service: HappierService): string {
    return [
        service.platform,
        service.backend,
        service.targetMode ?? 'pinned',
        service.ring ?? 'stable',
        service.instanceId ?? 'cloud',
    ].join(':');
}

function sharesServerUrl(service: HappierService, target: DaemonServiceInstallTarget): boolean {
    const targetComparableKey = comparableServerUrl(target.serverUrl);
    const serviceComparableKey = comparableServerUrl(service.serverUrl ?? service.publicServerUrl ?? null);
    if (targetComparableKey && serviceComparableKey) {
        return targetComparableKey === serviceComparableKey;
    }
    const targetUrl = normalizeUrl(target.serverUrl);
    if (!targetUrl) return false;
    const serviceUrl = normalizeUrl(service.serverUrl ?? service.publicServerUrl ?? null);
    return Boolean(serviceUrl) && serviceUrl === targetUrl;
}

function isCompetingService(service: HappierService, target: DaemonServiceInstallTarget): boolean {
    if (!isVerifiedDaemonService(service) || matchesTarget(service, target)) {
        return false;
    }
    if (target.targetMode === 'default-following') {
        return service.platform === target.platform && service.backend === target.backend;
    }
    if (service.instanceId && service.instanceId === target.instanceId) {
        return true;
    }
    if (service.ring === target.ring && sharesServerUrl(service, target)) {
        return true;
    }
    return false;
}

function isForeignHomeConflict(service: HappierService, target: DaemonServiceInstallTarget): boolean {
    const targetHomeDir = normalizeHomeDir(target.happierHomeDir);
    const serviceHomeDir = normalizeHomeDir(service.happierHomeDir);
    return targetHomeDir !== null && serviceHomeDir !== null && targetHomeDir !== serviceHomeDir;
}

export function resolveDaemonServiceInstallConflictPlan(params: Readonly<{
    target: DaemonServiceInstallTarget;
    strategy: DaemonServiceInstallStrategy;
    services: readonly HappierService[];
}>): DaemonServiceInstallConflictPlan {
    const verifiedDaemons = params.services.filter(isVerifiedDaemonService);
    const exactTargetExists = verifiedDaemons.some((service) => matchesTarget(service, params.target));
    const duplicateTupleKeys = new Set<string>();
    const countsByTuple = new Map<string, number>();
    for (const service of verifiedDaemons) {
        const tupleKey = resolveTupleKey(service);
        const nextCount = (countsByTuple.get(tupleKey) ?? 0) + 1;
        countsByTuple.set(tupleKey, nextCount);
        if (nextCount > 1) duplicateTupleKeys.add(tupleKey);
    }
    const competingServices = verifiedDaemons.filter((service) =>
        isCompetingService(service, params.target) || duplicateTupleKeys.has(resolveTupleKey(service)),
    );
    const foreignHomeConflicts = competingServices.filter((service) => isForeignHomeConflict(service, params.target));
    const resolveServicesToRemove = (): readonly HappierService[] => {
        if (params.strategy === 'replace-all') {
            return competingServices.filter((service) => !foreignHomeConflicts.includes(service));
        }
        if (params.strategy === 'replace-ring') {
            if (params.target.targetMode === 'default-following') {
                return competingServices.filter((service) => (
                    (service.targetMode ?? 'pinned') === 'default-following'
                    && !foreignHomeConflicts.includes(service)
                ));
            }
            return competingServices.filter((service) => service.ring === params.target.ring && !foreignHomeConflicts.includes(service));
        }
        return [];
    };

    if (exactTargetExists) {
        return {
            exactTargetExists: true,
            competingServices,
            foreignHomeConflicts,
            servicesToRemove: resolveServicesToRemove(),
        };
    }

    if (params.strategy === 'add') {
        return {
            exactTargetExists: false,
            competingServices,
            foreignHomeConflicts,
            servicesToRemove: [],
        };
    }

    if (params.strategy === 'replace-ring') {
        return {
            exactTargetExists: false,
            competingServices,
            foreignHomeConflicts,
            servicesToRemove: resolveServicesToRemove(),
        };
    }

    if (params.strategy === 'replace-all') {
        return {
            exactTargetExists: false,
            competingServices,
            foreignHomeConflicts,
            servicesToRemove: resolveServicesToRemove(),
        };
    }

    return {
        exactTargetExists: false,
        competingServices,
        foreignHomeConflicts,
        servicesToRemove: [],
    };
}
