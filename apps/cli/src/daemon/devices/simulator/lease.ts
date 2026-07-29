import type { MachineLiveStreamControlLeaseV1 } from '@happier-dev/protocol';

export type SimulatorInputLeaseManager = Readonly<{
    acquire: (input: Readonly<{
        streamId: string;
        sourceId: string;
        holderId: string;
        nowMs: number;
    }>) => Readonly<{ ok: true; lease: MachineLiveStreamControlLeaseV1 } | { ok: false; reasonCode: 'lease_already_held' }>;
    release: (input: Readonly<{
        streamId: string;
        sourceId: string;
        leaseId: string;
    }>) => Readonly<{ ok: true } | { ok: false; reasonCode: 'input_lease_mismatch' }>;
    read: (input: Readonly<{ streamId: string; sourceId: string; nowMs: number }>) => MachineLiveStreamControlLeaseV1 | null;
}>;

export function createSimulatorInputLeaseManager(input: Readonly<{ ttlMs: number }>): SimulatorInputLeaseManager {
    const leasesBySource = new Map<string, MachineLiveStreamControlLeaseV1>();
    const ttlMs = Math.max(1, Math.floor(input.ttlMs));

    const keyFor = (streamId: string, sourceId: string) => `${streamId}:${sourceId}`;
    const readActive = (streamId: string, sourceId: string, nowMs: number): MachineLiveStreamControlLeaseV1 | null => {
        const key = keyFor(streamId, sourceId);
        const existing = leasesBySource.get(key) ?? null;
        if (!existing) return null;
        if (existing.expiresAtMs <= nowMs) {
            leasesBySource.delete(key);
            return null;
        }
        return existing;
    };

    return {
        acquire: (request) => {
            const existing = readActive(request.streamId, request.sourceId, request.nowMs);
            if (existing && existing.holderId !== request.holderId) {
                return { ok: false, reasonCode: 'lease_already_held' };
            }
            const lease: MachineLiveStreamControlLeaseV1 = {
                v: 1,
                leaseId: `${request.streamId}:${request.sourceId}:${request.holderId}:${request.nowMs}`,
                streamId: request.streamId,
                sourceId: request.sourceId,
                holderId: request.holderId,
                mode: 'exclusive',
                acquiredAtMs: request.nowMs,
                expiresAtMs: request.nowMs + ttlMs,
            };
            leasesBySource.set(keyFor(request.streamId, request.sourceId), lease);
            return { ok: true, lease };
        },
        release: (request) => {
            const key = keyFor(request.streamId, request.sourceId);
            const existing = leasesBySource.get(key);
            if (!existing || existing.leaseId !== request.leaseId) {
                return { ok: false, reasonCode: 'input_lease_mismatch' };
            }
            leasesBySource.delete(key);
            return { ok: true };
        },
        read: (request) => readActive(request.streamId, request.sourceId, request.nowMs),
    };
}
