import type {
    HappierService,
    HappierServiceBackend,
    HappierServicePlatform,
    HappierServiceTargetMode,
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
    /**
     * The server a default-following target currently follows. Daemons are per-server, so a
     * pinned service competes with a default-following one only when both serve this server;
     * `null`/absent keeps the conservative reading that every pinned service may compete.
     */
    followedServerId?: string | null;
}>;

export type DaemonServiceInstallConflictPlan = Readonly<{
    exactTargetExists: boolean;
    exactTargetRunning: boolean;
    exactTargetIsConverged: boolean;
    competingServices: readonly HappierService[];
    foreignHomeConflicts: readonly HappierService[];
    servicesToRemove: readonly HappierService[];
}>;

export function normalizeHomeDir(
    value: string | null | undefined,
    platform: HappierServicePlatform,
): string | null {
    let normalized = String(value ?? '').trim().replace(/[\\/]+$/u, '');
    if (!normalized) return null;

    const posixWindowsDriveMatch = platform === 'win32' ? /^\/([a-zA-Z])\/(.*)$/u.exec(normalized) : null;
    if (posixWindowsDriveMatch) {
        normalized = `${posixWindowsDriveMatch[1]?.toLowerCase()}:/${String(posixWindowsDriveMatch[2] ?? '').replace(/[\\]+/gu, '/')}`;
    }
    if (platform === 'win32') {
        if (normalized.startsWith('\\\\')) normalized = normalized.replace(/^\\\\+/u, '//');
        normalized = normalized.replace(/[\\]+/gu, '/').replace(/\/{3,}/gu, '//').toLowerCase().replace(/\/+$/u, '');
    }
    return normalized || null;
}

export function daemonServiceMatchesInstallTarget(service: HappierService, target: DaemonServiceInstallTarget): boolean {
    const serviceTargetMode = service.targetMode ?? 'pinned';
    if (serviceTargetMode !== target.targetMode) {
        return false;
    }
    const targetHomeDir = normalizeHomeDir(target.happierHomeDir, target.platform);
    if (targetHomeDir !== null && !happierHomeDirsMatch(service.happierHomeDir, target.happierHomeDir, target.platform)) {
        return false;
    }
    if (target.targetMode === 'default-following') {
        return (
            service.serviceType === 'daemon' &&
            service.platform === target.platform &&
            service.backend === target.backend &&
            (target.ring === null || service.ring === target.ring)
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

/** Unknown homes cannot establish authority over an installed service. */
export function happierHomeDirsMatch(left: string | null | undefined, right: string | null | undefined, platform: HappierServicePlatform): boolean {
    const leftKey = normalizeHomeDir(left, platform);
    return leftKey !== null && leftKey === normalizeHomeDir(right, platform);
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
        normalizeHomeDir(service.happierHomeDir, service.platform) ?? 'unknown-home',
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
    if (service.serviceType !== 'daemon' || daemonServiceMatchesInstallTarget(service, target)) {
        return false;
    }
    if (target.targetMode === 'default-following') {
        if (service.platform !== target.platform) return false;
        const followedServerId = String(target.followedServerId ?? '').trim();
        if ((service.targetMode ?? 'pinned') === 'default-following' || !followedServerId) return true;
        return service.instanceId === followedServerId;
    }
    if (service.instanceId && service.instanceId === target.instanceId) {
        return true;
    }
    if (service.ring === target.ring && (target.serverUrl === null || sharesServerUrl(service, target))) {
        return true;
    }
    return false;
}

function isForeignHomeConflict(service: HappierService, target: DaemonServiceInstallTarget): boolean {
    const targetHomeDir = normalizeHomeDir(target.happierHomeDir, target.platform);
    if (targetHomeDir === null) return false;
    return !happierHomeDirsMatch(service.happierHomeDir, target.happierHomeDir, target.platform);
}

function isReplaceAllAllowedForeignHomeCleanup(
    service: HappierService,
    target: DaemonServiceInstallTarget,
): boolean {
    return target.targetMode === 'default-following'
        && (service.targetMode ?? 'pinned') === 'default-following'
        && service.backend === target.backend
        && (service.instanceId === null || service.instanceId === 'default');
}

export function resolveDaemonServiceInstallConflictPlan(params: Readonly<{
    target: DaemonServiceInstallTarget;
    strategy: DaemonServiceInstallStrategy;
    services: readonly HappierService[];
}>): DaemonServiceInstallConflictPlan {
    const verifiedDaemons = params.services.filter(isVerifiedDaemonService);
    const exactTargetServices = params.services.filter((service) => service.serviceType === 'daemon' && daemonServiceMatchesInstallTarget(service, params.target));
    const unverifiedConflicts = params.services.filter((service) => service.serviceType === 'daemon' && service.installed && service.verification !== 'verified'
        && (daemonServiceMatchesInstallTarget(service, params.target) || isCompetingService(service, params.target)));
    const exactTargetExists = exactTargetServices.length > 0;
    const exactTargetRunning = exactTargetServices.some((service) => service.running);
    const duplicateTupleKeys = new Set<string>();
    const countsByTuple = new Map<string, number>();
    for (const service of verifiedDaemons) {
        const tupleKey = resolveTupleKey(service);
        const nextCount = (countsByTuple.get(tupleKey) ?? 0) + 1;
        countsByTuple.set(tupleKey, nextCount);
        if (nextCount > 1) duplicateTupleKeys.add(tupleKey);
    }
    const competingServices = [...verifiedDaemons.filter((service) =>
        isCompetingService(service, params.target) || duplicateTupleKeys.has(resolveTupleKey(service)),
    ), ...unverifiedConflicts];
    const foreignHomeConflicts = competingServices.filter((service) => (
        isForeignHomeConflict(service, params.target)
        && (params.strategy !== 'replace-all' || !isReplaceAllAllowedForeignHomeCleanup(service, params.target))
    ));
    const resolveServicesToRemove = (): readonly HappierService[] => {
        if (params.strategy === 'replace-all') {
            return competingServices.filter((service) => service.verification === 'verified' && !foreignHomeConflicts.includes(service));
        }
        if (params.strategy === 'replace-ring') {
            if (params.target.targetMode === 'default-following') {
                return competingServices.filter((service) => (
                    service.verification === 'verified'
                    && (service.targetMode ?? 'pinned') === 'default-following'
                    && (params.target.ring === null || service.ring === params.target.ring)
                    && !foreignHomeConflicts.includes(service)
                ));
            }
            return competingServices.filter((service) => service.verification === 'verified' && service.ring === params.target.ring && !foreignHomeConflicts.includes(service));
        }
        return [];
    };

    const servicesToRemove = resolveServicesToRemove();
    const removableServices = new Set(servicesToRemove);
    return {
        exactTargetExists,
        exactTargetRunning,
        exactTargetIsConverged: exactTargetExists && unverifiedConflicts.length === 0 && (
            competingServices.length === 0
            || competingServices.every((service) => removableServices.has(service))
        ),
        competingServices,
        foreignHomeConflicts,
        servicesToRemove,
    };
}
