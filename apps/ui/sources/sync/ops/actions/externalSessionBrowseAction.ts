import { ExternalSessionCandidateDeleteRequestSchema, ExternalSessionLinkEnsureRequestSchema, ExternalSessionsCandidatesListRequestSchema } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import {
    ExternalSessionMaterializeActionInputV1Schema,
    ExternalSessionOperationReferenceV1Schema,
    projectExternalSessionMaterializeActionResultV1,
    projectExternalSessionOperationActionResultV1,
} from '@happier-dev/protocol/sessions';
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
export const executeExternalSessionBrowseAction: NonNullable<ActionExecutorDeps['hostExternalSessionAction']> = async ({ actionId, input, context, signal }) => {
    const options = { serverId: context.serverId, ...(signal ? { signal } : {}) };
    switch (actionId) {
        case 'sessions.external.candidates.list':
            return { ok: true, result: await machineExternalSessionsCandidatesList(ExternalSessionsCandidatesListRequestSchema.parse(input), options) };
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
