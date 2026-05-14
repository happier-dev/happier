import {
    ExternalSessionTakeoverInputV1Schema,
    type ExternalSessionTakeoverInputV1,
} from '@happier-dev/protocol/sessions';
import {
    ExternalSessionAttachRequestSchema,
    ExternalSessionAttachResponseSchema,
    ExternalSessionDetachRequestSchema,
    ExternalSessionDetachResponseSchema,
    ExternalSessionFollowPolicySetRequestSchema,
    ExternalSessionFollowPolicySetResponseSchema,
    ExternalSessionLinkEnsureRequestSchema,
    ExternalSessionLinkEnsureResponseSchema,
    ExternalSessionStatusGetRequestSchema,
    ExternalSessionStatusGetResponseSchema,
    ExternalSessionTakeoverPersistResponseSchema,
    ExternalSessionTakeoverResponseSchema,
    ExternalSessionsCandidatesListRequestSchema,
    ExternalSessionsCandidatesListResponseSchema,
    ExternalSessionTranscriptPageRequestSchema,
    ExternalSessionTranscriptPageResponseSchema,
    ExternalSessionTranscriptReadAfterRequestSchema,
    ExternalSessionTranscriptReadAfterResponseSchema,
    type ExternalSessionAttachRequest,
    type ExternalSessionAttachResponse,
    type ExternalSessionDetachRequest,
    type ExternalSessionDetachResponse,
    type ExternalSessionFollowPolicySetRequest,
    type ExternalSessionFollowPolicySetResponse,
    type ExternalSessionLinkEnsureRequest,
    type ExternalSessionLinkEnsureResponse,
    type ExternalSessionStatusGetRequest,
    type ExternalSessionStatusGetResponse,
    type ExternalSessionTakeoverPersistRequest,
    type ExternalSessionTakeoverPersistResponse,
    type ExternalSessionTakeoverRequest,
    type ExternalSessionTakeoverResponse,
    type ExternalSessionsCandidatesListRequest,
    type ExternalSessionsCandidatesListResponse,
    type ExternalSessionTranscriptPageRequest,
    type ExternalSessionTranscriptPageResponse,
    type ExternalSessionTranscriptReadAfterRequest,
    type ExternalSessionTranscriptReadAfterResponse,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { ZodType } from 'zod';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { readReplacementAwareMachineRpcTarget } from './machineRpcTarget';

type MachineExternalSessionsOpts = Readonly<{
    serverId?: string | null;
    timeoutMs?: number | null;
}>;

function throwUnsupportedResponse(method: string): never {
    throw new Error(`Unsupported response from machine RPC (${method})`);
}

async function callExternalSessionMachineRpc<Request, Response>(params: Readonly<{
    machineId: string;
    method: string;
    input: Request;
    requestSchema: ZodType<Request>;
    responseSchema: ZodType<Response>;
    opts?: MachineExternalSessionsOpts;
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

export async function machineExternalSessionsCandidatesList(
    input: ExternalSessionsCandidatesListRequest,
    opts?: MachineExternalSessionsOpts,
): Promise<ExternalSessionsCandidatesListResponse> {
    return callExternalSessionMachineRpc({
        machineId: input.machineId,
        method: RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST,
        input,
        requestSchema: ExternalSessionsCandidatesListRequestSchema,
        responseSchema: ExternalSessionsCandidatesListResponseSchema,
        opts,
    });
}

export async function machineExternalSessionLinkEnsure(
    input: ExternalSessionLinkEnsureRequest,
    opts?: MachineExternalSessionsOpts,
): Promise<ExternalSessionLinkEnsureResponse> {
    return callExternalSessionMachineRpc({
        machineId: input.machineId,
        method: RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE,
        input,
        requestSchema: ExternalSessionLinkEnsureRequestSchema,
        responseSchema: ExternalSessionLinkEnsureResponseSchema,
        opts,
    });
}

export async function machineExternalSessionAttach(
    input: ExternalSessionAttachRequest,
    opts?: MachineExternalSessionsOpts,
): Promise<ExternalSessionAttachResponse> {
    return callExternalSessionMachineRpc({
        machineId: input.machineId,
        method: RPC_METHODS.DAEMON_EXTERNAL_SESSION_ATTACH,
        input,
        requestSchema: ExternalSessionAttachRequestSchema,
        responseSchema: ExternalSessionAttachResponseSchema,
        opts,
    });
}

export async function machineExternalSessionDetach(
    input: ExternalSessionDetachRequest,
    opts?: MachineExternalSessionsOpts,
): Promise<ExternalSessionDetachResponse> {
    return callExternalSessionMachineRpc({
        machineId: input.machineId,
        method: RPC_METHODS.DAEMON_EXTERNAL_SESSION_DETACH,
        input,
        requestSchema: ExternalSessionDetachRequestSchema,
        responseSchema: ExternalSessionDetachResponseSchema,
        opts,
    });
}

export async function machineExternalSessionFollowPolicySet(
    input: ExternalSessionFollowPolicySetRequest,
    opts?: MachineExternalSessionsOpts,
): Promise<ExternalSessionFollowPolicySetResponse> {
    return callExternalSessionMachineRpc({
        machineId: input.machineId,
        method: RPC_METHODS.DAEMON_EXTERNAL_SESSION_FOLLOW_POLICY_SET,
        input,
        requestSchema: ExternalSessionFollowPolicySetRequestSchema,
        responseSchema: ExternalSessionFollowPolicySetResponseSchema,
        opts,
    });
}

export async function machineExternalSessionStatusGet(
    input: ExternalSessionStatusGetRequest,
    opts?: MachineExternalSessionsOpts,
): Promise<ExternalSessionStatusGetResponse> {
    return callExternalSessionMachineRpc({
        machineId: input.machineId,
        method: RPC_METHODS.DAEMON_EXTERNAL_SESSION_STATUS_GET,
        input,
        requestSchema: ExternalSessionStatusGetRequestSchema,
        responseSchema: ExternalSessionStatusGetResponseSchema,
        opts,
    });
}

export async function machineExternalSessionTranscriptPage(
    input: ExternalSessionTranscriptPageRequest,
    opts?: MachineExternalSessionsOpts,
): Promise<ExternalSessionTranscriptPageResponse> {
    return callExternalSessionMachineRpc({
        machineId: input.machineId,
        method: RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE,
        input,
        requestSchema: ExternalSessionTranscriptPageRequestSchema,
        responseSchema: ExternalSessionTranscriptPageResponseSchema,
        opts,
    });
}

export async function machineExternalSessionTranscriptReadAfter(
    input: ExternalSessionTranscriptReadAfterRequest,
    opts?: MachineExternalSessionsOpts,
): Promise<ExternalSessionTranscriptReadAfterResponse> {
    return callExternalSessionMachineRpc({
        machineId: input.machineId,
        method: RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER,
        input,
        requestSchema: ExternalSessionTranscriptReadAfterRequestSchema,
        responseSchema: ExternalSessionTranscriptReadAfterResponseSchema,
        opts,
    });
}

export async function machineExternalSessionTakeover(
    input: ExternalSessionTakeoverRequest,
    opts?: MachineExternalSessionsOpts,
): Promise<ExternalSessionTakeoverResponse> {
    const actionInput = {
        machineId: input.machineId,
        linkedSessionId: input.sessionId,
        targetRuntimeMode: 'terminal',
        storageMode: 'external-linked',
        ...(input.forceStop === undefined ? {} : { forceStop: input.forceStop }),
    } satisfies ExternalSessionTakeoverInputV1;

    return callExternalSessionMachineRpc({
        machineId: input.machineId,
        method: RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER,
        input: actionInput,
        requestSchema: ExternalSessionTakeoverInputV1Schema,
        responseSchema: ExternalSessionTakeoverResponseSchema,
        opts,
    });
}

export async function machineExternalSessionTakeoverPersist(
    input: ExternalSessionTakeoverPersistRequest,
    opts?: MachineExternalSessionsOpts,
): Promise<ExternalSessionTakeoverPersistResponse> {
    const actionInput = {
        machineId: input.machineId,
        linkedSessionId: input.sessionId,
        targetRuntimeMode: 'terminal',
        storageMode: 'persisted',
        ...(input.forceStop === undefined ? {} : { forceStop: input.forceStop }),
    } satisfies ExternalSessionTakeoverInputV1;

    return callExternalSessionMachineRpc({
        machineId: input.machineId,
        method: RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER,
        input: actionInput,
        requestSchema: ExternalSessionTakeoverInputV1Schema,
        responseSchema: ExternalSessionTakeoverPersistResponseSchema,
        opts,
    });
}
