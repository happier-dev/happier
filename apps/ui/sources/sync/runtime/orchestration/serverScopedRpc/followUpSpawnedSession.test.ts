import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchAndApplySessionById } from '@/sync/engine/sessions/sessionById';
import type { Session } from '@/sync/domains/state/storageTypes';
import { createNotAuthenticatedError } from '@/sync/runtime/connectivity/authErrors';

const syncMock = vi.hoisted(() => ({
    applySessions: vi.fn(),
    refreshSessions: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => {}),
    enqueuePendingMessage: vi.fn(async (_sessionId: string, _text: string, _displayText?: string, _meta?: Record<string, unknown>, options?: Readonly<{ localId?: string | null }>) => ({
        localId: options?.localId ?? 'pending-local-id',
        accepted: true,
    })),
}));
const getSyncSingletonMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/sync', () => ({
    sync: syncMock,
}));

vi.mock('@/sync/runtime/getSyncSingleton', () => ({
    getSyncSingleton: getSyncSingletonMock,
}));

vi.mock('@/agents/catalog/catalog', () => ({
    getAgentCore: () => ({ model: { defaultMode: 'default', supportsSelection: false } }),
    resolveAgentIdFromFlavor: () => 'codex',
}));

describe('followUpSpawnedSessionWithServerScope', () => {
    beforeEach(() => {
        syncMock.applySessions.mockClear();
        syncMock.refreshSessions.mockClear();
        syncMock.sendMessage.mockClear();
        syncMock.enqueuePendingMessage.mockClear();
        getSyncSingletonMock.mockReset();
        getSyncSingletonMock.mockReturnValue(syncMock);
    });

    it('attaches a recoverable follow-up payload when active-scope sendMessage fails before the first message send', async () => {
        const ensureSessionVisibleForMessageRoute = vi.fn(async () => {});
        const storedSession = {
            id: 'sess_target',
            createdAt: 1,
            updatedAt: 2,
            seq: 0,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadataVersion: 1,
            metadata: null,
            agentStateVersion: 1,
            agentState: null,
        } as Session;

        const { createFollowUpSpawnedSessionWithServerScope, readRecoverableFollowUpPayload } = await import('./followUpSpawnedSession');
        const { followUpSpawnedSessionWithServerScope } = createFollowUpSpawnedSessionWithServerScope({
            resolveContext: async () => ({
                scope: 'active',
                timeoutMs: 5_000,
            }),
            activeSync: {
                refreshSessions: async () => {},
                enqueuePendingMessage: async () => {
                    throw new Error('active send failed');
                },
            },
            ensureSessionVisibleForMessageRoute,
            getStoredSession: () => storedSession,
        });

        let thrown: unknown = null;
        try {
            await followUpSpawnedSessionWithServerScope({
                sessionId: 'sess_target',
                initialMessageText: 'Investigate this bug\n\n[attachments block]',
                displayText: 'Investigate this bug',
                metaOverrides: {
                    happier: {
                        kind: 'attachments.v1',
                    },
                },
                profileId: 'profile-work',
            });
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toBe('active send failed');
        expect(readRecoverableFollowUpPayload(thrown)).toEqual({
            draftText: 'Investigate this bug\n\n[attachments block]',
            displayText: 'Investigate this bug',
            metaOverrides: {
                happier: {
                    kind: 'attachments.v1',
                },
            },
            profileId: 'profile-work',
        });
        expect(ensureSessionVisibleForMessageRoute).toHaveBeenCalledWith('sess_target', { forceRefresh: true });
    }, 120_000);

    it('enqueues post-spawn first text and attachment metadata exactly once with the stable local id', async () => {
        const enqueuePendingMessage = vi.fn(async () => ({
            localId: 'spawn-first-turn:nonce-1',
            accepted: true,
        }));
        const storedSession = {
            id: 'sess_target',
            createdAt: 1,
            updatedAt: 2,
            seq: 0,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadataVersion: 1,
            metadata: null,
            agentStateVersion: 1,
            agentState: null,
        } as Session;
        const { createFollowUpSpawnedSessionWithServerScope } = await import('./followUpSpawnedSession');
        const { followUpSpawnedSessionWithServerScope } = createFollowUpSpawnedSessionWithServerScope({
            resolveContext: async () => ({ scope: 'active', timeoutMs: 5_000 }),
            activeSync: {
                refreshSessions: async () => {},
                enqueuePendingMessage,
            },
            ensureSessionVisibleForMessageRoute: async () => {},
            getStoredSession: () => storedSession,
        });
        const attachmentMeta = {
            happier: {
                kind: 'attachments.v1',
                attachments: [{ name: 'evidence.txt', uploadedPath: 'uploads/evidence.txt' }],
            },
        };

        await followUpSpawnedSessionWithServerScope({
            sessionId: 'sess_target',
            initialMessageText: 'Investigate this bug\n\n[attachments block]',
            displayText: 'Investigate this bug',
            metaOverrides: attachmentMeta,
            messageLocalId: 'spawn-first-turn:nonce-1',
        });

        expect(enqueuePendingMessage).toHaveBeenCalledExactlyOnceWith(
            'sess_target',
            'Investigate this bug\n\n[attachments block]',
            'Investigate this bug',
            attachmentMeta,
            {
                localId: 'spawn-first-turn:nonce-1',
                requestedAction: { v: 1, kind: 'enqueue' },
            },
        );
    });

    it('hydrates scoped sessions through sync bookkeeping instead of writing directly to storage state', async () => {
        const { createFollowUpSpawnedSessionWithServerScope } = await import('./followUpSpawnedSession');
        const { sync } = await import('@/sync/sync');
        const syncApplySessions = vi
            .spyOn(sync as unknown as { applySessions: (sessions: Session[]) => void }, 'applySessions')
            .mockImplementation(() => {});
        const { followUpSpawnedSessionWithServerScope } = createFollowUpSpawnedSessionWithServerScope({
            resolveContext: async () => ({
                scope: 'scoped',
                timeoutMs: 5_000,
                targetServerId: 'server-b',
                targetAccountId: 'account-b',
                targetServerUrl: 'https://server-b.example.test',
                token: 'token-b',
                encryption: {
                    decryptEncryptionKey: async () => null,
                    initializeSessions: async () => {},
                    getSessionEncryption: () => null,
                },
            }),
            fetchSessionById: async ({ applySessions }) => {
                const session = {
                    id: 'sess_target',
                    createdAt: 1,
                    updatedAt: 2,
                    seq: 3,
                    active: true,
                    activeAt: 2,
                    encryptionMode: 'plain',
                    metadataVersion: 1,
                    metadata: null,
                    agentStateVersion: 1,
                    agentState: null,
                    thinking: null,
                    thinkingAt: null,
                    presence: 'online',
                    share: null,
                } as unknown as Session;
                applySessions([session]);
                return { ok: true, session: null };
            },
        });

        await followUpSpawnedSessionWithServerScope({
            sessionId: 'sess_target',
            targetServerId: 'server-b',
        });

        expect(syncApplySessions).toHaveBeenCalledTimes(1);
    });

    it('hydrates and sends the initial message through the selected server scope without writing workspace metadata', async () => {
        const sendSessionMessageWithServerScope = vi.fn(async () => ({ ok: true as const }));
        const refreshSessions = vi.fn(async () => {});

        let storedSession: Session | null = null;
        const fetchedSession = {
            id: 'sess_target',
            createdAt: 1,
            updatedAt: 2,
            seq: 3,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            dataEncryptionKey: null,
            metadataVersion: 1,
            metadata: { path: '/tmp/repo', host: 'host', existing: true },
            agentStateVersion: 1,
            agentState: { controlledByUser: true, requests: {}, completedRequests: {} },
            share: null,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as Session;

        const { createFollowUpSpawnedSessionWithServerScope } = await import('./followUpSpawnedSession');
        const { followUpSpawnedSessionWithServerScope } = createFollowUpSpawnedSessionWithServerScope({
            resolveContext: async () => ({
                scope: 'scoped',
                timeoutMs: 5_000,
                targetServerId: 'server-b',
                targetAccountId: 'account-b',
                targetServerUrl: 'https://server-b.example.test',
                token: 'token-b',
                encryption: {
                    decryptEncryptionKey: async () => null,
                    initializeSessions: async () => {},
                    getSessionEncryption: () => null,
                },
            }),
            fetchSessionById: async ({ applySessions }) => {
                applySessions([fetchedSession]);
                return {
                    ok: true,
                    session: {
                        id: 'sess_target',
                        metadata: { existing: true },
                    } as any,
                };
            },
            sendSessionMessageWithServerScope,
            activeSync: {
                refreshSessions,
            },
            getStoredSession: () => storedSession,
            applySessions: (sessions) => {
                storedSession = sessions[0] as Session;
            },
        });

        await followUpSpawnedSessionWithServerScope({
            sessionId: 'sess_target',
            targetServerId: 'server-b',
            initialMessageText: 'hello from scoped server',
            displayText: 'hello display',
            metaOverrides: {
                happier: {
                    kind: 'attachments.v1',
                },
            },
            profileId: 'profile-work',
        });

        expect(sendSessionMessageWithServerScope).toHaveBeenCalledWith({
            sessionId: 'sess_target',
            message: 'hello from scoped server',
            serverId: 'server-b',
            displayText: 'hello display',
            metaOverrides: {
                happier: {
                    kind: 'attachments.v1',
                },
            },
            profileId: 'profile-work',
            messageLocalId: undefined,
            providerDeliveryIntent: 'first_turn',
        });
        expect(storedSession).not.toBeNull();
        if (!storedSession) {
            throw new Error('Expected hydrated session');
        }
        const hydratedSession: Session = storedSession;
        expect(hydratedSession).toMatchObject({
            metadata: {
                existing: true,
            },
        });
        expect(refreshSessions).not.toHaveBeenCalled();
    });

    it('does not send the scoped follow-up when session-by-id hydration returns terminal auth', async () => {
        const sendSessionMessageWithServerScope = vi.fn(async () => ({ ok: true as const }));

        const { createFollowUpSpawnedSessionWithServerScope } = await import('./followUpSpawnedSession');
        const { followUpSpawnedSessionWithServerScope } = createFollowUpSpawnedSessionWithServerScope({
            resolveContext: async () => ({
                scope: 'scoped',
                timeoutMs: 5_000,
                targetServerId: 'server-b',
                targetAccountId: 'account-b',
                targetServerUrl: 'https://server-b.example.test',
                token: 'token-b',
                encryption: {
                    decryptEncryptionKey: async () => null,
                    initializeSessions: async () => {},
                    getSessionEncryption: () => null,
                },
            }),
            fetchSessionById: async () => ({
                ok: false,
                session: null,
                errorCode: 'unauthorized',
                httpStatus: 401,
            }),
            sendSessionMessageWithServerScope,
            getStoredSession: () => null,
            applySessions: () => {},
        });

        await expect(followUpSpawnedSessionWithServerScope({
            sessionId: 'sess_target',
            targetServerId: 'server-b',
            initialMessageText: 'hello from scoped server',
        })).rejects.toMatchObject({
            name: 'HappyError',
            kind: 'auth',
            code: 'not_authenticated',
        });

        expect(sendSessionMessageWithServerScope).not.toHaveBeenCalled();
    });

    it('does not send the scoped follow-up when session-by-id hydration throws terminal auth', async () => {
        const sendSessionMessageWithServerScope = vi.fn(async () => ({ ok: true as const }));

        const { createFollowUpSpawnedSessionWithServerScope } = await import('./followUpSpawnedSession');
        const { followUpSpawnedSessionWithServerScope } = createFollowUpSpawnedSessionWithServerScope({
            resolveContext: async () => ({
                scope: 'scoped',
                timeoutMs: 5_000,
                targetServerId: 'server-b',
                targetAccountId: 'account-b',
                targetServerUrl: 'https://server-b.example.test',
                token: 'token-b',
                encryption: {
                    decryptEncryptionKey: async () => null,
                    initializeSessions: async () => {},
                    getSessionEncryption: () => null,
                },
            }),
            fetchSessionById: async () => {
                throw createNotAuthenticatedError();
            },
            sendSessionMessageWithServerScope,
            getStoredSession: () => null,
            applySessions: () => {},
        });

        await expect(followUpSpawnedSessionWithServerScope({
            sessionId: 'sess_target',
            targetServerId: 'server-b',
            initialMessageText: 'hello from scoped server',
        })).rejects.toMatchObject({
            name: 'HappyError',
            kind: 'auth',
            code: 'not_authenticated',
        });

        expect(sendSessionMessageWithServerScope).not.toHaveBeenCalled();
    });


    it('fails active-scope first-message follow-up recoverably when local hydration still lags behind', async () => {
        const refreshSessions = vi.fn(async () => {});
        const sendMessage = vi.fn(async () => {});
        const ensureSessionVisibleForMessageRoute = vi.fn(async (_sessionId: string, _options?: Readonly<{ forceRefresh?: boolean; serverId?: string }>) => {});

        const { createFollowUpSpawnedSessionWithServerScope, readRecoverableFollowUpPayload } = await import('./followUpSpawnedSession');
        const { followUpSpawnedSessionWithServerScope } = createFollowUpSpawnedSessionWithServerScope({
            resolveContext: async () => ({
                scope: 'active',
                timeoutMs: 5_000,
            }),
            activeSync: {
                refreshSessions,
            },
            ensureSessionVisibleForMessageRoute,
            getStoredSession: () => null,
        });

        let thrown: unknown = null;
        try {
            await followUpSpawnedSessionWithServerScope({
                sessionId: 'sess_target',
                initialMessageText: 'hello from active server',
            });
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toBe('Created session is not available locally yet');
        expect(readRecoverableFollowUpPayload(thrown)).toEqual({
            draftText: 'hello from active server',
        });
        expect(refreshSessions).not.toHaveBeenCalled();
        expect(sendMessage).not.toHaveBeenCalled();
        expect(ensureSessionVisibleForMessageRoute).toHaveBeenCalledWith('sess_target', { forceRefresh: true });
    });



    it('forces active-scope hydration when the stored session already exists but is only partially hydrated', async () => {
        const refreshSessions = vi.fn(async () => {});
        const ensureSessionVisibleForMessageRoute = vi.fn(async (_sessionId: string, _options?: Readonly<{ forceRefresh?: boolean; serverId?: string }>) => {});
        let storedSession: Session | null = {
            id: 'sess_target',
            createdAt: 1,
            updatedAt: 2,
            seq: 0,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadataVersion: 0,
            metadata: null,
            agentStateVersion: 1,
            agentState: null,
        } as Session;

        const { createFollowUpSpawnedSessionWithServerScope } = await import('./followUpSpawnedSession');
        const { followUpSpawnedSessionWithServerScope } = createFollowUpSpawnedSessionWithServerScope({
            resolveContext: async () => ({
                scope: 'active',
                timeoutMs: 5_000,
            }),
            activeSync: {
                refreshSessions,
            },
            ensureSessionVisibleForMessageRoute: async (sessionId: string, options?: Readonly<{ forceRefresh?: boolean; serverId?: string }>) => {
                await ensureSessionVisibleForMessageRoute(sessionId, options);
                storedSession = {
                    ...storedSession!,
                    updatedAt: 3,
                    metadataVersion: 1,
                    metadata: {
                        path: '/repo',
                        host: 'host',
                        hydrated: true,
                    },
                    agentStateVersion: 2,
                    agentState: {
                        controlledByUser: true,
                        requests: {},
                        completedRequests: {},
                    },
                };
            },
            getStoredSession: () => storedSession,
        });

        await followUpSpawnedSessionWithServerScope({
            sessionId: 'sess_target',
            targetServerId: 'server-b',
        });

        expect(refreshSessions).toHaveBeenCalledTimes(1);
        expect(ensureSessionVisibleForMessageRoute).toHaveBeenCalledWith('sess_target', {
            forceRefresh: true,
            serverId: 'server-b',
        });
        expect(storedSession?.metadata).toMatchObject({
            hydrated: true,
        });
    });


    it('does not default active-send when created-session hydration reports a retryable failure over stale active state', async () => {
        const ensureSessionVisibleForMessageRoute = vi.fn(async () => ({
            kind: 'retryable_failure' as const,
            sessionId: 'sess_target',
            serverId: 'server-b',
            errorCode: 'timeout',
        }));
        const sendMessage = vi.fn(async () => {});
        getSyncSingletonMock.mockReturnValue({
            refreshSessions: vi.fn(async () => {}),
            sendMessage,
            ensureSessionVisibleForMessageRoute,
        });

        const staleStoredSession = {
            id: 'sess_target',
            createdAt: 1,
            updatedAt: 2,
            seq: 0,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadataVersion: 0,
            metadata: null,
            agentStateVersion: 1,
            agentState: null,
        } as Session;

        const { createFollowUpSpawnedSessionWithServerScope, readRecoverableFollowUpPayload } = await import('./followUpSpawnedSession');
        const { followUpSpawnedSessionWithServerScope } = createFollowUpSpawnedSessionWithServerScope({
            resolveContext: async () => ({
                scope: 'active',
                timeoutMs: 5_000,
            }),
            getStoredSession: () => staleStoredSession,
        });

        let thrown: unknown = null;
        try {
            await followUpSpawnedSessionWithServerScope({
                sessionId: 'sess_target',
                targetServerId: 'server-b',
                initialMessageText: 'hello from active server',
            });
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toBe('Created session is not available locally yet');
        expect(readRecoverableFollowUpPayload(thrown)).toEqual({
            draftText: 'hello from active server',
        });
        expect(ensureSessionVisibleForMessageRoute).toHaveBeenCalledWith('sess_target', {
            forceRefresh: true,
            serverId: 'server-b',
        });
        expect(sendMessage).not.toHaveBeenCalled();
    });
});
