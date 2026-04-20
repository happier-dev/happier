import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { HappyError } from '@/utils/errors/errors';
import { encodeV2SessionListCursorV1, type V2SessionRecord } from '@happier-dev/protocol';

import { fetchAndApplySessions, type SessionListEncryption } from './sessionSnapshot';

const onAgentRequest = vi.fn();

vi.mock('@/voice/context/voiceHooks', () => ({
    voiceHooks: {
        onAgentRequest: (...args: Parameters<typeof onAgentRequest>) => onAgentRequest(...args),
    },
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'test',
        serverUrl: 'https://example.test',
        kind: 'custom',
        generation: 1,
    }),
}));

type SessionRow = V2SessionRecord;

function buildSessionRow(overrides: Partial<SessionRow> & Pick<SessionRow, 'id'>): SessionRow {
    const { id, ...rest } = overrides;
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        archivedAt: null,
        metadata: `metadata-${overrides.id}`,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        dataEncryptionKey: null,
        share: null,
        ...rest,
    };
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function createEncryptionHarness(): {
    encryption: SessionListEncryption;
    decryptEncryptionKey: ReturnType<typeof vi.fn>;
    initializeSessions: ReturnType<typeof vi.fn>;
    decryptMetadata: ReturnType<typeof vi.fn>;
    decryptAgentState: ReturnType<typeof vi.fn>;
} {
    const decryptEncryptionKey = vi.fn(async (value: string) => new Uint8Array([value.length]));
    const initializeSessions = vi.fn(async () => {});
    const decryptMetadata = vi.fn(async (_version: number, value: string) => ({ decrypted: value }));
    const decryptAgentState = vi.fn(async () => null);
    const encryption: SessionListEncryption = {
        decryptEncryptionKey,
        initializeSessions,
        getSessionEncryption: () => ({
            decryptMetadata,
            decryptAgentState,
        }),
    };
    return { encryption, decryptEncryptionKey, initializeSessions, decryptMetadata, decryptAgentState };
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe('fetchAndApplySessions (/v2/sessions snapshot)', () => {
    it('accepts legacy-compatible session rows when /v2 payloads omit newer fields', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    {
                        id: 'legacy_v2_row',
                        seq: 4,
                        createdAt: 10,
                        updatedAt: 11,
                        active: true,
                        activeAt: 11,
                        metadata: JSON.stringify({ path: '/legacy', host: 'legacy-host' }),
                        metadataVersion: 2,
                        agentState: JSON.stringify({ controlledByUser: true }),
                        agentStateVersion: 3,
                        accessLevel: 'edit',
                        canApprovePermissions: true,
                    },
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption } = createEncryptionHarness();
        const appliedSessions: Array<Record<string, unknown>> = [];

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' } as AuthCredentials,
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions: (sessions) => {
                appliedSessions.push(...(sessions as unknown as Array<Record<string, unknown>>));
            },
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(appliedSessions).toEqual([
            expect.objectContaining({
                id: 'legacy_v2_row',
                accessLevel: 'edit',
                canApprovePermissions: true,
            }),
        ]);
    });

    it('falls back to /v1/sessions when the /v2 session list route is missing', async () => {
        const requestSpy = vi.fn(async (path: string) => {
            if (path.startsWith('/v2/sessions')) {
                return jsonResponse({
                    error: 'Not found',
                    path: '/v2/sessions',
                    method: 'GET',
                }, 404);
            }

            expect(path).toBe('/v1/sessions');
            return jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 'legacy_list_session',
                        encryptionMode: 'plain',
                        metadata: JSON.stringify({ path: '/legacy', host: 'legacy-host' }),
                        agentState: JSON.stringify({}),
                    }),
                ],
            });
        });

        const { encryption } = createEncryptionHarness();
        const appliedSessions: Array<Record<string, unknown>> = [];

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' } as AuthCredentials,
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions: (sessions) => {
                appliedSessions.push(...(sessions as unknown as Array<Record<string, unknown>>));
            },
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(requestSpy.mock.calls.map((call) => call[0])).toEqual([
            '/v2/sessions?limit=150',
            '/v1/sessions',
        ]);
        expect(appliedSessions).toEqual([
            expect.objectContaining({
                id: 'legacy_list_session',
                encryptionMode: 'plain',
            }),
        ]);
    });

    it('keeps cached session ids and renderables when the list falls back to capped /v1/sessions', async () => {
        const requestSpy = vi.fn(async (path: string) => {
            if (path.startsWith('/v2/sessions')) {
                return jsonResponse({
                    error: 'Not found',
                    path: '/v2/sessions',
                    method: 'GET',
                }, 404);
            }

            expect(path).toBe('/v1/sessions');
            return jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 'legacy_list_session',
                        encryptionMode: 'plain',
                        metadata: JSON.stringify({ path: '/legacy', host: 'legacy-host' }),
                        agentState: JSON.stringify({}),
                    }),
                ],
            });
        });

        const { encryption } = createEncryptionHarness();
        const onSnapshotFetched = vi.fn();
        const applySessionListRenderables = vi.fn();

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' } as AuthCredentials,
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions: () => {},
            onSnapshotFetched,
            applySessionListRenderables,
            cachedSessionListEntries: {
                cached_older: {
                    sessionId: 'cached_older',
                    metadataVersion: 5,
                    agentStateVersion: 7,
                    updatedAt: 30,
                    createdAt: 10,
                    active: false,
                    activeAt: 20,
                    archivedAt: null,
                    pendingCount: 0,
                    pendingVersion: 0,
                    accessLevel: 'view',
                    canApprovePermissions: false,
                    name: 'Older cached session',
                    summaryText: 'Older cached summary',
                    path: '/older',
                    homeDir: '/home/u',
                    host: 'legacy-host',
                    machineId: 'm1',
                    flavor: 'claude',
                    directSessionV1: null,
                    hiddenSystemSession: false,
                    hasPendingPermissionRequests: false,
                    hasPendingUserActionRequests: false,
                },
            },
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(onSnapshotFetched).toHaveBeenCalledWith(['legacy_list_session', 'cached_older']);
        expect(applySessionListRenderables).toHaveBeenCalledWith([
            expect.objectContaining({ id: 'legacy_list_session' }),
            expect.objectContaining({
                id: 'cached_older',
                metadata: expect.objectContaining({
                    name: 'Older cached session',
                    path: '/older',
                }),
            }),
        ], { replace: true });
    });

    it('fails the snapshot when a compat page mixes valid and malformed rows', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    {
                        id: 'legacy_valid_row',
                        seq: 4,
                        createdAt: 10,
                        updatedAt: 11,
                        active: true,
                        activeAt: 11,
                        metadata: JSON.stringify({ path: '/legacy', host: 'legacy-host' }),
                        metadataVersion: 2,
                        agentState: JSON.stringify({ controlledByUser: true }),
                        agentStateVersion: 3,
                    },
                    {
                        id: 'legacy_invalid_row',
                        createdAt: 10,
                        updatedAt: 11,
                        active: true,
                        activeAt: 11,
                        metadata: JSON.stringify({ path: '/broken', host: 'legacy-host' }),
                        metadataVersion: 2,
                        agentState: JSON.stringify({ controlledByUser: true }),
                        agentStateVersion: 3,
                    },
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption } = createEncryptionHarness();
        const applySessions = vi.fn();

        await expect(fetchAndApplySessions({
            credentials: { token: 't', secret: 's' } as AuthCredentials,
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        })).rejects.toThrow(/Invalid \/v[12]\/sessions response/);

        expect(applySessions).not.toHaveBeenCalled();
    });

    it('announces newly fetched agent requests relative to existing session state', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's1',
                        encryptionMode: 'plain',
                        metadata: JSON.stringify({ path: '/repo', host: 'dev' }),
                        agentState: JSON.stringify({
                            requests: {
                                req_1: {
                                    tool: 'AskUserQuestion',
                                    kind: 'user_action',
                                    arguments: { question: 'Choose one' },
                                    createdAt: 1,
                                },
                            },
                            completedRequests: {},
                        }),
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption } = createEncryptionHarness();

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions: () => {},
            getExistingSession: () => ({
                id: 's1',
                agentState: {
                    requests: {},
                    completedRequests: {},
                },
            } as any),
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(onAgentRequest).toHaveBeenCalledWith(
            's1',
            'req_1',
            'user_action',
            'AskUserQuestion',
            { question: 'Choose one' },
        );
    });

    it('captures previous sessions before applySessions mutates storage', async () => {
        let storedSession = {
            id: 's1',
            agentState: {
                requests: {},
                completedRequests: {},
            },
        } as any;

        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's1',
                        encryptionMode: 'plain',
                        metadata: JSON.stringify({ path: '/repo', host: 'dev' }),
                        agentState: JSON.stringify({
                            requests: {
                                req_1: {
                                    tool: 'AskUserQuestion',
                                    kind: 'user_action',
                                    arguments: { question: 'Choose one' },
                                    createdAt: 1,
                                },
                            },
                            completedRequests: {},
                        }),
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption } = createEncryptionHarness();

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions: (sessions) => {
                storedSession = sessions[0] as any;
            },
            getExistingSession: () => storedSession,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(onAgentRequest).toHaveBeenCalledWith(
            's1',
            'req_1',
            'user_action',
            'AskUserQuestion',
            { question: 'Choose one' },
        );
    });

    it('bypasses decrypt for plaintext sessions and parses metadata/agentState JSON', async () => {
        onAgentRequest.mockReset();
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_plain',
                        dataEncryptionKey: null,
                        encryptionMode: 'plain',
                        metadata: JSON.stringify({ path: '/repo', host: 'dev' }),
                        agentState: JSON.stringify({}),
                        lastViewedSessionSeq: 4,
                        pendingPermissionRequestCount: 2,
                        pendingUserActionRequestCount: 1,
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption, decryptMetadata, decryptAgentState } = createEncryptionHarness();
        const appliedSessions: Array<Record<string, unknown>> = [];

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions: (sessions) => {
                appliedSessions.push(...(sessions as unknown as Array<Record<string, unknown>>));
            },
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(decryptMetadata).not.toHaveBeenCalled();
        expect(decryptAgentState).not.toHaveBeenCalled();
        expect(appliedSessions).toHaveLength(1);
        expect(appliedSessions[0]).toEqual(
            expect.objectContaining({
                id: 's_plain',
                encryptionMode: 'plain',
                metadata: expect.objectContaining({ path: '/repo', host: 'dev' }),
                agentState: {},
                lastViewedSessionSeq: 4,
                pendingPermissionRequestCount: 2,
                pendingUserActionRequestCount: 1,
            }),
        );
    });

    it('stores the owning serverId on sessions fetched from a known server snapshot', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_owned',
                        dataEncryptionKey: null,
                        encryptionMode: 'plain',
                        metadata: JSON.stringify({ path: '/repo', host: 'dev' }),
                        agentState: JSON.stringify({}),
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption } = createEncryptionHarness();
        const appliedSessions: Array<Record<string, unknown>> = [];

        await fetchAndApplySessions({
            serverId: 'server-owned',
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions: (sessions) => {
                appliedSessions.push(...(sessions as unknown as Array<Record<string, unknown>>));
            },
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(appliedSessions[0]).toEqual(
            expect.objectContaining({
                id: 's_owned',
                serverId: 'server-owned',
            }),
        );
    });

    it('reuses warm cache list data when metadata and agentState versions match and the canonical session already exists', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_cached',
                        dataEncryptionKey: 'k1',
                        metadata: 'encrypted-meta',
                        metadataVersion: 7,
                        agentState: 'encrypted-state',
                        agentStateVersion: 9,
                        pendingCount: 2,
                        pendingVersion: 11,
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption, decryptMetadata, decryptAgentState } = createEncryptionHarness();
        const applySessions = vi.fn();
        const applySessionListRenderables = vi.fn();
        const onSnapshotFetched = vi.fn();

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            onSnapshotFetched,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
            ...( {
                cachedSessionListEntries: {
                    s_cached: {
                        sessionId: 's_cached',
                        metadataVersion: 7,
                        agentStateVersion: 9,
                        updatedAt: 30,
                        createdAt: 10,
                        active: true,
                        activeAt: 30,
                        archivedAt: null,
                        pendingCount: 1,
                        pendingVersion: 10,
                        accessLevel: 'admin',
                        canApprovePermissions: true,
                        name: 'Cached title',
                        summaryText: 'Cached summary',
                        path: '/home/u/repo',
                        homeDir: '/home/u',
                        host: 'mbp',
                        machineId: 'm1',
                        flavor: 'claude',
                        directSessionV1: { v: 1, providerId: 'codex' },
                        hiddenSystemSession: false,
                        hasPendingPermissionRequests: false,
                        hasPendingUserActionRequests: true,
                    },
                },
                applySessionListRenderables,
                getExistingSession: () => ({
                    id: 's_cached',
                    seq: 1,
                    createdAt: 10,
                    updatedAt: 30,
                    active: true,
                    activeAt: 30,
                    metadata: { path: '/home/u/repo', host: 'mbp', machineId: 'm1', name: 'Hydrated title' },
                    metadataVersion: 7,
                    agentState: null,
                    agentStateVersion: 9,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                }),
            } as any),
        } as any);

        expect(decryptMetadata).not.toHaveBeenCalled();
        expect(decryptAgentState).not.toHaveBeenCalled();
        expect(applySessions).not.toHaveBeenCalled();
        expect(onSnapshotFetched).toHaveBeenCalledWith(['s_cached']);
        expect(applySessionListRenderables).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's_cached',
                metadataVersion: 7,
                agentStateVersion: 9,
                pendingCount: 2,
                pendingVersion: 11,
                metadata: expect.objectContaining({
                    name: 'Cached title',
                    summaryText: 'Cached summary',
                    path: '/home/u/repo',
                    homeDir: '/home/u',
                    host: 'mbp',
                    machineId: 'm1',
                    flavor: 'claude',
                    directSessionV1: { v: 1, providerId: 'codex' },
                    hiddenSystemSession: false,
                }),
                hasPendingUserActionRequests: true,
            }),
        ], { replace: true });
    });

    it('hydrates matching warm cache rows when the canonical sessions map is empty', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_cached',
                        dataEncryptionKey: 'k1',
                        metadata: 'encrypted-meta',
                        metadataVersion: 7,
                        agentState: 'encrypted-state',
                        agentStateVersion: 9,
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption, decryptMetadata, decryptAgentState } = createEncryptionHarness();
        const applySessions = vi.fn();
        const applySessionListRenderables = vi.fn();

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            applySessionListRenderables,
            getExistingSession: () => null,
            cachedSessionListEntries: {
                s_cached: {
                    sessionId: 's_cached',
                    metadataVersion: 7,
                    agentStateVersion: 9,
                    updatedAt: 30,
                    createdAt: 10,
                    active: true,
                    activeAt: 30,
                    archivedAt: null,
                    pendingCount: 0,
                    pendingVersion: 0,
                    accessLevel: 'admin',
                    canApprovePermissions: true,
                    name: 'Cached title',
                    summaryText: 'Cached summary',
                    path: '/home/u/repo',
                    homeDir: '/home/u',
                    host: 'mbp',
                    machineId: 'm1',
                    flavor: 'claude',
                    directSessionV1: { v: 1, providerId: 'codex' },
                    hiddenSystemSession: false,
                    hasPendingPermissionRequests: false,
                    hasPendingUserActionRequests: false,
                },
            },
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(applySessionListRenderables).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's_cached',
                metadata: expect.objectContaining({
                    name: 'Cached title',
                    path: '/home/u/repo',
                }),
            }),
        ], { replace: true });
        await expect.poll(() => decryptMetadata.mock.calls.length).toBe(1);
        expect(decryptAgentState).toHaveBeenCalledTimes(1);
        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's_cached',
                metadataVersion: 7,
                agentStateVersion: 9,
            }),
        ]);
    });

    it('hydrates prioritized stale rows before eager background rows', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({ id: 's_oldest', dataEncryptionKey: 'k-oldest', metadata: 'meta-oldest', metadataVersion: 2 }),
                    buildSessionRow({ id: 's_priority', dataEncryptionKey: 'k-priority', metadata: 'meta-priority', metadataVersion: 2 }),
                    buildSessionRow({ id: 's_next', dataEncryptionKey: 'k-next', metadata: 'meta-next', metadataVersion: 2 }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption, decryptMetadata } = createEncryptionHarness();
        const applySessions = vi.fn();

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
            prioritizeSessionIds: ['s_priority'],
            sessionListEagerHydrationCount: 1,
            sessionListHydrationConcurrencyLimit: 1,
            ...( {
                cachedSessionListEntries: {
                    s_oldest: {
                        sessionId: 's_oldest',
                        metadataVersion: 1,
                        agentStateVersion: 0,
                        updatedAt: 1,
                        createdAt: 1,
                        active: true,
                        activeAt: 1,
                        archivedAt: null,
                        path: '/oldest',
                    },
                    s_priority: {
                        sessionId: 's_priority',
                        metadataVersion: 1,
                        agentStateVersion: 0,
                        updatedAt: 1,
                        createdAt: 1,
                        active: true,
                        activeAt: 1,
                        archivedAt: null,
                        path: '/priority',
                    },
                    s_next: {
                        sessionId: 's_next',
                        metadataVersion: 1,
                        agentStateVersion: 0,
                        updatedAt: 1,
                        createdAt: 1,
                        active: true,
                        activeAt: 1,
                        archivedAt: null,
                        path: '/next',
                    },
                },
                applySessionListRenderables: vi.fn(),
            } as any),
        } as any);

        await expect.poll(() => decryptMetadata.mock.calls.length).toBe(3);
        expect(decryptMetadata.mock.calls.map((call) => call[1])).toEqual([
            'meta-priority',
            'meta-oldest',
            'meta-next',
        ]);
        expect(applySessions).toHaveBeenCalledTimes(3);
    });

    it('renders placeholder rows immediately on empty cache and hydrates in the background', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_cold',
                        dataEncryptionKey: 'k-cold',
                        metadata: 'meta-cold',
                        metadataVersion: 3,
                        pendingPermissionRequestCount: 0,
                        pendingUserActionRequestCount: 2,
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption, decryptMetadata, decryptAgentState } = createEncryptionHarness();
        decryptMetadata.mockImplementation(async () => new Promise<never>(() => {}));
        decryptAgentState.mockImplementation(async () => new Promise<never>(() => {}));
        const applySessions = vi.fn();
        const applySessionListRenderables = vi.fn();

        const fetchPromise = fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            applySessionListRenderables,
            cachedSessionListEntries: {},
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        const raceResult = await Promise.race([
            fetchPromise.then(() => 'resolved'),
            new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 25)),
        ]);

        expect(raceResult).toBe('resolved');
        expect(applySessionListRenderables).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's_cold',
                metadataVersion: 3,
                metadata: null,
                hasPendingPermissionRequests: false,
                hasPendingUserActionRequests: true,
            }),
        ], { replace: true });
        expect(applySessions).not.toHaveBeenCalled();
    });

    it('preserves direct-session classification in placeholder rows while a stale direct session rehydrates', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_direct',
                        dataEncryptionKey: 'k-direct',
                        metadata: 'meta-direct',
                        metadataVersion: 3,
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption, decryptMetadata, decryptAgentState } = createEncryptionHarness();
        decryptMetadata.mockImplementation(async () => new Promise<never>(() => {}));
        decryptAgentState.mockImplementation(async () => new Promise<never>(() => {}));
        const applySessions = vi.fn();
        const applySessionListRenderables = vi.fn();

        const fetchPromise = fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            applySessionListRenderables,
            cachedSessionListEntries: {
                s_direct: {
                    sessionId: 's_direct',
                    metadataVersion: 2,
                    agentStateVersion: 0,
                    updatedAt: 3,
                    createdAt: 1,
                    active: true,
                    activeAt: 3,
                    archivedAt: null,
                    pendingCount: 0,
                    pendingVersion: 0,
                    accessLevel: undefined,
                    canApprovePermissions: undefined,
                    name: 'Direct session',
                    summaryText: 'Cached direct summary',
                    path: '/tmp/direct',
                    homeDir: '/tmp',
                    host: 'host',
                    machineId: 'm1',
                    flavor: 'claude',
                    directSessionV1: {
                        v: 1,
                        providerId: 'claude',
                    },
                    hiddenSystemSession: false,
                    hasPendingPermissionRequests: false,
                    hasPendingUserActionRequests: false,
                },
            },
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        const raceResult = await Promise.race([
            fetchPromise.then(() => 'resolved'),
            new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 25)),
        ]);

        expect(raceResult).toBe('resolved');
        expect(applySessionListRenderables).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's_direct',
                metadataVersion: 3,
                metadata: expect.objectContaining({
                    directSessionV1: expect.objectContaining({
                        v: 1,
                        providerId: 'claude',
                    }),
                }),
            }),
        ], { replace: true });
        expect(applySessions).not.toHaveBeenCalled();
    });

    it('preserves direct-session classification from cached rows when hydrated metadata omits directSessionV1', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_direct',
                        encryptionMode: 'plain',
                        metadataVersion: 3,
                        metadata: JSON.stringify({
                            path: '/tmp/direct',
                            host: 'host',
                            directSessionAttentionV1: {
                                v: 1,
                                observedProgressToken: '20:msg-2',
                                viewedProgressToken: '10:msg-1',
                                observedAtMs: 20,
                                viewedAtMs: 10,
                            },
                        }),
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption } = createEncryptionHarness();
        const applySessions = vi.fn();

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            cachedSessionListEntries: {
                s_direct: {
                    sessionId: 's_direct',
                    metadataVersion: 2,
                    agentStateVersion: 0,
                    updatedAt: 3,
                    createdAt: 1,
                    active: true,
                    activeAt: 3,
                    archivedAt: null,
                    pendingCount: 0,
                    pendingVersion: 0,
                    accessLevel: undefined,
                    canApprovePermissions: undefined,
                    name: 'Direct session',
                    summaryText: 'Cached direct summary',
                    path: '/tmp/direct',
                    homeDir: '/tmp',
                    host: 'host',
                    machineId: 'm1',
                    flavor: 'claude',
                    directSessionV1: {
                        v: 1,
                        providerId: 'claude',
                    },
                    hiddenSystemSession: false,
                    hasPendingPermissionRequests: false,
                    hasPendingUserActionRequests: false,
                },
            },
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's_direct',
                metadataVersion: 3,
                metadata: expect.objectContaining({
                    path: '/tmp/direct',
                    host: 'host',
                    machineId: 'm1',
                    directSessionV1: expect.objectContaining({
                        v: 1,
                        providerId: 'claude',
                    }),
                    directSessionAttentionV1: expect.objectContaining({
                        v: 1,
                        observedProgressToken: '20:msg-2',
                    }),
                }),
            }),
        ]);
    });

    it('preserves direct-session classification from cached rows when hydrated metadata sets directSessionV1 to null', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_direct',
                        encryptionMode: 'plain',
                        metadataVersion: 3,
                        metadata: JSON.stringify({
                            path: '/tmp/direct',
                            host: 'host',
                            directSessionV1: null,
                            directSessionAttentionV1: {
                                v: 1,
                                observedProgressToken: '20:msg-2',
                                viewedProgressToken: '10:msg-1',
                                observedAtMs: 20,
                                viewedAtMs: 10,
                            },
                        }),
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption } = createEncryptionHarness();
        const applySessions = vi.fn();

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            cachedSessionListEntries: {
                s_direct: {
                    sessionId: 's_direct',
                    metadataVersion: 2,
                    agentStateVersion: 0,
                    updatedAt: 3,
                    createdAt: 1,
                    active: true,
                    activeAt: 3,
                    archivedAt: null,
                    pendingCount: 0,
                    pendingVersion: 0,
                    accessLevel: undefined,
                    canApprovePermissions: undefined,
                    name: 'Direct session',
                    summaryText: 'Cached direct summary',
                    path: '/tmp/direct',
                    homeDir: '/tmp',
                    host: 'host',
                    machineId: 'm1',
                    flavor: 'claude',
                    directSessionV1: {
                        v: 1,
                        providerId: 'claude',
                    },
                    hiddenSystemSession: false,
                    hasPendingPermissionRequests: false,
                    hasPendingUserActionRequests: false,
                },
            },
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's_direct',
                metadataVersion: 3,
                metadata: expect.objectContaining({
                    path: '/tmp/direct',
                    host: 'host',
                    directSessionV1: expect.objectContaining({
                        v: 1,
                        providerId: 'claude',
                    }),
                    directSessionAttentionV1: expect.objectContaining({
                        v: 1,
                        observedProgressToken: '20:msg-2',
                    }),
                }),
            }),
        ]);
    });

    it('skips background hydration when the caller scope is no longer active', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_cold',
                        dataEncryptionKey: 'k-cold',
                        metadata: 'meta-cold',
                        metadataVersion: 3,
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption } = createEncryptionHarness();
        const applySessions = vi.fn();
        const applySessionListRenderables = vi.fn();

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            applySessionListRenderables,
            cachedSessionListEntries: {},
            shouldContinue: () => false,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        // Yield to allow any background tasks to run if they were scheduled.
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));

        expect(applySessions).not.toHaveBeenCalled();
    });

    it('pages through /v2/sessions and applies decrypted sessions with share and key cache mapping', async () => {
        onAgentRequest.mockReset();
        const requestSpy = vi.fn(async (path: string) => {
            const parsed = new URL(path, 'https://example.test');
            expect(parsed.pathname).toBe('/v2/sessions');

            const cursor = parsed.searchParams.get('cursor');
            if (!cursor) {
                return jsonResponse({
                    sessions: [
                        buildSessionRow({ id: 's2', seq: 2, dataEncryptionKey: 'k2' }),
                        buildSessionRow({
                            id: 's1',
                            seq: 1,
                            dataEncryptionKey: null,
                            share: { accessLevel: 'view', canApprovePermissions: true },
                        }),
                    ],
                    nextCursor: encodeV2SessionListCursorV1('s1'),
                    hasNext: true,
                });
            }

            expect(cursor).toBe(encodeV2SessionListCursorV1('s1'));
            return jsonResponse({
                sessions: [
                    buildSessionRow({ id: 's0', seq: 0, active: false, activeAt: 0, dataEncryptionKey: 'k0' }),
                ],
                nextCursor: null,
                hasNext: false,
            });
        });

        const { encryption, decryptEncryptionKey, initializeSessions, decryptMetadata, decryptAgentState } =
            createEncryptionHarness();
        const credentials: AuthCredentials = { token: 't', secret: 's' };
        const appliedSessions: Array<Record<string, unknown>> = [];
        const sessionDataKeys = new Map<string, Uint8Array>();

        await fetchAndApplySessions({
            credentials,
            encryption,
            sessionDataKeys,
            request: requestSpy,
            applySessions: (sessions) => {
                appliedSessions.push(...(sessions as unknown as Array<Record<string, unknown>>));
            },
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(requestSpy).toHaveBeenCalledTimes(2);
        expect(decryptEncryptionKey).toHaveBeenCalledTimes(2);
        expect(initializeSessions).toHaveBeenCalledTimes(1);
        expect(decryptMetadata).toHaveBeenCalledTimes(3);
        expect(decryptAgentState).toHaveBeenCalledTimes(3);

        expect(appliedSessions).toHaveLength(3);
        expect(appliedSessions.map((session) => session.id)).toEqual(['s2', 's1', 's0']);

        const sharedSession = appliedSessions.find((session) => session.id === 's1');
        expect(sharedSession?.accessLevel).toBe('view');
        expect(sharedSession?.canApprovePermissions).toBe(true);

        expect(sessionDataKeys.has('s2')).toBe(true);
        expect(sessionDataKeys.has('s0')).toBe(true);
        expect(sessionDataKeys.has('s1')).toBe(false);
    });

    it.each([401, 403] as const)('throws canonical auth for compat session list status %s', async (status) => {
        onAgentRequest.mockReset();
        const requestSpy = vi.fn(async () => new Response('auth failed', { status }));
        const { encryption } = createEncryptionHarness();

        await expect(
            fetchAndApplySessions({
                credentials: { token: 't', secret: 's' },
                encryption,
                sessionDataKeys: new Map<string, Uint8Array>(),
                request: requestSpy,
                applySessions: () => {},
                repairInvalidReadStateV1: async () => {},
                log: { log: () => {} },
            }),
        ).rejects.toMatchObject({
            name: 'HappyError',
            kind: 'auth',
            code: 'not_authenticated',
            canTryAgain: false,
        });
    });

    it('throws HappyError for other non-retryable 4xx responses', async () => {
        onAgentRequest.mockReset();
        const requestSpy = vi.fn(async () => new Response('unprocessable', { status: 422 }));
        const { encryption } = createEncryptionHarness();

        await expect(
            fetchAndApplySessions({
                credentials: { token: 't', secret: 's' },
                encryption,
                sessionDataKeys: new Map<string, Uint8Array>(),
                request: requestSpy,
                applySessions: () => {},
                repairInvalidReadStateV1: async () => {},
                log: { log: () => {} },
            }),
        ).rejects.toBeInstanceOf(HappyError);
    });

    it('falls back to /v1/sessions when /v2/sessions response shape is invalid', async () => {
        onAgentRequest.mockReset();
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            if (String(input).includes('/v2/sessions')) {
                return jsonResponse({ sessions: 'bad-shape', hasNext: false });
            }
            return jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 'legacy_after_invalid_v2',
                        encryptionMode: 'plain',
                        metadata: JSON.stringify({ path: '/legacy-after-invalid' }),
                        agentState: JSON.stringify({}),
                    }),
                ],
            });
        }));
        const { encryption } = createEncryptionHarness();
        const appliedSessions: Array<Record<string, unknown>> = [];

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            applySessions: (sessions) => {
                appliedSessions.push(...(sessions as unknown as Array<Record<string, unknown>>));
            },
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(appliedSessions).toEqual([
            expect.objectContaining({
                id: 'legacy_after_invalid_v2',
                encryptionMode: 'plain',
            }),
        ]);
    });

    it('throws when both /v2/sessions and /v1/sessions response shapes are invalid', async () => {
        onAgentRequest.mockReset();
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            if (String(input).includes('/v2/sessions')) {
                return jsonResponse({ sessions: 'bad-shape', hasNext: false });
            }
            return jsonResponse({ sessions: [{ id: 'legacy_invalid' }] });
        }));
        const { encryption } = createEncryptionHarness();

        await expect(
            fetchAndApplySessions({
                credentials: { token: 't', secret: 's' },
                encryption,
                sessionDataKeys: new Map<string, Uint8Array>(),
                applySessions: () => {},
                repairInvalidReadStateV1: async () => {},
                log: { log: () => {} },
            }),
        ).rejects.toThrow('Invalid /v1/sessions response');
    });

    it('uses injected request transport when provided', async () => {
        onAgentRequest.mockReset();
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        const requestSpy = vi.fn(async (_path: string, _init?: RequestInit) =>
            jsonResponse({
                sessions: [buildSessionRow({ id: 's1', seq: 1 })],
                nextCursor: null,
                hasNext: false,
            }),
        );
        const { encryption } = createEncryptionHarness();
        const sessionDataKeys = new Map<string, Uint8Array>();
        const appliedSessions: Array<Record<string, unknown>> = [];

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys,
            request: requestSpy,
            applySessions: (sessions) => {
                appliedSessions.push(...(sessions as unknown as Array<Record<string, unknown>>));
            },
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(requestSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(appliedSessions.map((session) => session.id)).toEqual(['s1']);
    });
});
