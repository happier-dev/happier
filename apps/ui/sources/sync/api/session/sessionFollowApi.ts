import { parseSessionFollowActionResponse, resolveSessionFollowActionRequest } from '@happier-dev/protocol/sessions/follow/actionTransport';
import { SessionFollowErrorCodeV1Schema, type SetSessionFollowRequest, ReplaceSessionVoiceInclusionsResponseSchema, SESSION_FOLLOW_HTTP_PATHS_V1 } from '@happier-dev/protocol/sessions/follow/api';
import { SessionFollowSourcesErrorCodeV1Schema, type SessionFollowSourcesErrorCodeV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { SessionAutoFollowPreferencesV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import type { SessionFollowActionIdV1, SessionFollowActionOutputV1 } from '@happier-dev/protocol/sessions/follow/actions';

import { subscribeHomeCredentialMutations } from '@/auth/storage/tokenStorage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { createServerRequestForResolvedServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { resolveServerAccountRequestContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerAccountRequestContext';

export type SessionFollowApiResult<T> =
    | Readonly<{ kind: 'ok'; value: T }>
    | Readonly<{ kind: 'failed'; error: SessionFollowSourcesErrorCodeV1 | 'unavailable' }>;

const UNAVAILABLE = Object.freeze({ kind: 'failed', error: 'unavailable' } as const);

type ResolvedFollowRequestContext = Awaited<ReturnType<typeof resolveServerAccountRequestContext>>;
type ScopedFollowRequestContext = Extract<ResolvedFollowRequestContext, { scope: 'scoped' }>;

/**
 * One currentness/credential guard for every exact-Home Follow request. Human
 * controls, Actions, and the Voice inclusion replacement all use this seam so
 * a credential rotation cannot be handled by one path and missed by another.
 */
async function withCurrentFollowRequest<T>(params: Readonly<{
    serverId: string;
    signal?: AbortSignal;
    operation: (request: Readonly<{
        context: ScopedFollowRequestContext;
        signal: AbortSignal;
        isCurrent: () => boolean;
    }>) => Promise<T>;
}>): Promise<T | typeof UNAVAILABLE> {
    if (!params.serverId.trim() || params.signal?.aborted) return UNAVAILABLE;
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime?.isCurrent()) return UNAVAILABLE;

    const controller = new AbortController();
    const abort = () => controller.abort();
    const retirement = lifetime.onRetire(abort);
    // An inactive Home can change credentials without retiring the focused Home.
    const unsubscribeCredentials = subscribeHomeCredentialMutations((event) => {
        if (areServerProfileIdentifiersEquivalent(event.serverId, params.serverId)) abort();
    });
    params.signal?.addEventListener('abort', abort, { once: true });
    if (params.signal?.aborted) abort();
    const isCurrent = () => lifetime.isCurrent() && !controller.signal.aborted;
    let context: ResolvedFollowRequestContext | undefined;

    try {
        context = await resolveServerAccountRequestContext({ serverId: params.serverId, preferScoped: true });
        if (!isCurrent() || context.scope !== 'scoped') return UNAVAILABLE;
        if (areServerProfileIdentifiersEquivalent(context.targetServerId, lifetime.scope.serverId)
            && context.targetAccountId !== lifetime.scope.accountId) return UNAVAILABLE;
        return await params.operation({ context, signal: controller.signal, isCurrent });
    } catch {
        return UNAVAILABLE;
    } finally {
        retirement.dispose();
        unsubscribeCredentials();
        params.signal?.removeEventListener('abort', abort);
        if (context?.scope === 'scoped') await context.release?.();
    }
}

/** One family adapter for human controls and the shared Action executor. */
export async function executeSessionFollowAction<TActionId extends SessionFollowActionIdV1>(
    actionId: TActionId,
    input: unknown,
    serverId: string,
    signal?: AbortSignal,
): Promise<SessionFollowApiResult<SessionFollowActionOutputV1[TActionId]>> {
    return await withCurrentFollowRequest({
        serverId,
        signal,
        operation: async ({ context, signal: requestSignal, isCurrent }) => {
            const request = resolveSessionFollowActionRequest(actionId, input);
            const send = createServerRequestForResolvedServerScope({
                context,
                // preferScoped must never fall back to the focused Home transport.
                activeRequest: async () => { throw new Error('Follow requires an explicit Home'); },
            });
            const response = await send(request.path, {
                method: request.method,
                ...(request.body === undefined ? {} : {
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(request.body),
                }),
                signal: requestSignal,
            });
            if (!isCurrent()) return UNAVAILABLE;
            const payload: unknown = await response.json();
            if (!isCurrent()) return UNAVAILABLE;
            if (!response.ok) {
                const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {};
                const error = SessionFollowSourcesErrorCodeV1Schema.safeParse(record.error);
                return error.success ? { kind: 'failed', error: error.data } : UNAVAILABLE;
            }
            return { kind: 'ok', value: parseSessionFollowActionResponse(actionId, input, payload) };
        },
    });
}

export const sessionFollowAction: NonNullable<ActionExecutorDeps['sessionFollowAction']> = async (args) => {
    const result = await executeSessionFollowAction(args.actionId, args.input, args.serverId ?? '', args.signal);
    return result.kind === 'ok' ? result.value : {
        ok: false,
        errorCode: result.error === 'unavailable' ? 'network_error' : result.error,
        error: result.error,
    };
};

async function executeAccountFollowAction<TActionId extends Exclude<SessionFollowActionIdV1, `session.follow.sources.${string}`>>(
    actionId: TActionId,
    input: unknown,
    serverId: string,
) {
    const result = await executeSessionFollowAction(actionId, input, serverId);
    if (result.kind === 'ok') return result;
    const error = SessionFollowErrorCodeV1Schema.safeParse(result.error);
    return { kind: 'failed' as const, error: error.success ? error.data : 'unavailable' as const };
}

export function sessionFollowGet(address: SessionAddress) {
    return executeAccountFollowAction('session.follow.get', { sessionId: address.sessionId }, address.serverId);
}

export function sessionFollowSet(address: SessionAddress, preferences: SetSessionFollowRequest) {
    return executeAccountFollowAction('session.follow.set', { sessionId: address.sessionId, ...preferences }, address.serverId);
}

export function sessionFollowRemove(address: SessionAddress) {
    return executeAccountFollowAction('session.follow.remove', { sessionId: address.sessionId }, address.serverId);
}

export async function replaceSessionVoiceInclusions(
    serverId: string,
    sessionIds: readonly string[],
): Promise<SessionFollowApiResult<Readonly<{ changed: boolean; sessionIds: string[] }>>> {
    return await withCurrentFollowRequest({
        serverId,
        operation: async ({ context, signal, isCurrent }) => {
            const send = createServerRequestForResolvedServerScope({
                context,
                activeRequest: async () => { throw new Error('Follow requires an explicit Home'); },
            });
            const response = await send(SESSION_FOLLOW_HTTP_PATHS_V1.voiceInclusions, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionIds: [...sessionIds] }),
                signal,
            });
            if (!isCurrent()) return UNAVAILABLE;
            const payload: unknown = await response.json();
            if (!isCurrent()) return UNAVAILABLE;
            if (!response.ok) {
                const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {};
                const error = SessionFollowErrorCodeV1Schema.safeParse(record.error);
                return error.success ? { kind: 'failed', error: error.data } : UNAVAILABLE;
            }
            return { kind: 'ok', value: ReplaceSessionVoiceInclusionsResponseSchema.parse(payload) };
        },
    });
}

export function sessionAutoFollowPreferencesGet(serverId: string) {
    return executeAccountFollowAction('session.follow.preferences.get', {}, serverId);
}

export function sessionAutoFollowPreferencesSet(serverId: string, preferences: SessionAutoFollowPreferencesV1) {
    return executeAccountFollowAction('session.follow.preferences.set', preferences, serverId);
}
