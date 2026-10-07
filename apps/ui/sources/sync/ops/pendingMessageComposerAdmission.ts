import {
    SessionPendingMessageComposerAdmissionAcceptedRequestV1Schema,
    SessionPendingMessageComposerAdmissionAbandonedRequestV1Schema,
    SessionPendingMessageComposerAdmissionPrepareRequestV1Schema,
    SessionPendingMessageComposerAdmissionPrepareResponseV1Schema,
    type SessionPendingMessageComposerAdmissionAcceptedRequestV1,
    type SessionPendingMessageComposerAdmissionAbandonedRequestV1,
    type SessionPendingMessageComposerAdmissionPrepareRequestV1,
    type SessionPendingMessageComposerAdmissionPrepareResponseV1,
} from '@happier-dev/protocol/sessions/userMessageRpc';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import {
    sessionRpcWithServerAccountScope,
    sessionRpcWithServerScope,
} from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';

type PendingMessageComposerAdmissionOptions = Readonly<{
    serverId?: string | null;
    signal?: AbortSignal;
    accountLifetime?: ServerAccountScopeLifetime;
}>;

function exactScopeRetiredError(): Error {
    return Object.assign(new Error('Session Account authority is unavailable'), {
        code: 'session_account_scope_retired',
    });
}

async function pendingMessageComposerAdmissionRpc<R, A>(params: Readonly<{
    sessionId: string;
    method: string;
    payload: A;
    options?: PendingMessageComposerAdmissionOptions;
}>): Promise<R> {
    const lifetime = params.options?.accountLifetime;
    if (!lifetime) {
        return await sessionRpcWithServerScope<R, A>({
            sessionId: params.sessionId,
            serverId: params.options?.serverId,
            method: params.method,
            payload: params.payload,
            signal: params.options?.signal,
        });
    }
    if (!lifetime.isCurrent()) throw exactScopeRetiredError();

    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    params.options?.signal?.addEventListener('abort', forwardAbort, { once: true });
    const retirement = lifetime.onRetire(forwardAbort);
    try {
        const result = await sessionRpcWithServerAccountScope<R, A>({
            sessionId: params.sessionId,
            scope: lifetime.scope,
            method: params.method,
            payload: params.payload,
            signal: controller.signal,
            onIssued: () => {
                if (!lifetime.isCurrent()) throw exactScopeRetiredError();
            },
        });
        if (!lifetime.isCurrent()) throw exactScopeRetiredError();
        return result;
    } finally {
        retirement.dispose();
        params.options?.signal?.removeEventListener('abort', forwardAbort);
    }
}

export async function preparePendingMessageComposerAdmission(
    sessionId: string,
    request: SessionPendingMessageComposerAdmissionPrepareRequestV1,
    options?: PendingMessageComposerAdmissionOptions,
): Promise<SessionPendingMessageComposerAdmissionPrepareResponseV1> {
    const payload = SessionPendingMessageComposerAdmissionPrepareRequestV1Schema.parse(request);
    const response = await pendingMessageComposerAdmissionRpc<unknown, typeof payload>({
        sessionId,
        method: SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_PREPARE_V1,
        payload,
        options,
    });
    return SessionPendingMessageComposerAdmissionPrepareResponseV1Schema.parse(response);
}

export async function acceptPendingMessageComposerAdmission(
    sessionId: string,
    request: SessionPendingMessageComposerAdmissionAcceptedRequestV1,
    options?: PendingMessageComposerAdmissionOptions,
): Promise<void> {
    const payload = SessionPendingMessageComposerAdmissionAcceptedRequestV1Schema.parse(request);
    const response = await pendingMessageComposerAdmissionRpc<unknown, typeof payload>({
        sessionId,
        method: SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_ACCEPTED_V1,
        payload,
        options,
    });
    if (!response || typeof response !== 'object' || (response as { ok?: unknown }).ok !== true) {
        throw new Error('composer_attachment_acceptance_settlement_failed');
    }
}

export async function abandonPendingMessageComposerAdmission(
    sessionId: string,
    request: SessionPendingMessageComposerAdmissionAbandonedRequestV1,
    options?: PendingMessageComposerAdmissionOptions,
): Promise<void> {
    const payload = SessionPendingMessageComposerAdmissionAbandonedRequestV1Schema.parse(request);
    const response = await pendingMessageComposerAdmissionRpc<unknown, typeof payload>({
        sessionId,
        method: SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_ABANDONED_V1,
        payload,
        options,
    });
    if (!response || typeof response !== 'object' || (response as { ok?: unknown }).ok !== true) {
        throw new Error('composer_media_abandonment_settlement_failed');
    }
}
