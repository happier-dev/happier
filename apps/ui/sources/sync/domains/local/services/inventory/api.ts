import { LocalServiceInventorySnapshotV1Schema } from '@happier-dev/protocol';

import type { LocalServiceInventorySnapshot } from './store';

export const LOCAL_SERVICE_INVENTORY_SNAPSHOT_ROUTE = '/local-services/inventory/snapshot';
export const LOCAL_SERVICE_INVENTORY_REFRESH_ROUTE = '/local-services/inventory/refresh';

export type LocalServiceInventorySnapshotRequest = (
    path: string,
    init?: RequestInit,
) => Promise<Response>;

export type LocalServiceInventorySnapshotClientInput = Readonly<{
    machineId: string;
    serverId?: string | null;
    sessionId?: string | null;
    refresh?: boolean;
    signal?: AbortSignal;
    request?: LocalServiceInventorySnapshotRequest;
}>;

export type LocalServiceInventorySnapshotClientResult =
    | Readonly<{ ok: true; snapshot: LocalServiceInventorySnapshot }>
    | Readonly<{ ok: false; reason: 'unavailable' | 'request_failed' | 'invalid_response' }>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readResponseSnapshotPayload(value: unknown): unknown {
    if (!isRecord(value)) {
        return null;
    }
    return value.ok === true ? value.snapshot : value;
}

export async function fetchLocalServiceInventorySnapshot(
    input: LocalServiceInventorySnapshotClientInput,
): Promise<LocalServiceInventorySnapshotClientResult> {
    const request = input.request;
    if (!request) {
        return { ok: false, reason: 'unavailable' };
    }

    try {
        const response = await request(
            input.refresh ? LOCAL_SERVICE_INVENTORY_REFRESH_ROUTE : LOCAL_SERVICE_INVENTORY_SNAPSHOT_ROUTE,
            {
                method: 'POST',
                signal: input.signal,
            },
        );
        if (response.status === 404 || response.status === 501) {
            return { ok: false, reason: 'unavailable' };
        }
        if (!response.ok) {
            return { ok: false, reason: 'request_failed' };
        }
        const parsed = LocalServiceInventorySnapshotV1Schema.safeParse(
            readResponseSnapshotPayload(await response.json()),
        );
        if (!parsed.success || parsed.data.machineId !== input.machineId) {
            return { ok: false, reason: 'invalid_response' };
        }
        return { ok: true, snapshot: parsed.data };
    } catch {
        return { ok: false, reason: 'request_failed' };
    }
}

/**
 * Parked read of the daemon's inventory registry (the push half of freshness).
 *
 * `sinceGeneratedAt` is the `generatedAt` of the snapshot the caller already holds, so a change
 * that lands between the caller's snapshot read and its first watch is answered immediately
 * instead of being missed. Exactly one watch is outstanding per subscribed store entry.
 */
export type LocalServiceInventoryWatchClientInput = Readonly<{
    machineId: string;
    serverId?: string | null;
    sessionId?: string | null;
    sinceGeneratedAt?: number | null;
    signal?: AbortSignal;
}>;

export type LocalServiceInventoryWatchClientResult =
    | Readonly<{ ok: true; changed: true; snapshot: LocalServiceInventorySnapshot }>
    | Readonly<{ ok: true; changed: false }>
    | Readonly<{ ok: false; reason: 'unavailable' | 'request_failed' | 'invalid_response' }>;
