import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1 } from '@happier-dev/protocol';

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
    AGENT_IDS: ['codex'],
    getAgentCore: () => ({ model: { defaultMode: 'default', supportsSelection: false } }),
    resolveAgentIdFromFlavor: () => 'codex',
}));

function composerAttachmentOnlyMeta(): Record<string, unknown> {
    return {
        [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
            v: 1,
            composerAttachments: [{
                v: 1,
                instanceId: 'attachment-instance-1',
                attachment: {
                    pluginId: 'com.acme.review',
                    localId: 'review',
                },
                key: 'review-42',
                value: { reviewId: '42' },
                presentation: { label: 'Review #42', typeLabel: 'Review comment' },
                // The real post-spawn shape: a Composer draft whose media is
                // still the transfer-owned staged claim. The daemon's
                // SessionMedia finalizer turns it into a durable reference
                // during admission, so this turn must reach the sender.
                content: {
                    kind: 'stagedMedia',
                    handle: {
                        v: 1,
                        id: 'staged-content-42',
                        executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
                        owner: { pluginId: 'com.acme.review', localId: 'review' },
                        mediaKind: 'image',
                        mimeType: 'image/png',
                        name: 'review-42.png',
                        sizeBytes: 2048,
                        sha256: 'a'.repeat(64),
                    },
                },
            }],
        },
    };
}

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
                initialMessageText: '  Investigate this bug\n\n[attachments block]  ',
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
            draftText: '  Investigate this bug\n\n[attachments block]  ',
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
                    requestedAction: { v: 1, kind: 'send_now' },
            },
        );
    });

    it('sends an attachment-only post-spawn first turn through the canonical sender', async () => {
        const sendSessionMessageWithServerScope = vi.fn(async () => ({ ok: true as const }));
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
            sendSessionMessageWithServerScope,
            activeSync: { refreshSessions: async () => {} },
            ensureSessionVisibleForMessageRoute: async () => {},
            getStoredSession: () => storedSession,
        });
        const metaOverrides = composerAttachmentOnlyMeta();

        await followUpSpawnedSessionWithServerScope({
            sessionId: 'sess_target',
            initialMessageText: '',
            metaOverrides,
            messageLocalId: 'spawn-attachment-only-1',
        });

        expect(sendSessionMessageWithServerScope).toHaveBeenCalledExactlyOnceWith({
            sessionId: 'sess_target',
            message: '',
            serverId: null,
            displayText: undefined,
            metaOverrides,
            profileId: undefined,
            messageLocalId: 'spawn-attachment-only-1',
            providerDeliveryIntent: 'first_turn',
        });
    });

    it('retains an attachment-only post-spawn input as recoverable when canonical admission fails', async () => {
        const sendSessionMessageWithServerScope = vi.fn(async () => ({
            ok: false as const,
            errorCode: 'prepare_failed',
            error: 'Attachment preparation failed',
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
        const { createFollowUpSpawnedSessionWithServerScope, readRecoverableFollowUpPayload } = await import('./followUpSpawnedSession');
        const { followUpSpawnedSessionWithServerScope } = createFollowUpSpawnedSessionWithServerScope({
            resolveContext: async () => ({ scope: 'active', timeoutMs: 5_000 }),
            sendSessionMessageWithServerScope,
            activeSync: { refreshSessions: async () => {} },
            ensureSessionVisibleForMessageRoute: async () => {},
            getStoredSession: () => storedSession,
        });
        const metaOverrides = composerAttachmentOnlyMeta();

        let thrown: unknown = null;
        try {
            await followUpSpawnedSessionWithServerScope({
                sessionId: 'sess_target',
                initialMessageText: '',
                metaOverrides,
                messageLocalId: 'spawn-attachment-only-1',
            });
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toBe('Attachment preparation failed');
        expect(readRecoverableFollowUpPayload(thrown)).toEqual({
            draftText: '',
            metaOverrides,
        });
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
                credentials: { token: 'token-b' },
                encryption: null,
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

    it('uses the canonical scoped request owner to hydrate before sending the first message', async () => {
        const sendSessionMessageWithServerScope = vi.fn(async () => ({ ok: true as const }));
        const fetchedSession = {
            id: 'sess_target',
            createdAt: 1,
            updatedAt: 2,
            seq: 3,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadataVersion: 1,
            metadata: { path: '/tmp/repo', host: 'host' },
            agentStateVersion: 1,
            agentState: null,
            presence: 'online',
        } as Session;
        let storedSession: Session | null = null;
        const fetchSessionById = vi.fn(async ({
            activeRequest,
            authority,
            applySessions,
        }: {
            activeRequest: (path: string, init?: RequestInit) => Promise<Response>;
            authority?: Readonly<{
                context: Readonly<{ targetServerId: string }>;
                request: (path: string, init?: RequestInit) => Promise<Response>;
            }>;
            applySessions: (sessions: Session[]) => void;
        }) => {
            expect(authority?.context.targetServerId).toBe('server-b');
            expect(authority?.request).toBe(activeRequest);
            applySessions([fetchedSession]);
            return { ok: true, session: null };
        });

        const { createFollowUpSpawnedSessionWithServerScope } = await import('./followUpSpawnedSession');
        const { followUpSpawnedSessionWithServerScope } = createFollowUpSpawnedSessionWithServerScope({
            resolveContext: async () => ({
                scope: 'scoped',
                timeoutMs: 5_000,
                targetServerId: 'server-b',
                targetAccountId: 'account-b',
                targetServerUrl: 'https://server-b.example.test',
                token: 'token-b',
                credentials: { token: 'token-b' },
                encryption: null,
            }),
            fetchSessionById,
            sendSessionMessageWithServerScope,
            getStoredSession: () => storedSession,
            applySessions: (sessions) => {
                storedSession = sessions[0] ?? null;
            },
        });

        await followUpSpawnedSessionWithServerScope({
            sessionId: 'sess_target',
            targetServerId: 'server-b',
            initialMessageText: 'List the files in this directory and stop.',
        });

        expect(fetchSessionById).toHaveBeenCalledOnce();
        expect(sendSessionMessageWithServerScope).toHaveBeenCalledOnce();
        expect(sendSessionMessageWithServerScope).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess_target',
            message: 'List the files in this directory and stop.',
            providerDeliveryIntent: 'first_turn',
        }));
        expect(storedSession).toBe(fetchedSession);
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
                credentials: { token: 'token-b' },
                encryption: null,
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


    it('routes an attachment-only first turn through the selected server scope after hydration', async () => {
        const sendSessionMessageWithServerScope = vi.fn(async () => ({ ok: true as const }));
        const fetchedSession = {
            id: 'sess_target',
            createdAt: 1,
            updatedAt: 2,
            seq: 3,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadataVersion: 1,
            metadata: { path: '/tmp/repo', host: 'host' },
            agentStateVersion: 1,
            agentState: null,
            presence: 'online',
        } as Session;
        let storedSession: Session | null = null;
        const { createFollowUpSpawnedSessionWithServerScope } = await import('./followUpSpawnedSession');
        const { followUpSpawnedSessionWithServerScope } = createFollowUpSpawnedSessionWithServerScope({
            resolveContext: async () => ({
                scope: 'scoped',
                timeoutMs: 5_000,
                targetServerId: 'server-b',
                targetAccountId: 'account-b',
                targetServerUrl: 'https://server-b.example.test',
                token: 'token-b',
                credentials: { token: 'token-b' },
                encryption: null,
            }),
            fetchSessionById: async ({ applySessions }) => {
                applySessions([fetchedSession]);
                return { ok: true, session: null };
            },
            sendSessionMessageWithServerScope,
            getStoredSession: () => storedSession,
            applySessions: (sessions) => {
                storedSession = sessions[0] as Session;
            },
        });
        const metaOverrides = composerAttachmentOnlyMeta();

        await followUpSpawnedSessionWithServerScope({
            sessionId: 'sess_target',
            targetServerId: 'server-b',
            initialMessageText: '',
            metaOverrides,
            messageLocalId: 'scoped-spawn-attachment-only-1',
        });

        expect(sendSessionMessageWithServerScope).toHaveBeenCalledExactlyOnceWith({
            sessionId: 'sess_target',
            message: '',
            serverId: 'server-b',
            displayText: undefined,
            metaOverrides,
            profileId: undefined,
            messageLocalId: 'scoped-spawn-attachment-only-1',
            providerDeliveryIntent: 'first_turn',
        });
        expect(storedSession).toBe(fetchedSession);
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
                credentials: { token: 'token-b' },
                encryption: null,
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
                credentials: { token: 'token-b' },
                encryption: null,
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

describe('follow-up first-turn continuity (real scoped transport)', () => {
    let boundary: Awaited<ReturnType<typeof import('@/dev/testkit/harness/sessionOpsNetworkBoundary').installSessionOpsNetworkBoundary>>;
    let storage: typeof import('@/sync/domains/state/storage').storage;
    let fixtures: typeof import('@/dev/testkit/fixtures/sessionFixtures');
    let followUp: typeof import('./followUpSpawnedSession').followUpSpawnedSessionWithServerScope;
    let readRecovery: typeof import('./followUpSpawnedSession').readRecoverableFollowUpPayload;
    let home: Awaited<ReturnType<typeof boundary.addHome>>;
    let focusedHome: Awaited<ReturnType<typeof boundary.addHome>>;
    let storedMetadata: NonNullable<Session['metadata']>;
    let hydrationStatus: number;
    const pendingWrites: Array<{ url: string; token: string | null; body: unknown }> = [];

    beforeAll(async () => {
        vi.doUnmock('@/sync/sync');
        vi.doUnmock('@/sync/runtime/getSyncSingleton');
        vi.doUnmock('@/agents/catalog/catalog');
        vi.resetModules();
        const { installSessionOpsNetworkBoundary } = await import('@/dev/testkit/harness/sessionOpsNetworkBoundary');
        boundary = await installSessionOpsNetworkBoundary();
        await loadSyncSingletonForTests();
        storage = (await import('@/sync/domains/state/storage')).storage;
        fixtures = await import('@/dev/testkit/fixtures/sessionFixtures');
        const owner = await import('./followUpSpawnedSession');
        followUp = owner.followUpSpawnedSessionWithServerScope;
        readRecovery = owner.readRecoverableFollowUpPayload;
    });

    beforeEach(async () => {
        vi.stubGlobal('indexedDB', new IDBFactory());
        storage.setState(storage.getInitialState(), true);
        boundary.resetRequests();
        pendingWrites.length = 0;
        hydrationStatus = 200;
        home = await boundary.addHome('https://follow-up-target.example.test', 'target-account');
        focusedHome = await boundary.addHome('https://follow-up-focused.example.test', 'focused-account');
        const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
        await setActiveServerId(focusedHome.id, { scope: 'device' });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockResolvedValueOnce(null);
        await (await import('@/sync/runtime/orchestration/connectionManager')).switchConnectionToActiveServer();
        storage.setState({ profileScope: { serverId: focusedHome.id, accountId: focusedHome.accountId } });
        const { MetadataSchema } = await import('@happier-dev/session-core/state');
        storedMetadata = MetadataSchema.parse({
            path: '/newer-workspace', host: 'machine.local', machineId: 'machine-1', flavor: 'codex',
            sessionModelsV1: { v: 1, agentId: 'codex', updatedAt: 2, currentModelId: 'newer-model',
                availableModels: [{ id: 'newer-model', name: 'Newer model' }] },
        });
        storage.getState().applySessions([fixtures.createSessionFixture({
            id: 'sess_target', serverId: home.id, seq: 3, updatedAt: 2, active: true,
            metadataLayoutVersion: 0, metadataVersion: 2, metadata: storedMetadata,
        })]);
        const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
        const features = createRootLayoutFeaturesResponse();
        features.capabilities.session.pendingInput = { protocolVersion: 1 };
        const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
        resetServerFeaturesClientForTests();
        boundary.setHttpResponder(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/features') return Response.json(features);
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json({
                mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null,
                updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
            });
            if (url.pathname === '/v2/sessions/sess_target') {
                expect(url.origin).toBe(home.serverUrl);
                expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${home.token}`);
                if (hydrationStatus !== 200) return Response.json({ error: 'unauthorized' }, { status: hydrationStatus });
                return Response.json({ session: {
                    id: 'sess_target', createdAt: 1, updatedAt: 1, seq: 2, active: true, activeAt: 1,
                    encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
                    metadataVersion: 1, metadata: JSON.stringify({ path: '/older-workspace', host: 'machine.local' }),
                    agentStateVersion: 1, agentState: null, share: null,
                    access: fixtures.createSessionAccessFixture(),
                } });
            }
            if (url.pathname === '/v2/sessions/sess_target/pending' && init?.method === 'POST') {
                const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : null;
                pendingWrites.push({ url: url.href, token: new Headers(init.headers).get('Authorization'), body });
                if (!body || typeof body !== 'object' || !('localId' in body) || !('content' in body) || !('requestedAction' in body)) {
                    throw new Error('Malformed first-turn Pending request');
                }
                return Response.json({ didWrite: true, requestedAction: body.requestedAction, pendingCount: 1, pendingVersion: 1,
                    pending: { localId: body.localId, content: body.content, status: 'queued', position: 0,
                        createdAt: 10, updatedAt: 10, discardedAt: null, discardedReason: null, authorAccountId: home.accountId } });
            }
            return null;
        });
    });

    afterEach(() => vi.unstubAllGlobals());
    afterAll(async () => {
        await (await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool')).resetServerReachabilitySupervisors();
        await boundary?.dispose();
    });

    it('sends the first turn when the scoped by-id row is older than the stored models seed', async () => {
        await followUp({ sessionId: 'sess_target', targetServerId: home.id,
            initialMessageText: 'first prompt', messageLocalId: 'first-turn-local-id' });
        expect(pendingWrites).toEqual([{
            url: `${home.serverUrl}/v2/sessions/sess_target/pending`, token: `Bearer ${home.token}`,
            body: expect.objectContaining({ localId: 'first-turn-local-id', messageRole: 'user',
                requestedAction: { v: 1, kind: 'send_now' },
                content: expect.objectContaining({ t: 'plain', v: expect.objectContaining({
                    role: 'user', content: { type: 'text', text: 'first prompt' },
                }) }),
            }),
        }]);
        expect(storage.getState().sessions['sess_target'].metadataVersion).toBe(2);
        expect(storage.getState().sessions['sess_target'].metadata).toEqual(storedMetadata);
        const { loadPendingOutboxForSession } = await import('@/sync/domains/state/pendingOutboxPersistence');
        expect(await loadPendingOutboxForSession('sess_target', { serverId: home.id, accountId: home.accountId })).toEqual([]);
    });

    it('does not send or replace newer metadata when the target Home rejects hydration', async () => {
        hydrationStatus = 401;
        let thrown: unknown;
        try {
            await followUp({ sessionId: 'sess_target', targetServerId: home.id,
                initialMessageText: 'first prompt', messageLocalId: 'first-turn-local-id' });
        } catch (error) { thrown = error; }
        expect(thrown).toMatchObject({ name: 'HappyError', kind: 'auth', code: 'not_authenticated' });
        expect(readRecovery(thrown)).toMatchObject({ draftText: 'first prompt' });
        expect(pendingWrites).toEqual([]);
        expect(storage.getState().sessions['sess_target'].metadataVersion).toBe(2);
        expect(storage.getState().sessions['sess_target'].metadata).toEqual(storedMetadata);
    });
});
