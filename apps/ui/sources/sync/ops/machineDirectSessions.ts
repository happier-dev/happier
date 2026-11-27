import {
    DirectSessionLinkEnsureRequestSchema,
    DirectSessionLinkEnsureResponseSchema,
    DirectSessionRetentionRequestSchema,
    DirectSessionRetentionResponseSchema,
    DirectSessionCandidateDeleteRequestSchema,
    DirectSessionCandidateDeleteResponseSchema,
    DirectSessionStatusGetRequestSchema,
    DirectSessionStatusGetResponseSchema,
    DirectSessionTakeoverPersistStartResponseSchema,
    DirectSessionTakeoverPersistRequestSchema,
    DirectSessionTakeoverRequestSchema,
    DirectSessionTakeoverResponseSchema,
    DirectSessionsCandidatesListRequestSchema,
    DirectSessionsCandidatesListResponseSchema,
    DirectSessionsAcpSessionListCapabilityRequestSchema,
    DirectSessionsAcpSessionListCapabilityResponseSchema,
    DirectTranscriptPageRequestSchema,
    DirectTranscriptPageResponseSchema,
    DirectTranscriptReadAfterRequestSchema,
    DirectTranscriptReadAfterResponseSchema,
    LocalHistoryRpcRequestSchema,
    LocalHistoryRpcResponseSchema,
    type DirectSessionLinkEnsureRequest,
    type DirectSessionLinkEnsureResponse,
    type DirectSessionRetentionRequest,
    type DirectSessionRetentionResponse,
    type DirectSessionCandidateDeleteRequest,
    type DirectSessionCandidateDeleteResponse,
    type DirectSessionStatusGetRequest,
    type DirectSessionStatusGetResponse,
    type DirectSessionTakeoverPersistStartResponse,
    type DirectSessionTakeoverPersistRequest,
    type DirectSessionTakeoverRequest,
    type DirectSessionTakeoverResponse,
    type DirectSessionsCandidatesListRequest,
    type DirectSessionsCandidatesListResponse,
    type DirectTranscriptPageRequest,
    type DirectTranscriptPageResponse,
    type DirectTranscriptReadAfterRequest,
    type DirectTranscriptReadAfterResponse,
    type LocalHistoryRpcRequest,
    type LocalHistoryRpcResponse,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { ZodType } from 'zod';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError } from '@/sync/runtime/rpcErrors';
import { storage } from '@/sync/domains/state/storage';
import { resolveTerminalSpawnOptions } from '@/sync/domains/settings/terminalSettings';
import { readReplacementAwareMachineRpcTarget } from './machineRpcTarget';

type MachineDirectSessionsOpts = Readonly<{
    serverId?: string | null;
    timeoutMs?: number | null;
}>;

function throwUnsupportedResponse(method: string): never {
    throw new Error(`Unsupported response from machine RPC (${method})`);
}

async function callDirectSessionMachineRpc<Request, Response>(params: Readonly<{
    machineId: string;
    method: string;
    input: Request;
    requestSchema: ZodType<Request>;
    responseSchema: ZodType<Response>;
    opts?: MachineDirectSessionsOpts;
}>): Promise<Response> {
    const payload = params.requestSchema.parse(params.input);
    const routeTarget = readReplacementAwareMachineRpcTarget(params.machineId);
    if (!routeTarget) {
        throw new Error(`Machine RPC target is unavailable (${params.method})`);
    }
    const response = await machineRpcWithServerScope<unknown, Request>({
        machineId: routeTarget.machineId,
        serverId: params.opts?.serverId,
        timeoutMs: params.opts?.timeoutMs ?? undefined,
        method: params.method,
        payload,
    });
    const parsed = params.responseSchema.safeParse(response);
    if (!parsed.success) {
        throwUnsupportedResponse(params.method);
    }
    return parsed.data;
}

export async function machineDirectSessionRetention(
    machineId: string,
    input: DirectSessionRetentionRequest,
    opts?: MachineDirectSessionsOpts,
): Promise<DirectSessionRetentionResponse> {
    try {
        return await callDirectSessionMachineRpc({
            machineId,
            method: RPC_METHODS.DAEMON_DIRECT_SESSION_RETENTION,
            input,
            requestSchema: DirectSessionRetentionRequestSchema,
            responseSchema: DirectSessionRetentionResponseSchema,
            opts,
        });
    } catch (error) {
        if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) {
            return { ok: false, errorCode: 'provider_unavailable' };
        }
        throw error;
    }
}

export async function machineLocalHistory(
    machineId: string,
    input: LocalHistoryRpcRequest,
    opts?: MachineDirectSessionsOpts,
): Promise<LocalHistoryRpcResponse> {
    try {
        return await callDirectSessionMachineRpc({
            machineId,
            method: RPC_METHODS.DAEMON_LOCAL_HISTORY,
            input,
            requestSchema: LocalHistoryRpcRequestSchema,
            responseSchema: LocalHistoryRpcResponseSchema,
            opts,
        });
    } catch (error) {
        if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) {
            return { ok: false, errorCode: 'provider_unavailable' };
        }
        throw error;
    }
}

export async function machineDirectSessionsCandidatesList(
    input: DirectSessionsCandidatesListRequest,
    opts?: MachineDirectSessionsOpts,
): Promise<DirectSessionsCandidatesListResponse> {
    if (input.source.kind === 'acpSessionList') {
        try {
            await callDirectSessionMachineRpc({
                machineId: input.machineId,
                method: RPC_METHODS.DAEMON_DIRECT_SESSIONS_ACP_SESSION_LIST_CAPABILITY_GET,
                input: {},
                requestSchema: DirectSessionsAcpSessionListCapabilityRequestSchema,
                responseSchema: DirectSessionsAcpSessionListCapabilityResponseSchema,
                opts,
            });
        } catch (error) {
            if (!isRpcMethodNotAvailableError(error) && !isRpcMethodNotFoundError(error)) {
                throw error;
            }
            return {
                ok: false,
                errorCode: 'provider_unavailable',
                error: 'acp_session_list_requires_daemon_upgrade',
            };
        }
    }
    return callDirectSessionMachineRpc({
        machineId: input.machineId,
        method: RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST,
        input,
        requestSchema: DirectSessionsCandidatesListRequestSchema,
        responseSchema: DirectSessionsCandidatesListResponseSchema,
        opts,
    });
}

export async function machineDirectSessionCandidateDelete(
    input: DirectSessionCandidateDeleteRequest,
    opts?: MachineDirectSessionsOpts,
): Promise<DirectSessionCandidateDeleteResponse> {
    return callDirectSessionMachineRpc({
        machineId: input.machineId,
        method: RPC_METHODS.DAEMON_DIRECT_SESSION_CANDIDATE_DELETE,
        input,
        requestSchema: DirectSessionCandidateDeleteRequestSchema,
        responseSchema: DirectSessionCandidateDeleteResponseSchema,
        opts,
    });
}

export async function machineDirectSessionLinkEnsure(
    input: DirectSessionLinkEnsureRequest,
    opts?: MachineDirectSessionsOpts,
): Promise<DirectSessionLinkEnsureResponse> {
    return callDirectSessionMachineRpc({
        machineId: input.machineId,
        method: RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE,
        input,
        requestSchema: DirectSessionLinkEnsureRequestSchema,
        responseSchema: DirectSessionLinkEnsureResponseSchema,
        opts,
    });
}

export async function machineDirectSessionStatusGet(
    input: DirectSessionStatusGetRequest,
    opts?: MachineDirectSessionsOpts,
): Promise<DirectSessionStatusGetResponse> {
    return callDirectSessionMachineRpc({
        machineId: input.machineId,
        method: RPC_METHODS.DAEMON_DIRECT_SESSION_STATUS_GET,
        input,
        requestSchema: DirectSessionStatusGetRequestSchema,
        responseSchema: DirectSessionStatusGetResponseSchema,
        opts,
    });
}

export async function machineDirectSessionTranscriptPage(
    input: DirectTranscriptPageRequest,
    opts?: MachineDirectSessionsOpts,
): Promise<DirectTranscriptPageResponse> {
    return callDirectSessionMachineRpc({
        machineId: input.machineId,
        method: RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_PAGE,
        input,
        requestSchema: DirectTranscriptPageRequestSchema,
        responseSchema: DirectTranscriptPageResponseSchema,
        opts,
    });
}

export async function machineDirectSessionTranscriptReadAfter(
    input: DirectTranscriptReadAfterRequest,
    opts?: MachineDirectSessionsOpts,
): Promise<DirectTranscriptReadAfterResponse> {
    return callDirectSessionMachineRpc({
        machineId: input.machineId,
        method: RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_READ_AFTER,
        input,
        requestSchema: DirectTranscriptReadAfterRequestSchema,
        responseSchema: DirectTranscriptReadAfterResponseSchema,
        opts,
    });
}

function withTakeoverTerminalSettings(input: DirectSessionTakeoverRequest): DirectSessionTakeoverRequest {
    const terminal = input.terminal ?? resolveTerminalSpawnOptions({
        settings: storage.getState().settings,
        machineId: readReplacementAwareMachineRpcTarget(input.machineId)?.machineId ?? input.machineId,
    });
    return terminal ? { ...input, terminal } : input;
}

export async function machineDirectSessionTakeover(
    input: DirectSessionTakeoverRequest,
    opts?: MachineDirectSessionsOpts,
): Promise<DirectSessionTakeoverResponse> {
    return callDirectSessionMachineRpc({
        machineId: input.machineId,
        method: RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER,
        input: withTakeoverTerminalSettings(input),
        requestSchema: DirectSessionTakeoverRequestSchema,
        responseSchema: DirectSessionTakeoverResponseSchema,
        opts,
    });
}

export async function machineDirectSessionTakeoverPersistStart(
    input: DirectSessionTakeoverPersistRequest,
    opts?: MachineDirectSessionsOpts,
): Promise<DirectSessionTakeoverPersistStartResponse> {
    try {
        return await callDirectSessionMachineRpc({
            machineId: input.machineId,
            method: RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST_START,
            input: withTakeoverTerminalSettings(input),
            requestSchema: DirectSessionTakeoverPersistRequestSchema,
            responseSchema: DirectSessionTakeoverPersistStartResponseSchema,
            opts,
        });
    } catch (error) {
        if (!isRpcMethodNotAvailableError(error) && !isRpcMethodNotFoundError(error)) throw error;
        return { ok: false, errorCode: 'provider_unavailable', error: 'direct_session_import_requires_daemon_upgrade' };
    }
}
