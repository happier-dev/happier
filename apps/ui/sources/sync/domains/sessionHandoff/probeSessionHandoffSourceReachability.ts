import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { resolveSessionHandoffRuntimeConfig } from './sessionHandoffRuntimeConfig';

export type SessionHandoffSourceReachability = 'reachable' | 'unavailable';

const inflightSessionHandoffSourceReachabilityProbes = new Map<string, Promise<SessionHandoffSourceReachability>>();

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function buildProbeKey(input: Readonly<{
    serverId?: string | null;
    sourceMachineId: string;
}>): string {
    return `${normalizeNonEmptyString(input.serverId) ?? '__default__'}::${input.sourceMachineId}`;
}

export async function probeSessionHandoffSourceReachability(input: Readonly<{
    serverId?: string | null;
    sourceMachineId?: string | null;
    timeoutMs?: number | null;
}>): Promise<SessionHandoffSourceReachability> {
    const serverId = normalizeNonEmptyString(input.serverId);
    const sourceMachineId = normalizeNonEmptyString(input.sourceMachineId);
    if (!sourceMachineId) {
        return 'unavailable';
    }

    const key = buildProbeKey({ serverId, sourceMachineId });
    const existingProbe = inflightSessionHandoffSourceReachabilityProbes.get(key);
    if (existingProbe) {
        return await existingProbe;
    }

    const timeoutMs = typeof input.timeoutMs === 'number' && input.timeoutMs > 0
        ? Math.max(
            250,
            Math.min(30_000, input.timeoutMs),
        )
        : resolveSessionHandoffRuntimeConfig().sourceReachabilityProbeTimeoutMs;

    const probePromise = (async (): Promise<SessionHandoffSourceReachability> => {
        try {
            await machineRpcWithServerScope<unknown, Record<string, never>>({
                machineId: sourceMachineId,
                serverId,
                method: RPC_METHODS.CAPABILITIES_DESCRIBE,
                payload: {},
                timeoutMs,
            });
            return 'reachable';
        } catch {
            return 'unavailable';
        }
    })().finally(() => {
        inflightSessionHandoffSourceReachabilityProbes.delete(key);
    });

    inflightSessionHandoffSourceReachabilityProbes.set(key, probePromise);
    return await probePromise;
}
