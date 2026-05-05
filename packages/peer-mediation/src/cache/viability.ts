import type { PeerRouteViabilityRecord } from '../route/types.js';

export type { PeerRouteViabilityRecord } from '../route/types.js';

export type PeerRouteViabilityCacheKey = Readonly<{
    serverId: string;
    targetMachineId: string;
    flowKind?: string;
    routeKind: string;
    endpointFingerprint?: string;
}>;

export type CreatePeerRouteViabilityCacheOptions = Readonly<{
    now: () => number;
    positiveTtlMs: number;
    negativeTtlMs: number;
}>;

export type PeerRouteViabilityCache = Readonly<{
    read: (key: PeerRouteViabilityCacheKey) => PeerRouteViabilityRecord;
    recordViable: (key: PeerRouteViabilityCacheKey) => void;
    recordUnavailable: (key: PeerRouteViabilityCacheKey, failureReason: string) => void;
    invalidate: (key: Readonly<{
        serverId: string;
        targetMachineId: string;
        flowKind?: string;
        routeKind?: string;
        endpointFingerprint?: string;
    }>) => void;
}>;

type StoredPeerRouteViabilityEntry =
    | Readonly<{
        status: 'viable';
        checkedAt: number;
        expiresAt: number;
        key: PeerRouteViabilityCacheKey;
    }>
    | Readonly<{
        status: 'unavailable';
        checkedAt: number;
        expiresAt: number;
        failureReason: string;
        key: PeerRouteViabilityCacheKey;
    }>;

function normalizeRouteKind(routeKind: string): string {
    if (
        routeKind === 'server_relay'
        || routeKind === 'server_relay_stream'
        || routeKind === 'server_routed_stream'
    ) {
        return 'server_relay';
    }
    return routeKind;
}

function toStorageKey(key: PeerRouteViabilityCacheKey): string {
    return [
        key.serverId,
        key.targetMachineId,
        key.flowKind ?? '',
        normalizeRouteKind(key.routeKind),
        key.endpointFingerprint ?? '',
    ].join('\u0000');
}

function isExpired(entry: StoredPeerRouteViabilityEntry, now: number): boolean {
    return now > entry.expiresAt;
}

export function createPeerRouteViabilityCache(
    options: CreatePeerRouteViabilityCacheOptions,
): PeerRouteViabilityCache {
    const entries = new Map<string, StoredPeerRouteViabilityEntry>();

    function read(key: PeerRouteViabilityCacheKey): PeerRouteViabilityRecord {
        const storageKey = toStorageKey(key);
        const entry = entries.get(storageKey) ?? null;
        if (!entry) {
            return { status: 'unknown' };
        }

        const now = options.now();
        if (isExpired(entry, now)) {
            entries.delete(storageKey);
            return { status: 'unknown' };
        }

        if (entry.status === 'viable') {
            return {
                status: 'viable',
                checkedAt: entry.checkedAt,
                expiresAt: entry.expiresAt,
                endpointFingerprint: entry.key.endpointFingerprint,
            };
        }

        return {
            status: 'unavailable',
            checkedAt: entry.checkedAt,
            expiresAt: entry.expiresAt,
            failureReason: entry.failureReason,
            endpointFingerprint: entry.key.endpointFingerprint,
        };
    }

    function recordViable(key: PeerRouteViabilityCacheKey): void {
        const checkedAt = options.now();
        entries.set(toStorageKey(key), {
            status: 'viable',
            checkedAt,
            expiresAt: checkedAt + Math.max(0, options.positiveTtlMs),
            key,
        });
    }

    function recordUnavailable(key: PeerRouteViabilityCacheKey, failureReason: string): void {
        const checkedAt = options.now();
        entries.set(toStorageKey(key), {
            status: 'unavailable',
            checkedAt,
            expiresAt: checkedAt + Math.max(0, options.negativeTtlMs),
            failureReason,
            key,
        });
    }

    function invalidate(key: Readonly<{
        serverId: string;
        targetMachineId: string;
        flowKind?: string;
        routeKind?: string;
        endpointFingerprint?: string;
    }>): void {
        const normalizedInvalidateRouteKind = key.routeKind ? normalizeRouteKind(key.routeKind) : null;
        for (const [storageKey, entry] of entries) {
            if (entry.key.serverId !== key.serverId) continue;
            if (entry.key.targetMachineId !== key.targetMachineId) continue;
            if (key.flowKind !== undefined && entry.key.flowKind !== key.flowKind) continue;
            if (normalizedInvalidateRouteKind && toStorageKey({ ...entry.key, routeKind: normalizedInvalidateRouteKind }) !== storageKey) continue;
            if (key.endpointFingerprint !== undefined && entry.key.endpointFingerprint !== key.endpointFingerprint) continue;
            entries.delete(storageKey);
        }
    }

    return {
        read,
        recordViable,
        recordUnavailable,
        invalidate,
    };
}
