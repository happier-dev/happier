import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { readRpcErrorCode } from '@/sync/runtime/rpcErrors';

import {
    readCachedMachineRpcDirectRoute,
    recordCachedMachineRpcDirectRouteUnavailable,
} from './transferRouteCache';
import type { MachineRpcDirectRouteAvailability } from './useMachineRpcDirectRouteAvailability';

const DEFAULT_MACHINE_RPC_DIRECT_ROUTE_PROBE_TIMEOUT_MS = 2_500;
const MAX_MACHINE_RPC_DIRECT_ROUTE_PROBE_TIMEOUT_MS = 30_000;
const MIN_MACHINE_RPC_DIRECT_ROUTE_PROBE_TIMEOUT_MS = 250;
const MACHINE_RPC_DIRECT_ROUTE_PROBE_UNAVAILABLE_REASON = 'machine_rpc_direct_probe_unavailable';

const inflightMachineRpcDirectRouteProbes = new Map<string, Promise<MachineRpcDirectRouteAvailability>>();

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readMachineRpcDirectRouteProbeTimeoutMs(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_MACHINE_RPC_DIRECT_ROUTE_PROBE_TIMEOUT_MS ?? '').trim();
    if (!raw) return DEFAULT_MACHINE_RPC_DIRECT_ROUTE_PROBE_TIMEOUT_MS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_MACHINE_RPC_DIRECT_ROUTE_PROBE_TIMEOUT_MS;
    return Math.max(
        MIN_MACHINE_RPC_DIRECT_ROUTE_PROBE_TIMEOUT_MS,
        Math.min(MAX_MACHINE_RPC_DIRECT_ROUTE_PROBE_TIMEOUT_MS, parsed),
    );
}

function resolveMachineRpcDirectRouteAvailabilityFromCache(input: Readonly<{
    serverId?: string | null;
    remoteMachineId: string;
}>): MachineRpcDirectRouteAvailability {
    const cached = readCachedMachineRpcDirectRoute({
        serverId: input.serverId,
        remoteMachineId: input.remoteMachineId,
    });
    if (cached.status === 'viable') return 'viable';
    if (cached.status === 'unavailable') return 'unavailable';
    return 'unknown';
}

function buildProbeKey(input: Readonly<{
    serverId?: string | null;
    remoteMachineId: string;
}>): string {
    return `${normalizeNonEmptyString(input.serverId) ?? '__default__'}::${input.remoteMachineId}`;
}

function deriveMachineRpcDirectRouteProbeFailureReason(error: unknown): string {
    const rpcErrorCode = readRpcErrorCode(error);
    if (typeof rpcErrorCode === 'string' && rpcErrorCode.trim().length > 0) {
        return rpcErrorCode;
    }

    if (error && typeof error === 'object') {
        const code = (error as { code?: unknown }).code;
        if (typeof code === 'string' && code.trim().length > 0) {
            return code.trim();
        }
    }

    if (error instanceof Error && typeof error.message === 'string' && error.message.trim().length > 0) {
        return error.message.trim();
    }

    return MACHINE_RPC_DIRECT_ROUTE_PROBE_UNAVAILABLE_REASON;
}

export async function probeMachineRpcDirectRouteAvailability(input: Readonly<{
    serverId?: string | null;
    remoteMachineId?: string | null;
    timeoutMs?: number | null;
}>): Promise<MachineRpcDirectRouteAvailability> {
    const serverId = normalizeNonEmptyString(input.serverId);
    const remoteMachineId = normalizeNonEmptyString(input.remoteMachineId);
    if (!remoteMachineId) {
        return 'unknown';
    }

    const cachedAvailability = resolveMachineRpcDirectRouteAvailabilityFromCache({
        serverId,
        remoteMachineId,
    });
    if (cachedAvailability !== 'unknown') {
        return cachedAvailability;
    }

    const key = buildProbeKey({ serverId, remoteMachineId });
    const existingProbe = inflightMachineRpcDirectRouteProbes.get(key);
    if (existingProbe) {
        return await existingProbe;
    }

    const timeoutMs = typeof input.timeoutMs === 'number' && input.timeoutMs > 0
        ? Math.max(
            MIN_MACHINE_RPC_DIRECT_ROUTE_PROBE_TIMEOUT_MS,
            Math.min(MAX_MACHINE_RPC_DIRECT_ROUTE_PROBE_TIMEOUT_MS, input.timeoutMs),
        )
        : readMachineRpcDirectRouteProbeTimeoutMs();

    const probePromise = (async (): Promise<MachineRpcDirectRouteAvailability> => {
        let probeSucceeded = false;
        try {
            await machineRpcWithServerScope<unknown, Record<string, never>>({
                machineId: remoteMachineId,
                serverId,
                method: RPC_METHODS.CAPABILITIES_DESCRIBE,
                payload: {},
                timeoutMs,
            });
            probeSucceeded = true;
        } catch (error) {
            recordCachedMachineRpcDirectRouteUnavailable(
                {
                    serverId,
                    remoteMachineId,
                },
                deriveMachineRpcDirectRouteProbeFailureReason(error),
            );
        }

        const nextAvailability = resolveMachineRpcDirectRouteAvailabilityFromCache({
            serverId,
            remoteMachineId,
        });
        if (nextAvailability !== 'unknown') {
            return nextAvailability;
        }

        if (probeSucceeded) {
            // A successful scoped probe is sufficient runtime truth for the session-handoff UI to
            // surface the action. Keep the shared machine-rpc direct-route cache unchanged so other
            // transfer features do not treat scoped success as authoritative direct-route viability.
            return 'viable';
        }

        recordCachedMachineRpcDirectRouteUnavailable(
            {
                serverId,
                remoteMachineId,
            },
            MACHINE_RPC_DIRECT_ROUTE_PROBE_UNAVAILABLE_REASON,
        );
        return 'unavailable';
    })().finally(() => {
        inflightMachineRpcDirectRouteProbes.delete(key);
    });

    inflightMachineRpcDirectRouteProbes.set(key, probePromise);
    return await probePromise;
}
