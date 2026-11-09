/**
 * Capability probe operations (machine RPC)
 */

import { isPlainObject } from './_shared';
import { RPC_METHODS, isRpcMethodNotFoundResult } from '@happier-dev/protocol/rpc';
import { isRpcMethodNotFoundError, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import {
    parseCapabilitiesDescribeResponse,
    parseCapabilitiesDetectResponse,
    parseCapabilitiesInvokeResponse,
    type CapabilitiesDescribeResponse,
    type CapabilitiesDetectRequest,
    type CapabilitiesDetectResponse,
    type CapabilitiesInvokeRequest,
    type CapabilitiesInvokeResponse,
} from '../api/capabilities/capabilitiesProtocol';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { ScopedRpcSocketConnectionTimeoutError } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool';
import { ServerFetchAbortedForServerSwitchError } from '@/sync/http/client';
import { isDemoModeActive } from '@/demoMode/runtime/enterExitDemoMode';
import { readRpcRequestDisposition, type RpcRequestDisposition } from '@happier-dev/sync-client';
import { readCapabilityInvokeFailure } from '@happier-dev/protocol/capabilities';

export type {
    CapabilitiesDescribeResponse,
    CapabilitiesDetectRequest,
    CapabilitiesDetectResponse,
    CapabilitiesInvokeRequest,
    CapabilitiesInvokeResponse,
} from '../api/capabilities/capabilitiesProtocol';

type CapabilityProbeError = Readonly<{
    name?: string;
    rpcErrorCode?: string;
    connectionPhase?: ScopedRpcSocketConnectionTimeoutError['connectionPhase'];
}>;

function describeCapabilityProbeError(error: unknown): CapabilityProbeError {
    const rpcErrorCode = readRpcErrorCode(error);
    // Retain classification without transport messages, request configuration,
    // credentials or stacks. The pool alone identifies its connection phase.
    return {
        ...(error instanceof Error ? { name: error.name } : {}),
        ...(rpcErrorCode ? { rpcErrorCode } : {}),
        ...(error instanceof ScopedRpcSocketConnectionTimeoutError ? { connectionPhase: error.connectionPhase } : {}),
    };
}

export type MachineCapabilitiesDescribeResult =
    | { supported: true; response: CapabilitiesDescribeResponse }
    | { supported: false; reason: 'not-supported' | 'error' | 'server-switch-abort'; error?: CapabilityProbeError };

export async function machineCapabilitiesDescribe(
    machineId: string,
    options?: { serverId?: string | null; accountId?: string | null; signal?: AbortSignal },
): Promise<MachineCapabilitiesDescribeResult> {
    try {
        const result = await machineRpcWithServerScope<unknown, {}>({
            machineId,
            method: RPC_METHODS.CAPABILITIES_DESCRIBE,
            payload: {},
            serverId: options?.serverId,
            accountId: options?.accountId,
            signal: options?.signal,
        });
        if (isRpcMethodNotFoundResult(result)) return { supported: false, reason: 'not-supported' };
        if (isPlainObject(result) && typeof result.error === 'string') return { supported: false, reason: 'error' };
        const parsed = parseCapabilitiesDescribeResponse(result);
        if (!parsed) return { supported: false, reason: 'error' };
        return { supported: true, response: parsed };
    } catch (error) {
        if (error instanceof ServerFetchAbortedForServerSwitchError) {
            return { supported: false, reason: 'server-switch-abort' };
        }
        return { supported: false, reason: 'error', error: describeCapabilityProbeError(error) };
    }
}

export type MachineCapabilitiesDetectResult =
    | { supported: true; response: CapabilitiesDetectResponse }
    | { supported: false; reason: 'not-supported' | 'error' | 'server-switch-abort';
        error?: CapabilityProbeError };

export async function machineCapabilitiesDetect(
    machineId: string,
    request: CapabilitiesDetectRequest,
    options?: { timeoutMs?: number; serverId?: string | null; accountId?: string | null; signal?: AbortSignal },
): Promise<MachineCapabilitiesDetectResult> {
    if (isDemoModeActive()) {
        return { supported: false, reason: 'not-supported' };
    }
    try {
        const result = await machineRpcWithServerScope<unknown, CapabilitiesDetectRequest>({
            machineId,
            method: RPC_METHODS.CAPABILITIES_DETECT,
            payload: request,
            serverId: options?.serverId,
            accountId: options?.accountId,
            ...(typeof options?.timeoutMs === 'number'
                ? { timeoutMs: options.timeoutMs }
                : { operationTimeoutMs: null }),
            ...(options?.signal ? { signal: options.signal } : {}),
        });

        if (isRpcMethodNotFoundResult(result)) return { supported: false, reason: 'not-supported' };
        if (isPlainObject(result) && typeof result.error === 'string') {
            return { supported: false, reason: 'error' };
        }

        const parsed = parseCapabilitiesDetectResponse(result);
        if (!parsed) return { supported: false, reason: 'error' };
        return { supported: true, response: parsed };
    } catch (error) {
        if (error instanceof ServerFetchAbortedForServerSwitchError) {
            return { supported: false, reason: 'server-switch-abort' };
        }
        return { supported: false, reason: 'error', error: describeCapabilityProbeError(error) };
    }
}

export type MachineCapabilitiesInvokeResult =
    | { supported: true; response: CapabilitiesInvokeResponse }
    | { supported: false; reason: 'not-supported' | 'error' | 'outcomeUnknown'; errorCode?: string; retryable?: boolean; requestDisposition?: RpcRequestDisposition };

export async function machineCapabilitiesInvoke(
    machineId: string,
    request: CapabilitiesInvokeRequest,
    options?: { timeoutMs?: number | null; operationTimeoutMs?: null; serverId?: string | null; accountId?: string | null; signal?: AbortSignal },
): Promise<MachineCapabilitiesInvokeResult> {
    // CLI preflight owns native preparation, inspection and cleanup. The
    // transport timeout still bounds setup, but must not abandon its reply.
    const preflightOwnsOperation = request.id.startsWith('cli.') && (
        request.method === 'probeModels' || request.method === 'probeModes'
        || request.method === 'probeConfigOptions' || request.method === 'probeCatalogs'
        || request.method === 'probePassiveRealtimeSetup'
    );
    try {
        const result = await machineRpcWithServerScope<unknown, CapabilitiesInvokeRequest>({
            machineId,
            method: RPC_METHODS.CAPABILITIES_INVOKE,
            payload: request,
            serverId: options?.serverId,
            accountId: options?.accountId,
            ...(options?.signal ? { signal: options.signal } : {}),
            ...(typeof options?.timeoutMs === 'number'
                ? { timeoutMs: options.timeoutMs }
                : { operationTimeoutMs: null }),
            ...(preflightOwnsOperation || options?.operationTimeoutMs === null ? { operationTimeoutMs: null } : {}),
        });

        if (isRpcMethodNotFoundResult(result)) return { supported: false, reason: 'not-supported' };
        if (isPlainObject(result) && typeof result.error === 'string') return {
            supported: false, reason: 'error', ...readCapabilityInvokeFailure(result),
        };

        const parsed = parseCapabilitiesInvokeResponse(result);
        if (!parsed) return { supported: false, reason: 'error' };
        return { supported: true, response: parsed };
    } catch (error) {
        if (options?.signal?.aborted) throw error;
        if (isRpcMethodNotFoundError(error)) return { supported: false, reason: 'not-supported' };
        const requestDisposition = readRpcRequestDisposition(error);
        return { supported: false, reason: preflightOwnsOperation && requestDisposition === 'outcomeUnknown' ? 'outcomeUnknown' : 'error',
            ...readCapabilityInvokeFailure(error),
            ...(requestDisposition ? { requestDisposition } : {}) };
    }
}

/**
 * Stop the daemon on a specific machine
 */
