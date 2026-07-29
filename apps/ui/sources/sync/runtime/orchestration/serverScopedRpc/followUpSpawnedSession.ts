import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { createNotAuthenticatedError, isAuthenticationResponseStatus } from '@/sync/runtime/connectivity/authErrors';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';

import { fetchSessionByIdWithServerScope } from './fetchSessionByIdWithServerScope';
import {
    requireLocalSessionVisibleForRoute,
    type EnsureSessionVisibleForMessageRoute,
} from './localSessionRouteReadiness';
import { resolveServerScopedSessionContext } from './resolveServerScopedSessionContext';
import {
    createServerScopedSessionSendMessage,
    sendSessionMessageWithServerScope,
} from './serverScopedSessionSendMessage';

type AppliedSession = Omit<Session, 'presence'> & { presence?: 'online' | number };

export type RecoverableFollowUpPayload = Readonly<{
    draftText: string;
    displayText?: string | null;
    metaOverrides?: Record<string, unknown> | null;
    profileId?: string | null;
}>;

type RecoverableFollowUpError = Error & {
    recoverableFollowUpPayload?: RecoverableFollowUpPayload;
};

function buildRecoverableFollowUpPayload(params: Readonly<{
    initialMessageText?: string | null;
    displayText?: string | null;
    metaOverrides?: Record<string, unknown> | null;
    profileId?: string | null;
}>): RecoverableFollowUpPayload | null {
    const draftText = String(params.initialMessageText ?? '').trim();
    if (!draftText) {
        return null;
    }

    return {
        draftText,
        displayText: typeof params.displayText === 'string' ? params.displayText : undefined,
        metaOverrides: params.metaOverrides ?? undefined,
        profileId: params.profileId ?? undefined,
    };
}

function attachRecoverableFollowUpPayload(error: unknown, payload: RecoverableFollowUpPayload | null): unknown {
    if (!payload || !(error instanceof Error)) {
        return error;
    }

    const decoratedError = error as RecoverableFollowUpError;
    if (!decoratedError.recoverableFollowUpPayload) {
        decoratedError.recoverableFollowUpPayload = payload;
    }
    return decoratedError;
}

function throwForFailedScopedHydration(result: Awaited<ReturnType<typeof fetchSessionByIdWithServerScope>>): void {
    if (result.ok) {
        return;
    }

    const errorCode = typeof result.errorCode === 'string' ? result.errorCode : '';
    if (
        isAuthenticationResponseStatus(result.httpStatus)
        || errorCode === 'unauthorized'
        || errorCode === 'forbidden'
        || errorCode === 'not_authenticated'
    ) {
        const status = isAuthenticationResponseStatus(result.httpStatus) ? result.httpStatus : undefined;
        throw createNotAuthenticatedError(status);
    }

    throw new Error(errorCode || 'Failed to hydrate created session');
}

export function readRecoverableFollowUpPayload(error: unknown): RecoverableFollowUpPayload | null {
    if (!(error instanceof Error)) {
        return null;
    }

    const payload = (error as RecoverableFollowUpError).recoverableFollowUpPayload;
    return payload?.draftText ? payload : null;
}

function getDefaultActiveSync() {
    return {
        ensureSessionVisibleForMessageRoute: async (sessionId: string, options?: Readonly<{ forceRefresh?: boolean; serverId?: string }>) => {
            const activeSync = getSyncSingleton();
            if (typeof activeSync.ensureSessionVisibleForMessageRoute === 'function') {
                return await activeSync.ensureSessionVisibleForMessageRoute(sessionId, options);
            }
            return undefined;
        },
        refreshSessions: async () => {
            const activeSync = getSyncSingleton();
            if (typeof activeSync.refreshSessions === 'function') {
                await activeSync.refreshSessions();
            }
        },
        enqueuePendingMessage: async (
            sessionId: string,
            text: string,
            displayText?: string,
            metaOverrides?: Record<string, unknown>,
            options?: Readonly<{ localId?: string | null; requestedAction?: import('@happier-dev/protocol').PendingRequestedActionV1 }>,
        ) => await getSyncSingleton().enqueuePendingMessage(sessionId, text, displayText, metaOverrides, {
            ...options,
            requestedAction: options?.requestedAction ?? { v: 1, kind: 'enqueue' },
        }),
    };
}

type ActiveSyncLike = Readonly<ReturnType<typeof getDefaultActiveSync>>;

function getDefaultApplySessions(): (sessions: AppliedSession[]) => void {
    return (sessions: AppliedSession[]) => {
        const syncWithSessionApply = getSyncSingleton() as unknown as {
            applySessions?: (sessions: AppliedSession[]) => void;
        };

        if (typeof syncWithSessionApply.applySessions === 'function') {
            syncWithSessionApply.applySessions(sessions);
            return;
        }

        const applySessions = storage.getState().applySessions;
        if (typeof applySessions === 'function') {
            applySessions(sessions);
        }
    };
}

export function createFollowUpSpawnedSessionWithServerScope(deps?: Readonly<{
    resolveContext?: typeof resolveServerScopedSessionContext;
    fetchSessionById?: typeof fetchSessionByIdWithServerScope;
    sendSessionMessageWithServerScope?: typeof sendSessionMessageWithServerScope;
    activeSync?: Partial<ActiveSyncLike> & Pick<ActiveSyncLike, 'refreshSessions'>;
    ensureSessionVisibleForMessageRoute?: EnsureSessionVisibleForMessageRoute;
    getStoredSession?: (sessionId: string) => Session | null;
    applySessions?: (sessions: AppliedSession[]) => void;
}>): Readonly<{
    followUpSpawnedSessionWithServerScope: (params: Readonly<{
        sessionId: string;
        targetServerId?: string | null;
        initialMessageText?: string | null;
        displayText?: string | null;
        metaOverrides?: Record<string, unknown> | null;
        profileId?: string | null;
        messageLocalId?: string | null;
    }>) => Promise<void>;
}> {
    const resolveContext = deps?.resolveContext ?? resolveServerScopedSessionContext;
    const fetchSessionById = deps?.fetchSessionById ?? fetchSessionByIdWithServerScope;
    const activeSync = { ...getDefaultActiveSync(), ...(deps?.activeSync ?? {}) };
    const ensureSessionVisibleForMessageRoute = deps?.ensureSessionVisibleForMessageRoute
        ?? activeSync.ensureSessionVisibleForMessageRoute;
    const getStoredSession = deps?.getStoredSession ?? ((sessionId: string) => storage.getState().sessions[sessionId] ?? null);
    const applySessions = deps?.applySessions ?? getDefaultApplySessions();

    const followUpSpawnedSessionWithServerScope = async (params: Readonly<{
        sessionId: string;
        targetServerId?: string | null;
        initialMessageText?: string | null;
        displayText?: string | null;
        metaOverrides?: Record<string, unknown> | null;
        profileId?: string | null;
        messageLocalId?: string | null;
    }>): Promise<void> => {
        const sessionId = String(params.sessionId ?? '').trim();
        if (!sessionId) {
            throw new Error('Session ID is required');
        }

        const recoverablePayload = buildRecoverableFollowUpPayload(params);

        try {
            const context = await resolveContext({ serverId: params.targetServerId ?? null });
            const sendScopedMessage = deps?.sendSessionMessageWithServerScope
                ?? createServerScopedSessionSendMessage({
                    resolveContext: async () => context,
                    enqueuePendingMessageActive: activeSync.enqueuePendingMessage,
                    getSession: getStoredSession,
                }).sendSessionMessageWithServerScope;
            const trimmedInitialMessage = String(params.initialMessageText ?? '').trim();

            if (context.scope === 'active') {
                if (trimmedInitialMessage.length > 0) {
                    await requireLocalSessionVisibleForRoute({
                        sessionId,
                        serverId: params.targetServerId ?? null,
                        getStoredSession,
                        ensureSessionVisibleForMessageRoute,
                    });
                    const result = await sendScopedMessage({
                        sessionId,
                        message: trimmedInitialMessage,
                        serverId: params.targetServerId ?? null,
                        displayText: typeof params.displayText === 'string' ? params.displayText : undefined,
                        metaOverrides: params.metaOverrides ?? undefined,
                        profileId: params.profileId,
                        messageLocalId: params.messageLocalId,
                        providerDeliveryIntent: 'first_turn',
                    });
                    if (!result.ok) {
                        throw new Error(result.error || 'Failed to send message');
                    }
                    return;
                }

                await activeSync.refreshSessions();
                await requireLocalSessionVisibleForRoute({
                    sessionId,
                    serverId: params.targetServerId ?? null,
                    getStoredSession,
                    ensureSessionVisibleForMessageRoute,
                });
                return;
            }

            const hydrationResult = await fetchSessionById({
                sessionId,
                serverId: context.targetServerId,
                activeCredentials: { token: context.token, secret: '' } satisfies AuthCredentials,
                activeEncryption: null,
                sessionDataKeys: new Map<string, Uint8Array>(),
                activeRequest: async (path: string, init: RequestInit) => {
                    throw new Error(`Unexpected active scoped request for ${path}`);
                },
                applySessions,
                getExistingSession: (targetSessionId) => getStoredSession(targetSessionId),
                log: { log: () => {} },
            });
            throwForFailedScopedHydration(hydrationResult);

            if (trimmedInitialMessage.length > 0) {
                const result = await sendScopedMessage({
                    sessionId,
                    message: trimmedInitialMessage,
                    serverId: context.targetServerId,
                    displayText: typeof params.displayText === 'string' ? params.displayText : undefined,
                    metaOverrides: params.metaOverrides ?? undefined,
                    profileId: params.profileId,
                    messageLocalId: params.messageLocalId,
                    providerDeliveryIntent: 'first_turn',
                });
                if (!result.ok) {
                    throw new Error(result.error || 'Failed to send message');
                }
            }
        } catch (error) {
            throw attachRecoverableFollowUpPayload(error, recoverablePayload);
        }
    };

    return { followUpSpawnedSessionWithServerScope };
}

export const { followUpSpawnedSessionWithServerScope } = createFollowUpSpawnedSessionWithServerScope();
