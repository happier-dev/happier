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
            }),
        );
    });

    it('reuses warm cache list data when metadata and agentState versions match', async () => {
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
                hasPendingPermissionRequests: undefined,
                hasPendingUserActionRequests: undefined,
            }),
        ], { replace: true });
        expect(applySessions).not.toHaveBeenCalled();
    });

    it('pages through /v2/sessions and applies decrypted sessions with share and key cache mapping', async () => {
        onAgentRequest.mockReset();
        const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
            const parsed = new URL(typeof input === 'string' ? input : String(input));
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
        vi.stubGlobal('fetch', fetchSpy);

        const { encryption, decryptEncryptionKey, initializeSessions, decryptMetadata, decryptAgentState } =
            createEncryptionHarness();
        const credentials: AuthCredentials = { token: 't', secret: 's' };
        const appliedSessions: Array<Record<string, unknown>> = [];
        const sessionDataKeys = new Map<string, Uint8Array>();

        await fetchAndApplySessions({
            credentials,
            encryption,
            sessionDataKeys,
            applySessions: (sessions) => {
                appliedSessions.push(...(sessions as unknown as Array<Record<string, unknown>>));
            },
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(fetchSpy).toHaveBeenCalledTimes(2);
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

    it('throws HappyError for non-retryable 4xx responses', async () => {
        onAgentRequest.mockReset();
        vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })));
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
        ).rejects.toBeInstanceOf(HappyError);
    });

    it('throws when /v2/sessions response shape is invalid', async () => {
        onAgentRequest.mockReset();
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ sessions: 'bad-shape', hasNext: false })));
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
        ).rejects.toThrow('Invalid /v2/sessions response');
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
