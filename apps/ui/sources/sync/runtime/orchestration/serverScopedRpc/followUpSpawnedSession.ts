import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { createNotAuthenticatedError, isAuthenticationResponseStatus } from '@/sync/runtime/connectivity/authErrors';
import { delay } from '@/utils/timing/time';

import { fetchSessionByIdWithServerScope } from './fetchSessionByIdWithServerScope';
import { resolveServerScopedSessionContext } from './resolveServerScopedSessionContext';
import {
    createServerScopedSessionSendMessage,
    sendSessionMessageWithServerScope,
} from './serverScopedSessionSendMessage';

type AppliedSession = Omit<Session, 'presence'> & { presence?: 'online' | number };

// This covers only bounded server-to-client sync propagation after spawn already resolved.
// Provider startup remains owned by the spawn RPC and nonce-settlement budgets.
const POST_SPAWN_SESSION_VISIBILITY_GRACE_MAX_MS = 10_000;
const POST_SPAWN_SESSION_VISIBILITY_POLL_INTERVAL_MS = 250;

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
        throw createNotAuthenticatedError();
    }

    throw new Error(errorCode || 'Failed to hydrate created session');
}

/**
 * @deprecated New-session launch retry state is owned by NewSessionLaunchAttempt.
 * Keep this only for recovery payload readers that still validate scoped follow-up errors.
 */
export function readRecoverableFollowUpPayload(error: unknown): RecoverableFollowUpPayload | null {
    if (!(error instanceof Error)) {
        return null;
    }

    const payload = (error as RecoverableFollowUpError).recoverableFollowUpPayload;
    return payload?.draftText ? payload : null;
}

async function ensureSessionHydratedForNavigation(params: Readonly<{
    sessionId: string;
    serverId?: string | null;
    contextTimeoutMs: number;
    getStoredSession: (sessionId: string) => Session | null;
    ensureSessionVisibleForMessageRoute?: (
        sessionId: string,
        options?: Readonly<{ forceRefresh?: boolean; serverId?: string }>,
    ) => Promise<unknown>;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    visibilityGraceMs: number;
}>): Promise<void> {
    const graceMs = Math.max(0, Math.min(
        params.visibilityGraceMs,
        POST_SPAWN_SESSION_VISIBILITY_GRACE_MAX_MS,
        params.contextTimeoutMs,
    ));
    const deadlineMs = params.now() + graceMs;
    const serverId = String(params.serverId ?? '').trim();

    while (true) {
        if (typeof params.ensureSessionVisibleForMessageRoute === 'function') {
            await params.ensureSessionVisibleForMessageRoute(
                params.sessionId,
                serverId ? { forceRefresh: true, serverId } : { forceRefresh: true },
            );
        }

        if (params.getStoredSession(params.sessionId)) {
            return;
        }

        const remainingMs = deadlineMs - params.now();
        if (remainingMs <= 0) {
            throw new Error('Created session is not available locally yet');
        }
        await params.sleep(Math.min(POST_SPAWN_SESSION_VISIBILITY_POLL_INTERVAL_MS, remainingMs));
    }
}

function getDefaultActiveSync() {
    return {
        ensureSessionVisibleForMessageRoute: async (sessionId: string, options?: Readonly<{ forceRefresh?: boolean }>) => {
            if (typeof sync.ensureSessionVisibleForMessageRoute === 'function') {
                await sync.ensureSessionVisibleForMessageRoute(sessionId, options);
            }
        },
        refreshSessions: async () => {
            if (typeof sync.refreshSessions === 'function') {
                await sync.refreshSessions();
            }
        },
        enqueuePendingMessage: async (
            sessionId: string,
            text: string,
            displayText?: string,
            metaOverrides?: Record<string, unknown>,
            options?: Readonly<{ localId?: string | null; requestedAction: import('@happier-dev/protocol').PendingRequestedActionV1 }>,
        ) => await sync.enqueuePendingMessage(sessionId, text, displayText, metaOverrides, options),
    };
}

type ActiveSyncLike = Readonly<ReturnType<typeof getDefaultActiveSync>>;

function getDefaultApplySessions(): (sessions: AppliedSession[]) => void {
    return (sessions: AppliedSession[]) => {
        const syncWithSessionApply = sync as unknown as {
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
    ensureSessionVisibleForMessageRoute?: (
        sessionId: string,
        options?: Readonly<{ forceRefresh?: boolean; serverId?: string }>,
    ) => Promise<unknown>;
    getStoredSession?: (sessionId: string) => Session | null;
    applySessions?: (sessions: AppliedSession[]) => void;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    visibilityGraceMs?: number;
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
    const sleep = deps?.sleep ?? delay;
    const now = deps?.now ?? Date.now;
    const visibilityGraceMs = deps?.visibilityGraceMs ?? POST_SPAWN_SESSION_VISIBILITY_GRACE_MAX_MS;

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
                const explicitTargetServerId = String(params.targetServerId ?? '').trim();
                if (trimmedInitialMessage.length > 0) {
                    const sessionWasAlreadyStored = Boolean(getStoredSession(sessionId));
                    if (!sessionWasAlreadyStored) {
                        await ensureSessionHydratedForNavigation({
                            sessionId,
                            serverId: explicitTargetServerId,
                            contextTimeoutMs: context.timeoutMs,
                            getStoredSession,
                            ensureSessionVisibleForMessageRoute,
                            sleep,
                            now,
                            visibilityGraceMs,
                        });
                    }

                    const result = await sendScopedMessage({
                        sessionId,
                        message: trimmedInitialMessage,
                        serverId: params.targetServerId ?? null,
                        displayText: typeof params.displayText === 'string' ? params.displayText : undefined,
                        metaOverrides: params.metaOverrides ?? undefined,
                        profileId: params.profileId,
                        localId: params.messageLocalId,
                        providerDeliveryIntent: 'first_turn',
                    });
                    if (!result.ok) {
                        throw new Error(result.error || 'Failed to send message');
                    }

                    return;
                }

                await activeSync.refreshSessions();
                await ensureSessionHydratedForNavigation({
                    sessionId,
                    serverId: explicitTargetServerId,
                    contextTimeoutMs: context.timeoutMs,
                    getStoredSession,
                    ensureSessionVisibleForMessageRoute,
                    sleep,
                    now,
                    visibilityGraceMs,
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
                    localId: params.messageLocalId,
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
