import {
    SessionPendingMessageComposerAdmissionAcceptedRequestV1Schema,
    SessionPendingMessageComposerAdmissionPrepareRequestV1Schema,
    SessionPendingMessageComposerAdmissionPrepareResponseV1Schema,
    type SessionPendingMessageComposerAdmissionAcceptedRequestV1,
    type SessionPendingMessageComposerAdmissionPrepareRequestV1,
    type SessionPendingMessageComposerAdmissionPrepareResponseV1,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';

export async function preparePendingMessageComposerAdmission(
    sessionId: string,
    request: SessionPendingMessageComposerAdmissionPrepareRequestV1,
    options?: Readonly<{ serverId?: string | null; signal?: AbortSignal }>,
): Promise<SessionPendingMessageComposerAdmissionPrepareResponseV1> {
    const payload = SessionPendingMessageComposerAdmissionPrepareRequestV1Schema.parse(request);
    const response = await sessionRpcWithServerScope<unknown, typeof payload>({
        sessionId,
        serverId: options?.serverId,
        method: SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_PREPARE_V1,
        payload,
        signal: options?.signal,
    });
    return SessionPendingMessageComposerAdmissionPrepareResponseV1Schema.parse(response);
}

export async function acceptPendingMessageComposerAdmission(
    sessionId: string,
    request: SessionPendingMessageComposerAdmissionAcceptedRequestV1,
    options?: Readonly<{ serverId?: string | null; signal?: AbortSignal }>,
): Promise<void> {
    const payload = SessionPendingMessageComposerAdmissionAcceptedRequestV1Schema.parse(request);
    const response = await sessionRpcWithServerScope<unknown, typeof payload>({
        sessionId,
        serverId: options?.serverId,
        method: SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_ACCEPTED_V1,
        payload,
        signal: options?.signal,
    });
    if (!response || typeof response !== 'object' || (response as { ok?: unknown }).ok !== true) {
        throw new Error('composer_attachment_acceptance_settlement_failed');
    }
}
