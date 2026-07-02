import { describe, expect, it, vi } from 'vitest';

import { fetchAndApplySessionById } from '@/sync/engine/sessions/sessionById';
import type { Session } from '@/sync/domains/state/storageTypes';
import { createNotAuthenticatedError } from '@/sync/runtime/connectivity/authErrors';

const syncMock = vi.hoisted(() => ({
    applySessions: vi.fn(),
    refreshSessions: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => {}),
}));

vi.mock('@/sync/sync', () => ({
    sync: syncMock,
}));

vi.mock('@/agents/catalog/catalog', () => ({
    getAgentCore: () => ({ model: { defaultMode: 'default', supportsSelection: false } }),
    resolveAgentIdFromFlavor: () => 'codex',
}));

describe('followUpSpawnedSessionWithServerScope', () => {
    it('attaches a recoverable follow-up payload when active-scope sendMessage fails before the first message send', async () => {
        const ensureSessionVisibleForMessageRoute = vi.fn(async () => {});

        const { createFollowUpSpawnedSessionWithServerScope, readRecoverableFollowUpPayload } = await import('./followUpSpawnedSession');
        const { followUpSpawnedSessionWithServerScope } = createFollowUpSpawnedSessionWithServerScope({
            resolveContext: async () => ({
                scope: 'active',
                timeoutMs: 5_000,
            }),
            activeSync: {
                refreshSessions: async () => {},
                sendMessage: async () => {
                    throw new Error('active send failed');
                },
            },
            ensureSessionVisibleForMessageRoute,
            getStoredSession: () => null,
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
        expect(ensureSessionVisibleForMessageRoute).not.toHaveBeenCalled();
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
        const sendMessage = vi.fn(async () => {});

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
                sendMessage,
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
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it('does not send the scoped follow-up when session-by-id hydration returns terminal auth', async () => {
        const sendSessionMessageWithServerScope = vi.fn(async () => ({ ok: true as const }));

        const { createFollowUpSpawnedSessionWithServerScope } = await import('./followUpSpawnedSession');
        const { followUpSpawnedSessionWithServerScope } = createFollowUpSpawnedSessionWithServerScope({
            resolveContext: async () => ({
                scope: 'scoped',
                timeoutMs: 5_000,
                targetServerId: 'server-b',
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

    it('hydrates the active-scope session after sending the initial message so navigation can resolve it locally', async () => {
        const refreshSessions = vi.fn(async () => {});
        const sendMessage = vi.fn(async () => {});
        let storedSession: Session | null = null;
        const ensureSessionVisibleForMessageRoute = vi.fn(async () => {
            storedSession = {
                id: 'sess_target',
                createdAt: 1,
                updatedAt: 2,
                seq: 1,
                active: true,
                activeAt: 2,
                encryptionMode: 'plain',
                metadataVersion: 1,
                metadata: { path: '/tmp/repo' },
                agentStateVersion: 1,
                agentState: null,
            } as Session;
        });

        const { createFollowUpSpawnedSessionWithServerScope } = await import('./followUpSpawnedSession');
        const { followUpSpawnedSessionWithServerScope } = createFollowUpSpawnedSessionWithServerScope({
            resolveContext: async () => ({
                scope: 'active',
                timeoutMs: 5_000,
            }),
            activeSync: {
                refreshSessions,
                sendMessage,
            },
            ensureSessionVisibleForMessageRoute,
            getStoredSession: () => storedSession,
        });

        await expect(followUpSpawnedSessionWithServerScope({
            sessionId: 'sess_target',
            targetServerId: 'server-b',
            initialMessageText: 'hello from active server',
        })).resolves.toBeUndefined();

        expect(refreshSessions).not.toHaveBeenCalled();
        expect(sendMessage).toHaveBeenCalledWith(
            'sess_target',
            'hello from active server',
            undefined,
            undefined,
            {
                profileId: undefined,
                localId: undefined,
                bypassPendingQueueReason: 'server_scoped_rpc',
            },
        );
        expect(ensureSessionVisibleForMessageRoute).toHaveBeenCalledWith(
            'sess_target',
            { forceRefresh: true, serverId: 'server-b' },
        );
    });

    it('does not fail active-scope follow-up after the first message is sent when local hydration still lags behind', async () => {
        const refreshSessions = vi.fn(async () => {});
        const sendMessage = vi.fn(async () => {});
        const ensureSessionVisibleForMessageRoute = vi.fn(async (_sessionId: string, _options?: Readonly<{ forceRefresh?: boolean; serverId?: string }>) => {});

        const { createFollowUpSpawnedSessionWithServerScope } = await import('./followUpSpawnedSession');
        const { followUpSpawnedSessionWithServerScope } = createFollowUpSpawnedSessionWithServerScope({
            resolveContext: async () => ({
                scope: 'active',
                timeoutMs: 5_000,
            }),
            activeSync: {
                refreshSessions,
                sendMessage,
            },
            ensureSessionVisibleForMessageRoute,
            getStoredSession: () => null,
        });

        await expect(followUpSpawnedSessionWithServerScope({
            sessionId: 'sess_target',
            initialMessageText: 'hello from active server',
        })).resolves.toBeUndefined();

        expect(refreshSessions).not.toHaveBeenCalled();
        expect(sendMessage).toHaveBeenCalledWith(
            'sess_target',
            'hello from active server',
            undefined,
            undefined,
            {
                profileId: undefined,
                localId: undefined,
                bypassPendingQueueReason: 'server_scoped_rpc',
            },
        );
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
                sendMessage: async () => {},
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

    it('passes displayText, metadata overrides, and profileId through the default active-scope sendMessage wrapper', async () => {
        let storedSession: Session | null = null;
        const { sync } = await import('@/sync/sync');
        const refreshSessions = vi.spyOn(sync, 'refreshSessions').mockImplementation(async () => {});
        const sendMessage = vi.spyOn(sync, 'sendMessage').mockImplementation(async () => {});
        const ensureSessionVisibleForMessageRoute = vi.fn(async (_sessionId: string, _options?: Readonly<{ forceRefresh?: boolean; serverId?: string }>) => {});

        const { createFollowUpSpawnedSessionWithServerScope } = await import('./followUpSpawnedSession');
        const { followUpSpawnedSessionWithServerScope } = createFollowUpSpawnedSessionWithServerScope({
            resolveContext: async () => ({
                scope: 'active',
                timeoutMs: 5_000,
            }),
            ensureSessionVisibleForMessageRoute: async (sessionId: string, options?: Readonly<{ forceRefresh?: boolean; serverId?: string }>) => {
                await ensureSessionVisibleForMessageRoute(sessionId, options);
                storedSession = {
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
            },
            getStoredSession: () => storedSession,
        });

        await followUpSpawnedSessionWithServerScope({
            sessionId: 'sess_target',
            initialMessageText: 'hello from active server',
            displayText: 'hello display',
            metaOverrides: {
                happier: {
                    kind: 'attachments.v1',
                },
            },
            profileId: 'profile-work',
        });

        expect(refreshSessions).not.toHaveBeenCalled();
        expect(ensureSessionVisibleForMessageRoute).toHaveBeenCalledWith('sess_target', { forceRefresh: true });
        expect(sendMessage).toHaveBeenCalledWith(
            'sess_target',
            'hello from active server',
            'hello display',
            {
                happier: {
                    kind: 'attachments.v1',
                },
            },
            {
                profileId: 'profile-work',
                localId: undefined,
                bypassPendingQueueReason: 'server_scoped_rpc',
            },
        );
    });
});
