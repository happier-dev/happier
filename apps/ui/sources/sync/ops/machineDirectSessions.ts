import {
    DirectSessionLinkEnsureRequestSchema,
    DirectSessionLinkEnsureResponseSchema,
    DirectSessionStatusGetRequestSchema,
    DirectSessionStatusGetResponseSchema,
    DirectSessionTakeoverPersistRequestSchema,
    DirectSessionTakeoverPersistResponseSchema,
    DirectSessionTakeoverRequestSchema,
    DirectSessionTakeoverResponseSchema,
    DirectSessionsCandidatesListRequestSchema,
    DirectSessionsCandidatesListResponseSchema,
    DirectTranscriptPageRequestSchema,
    DirectTranscriptPageResponseSchema,
    DirectTranscriptReadAfterRequestSchema,
    DirectTranscriptReadAfterResponseSchema,
    type DirectSessionLinkEnsureRequest,
    type DirectSessionLinkEnsureResponse,
    type DirectSessionStatusGetRequest,
    type DirectSessionStatusGetResponse,
    type DirectSessionTakeoverPersistRequest,
    type DirectSessionTakeoverPersistResponse,
    type DirectSessionTakeoverRequest,
    type DirectSessionTakeoverResponse,
    type DirectSessionsCandidatesListRequest,
    type DirectSessionsCandidatesListResponse,
    type DirectTranscriptPageRequest,
    type DirectTranscriptPageResponse,
    type DirectTranscriptReadAfterRequest,
    type DirectTranscriptReadAfterResponse,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { ZodType } from 'zod';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

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
    const response = await machineRpcWithServerScope<unknown, Request>({
        machineId: params.machineId,
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

export async function machineDirectSessionsCandidatesList(
    input: DirectSessionsCandidatesListRequest,
    opts?: MachineDirectSessionsOpts,
): Promise<DirectSessionsCandidatesListResponse> {
    return callDirectSessionMachineRpc({
        machineId: input.machineId,
        method: RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST,
        input,
        requestSchema: DirectSessionsCandidatesListRequestSchema,
        responseSchema: DirectSessionsCandidatesListResponseSchema,
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

export async function machineDirectSessionTakeover(
    input: DirectSessionTakeoverRequest,
    opts?: MachineDirectSessionsOpts,
): Promise<DirectSessionTakeoverResponse> {
    return callDirectSessionMachineRpc({
        machineId: input.machineId,
        method: RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER,
        input,
        requestSchema: DirectSessionTakeoverRequestSchema,
        responseSchema: DirectSessionTakeoverResponseSchema,
        opts,
    });
}

export async function machineDirectSessionTakeoverPersist(
    input: DirectSessionTakeoverPersistRequest,
    opts?: MachineDirectSessionsOpts,
): Promise<DirectSessionTakeoverPersistResponse> {
    return callDirectSessionMachineRpc({
        machineId: input.machineId,
        method: RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST,
        input,
        requestSchema: DirectSessionTakeoverPersistRequestSchema,
        responseSchema: DirectSessionTakeoverPersistResponseSchema,
        opts,
    });
}
