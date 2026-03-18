import type { AppSessionTransferRoute } from '../route/resolveAppSessionTransferRoute.js';
import type { MachineTransferStrategy } from '../route/resolveMachineTransferRoute.js';

export type TransferRouteKind = MachineTransferStrategy | AppSessionTransferRoute;

export type TransferRouteViabilityCacheKey = Readonly<{
    serverId: string;
    targetMachineId: string;
    routeKind: TransferRouteKind;
    endpointFingerprint?: string;
}>;

export type TransferRouteViabilityRecord =
    | Readonly<{
        status: 'unknown';
    }>
    | Readonly<{
        status: 'viable';
        checkedAt: number;
        expiresAt: number;
        endpointFingerprint?: string;
    }>
    | Readonly<{
        status: 'unavailable';
        checkedAt: number;
        expiresAt: number;
        failureReason: string;
        endpointFingerprint?: string;
    }>;

type StoredTransferRouteViabilityEntry =
    | Readonly<{
        status: 'viable';
        checkedAt: number;
        expiresAt: number;
        key: TransferRouteViabilityCacheKey;
    }>
    | Readonly<{
        status: 'unavailable';
        checkedAt: number;
        expiresAt: number;
        failureReason: string;
        key: TransferRouteViabilityCacheKey;
    }>;

export type CreateTransferRouteViabilityCacheOptions = Readonly<{
    now: () => number;
    positiveTtlMs: number;
    negativeTtlMs: number;
}>;

export type TransferRouteViabilityCache = Readonly<{
    read: (key: TransferRouteViabilityCacheKey) => TransferRouteViabilityRecord;
    recordViable: (key: TransferRouteViabilityCacheKey) => void;
    recordUnavailable: (key: TransferRouteViabilityCacheKey, failureReason: string) => void;
    invalidate: (key: Readonly<{
        serverId: string;
        targetMachineId: string;
        routeKind?: TransferRouteKind;
        endpointFingerprint?: string;
    }>) => void;
}>;

function toStorageKey(key: TransferRouteViabilityCacheKey): string {
    return [
        key.serverId,
        key.targetMachineId,
        key.routeKind,
        key.endpointFingerprint ?? '',
    ].join('\u0000');
}

function isExpired(entry: StoredTransferRouteViabilityEntry, now: number): boolean {
    return now > entry.expiresAt;
}

export function createTransferRouteViabilityCache(
    options: CreateTransferRouteViabilityCacheOptions,
): TransferRouteViabilityCache {
    const entries = new Map<string, StoredTransferRouteViabilityEntry>();

    function read(key: TransferRouteViabilityCacheKey): TransferRouteViabilityRecord {
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

    function recordViable(key: TransferRouteViabilityCacheKey): void {
        const checkedAt = options.now();
        entries.set(toStorageKey(key), {
            status: 'viable',
            checkedAt,
            expiresAt: checkedAt + Math.max(0, options.positiveTtlMs),
            key,
        });
    }

    function recordUnavailable(key: TransferRouteViabilityCacheKey, failureReason: string): void {
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
        routeKind?: TransferRouteKind;
        endpointFingerprint?: string;
    }>): void {
        for (const [storageKey, entry] of entries) {
            if (entry.key.serverId !== key.serverId) continue;
            if (entry.key.targetMachineId !== key.targetMachineId) continue;
            if (key.routeKind && entry.key.routeKind !== key.routeKind) continue;
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
