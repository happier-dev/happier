import type {
    HappierService,
    HappierServiceBackend,
    HappierServicePlatform,
    HappierServiceVerification,
} from './types.js';
import type { PublicReleaseRingLabel } from '@happier-dev/release-runtime/releaseRings';

export type DaemonServiceInstallStrategy = 'require-explicit' | 'add' | 'replace-ring' | 'replace-all';

export type DaemonServiceInstallTarget = Readonly<{
    platform: HappierServicePlatform;
    backend: HappierServiceBackend;
    ring: PublicReleaseRingLabel;
    instanceId: string;
    serverUrl: string | null;
}>;

export type DaemonServiceInstallConflictPlan = Readonly<{
    exactTargetExists: boolean;
    competingServices: readonly HappierService[];
    servicesToRemove: readonly HappierService[];
}>;

function matchesTarget(service: HappierService, target: DaemonServiceInstallTarget): boolean {
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

function resolveTupleKey(service: HappierService): string {
    return [
        service.platform,
        service.backend,
        service.ring ?? 'stable',
        service.instanceId ?? 'cloud',
    ].join(':');
}

function sharesServerUrl(service: HappierService, target: DaemonServiceInstallTarget): boolean {
    const targetUrl = normalizeUrl(target.serverUrl);
    if (!targetUrl) return false;
    const serviceUrl = normalizeUrl(service.serverUrl ?? service.publicServerUrl ?? null);
    return Boolean(serviceUrl) && serviceUrl === targetUrl;
}

function isCompetingService(service: HappierService, target: DaemonServiceInstallTarget): boolean {
    if (!isVerifiedDaemonService(service) || matchesTarget(service, target)) {
        return false;
    }
    if (service.instanceId && service.instanceId === target.instanceId) {
        return true;
    }
    if (service.ring === target.ring && sharesServerUrl(service, target)) {
        return true;
    }
    return false;
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

    if (exactTargetExists) {
        return {
            exactTargetExists: true,
            competingServices,
            servicesToRemove: [],
        };
    }

    if (params.strategy === 'add') {
        return {
            exactTargetExists: false,
            competingServices,
            servicesToRemove: [],
        };
    }

    if (params.strategy === 'replace-ring') {
        return {
            exactTargetExists: false,
            competingServices,
            servicesToRemove: competingServices.filter((service) => service.ring === params.target.ring),
        };
    }

    if (params.strategy === 'replace-all') {
        return {
            exactTargetExists: false,
            competingServices,
            servicesToRemove: competingServices,
        };
    }

    return {
        exactTargetExists: false,
        competingServices,
        servicesToRemove: [],
    };
}
