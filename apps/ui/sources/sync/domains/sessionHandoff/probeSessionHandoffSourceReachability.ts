import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

export type SessionHandoffSourceReachability = 'reachable' | 'unavailable';

const DEFAULT_SESSION_HANDOFF_SOURCE_REACHABILITY_PROBE_TIMEOUT_MS = 2_500;
const MAX_SESSION_HANDOFF_SOURCE_REACHABILITY_PROBE_TIMEOUT_MS = 30_000;
const MIN_SESSION_HANDOFF_SOURCE_REACHABILITY_PROBE_TIMEOUT_MS = 250;

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

function readSessionHandoffSourceReachabilityProbeTimeoutMs(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SESSION_HANDOFF_SOURCE_REACHABILITY_PROBE_TIMEOUT_MS ?? '').trim();
    if (!raw) return DEFAULT_SESSION_HANDOFF_SOURCE_REACHABILITY_PROBE_TIMEOUT_MS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_SESSION_HANDOFF_SOURCE_REACHABILITY_PROBE_TIMEOUT_MS;
    return Math.max(
        MIN_SESSION_HANDOFF_SOURCE_REACHABILITY_PROBE_TIMEOUT_MS,
        Math.min(MAX_SESSION_HANDOFF_SOURCE_REACHABILITY_PROBE_TIMEOUT_MS, parsed),
    );
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
            MIN_SESSION_HANDOFF_SOURCE_REACHABILITY_PROBE_TIMEOUT_MS,
            Math.min(MAX_SESSION_HANDOFF_SOURCE_REACHABILITY_PROBE_TIMEOUT_MS, input.timeoutMs),
        )
        : readSessionHandoffSourceReachabilityProbeTimeoutMs();

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
