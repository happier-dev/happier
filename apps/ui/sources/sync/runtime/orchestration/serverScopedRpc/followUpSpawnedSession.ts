import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';

import { fetchSessionByIdWithServerScope } from './fetchSessionByIdWithServerScope';
import { resolveServerScopedSessionContext } from './resolveServerScopedSessionContext';
import { sendSessionMessageWithServerScope } from './serverScopedSessionSendMessage';

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

export function readRecoverableFollowUpPayload(error: unknown): RecoverableFollowUpPayload | null {
    if (!(error instanceof Error)) {
        return null;
    }

    const payload = (error as RecoverableFollowUpError).recoverableFollowUpPayload;
    return payload?.draftText ? payload : null;
}

async function ensureSessionHydratedForNavigation(params: Readonly<{
    sessionId: string;
    getStoredSession: (sessionId: string) => Session | null;
    ensureSessionVisibleForMessageRoute?: (sessionId: string, options?: Readonly<{ forceRefresh?: boolean }>) => Promise<unknown>;
}>): Promise<void> {
    if (typeof params.ensureSessionVisibleForMessageRoute === 'function') {
        await params.ensureSessionVisibleForMessageRoute(params.sessionId, { forceRefresh: true });
    }

    if (!params.getStoredSession(params.sessionId)) {
        throw new Error('Created session is not available locally yet');
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
        sendMessage: async (
            sessionId: string,
            text: string,
            displayText?: string,
            metaOverrides?: Record<string, unknown>,
            options?: Readonly<{ profileId?: string | null }>,
        ) => {
            if (typeof sync.sendMessage === 'function') {
                await sync.sendMessage(sessionId, text, displayText, metaOverrides, options);
            }
        },
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
    activeSync?: Readonly<Omit<ActiveSyncLike, 'ensureSessionVisibleForMessageRoute'>> & {
        ensureSessionVisibleForMessageRoute?: ActiveSyncLike['ensureSessionVisibleForMessageRoute'];
    };
    ensureSessionVisibleForMessageRoute?: (sessionId: string, options?: Readonly<{ forceRefresh?: boolean }>) => Promise<unknown>;
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
    }>) => Promise<void>;
}> {
    const resolveContext = deps?.resolveContext ?? resolveServerScopedSessionContext;
    const fetchSessionById = deps?.fetchSessionById ?? fetchSessionByIdWithServerScope;
    const sendScopedMessage = deps?.sendSessionMessageWithServerScope ?? sendSessionMessageWithServerScope;
    const activeSync = deps?.activeSync ?? getDefaultActiveSync();
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
    }>): Promise<void> => {
        const sessionId = String(params.sessionId ?? '').trim();
        if (!sessionId) {
            throw new Error('Session ID is required');
        }

        const recoverablePayload = buildRecoverableFollowUpPayload(params);

        try {
            const context = await resolveContext({ serverId: params.targetServerId ?? null });
            const trimmedInitialMessage = String(params.initialMessageText ?? '').trim();

            if (context.scope === 'active') {
                if (trimmedInitialMessage.length > 0) {
                    await activeSync.sendMessage(
                        sessionId,
                        trimmedInitialMessage,
                        typeof params.displayText === 'string' ? params.displayText : undefined,
                        params.metaOverrides ?? undefined,
                        params.profileId ? { profileId: params.profileId } : undefined,
                    );
                    return;
                }

                await activeSync.refreshSessions();
                await ensureSessionHydratedForNavigation({
                    sessionId,
                    getStoredSession,
                    ensureSessionVisibleForMessageRoute,
                });
                return;
            }

            await fetchSessionById({
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

            if (trimmedInitialMessage.length > 0) {
                const result = await sendScopedMessage({
                    sessionId,
                    message: trimmedInitialMessage,
                    serverId: context.targetServerId,
                    displayText: typeof params.displayText === 'string' ? params.displayText : undefined,
                    metaOverrides: params.metaOverrides ?? undefined,
                    profileId: params.profileId,
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
