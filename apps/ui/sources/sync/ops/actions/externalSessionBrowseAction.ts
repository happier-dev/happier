import { ExternalSessionBackgroundFollowActionInputV1Schema, ExternalSessionCandidateDeleteRequestSchema, ExternalSessionLinkEnsureRequestSchema, ExternalSessionsCandidatesListRequestSchema, ExternalSessionStatusActionInputV1Schema, ExternalSessionTranscriptPageRequestSchema, ExternalSessionTranscriptReadAfterRequestSchema } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET_ACTION_ID, EXTERNAL_SESSION_STATUS_GET_ACTION_ID, EXTERNAL_SESSION_TAKEOVER_START_ACTION_ID, EXTERNAL_SESSION_TRANSCRIPT_PAGE_ACTION_ID, EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER_ACTION_ID } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import {
    ExternalSessionMaterializeActionInputV1Schema,
    ExternalSessionOperationReferenceV1Schema,
    projectExternalSessionMaterializeActionResultV1,
    projectExternalSessionOperationActionResultV1,
} from '@happier-dev/protocol/sessions';
import {
    ExternalSessionTakeoverActionInputV1Schema,
    captureExternalSessionTakeoverStartInputV1,
} from '@happier-dev/protocol/sessions/external/operationActionSchemasV1';
import {
    machineExternalSessionCandidateDelete,
    machineExternalSessionLinkEnsure,
    machineExternalSessionsCandidatesList,
    machineExternalSessionMaterializeStart,
    machineExternalSessionOperationStatus,
    machineExternalSessionOperationCancel,
    machineExternalSessionOperationResume,
    machineExternalSessionOperationRetry,
    machineExternalSessionOperationDiscard,
    machineExternalSessionFollowPolicySet,
    machineExternalSessionStatusGet,
    machineExternalSessionTranscriptPage,
    machineExternalSessionTranscriptReadAfter,
    machineExternalSessionTakeoverStart,
} from '@/sync/ops/machineExternalSessions';
import { storage } from '@/sync/domains/state/storage';
import { resolveSessionAddressFromLocalState } from '@/sync/domains/session/resolveSessionAddressFromLocalState';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

function readExternalActionOwnerMetadata(sessionId: string, serverId?: string | null) {
    const state = storage.getState();
    const address = serverId ? { serverId, sessionId } : resolveSessionAddressFromLocalState(state, sessionId);
    if (!address) return null;
    const direct = state.sessions[sessionId];
    const session = direct && areServerProfileIdentifiersEquivalent(direct.serverId, address.serverId)
        ? direct
        : readSessionListRowForServerId(state.sessionListRowsByServerId, address.serverId, sessionId);
    return session ? { serverId: address.serverId, metadata: readSessionOwnerMetadataView(session) } : null;
}

/** Host-side Browse controls retain the exact existing Machine RPC/compatibility owner. */
export const executeExternalSessionBrowseAction = async (
    { actionId, input, context, signal }: Parameters<NonNullable<ActionExecutorDeps['hostExternalSessionAction']>>[0],
    isFollowIntentCurrent?: () => boolean,
): Promise<ActionExecuteResult> => {
    const options = { serverId: context.serverId,
        ...(context.expectedAccountId ? { accountId: context.expectedAccountId } : {}),
        ...(signal ? { signal } : {}) };
    switch (actionId) {
        case EXTERNAL_SESSION_STATUS_GET_ACTION_ID: {
            const parsed = ExternalSessionStatusActionInputV1Schema.parse(input);
            const owner = readExternalActionOwnerMetadata(parsed.sessionId, context.serverId);
            const link = readExternalSessionLink(owner?.metadata);
            if (!link) return { ok: false, errorCode: 'session_machine_target_unavailable', error: 'Session owner Machine is unavailable' };
            const response = await machineExternalSessionStatusGet({ ...parsed, machineId: link.machineId,
                agentId: link.agentId, remoteSessionId: link.remoteSessionId, source: link.source },
                { ...options, serverId: owner?.serverId });
            const result = await getActionSpec(actionId).surfaceBindings!.plugin!.projectOutput!(response, {
                actionId, surface: 'rpc', caller: { kind: 'host' }, input: parsed,
            });
            return { ok: true, result };
        }
        case EXTERNAL_SESSION_TRANSCRIPT_PAGE_ACTION_ID:
            return { ok: true, result: await machineExternalSessionTranscriptPage(ExternalSessionTranscriptPageRequestSchema.parse(input), options) };
        case EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER_ACTION_ID:
            return { ok: true, result: await machineExternalSessionTranscriptReadAfter(ExternalSessionTranscriptReadAfterRequestSchema.parse(input), options) };
        case EXTERNAL_SESSION_TAKEOVER_START_ACTION_ID: {
            const parsed = ExternalSessionTakeoverActionInputV1Schema.parse(input);
            const owner = readExternalActionOwnerMetadata(parsed.request.sessionId, context.serverId);
            const captured = captureExternalSessionTakeoverStartInputV1(parsed, readExternalSessionLink(owner?.metadata));
            if (!captured) return { ok: true, result: { ok: false, error: { code: 'source_unavailable', message: 'Linked session source is unavailable' } } };
            const response = await machineExternalSessionTakeoverStart({ machineId: captured.request.source.machineId, ...captured },
                { ...options, serverId: owner?.serverId });
            return { ok: true, result: projectExternalSessionOperationActionResultV1(response, parsed.request.sessionId) };
        }
        case EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET_ACTION_ID: {
            const parsed = ExternalSessionBackgroundFollowActionInputV1Schema.parse(input);
            const owner = readExternalActionOwnerMetadata(parsed.sessionId, context.serverId);
            const link = readExternalSessionLink(owner?.metadata);
            if (!link) return { ok: false, errorCode: 'session_machine_target_unavailable', error: 'Session owner Machine is unavailable' };
            // This private UI precondition carries the exact link captured by
            // the user's toggle across asynchronous approval/admission.
            if (isFollowIntentCurrent?.() === false) {
                return { ok: false, errorCode: 'external_session_follow_intent_stale', error: 'external_session_follow_intent_stale' };
            }
            const response = await machineExternalSessionFollowPolicySet({ ...parsed, machineId: link.machineId,
                agentId: link.agentId, remoteSessionId: link.remoteSessionId, source: link.source },
                { ...options, serverId: owner?.serverId });
            const result = await getActionSpec(actionId).surfaceBindings!.plugin!.projectOutput!(response, {
                actionId, surface: 'rpc', caller: { kind: 'host' }, input: parsed,
                ...(signal ? { signal } : {}),
            });
            return { ok: true, result };
        }
        case 'sessions.external.candidates.list': {
            try {
                return { ok: true, result: await machineExternalSessionsCandidatesList(ExternalSessionsCandidatesListRequestSchema.parse(input), options) };
            } catch (error) {
                // Preserve transport classification through the Action envelope without vendor text.
                const code = readRpcErrorCode(error) ?? (error && typeof error === 'object' && 'code' in error
                    && error.code === 'MACHINE_RPC_TIMEOUT' ? error.code : null);
                if (code) return { ok: false, errorCode: code, error: code };
                throw error;
            }
        }
        case 'sessions.external.candidate.delete':
            return { ok: true, result: await machineExternalSessionCandidateDelete(ExternalSessionCandidateDeleteRequestSchema.parse(input), options) };
        case 'sessions.external.link.ensure':
            return { ok: true, result: await machineExternalSessionLinkEnsure(ExternalSessionLinkEnsureRequestSchema.parse(input), options) };
        case 'sessions.external.materialize.start': {
            const parsed = ExternalSessionMaterializeActionInputV1Schema.parse(input);
            const owner = readExternalActionOwnerMetadata(parsed.request.sessionId, context.serverId);
            const machineId = readExternalSessionLink(owner?.metadata)?.machineId;
            if (!machineId) return { ok: false, errorCode: 'session_machine_target_unavailable', error: 'Session owner Machine is unavailable' };
            const response = await machineExternalSessionMaterializeStart({ machineId, ...parsed }, { ...options, serverId: owner?.serverId });
            return { ok: true, result: projectExternalSessionMaterializeActionResultV1(response, parsed.request.sessionId) };
        }
        case 'sessions.external.operation.status.get':
        case 'sessions.external.operation.cancel':
        case 'sessions.external.operation.resume':
        case 'sessions.external.operation.retry':
        case 'sessions.external.operation.discard': {
            const parsed = ExternalSessionOperationReferenceV1Schema.parse(input);
            const owner = readExternalActionOwnerMetadata(parsed.sessionId, context.serverId);
            const machineId = resolveSessionMachineId(owner?.metadata);
            if (!machineId) return { ok: false, errorCode: 'session_machine_target_unavailable', error: 'Session owner Machine is unavailable' };
            const operation = actionId === 'sessions.external.operation.status.get' ? machineExternalSessionOperationStatus
                : actionId === 'sessions.external.operation.cancel' ? machineExternalSessionOperationCancel
                    : actionId === 'sessions.external.operation.resume' ? machineExternalSessionOperationResume
                        : actionId === 'sessions.external.operation.retry' ? machineExternalSessionOperationRetry
                            : machineExternalSessionOperationDiscard;
            const response = await operation({ machineId, ...parsed }, { ...options, serverId: owner?.serverId });
            return { ok: true, result: projectExternalSessionOperationActionResultV1(response, parsed.sessionId) };
        }
        default:
            return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
    }
};
