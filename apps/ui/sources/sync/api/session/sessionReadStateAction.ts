import { resolveSessionReadStateActionRequest, projectSessionReadStateActionTransportFailure } from '@happier-dev/protocol/sessions/readState/actionTransport';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { SessionReadStateActionIdV1 } from '@happier-dev/protocol/sessions/readState/actionIds';
import type { SessionViewerProjectionV1 } from '@happier-dev/protocol/sessions/personal/viewer';

import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeCredentialMutations } from '@/auth/storage/tokenStorage';
import { createServerRequestForResolvedServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { resolveServerAccountRequestContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerAccountRequestContext';

export type SessionReadStateApiResult<T> =
    | Readonly<{ kind: 'ok'; value: T }>
    | Readonly<{ kind: 'failed'; error: string; viewer?: SessionViewerProjectionV1 }>;

const UNAVAILABLE = Object.freeze({ kind: 'failed', error: 'unavailable' } as const);

/**
 * One family adapter for the explicit-human read-state Action and its human
 * controls. It calls the existing `POST /v2/sessions/:sessionId/read-state`
 * domain route through the exact-Home transport and projects the canonical
 * Action result. It performs no second persistence write, evaluation, or
 * server execution: the server's `applySessionReadCursorOperation` remains the
 * sole read-state writer, and this host only binds the exact Home
 * SessionAddress.
 */
async function executeSessionReadStateAction<TActionId extends SessionReadStateActionIdV1>(
    actionId: TActionId,
    input: unknown,
    serverId: string,
    signal?: AbortSignal,
): Promise<SessionReadStateApiResult<unknown>> {
    if (!serverId.trim() || signal?.aborted) return UNAVAILABLE;
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime?.isCurrent()) return UNAVAILABLE;

    const controller = new AbortController();
    const abort = () => controller.abort();
    const retirement = lifetime.onRetire(abort);
    const unsubscribeCredentials = subscribeHomeCredentialMutations((event) => {
        if (areServerProfileIdentifiersEquivalent(event.serverId, serverId)) abort();
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const isCurrent = () => lifetime.isCurrent() && !controller.signal.aborted;
    let context: Awaited<ReturnType<typeof resolveServerAccountRequestContext>> | undefined;

    try {
        const request = resolveSessionReadStateActionRequest(actionId, input);
        context = await resolveServerAccountRequestContext({ serverId, preferScoped: true });
        if (!isCurrent() || context.scope !== 'scoped') return UNAVAILABLE;
        if (areServerProfileIdentifiersEquivalent(context.targetServerId, lifetime.scope.serverId)
            && context.targetAccountId !== lifetime.scope.accountId) return UNAVAILABLE;

        const send = createServerRequestForResolvedServerScope({
            context,
            activeRequest: async () => { throw new Error('Read state requires an explicit Home'); },
        });
        const response = await send(request.path, {
            method: request.method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request.body),
            signal: controller.signal,
        });
        if (!isCurrent()) return UNAVAILABLE;
        const payload: unknown = await response.json().catch(() => null);
        if (!isCurrent()) return UNAVAILABLE;
        if (!response.ok) {
            const failure = projectSessionReadStateActionTransportFailure(response.status, payload);
            return {
                kind: 'failed',
                error: failure.errorCode,
                ...(failure.viewer ? { viewer: failure.viewer } : {}),
            };
        }
        // The shared Protocol executor is the sole Action response interpreter.
        // Keep this host adapter transport-only so route and Action projections
        // cannot drift or be applied twice.
        return { kind: 'ok', value: payload };
    } catch {
        return UNAVAILABLE;
    } finally {
        retirement.dispose();
        unsubscribeCredentials();
        signal?.removeEventListener('abort', abort);
        if (context?.scope === 'scoped') await context.release?.();
    }
}

export const sessionReadStateAction: NonNullable<ActionExecutorDeps['sessionReadStateAction']> = async (args) => {
    const result = await executeSessionReadStateAction(args.actionId, args.input, args.serverId ?? '', args.signal);
    return result.kind === 'ok' ? result.value : {
        ok: false,
        errorCode: result.error,
        error: result.error,
        ...(result.viewer ? { details: { viewer: result.viewer } } : {}),
    };
};
