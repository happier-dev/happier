import {
    SessionHandoffStartResponseSchema,
    type ActionOperationSnapshotV1,
    type SessionHandoffStorageMode,
    type SessionHandoffWorkspaceTransfer,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { observeActionOperationTerminal } from '@/sync/domains/actionOperations/observeActionOperationTerminal';
import { resolveSessionHandoffRuntimeConfig } from '@/sync/domains/sessionHandoff/sessionHandoffRuntimeConfig';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

type MachineRpc = (params: Readonly<{
    machineId: string;
    method: string;
    payload: unknown;
    serverId: string | null;
    timeoutMs: number;
}>) => Promise<unknown>;

type ObserveTerminal = (params: Readonly<{
    accountId: string;
    machineId: string;
    actionId: string;
    requestId: string;
    signal?: AbortSignal;
}>) => Promise<ActionOperationSnapshotV1>;

function readNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
}

function readAdmissionFailure(value: unknown): Readonly<{
    ok: false;
    errorCode: string;
    errorMessage: string;
}> | null {
    if (!value || typeof value !== 'object' || (value as { ok?: unknown }).ok !== false) return null;
    const record = value as Record<string, unknown>;
    return {
        ok: false,
        errorCode: readNonEmptyString(record.errorCode) ?? 'handoff_failed',
        errorMessage: readNonEmptyString(record.error) ?? readNonEmptyString(record.errorMessage) ?? 'Failed to start session handoff',
    };
}

function createAbortError(): Error {
    if (typeof DOMException !== 'undefined') {
        return new DOMException('Aborted', 'AbortError') as unknown as Error;
    }
    const error = new Error('Aborted');
    error.name = 'AbortError';
    return error;
}

export async function delegateSessionHandoffToSourceDaemon(
    params: Readonly<{
        accountId: string;
        sourceMachineId: string;
        targetMachineId: string;
        targetPath?: string;
        sessionId: string;
        sessionStorageMode: SessionHandoffStorageMode;
        targetSessionStorageMode?: SessionHandoffStorageMode;
        requestId: string;
        workspaceTransfer?: SessionHandoffWorkspaceTransfer;
        serverId?: string | null;
        signal?: AbortSignal;
    }>,
    deps?: Readonly<{
        machineRpc?: MachineRpc;
        observeTerminal?: ObserveTerminal;
    }>,
): Promise<
    | Readonly<{ ok: true; handoffId: string; status: unknown; warning?: unknown }>
    | Readonly<{ ok: false; errorCode: string; errorMessage: string }>
> {
    if (params.signal?.aborted) throw createAbortError();
    const observerController = new AbortController();
    const abortObserver = () => observerController.abort();
    params.signal?.addEventListener('abort', abortObserver, { once: true });
    const observedTerminal = (deps?.observeTerminal ?? observeActionOperationTerminal)({
        accountId: params.accountId,
        machineId: params.sourceMachineId,
        actionId: 'session.handoff',
        requestId: params.requestId,
        signal: observerController.signal,
    });
    void observedTerminal.catch(() => {});

    try {
        let rawAdmission: unknown;
        try {
            rawAdmission = await (deps?.machineRpc ?? machineRpcWithServerScope)({
                machineId: params.sourceMachineId,
                method: RPC_METHODS.DAEMON_SESSION_HANDOFF_START,
                payload: {
                    requestId: params.requestId,
                    sessionId: params.sessionId,
                    sourceMachineId: params.sourceMachineId,
                    targetMachineId: params.targetMachineId,
                    ...(params.targetPath ? { targetPath: params.targetPath } : {}),
                    sessionStorageMode: params.sessionStorageMode,
                    ...(params.targetSessionStorageMode ? { targetSessionStorageMode: params.targetSessionStorageMode } : {}),
                    preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
                    ...(params.workspaceTransfer ? { workspaceTransfer: params.workspaceTransfer } : {}),
                },
                serverId: params.serverId?.trim() || null,
                timeoutMs: resolveSessionHandoffRuntimeConfig().machineRpcTimeoutMs,
            });
        } catch (error) {
            observerController.abort();
            throw error;
        }

        const admissionFailure = readAdmissionFailure(rawAdmission);
        if (admissionFailure) {
            observerController.abort();
            return admissionFailure;
        }
        if (!SessionHandoffStartResponseSchema.safeParse(rawAdmission).success) {
            observerController.abort();
            return {
                ok: false,
                errorCode: 'invalid_response',
                errorMessage: 'Unsupported session handoff response from daemon',
            };
        }

        if (params.signal?.aborted) throw createAbortError();
        const terminal = await observedTerminal;
        if (terminal.state === 'cancelled') throw createAbortError();
        if (terminal.state === 'failed') {
            return {
                ok: false,
                errorCode: terminal.error?.errorCode ?? 'handoff_failed',
                errorMessage: terminal.error?.error ?? 'Failed to complete session handoff',
            };
        }
        const result = terminal.result;
        if (!result || typeof result !== 'object') {
            return {
                ok: false,
                errorCode: 'invalid_response',
                errorMessage: 'Invalid terminal session handoff result',
            };
        }
        const handoffId = readNonEmptyString((result as Record<string, unknown>).handoffId);
        if (!handoffId) {
            return {
                ok: false,
                errorCode: 'invalid_response',
                errorMessage: 'Invalid terminal session handoff result',
            };
        }
        return {
            ok: true,
            ...(result as Record<string, unknown>),
            handoffId,
        } as Readonly<{ ok: true; handoffId: string; status: unknown; warning?: unknown }>;
    } finally {
        params.signal?.removeEventListener('abort', abortObserver);
    }
}
