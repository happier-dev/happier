import { beforeEach, describe, expect, it, vi } from 'vitest';

const getServerFeaturesSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getServerFeaturesSnapshot: getServerFeaturesSnapshotMock,
}));

import { fetchAndApplySessionById } from '@/sync/engine/sessions/sessionById';
import type { Session } from '@/sync/domains/state/storageTypes';
import { createNotAuthenticatedError } from '@/sync/runtime/connectivity/authErrors';
import {
    createFollowUpSpawnedSessionWithServerScope,
    requireLocalSessionVisibleForRoute,
    readRecoverableFollowUpPayload,
} from './followUpSpawnedSession';

describe('followUpSpawnedSessionWithServerScope', () => {
    beforeEach(() => {
        getServerFeaturesSnapshotMock.mockReset();
        getServerFeaturesSnapshotMock.mockResolvedValue({
            status: 'ready',
            features: {
                capabilities: {
                    compatibility: {
                        pendingInput: { currentPendingInputProtocolVersion: 1 },
                    },
                },
                features: {
                    sharing: {
                        pendingQueueV2: { enabled: true },
                        pendingDeliveryState: { enabled: true },
                    },
                },
            },
        });
    });

    it('owns one local route-readiness hydration attempt for a fork child', async () => {
        const stored = {} as Session;
        const ensureSessionVisibleForMessageRoute = vi.fn(async () => ({ kind: 'available' }));
        const isLocalSessionReady = vi.fn(() => true);

        await expect(requireLocalSessionVisibleForRoute({
            sessionId: 'child',
            serverId: 'server-a',
            getStoredSession: () => stored,
            ensureSessionVisibleForMessageRoute,
            isLocalSessionReady,
        })).resolves.toBe(stored);

        expect(ensureSessionVisibleForMessageRoute).toHaveBeenCalledOnce();
        expect(isLocalSessionReady).toHaveBeenCalledOnce();
    });

    it('attaches a recoverable follow-up payload when active-scope durable enqueue fails before navigation hydration', async () => {
        const storedSession = {
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
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as Session;
        const ensureSessionVisibleForMessageRoute = vi.fn(async () => {});

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
        expect(ensureSessionVisibleForMessageRoute).not.toHaveBeenCalled();
    });

    it('does not let a redundant post-commit hydration failure strand a stored session on the new-session route', async () => {
        const calls: string[] = [];
        const storedSession = {
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
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as Session;
        const ensureSessionVisibleForMessageRoute = vi.fn(async () => {
            calls.push('hydrate');
            throw new Error('navigation hydration lagged');
        });
        const enqueuePendingMessage = vi.fn(async () => {
            calls.push('enqueue');
            return {
                localId: 'first-turn-local',
                accepted: true,
            };
        });

        const { createFollowUpSpawnedSessionWithServerScope } = await import('./followUpSpawnedSession');
        const { followUpSpawnedSessionWithServerScope } = createFollowUpSpawnedSessionWithServerScope({
            resolveContext: async () => ({
                scope: 'active',
                timeoutMs: 5_000,
            }),
            activeSync: {
                refreshSessions: async () => {},
                enqueuePendingMessage,
            },
            ensureSessionVisibleForMessageRoute,
            getStoredSession: () => storedSession,
        });

        await expect(followUpSpawnedSessionWithServerScope({
            sessionId: 'sess_target',
            initialMessageText: 'hello from new session',
            displayText: 'hello display',
            messageLocalId: 'first-turn-local',
            profileId: 'profile-work',
        })).resolves.toBeUndefined();

        expect(calls).toEqual(['enqueue']);
        expect(ensureSessionVisibleForMessageRoute).not.toHaveBeenCalled();
        expect(enqueuePendingMessage).toHaveBeenCalledWith(
            'sess_target',
            'hello from new session',
            'hello display',
            { profileId: 'profile-work' },
            {
                localId: 'first-turn-local',
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
        const enqueuePendingMessage = vi.fn(async () => ({
            localId: 'first-turn-local',
            accepted: true,
        }));

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
        } as unknown as Session;

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
                enqueuePendingMessage,
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
            messageLocalId: 'first-turn-local',
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
            localId: 'first-turn-local',
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
        expect(enqueuePendingMessage).not.toHaveBeenCalled();
    });

    it('treats scoped ack_unknown as a recoverable follow-up failure', async () => {
        const sendSessionMessageWithServerScope = vi.fn(async () => ({
            ok: false as const,
            errorCode: 'ack_unknown',
            error: 'ack_unknown',
        }));
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
            metadata: { existing: true },
            agentStateVersion: 1,
            agentState: null,
            share: null,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as unknown as Session;

        const { createFollowUpSpawnedSessionWithServerScope, readRecoverableFollowUpPayload } = await import('./followUpSpawnedSession');
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
                return { ok: true, session: { id: 'sess_target' } as any };
            },
            sendSessionMessageWithServerScope,
            getStoredSession: () => fetchedSession,
            applySessions: () => {},
        });

        let thrown: unknown = null;
        try {
            await followUpSpawnedSessionWithServerScope({
                sessionId: 'sess_target',
                targetServerId: 'server-b',
                initialMessageText: 'retry this follow-up',
                displayText: 'retry this',
                profileId: 'profile-work',
                messageLocalId: 'first-turn-local',
            });
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toBe('ack_unknown');
        expect(readRecoverableFollowUpPayload(thrown)).toEqual({
            draftText: 'retry this follow-up',
            displayText: 'retry this',
            profileId: 'profile-work',
        });
        expect(sendSessionMessageWithServerScope).toHaveBeenCalledWith(expect.objectContaining({
            localId: 'first-turn-local',
        }));
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

    it('hydrates the active-scope session after sending the initial message so navigation can resolve it locally', async () => {
        const refreshSessions = vi.fn(async () => {});
        const enqueuePendingMessage = vi.fn(async () => ({
            localId: 'first-turn-local',
            accepted: true,
        }));
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
                presence: 'online',
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
                enqueuePendingMessage,
            },
            ensureSessionVisibleForMessageRoute,
            getStoredSession: () => storedSession,
        });

        await followUpSpawnedSessionWithServerScope({
            sessionId: 'sess_target',
            initialMessageText: 'hello from active server',
            messageLocalId: 'first-turn-local',
        });

        expect(refreshSessions).not.toHaveBeenCalled();
        expect(enqueuePendingMessage).toHaveBeenCalledWith(
            'sess_target',
            'hello from active server',
            undefined,
            undefined,
            {
                localId: 'first-turn-local',
                requestedAction: { v: 1, kind: 'enqueue' },
            },
        );
        expect(ensureSessionVisibleForMessageRoute).toHaveBeenCalledWith(
            'sess_target',
            { forceRefresh: true },
        );
    });

    it('does not send active-scope follow-up when local hydration still lags behind', async () => {
        const refreshSessions = vi.fn(async () => {});
        const ensureSessionVisibleForMessageRoute = vi.fn(async () => {});
        let nowMs = 1_000;
        const sleep = vi.fn(async (ms: number) => {
            nowMs += ms;
        });

        const { createFollowUpSpawnedSessionWithServerScope } = await import('./followUpSpawnedSession');
        const { followUpSpawnedSessionWithServerScope } = createFollowUpSpawnedSessionWithServerScope({
            resolveContext: async () => ({
                scope: 'active',
                timeoutMs: 500,
            }),
            activeSync: {
                refreshSessions,
            },
            ensureSessionVisibleForMessageRoute,
            getStoredSession: () => null,
            sleep,
            now: () => nowMs,
        });

        await expect(followUpSpawnedSessionWithServerScope({
            sessionId: 'sess_target',
            targetServerId: 'server-b',
            initialMessageText: 'hello from active server',
        })).rejects.toMatchObject({
            message: 'Created session is not available locally yet',
            recoverableFollowUpPayload: {
                draftText: 'hello from active server',
            },
        });

        expect(refreshSessions).not.toHaveBeenCalled();
        expect(ensureSessionVisibleForMessageRoute).toHaveBeenCalledTimes(3);
        expect(ensureSessionVisibleForMessageRoute).toHaveBeenLastCalledWith(
            'sess_target',
            { forceRefresh: true, serverId: 'server-b' },
        );
        expect(sleep).toHaveBeenCalledTimes(2);
    });

    it('waits within the bounded post-spawn grace for active-scope session visibility before sending once', async () => {
        const refreshSessions = vi.fn(async () => {});
        const enqueuePendingMessage = vi.fn(async () => ({
            localId: 'first-turn-local',
            accepted: true,
        }));
        let nowMs = 1_000;
        let storedSession: Session | null = null;
        const ensureSessionVisibleForMessageRoute = vi.fn(async () => {
            if (ensureSessionVisibleForMessageRoute.mock.calls.length === 3) {
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
                    presence: 'online',
                } as Session;
            }
        });
        const sleep = vi.fn(async (ms: number) => {
            nowMs += ms;
        });

        const { createFollowUpSpawnedSessionWithServerScope } = await import('./followUpSpawnedSession');
        const factoryDeps = {
            resolveContext: async () => ({
                scope: 'active' as const,
                timeoutMs: 5_000,
            }),
            activeSync: {
                refreshSessions,
                enqueuePendingMessage,
            },
            ensureSessionVisibleForMessageRoute,
            getStoredSession: () => storedSession,
            sleep,
            now: () => nowMs,
        } satisfies NonNullable<Parameters<typeof createFollowUpSpawnedSessionWithServerScope>[0]>;
        const { followUpSpawnedSessionWithServerScope } = createFollowUpSpawnedSessionWithServerScope(factoryDeps);

        await expect(followUpSpawnedSessionWithServerScope({
            sessionId: 'sess_target',
            targetServerId: 'server-b',
            initialMessageText: 'hello after sync propagation',
            messageLocalId: 'first-turn-local',
        })).resolves.toBeUndefined();

        expect(ensureSessionVisibleForMessageRoute).toHaveBeenCalledTimes(3);
        expect(sleep).toHaveBeenCalledTimes(2);
        expect(enqueuePendingMessage).toHaveBeenCalledTimes(1);
        expect(enqueuePendingMessage).toHaveBeenCalledWith(
            'sess_target',
            'hello after sync propagation',
            undefined,
            undefined,
            {
                localId: 'first-turn-local',
                requestedAction: { v: 1, kind: 'enqueue' },
            },
        );
    });

    it('forces active-scope hydration when the stored session already exists but is only partially hydrated', async () => {
        const refreshSessions = vi.fn(async () => {});
        const ensureSessionVisibleForMessageRoute = vi.fn(async (_sessionId: string, _options?: Readonly<{ forceRefresh?: boolean }>) => {});
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
            ensureSessionVisibleForMessageRoute: async (sessionId: string, options?: Readonly<{ forceRefresh?: boolean }>) => {
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
        });

        expect(refreshSessions).toHaveBeenCalledTimes(1);
        expect(ensureSessionVisibleForMessageRoute).toHaveBeenCalledWith('sess_target', { forceRefresh: true });
        expect(storedSession?.metadata).toMatchObject({
            hydrated: true,
        });
    });

    it('passes displayText, metadata overrides, profileId, and identity through the default active-scope durable enqueue wrapper', async () => {
        let storedSession: Session | null = null;
        const { sync } = await import('@/sync/sync');
        const refreshSessions = vi.spyOn(sync, 'refreshSessions').mockImplementation(async () => {});
        const enqueuePendingMessage = vi.spyOn(sync, 'enqueuePendingMessage').mockImplementation(async () => ({
            localId: 'follow-up-local',
            accepted: true,
        }));
        const ensureSessionVisibleForMessageRoute = vi.fn(async (_sessionId: string, _options?: Readonly<{ forceRefresh?: boolean }>) => {});

        const { createFollowUpSpawnedSessionWithServerScope } = await import('./followUpSpawnedSession');
        const { followUpSpawnedSessionWithServerScope } = createFollowUpSpawnedSessionWithServerScope({
            resolveContext: async () => ({
                scope: 'active',
                timeoutMs: 5_000,
            }),
            ensureSessionVisibleForMessageRoute: async (sessionId: string, options?: Readonly<{ forceRefresh?: boolean }>) => {
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
                    presence: 'online',
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
        expect(ensureSessionVisibleForMessageRoute).toHaveBeenCalledWith(
            'sess_target',
            { forceRefresh: true },
        );
        expect(enqueuePendingMessage).toHaveBeenCalledWith(
            'sess_target',
            'hello from active server',
            'hello display',
            {
                happier: {
                    kind: 'attachments.v1',
                },
                profileId: 'profile-work',
            },
            {
                localId: expect.any(String),
                requestedAction: { v: 1, kind: 'enqueue' },
            },
        );
    });
});
