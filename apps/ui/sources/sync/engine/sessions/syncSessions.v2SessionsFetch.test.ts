import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import {
    applySessionListRenderablePatch,
    buildSessionListRenderableFromSession,
    preserveSessionListRenderableStaleFields,
    type SessionListRenderableSession,
} from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import { Encryption } from '@/sync/encryption/encryption';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
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

const MERGED_INITIAL_PAGE_PATH = '/v2/sessions?includeActive=true&includeAttention=true&limit=50';

type SessionRow = V2SessionRecord;
type FetchAndApplySessionsParams = Parameters<typeof fetchAndApplySessions>[0];
type TestNativeCryptoWorker = NonNullable<Parameters<Encryption['configureNativeCryptoWorker']>[0]['worker']>;

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

function buildExistingSession(overrides: Partial<Session> & Pick<Session, 'id'>): Session {
    const { id, ...rest } = overrides;
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...rest,
    };
}

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
    const responseHeaders = new Headers(headers);
    responseHeaders.set('Content-Type', 'application/json');
    return new Response(JSON.stringify(body), {
        status,
        headers: responseHeaders,
    });
}

function createDeferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
} {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

type EncryptionHarnessEncryption = Omit<
    SessionListEncryption,
    'decryptEncryptionKeys' | 'getCurrentEncryptionGenerationScope' | 'isCurrentEncryptionGenerationScope'
> & {
    decryptEncryptionKey: ReturnType<typeof vi.fn>;
    decryptEncryptionKeys: ReturnType<typeof vi.fn>;
    getCurrentEncryptionGenerationScope?: (scope?: { accountId?: string; serverId?: string | null }) => {
        accountId: string;
        serverId: string | null;
        generation: number;
    };
    isCurrentEncryptionGenerationScope?: (scope: { accountId: string; serverId: string | null; generation: number }) => boolean;
};

function createEncryptionHarness(): {
    encryption: EncryptionHarnessEncryption;
    decryptEncryptionKey: ReturnType<typeof vi.fn>;
    decryptEncryptionKeys: ReturnType<typeof vi.fn>;
    initializeSessions: ReturnType<typeof vi.fn>;
    removeSessionEncryption: ReturnType<typeof vi.fn>;
    getSessionEncryption: ReturnType<typeof vi.fn>;
    decryptMetadata: ReturnType<typeof vi.fn>;
    decryptAgentState: ReturnType<typeof vi.fn>;
} {
    const decryptEncryptionKeys = vi.fn(async (values: readonly string[], _scope?: { signal?: AbortSignal }) =>
        values.map((value) => new Uint8Array([value.length])),
    );
    const decryptEncryptionKey = vi.fn(async (value: string) => {
        const [decrypted] = await decryptEncryptionKeys([value]);
        return decrypted ?? null;
    });
    const initializeSessions = vi.fn(async () => {});
    const removeSessionEncryption = vi.fn();
    const getSessionEncryption = vi.fn(() => ({
        decryptMetadata,
        decryptAgentState,
    }));
    const decryptMetadata = vi.fn(async (_version: number, value: string) => ({ decrypted: value }));
    const decryptAgentState = vi.fn(async () => null);
    const encryption: EncryptionHarnessEncryption = {
        decryptEncryptionKey,
        decryptEncryptionKeys,
        initializeSessions,
        removeSessionEncryption,
        getSessionEncryption,
    };
    return { encryption, decryptEncryptionKey, decryptEncryptionKeys, initializeSessions, removeSessionEncryption, getSessionEncryption, decryptMetadata, decryptAgentState };
}

type SingleDecryptOnlyEncryptionHarness = Omit<SessionListEncryption, 'decryptEncryptionKeys'> & {
    decryptEncryptionKey: ReturnType<typeof vi.fn>;
};

function createSingleDecryptOnlyEncryptionHarness(): {
    encryption: SessionListEncryption;
    decryptEncryptionKey: ReturnType<typeof vi.fn>;
    initializeSessions: ReturnType<typeof vi.fn>;
} {
    const { decryptEncryptionKey, initializeSessions, removeSessionEncryption, getSessionEncryption } = createEncryptionHarness();
    const singleDecryptOnlyEncryption = {
        decryptEncryptionKey,
        initializeSessions,
        removeSessionEncryption,
        getSessionEncryption,
    } satisfies SingleDecryptOnlyEncryptionHarness;

    return {
        // Intentional malformed seam fixture: this proves session-list hydration
        // requires the batch decrypt dependency instead of accepting legacy fallback.
        encryption: singleDecryptOnlyEncryption as unknown as SessionListEncryption,
        decryptEncryptionKey,
        initializeSessions,
    };
}

function attachNativeWorkerScopeHarness(
    encryption: ReturnType<typeof createEncryptionHarness>['encryption'],
    initial?: { accountId?: string; serverId?: string | null; generation?: number },
): {
    bumpGeneration: () => void;
    switchAccount: (accountId: string) => void;
    switchServer: (serverId: string | null) => void;
} {
    let accountId = initial?.accountId ?? 'account-a';
    let serverId: string | null = initial?.serverId ?? 'server-a';
    let generation = initial?.generation ?? 0;

    encryption.getCurrentEncryptionGenerationScope = vi.fn((scope?: { accountId?: string; serverId?: string | null }) => ({
        accountId: scope?.accountId ?? accountId,
        serverId: scope?.serverId ?? serverId,
        generation,
    }));
    encryption.isCurrentEncryptionGenerationScope = vi.fn((scope: { accountId: string; serverId: string | null; generation: number }) =>
        scope.accountId === accountId
        && scope.serverId === serverId
        && scope.generation === generation,
    );

    return {
        bumpGeneration: () => {
            generation += 1;
        },
        switchAccount: (nextAccountId) => {
            accountId = nextAccountId;
        },
        switchServer: (nextServerId: string | null) => {
            serverId = nextServerId;
        },
    };
}

function expectDecryptEncryptionKeysCall(
    decryptEncryptionKeys: ReturnType<typeof vi.fn>,
    expectedEnvelopes: readonly string[],
    expectedScope: Readonly<{ serverId?: string | null }> = {},
): void {
    expect(decryptEncryptionKeys).toHaveBeenCalledTimes(1);
    const call = decryptEncryptionKeys.mock.calls[0];
    expect(call?.[0]).toEqual(expectedEnvelopes);
    const scope = call?.[1] as { serverId?: string | null } | undefined;
    if ('serverId' in expectedScope) {
        expect(scope?.serverId).toBe(expectedScope.serverId);
    } else {
        expect(scope?.serverId).toBeUndefined();
    }
}

function expectInitializeSessionsCall(
    initializeSessions: ReturnType<typeof vi.fn>,
    expectedSessions: ReadonlyArray<readonly [string, Uint8Array | null]>,
    expectedScope: Readonly<{ serverId?: string | null }> = {},
): void {
    expect(initializeSessions).toHaveBeenCalledTimes(1);
    const call = initializeSessions.mock.calls[0];
    expect(call?.[0]).toBeInstanceOf(Map);
    expect(Array.from((call?.[0] as Map<string, Uint8Array | null>).entries())).toEqual(expectedSessions);
    const scope = call?.[1] as { serverId?: string | null } | undefined;
    if ('serverId' in expectedScope) {
        expect(scope?.serverId).toBe(expectedScope.serverId);
    } else {
        expect(scope?.serverId).toBeUndefined();
    }
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    syncPerformanceTelemetry.configure({ enabled: false });
});

describe('fetchAndApplySessions (/v2/sessions snapshot)', () => {
    it('fetches one bounded v2 session page by default and returns the next cursor for loading more', async () => {
        const firstPage = Array.from({ length: 50 }, (_, index) => buildSessionRow({
            id: `session_${String(index + 1).padStart(3, '0')}`,
            encryptionMode: 'plain',
            metadata: JSON.stringify({ path: `/page-1/${index}`, host: 'host' }),
            agentState: JSON.stringify({}),
        }));
        const secondPage = Array.from({ length: 50 }, (_, index) => buildSessionRow({
            id: `session_${String(index + 51).padStart(3, '0')}`,
            encryptionMode: 'plain',
            metadata: JSON.stringify({ path: `/page-2/${index}`, host: 'host' }),
            agentState: JSON.stringify({}),
        }));
        const thirdPage = [buildSessionRow({
            id: 'session_101',
            encryptionMode: 'plain',
            metadata: JSON.stringify({ path: '/page-3/0', host: 'host' }),
            agentState: JSON.stringify({}),
        })];
        const requestSpy = vi.fn(async (path: string) => {
            if (path === '/v2/sessions?limit=50') {
                return jsonResponse({ sessions: firstPage, nextCursor: 'cursor_1', hasNext: true });
            }
            if (path === '/v2/sessions?limit=50&cursor=cursor_1') {
                return jsonResponse({ sessions: secondPage, nextCursor: 'cursor_2', hasNext: true });
            }
            if (path === '/v2/sessions?limit=50&cursor=cursor_2') {
                return jsonResponse({ sessions: thirdPage, nextCursor: null, hasNext: false });
            }
            throw new Error(`Unexpected path ${path}`);
        });

        const { encryption } = createEncryptionHarness();
        const applySessions = vi.fn();

        const result = await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' } as AuthCredentials,
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(requestSpy.mock.calls.map((call) => call[0])).toEqual([
            '/v2/sessions?limit=50',
        ]);
        expect(applySessions).toHaveBeenCalledWith(expect.arrayContaining([
            expect.objectContaining({ id: 'session_001' }),
        ]));
        expect(applySessions.mock.calls[0]?.[0]).toHaveLength(50);
        expect(result).toEqual(expect.objectContaining({
            hasNext: true,
            nextCursor: 'cursor_1',
        }));
    });

    it('does not write routine success logs for warm-cache session-list pages', async () => {
        const requestSpy = vi.fn(async () => jsonResponse({
            sessions: [
                buildSessionRow({
                    id: 'session_001',
                    encryptionMode: 'plain',
                    metadata: JSON.stringify({ path: '/repo', host: 'host' }),
                    agentState: JSON.stringify({}),
                }),
            ],
            nextCursor: null,
            hasNext: false,
        }));
        const { encryption } = createEncryptionHarness();
        const log = { log: vi.fn() };

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' } as AuthCredentials,
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions: vi.fn(),
            repairInvalidReadStateV1: async () => {},
            log,
        });

        expect(log.log).not.toHaveBeenCalled();
    });

    it('hydrates runtime activity projection fields into first-usable session-list renderables', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 'runtime-active',
                        encryptionMode: 'plain',
                        metadata: JSON.stringify({ path: '/repo', host: 'host' }),
                        agentState: JSON.stringify({}),
                        runtimeActivityState: 'active',
                        runtimeActivityActiveCount: 1,
                        runtimeActivityObservedAt: 1_000,
                        runtimeActivityRevision: 1,
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );
        const { encryption } = createEncryptionHarness();
        const applySessionListRenderables = vi.fn();

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' } as AuthCredentials,
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions: vi.fn(),
            applySessionListRenderables,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(applySessionListRenderables).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 'runtime-active',
                runtimeActivityActiveCount: 1,
                runtimeActivityState: 'active',
                runtimeActivityObservedAt: 1_000,
                runtimeActivityRevision: 1,
            }),
        ], { replace: true, coversWholeList: true });
    });

    it('hydrates a required changed session when only its runtime activity tuple advanced', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 'runtime-transition',
                        encryptionMode: 'plain',
                        metadata: JSON.stringify({ path: '/repo', host: 'host' }),
                        metadataVersion: 1,
                        agentState: JSON.stringify({}),
                        agentStateVersion: 0,
                        runtimeActivityState: 'idle',
                        runtimeActivityActiveCount: 0,
                        runtimeActivityObservedAt: 2_000,
                        runtimeActivityRevision: 35,
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );
        const { encryption } = createEncryptionHarness();
        const applySessions = vi.fn();
        const existingSession = buildExistingSession({
            id: 'runtime-transition',
            metadata: { path: '/repo', host: 'host' },
            metadataVersion: 1,
            agentState: {},
            agentStateVersion: 0,
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 1_000,
            runtimeActivityRevision: 34,
        });

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' } as AuthCredentials,
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            applySessionListRenderables: vi.fn(),
            getExistingSession: () => existingSession,
            getCurrentSessionListRenderable: () => buildSessionListRenderableFromSession(existingSession),
            requiredHydrationSessionIds: ['runtime-transition'],
            awaitSessionListHydration: true,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 'runtime-transition',
                runtimeActivityState: 'idle',
                runtimeActivityActiveCount: 0,
                runtimeActivityObservedAt: 2_000,
                runtimeActivityRevision: 35,
            }),
        ]);
    });

    it('does not send canonical pinned ids to /v2/sessions and still de-duplicates rows', async () => {
        const priorityRow = buildSessionRow({
            id: 's_pinned_outside_first_page',
            encryptionMode: 'plain',
            metadata: JSON.stringify({ path: '/priority', host: 'host' }),
            agentState: JSON.stringify({}),
        });
        const pageRow = buildSessionRow({
            id: 's_regular_first_page',
            encryptionMode: 'plain',
            metadata: JSON.stringify({ path: '/regular', host: 'host' }),
            agentState: JSON.stringify({}),
        });
        const requestSpy = vi.fn(async (path: string) => {
            if (path === '/v2/sessions?includeAttention=true&limit=50') {
                return jsonResponse({ sessions: [priorityRow, pageRow, priorityRow], nextCursor: null, hasNext: false });
            }
            throw new Error(`Unexpected path ${path}`);
        });

        const { encryption } = createEncryptionHarness();
        const applySessions = vi.fn();
        const applySessionListRenderables = vi.fn();
        const result = await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' } as AuthCredentials,
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            includeSessionListAttentionRows: true,
            applySessions,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(requestSpy.mock.calls.map((call) => call[0])).toEqual([
            '/v2/sessions?includeAttention=true&limit=50',
        ]);
        expect(applySessions.mock.calls[0]?.[0].map((session: { id: string }) => session.id)).toEqual([
            's_pinned_outside_first_page',
            's_regular_first_page',
        ]);
        expect(result.sessionIds).toEqual([
            's_pinned_outside_first_page',
            's_regular_first_page',
        ]);
    });

    it('issues one page request when the server merges the active rows', async () => {
        const requestSpy = vi.fn(async (path: string) => {
            if (path === MERGED_INITIAL_PAGE_PATH) {
                return jsonResponse({
                    includedActive: true,
                    sessions: [
                        buildSessionRow({ id: 's_active', encryptionMode: 'plain' }),
                        buildSessionRow({ id: 's_page', encryptionMode: 'plain' }),
                    ],
                    nextCursor: null,
                    hasNext: false,
                });
            }
            throw new Error(`Unexpected path ${path}`);
        });
        const { encryption } = createEncryptionHarness();

        const result = await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' } as AuthCredentials,
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            includeActiveSessionRows: true,
            includeSessionListAttentionRows: true,
            applySessions: vi.fn(),
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(requestSpy.mock.calls.map((call) => call[0])).toEqual([MERGED_INITIAL_PAGE_PATH]);
        expect(result.sessionIds).toEqual(['s_active', 's_page']);
    });

    it('falls back to the standalone active endpoint when the server does not merge the active rows', async () => {
        const activeRow = buildSessionRow({ id: 's_active', encryptionMode: 'plain' });
        const pageRow = buildSessionRow({ id: 's_page', encryptionMode: 'plain' });
        const requestSpy = vi.fn(async (path: string) => {
            if (path === MERGED_INITIAL_PAGE_PATH) {
                // No `includedActive` marker: an older server silently ignores the query flag.
                return jsonResponse({ sessions: [pageRow, activeRow], nextCursor: null, hasNext: false });
            }
            if (path === '/v2/sessions/active?limit=500') {
                return jsonResponse({ sessions: [activeRow], nextCursor: null, hasNext: false });
            }
            throw new Error(`Unexpected path ${path}`);
        });
        const { encryption } = createEncryptionHarness();

        const result = await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' } as AuthCredentials,
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            includeActiveSessionRows: true,
            includeSessionListAttentionRows: true,
            applySessions: vi.fn(),
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(requestSpy.mock.calls.map((call) => call[0])).toEqual([
            MERGED_INITIAL_PAGE_PATH,
            '/v2/sessions/active?limit=500',
        ]);
        // Pre-merge ordering contract: active rows lead the snapshot and win the de-dupe.
        expect(result.sessionIds).toEqual(['s_active', 's_page']);
    });

    it('attributes active-row and list-page request timings separately on the fallback path', async () => {
        const requestSpy = vi.fn(async (path: string) => {
            if (path === '/v2/sessions/active?limit=500') {
                return jsonResponse({
                    sessions: [buildSessionRow({ id: 's_active', encryptionMode: 'plain' })],
                    nextCursor: null,
                    hasNext: false,
                });
            }
            if (path === MERGED_INITIAL_PAGE_PATH) {
                return jsonResponse({
                    sessions: [buildSessionRow({ id: 's_page', encryptionMode: 'plain' })],
                    nextCursor: null,
                    hasNext: false,
                });
            }
            throw new Error(`Unexpected path ${path}`);
        });
        const { encryption } = createEncryptionHarness();
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' } as AuthCredentials,
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            includeActiveSessionRows: true,
            includeSessionListAttentionRows: true,
            applySessions: vi.fn(),
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(requestSpy.mock.calls.map((call) => call[0])).toEqual([
            MERGED_INITIAL_PAGE_PATH,
            '/v2/sessions/active?limit=500',
        ]);
        const requestEvent = syncPerformanceTelemetry.snapshot().events.find(
            (event) => event.name === 'sync.sessions.snapshot.fetchPage.request',
        );
        expect(requestEvent).toEqual(expect.objectContaining({
            count: 2,
            fields: expect.objectContaining({
                activePage: 1,
                listPage: 1,
                limit: 550,
            }),
        }));
    });

    it('requests server timing only while sync performance telemetry is enabled', async () => {
        const requestSpy = vi.fn<(path: string, init: RequestInit) => Promise<Response>>(async () =>
            jsonResponse({
                sessions: [buildSessionRow({ id: 's_page', encryptionMode: 'plain' })],
                nextCursor: null,
                hasNext: false,
            }),
        );
        const { encryption } = createEncryptionHarness();
        const commonParams = {
            credentials: { token: 't', secret: 's' } as AuthCredentials,
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions: vi.fn(),
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        } satisfies FetchAndApplySessionsParams;

        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();
        await fetchAndApplySessions(commonParams);
        expect(requestSpy.mock.calls[0]?.[1]?.headers).toEqual(expect.objectContaining({
            'X-Happier-Session-List-Timing': '1',
        }));

        requestSpy.mockClear();
        syncPerformanceTelemetry.configure({
            enabled: false,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        await fetchAndApplySessions(commonParams);
        expect(requestSpy.mock.calls[0]?.[1]?.headers).not.toEqual(expect.objectContaining({
            'X-Happier-Session-List-Timing': '1',
        }));
    });

    it('ignores legacy client-supplied pinned ids for hydration priority', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_legacy_pinned',
                        active: false,
                        dataEncryptionKey: 'k-legacy',
                        metadata: 'meta-legacy',
                        metadataVersion: 2,
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );
        const { encryption, decryptMetadata } = createEncryptionHarness();
        const applySessions = vi.fn();
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();
        const legacyPinnedIdsProperty = 'sessionList' + 'PinnedSessionIds';
        const legacyParams = {
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
            [legacyPinnedIdsProperty]: ['s_legacy_pinned'],
            sessionListEagerHydrationCount: 0,
            sessionListBackgroundHydrationMaxRows: 0,
            cachedSessionListEntries: {
                s_legacy_pinned: {
                    sessionId: 's_legacy_pinned',
                    metadataVersion: 1,
                    agentStateVersion: 0,
                    updatedAt: 1,
                    createdAt: 1,
                    active: false,
                    activeAt: 1,
                    archivedAt: null,
                    path: '/legacy',
                },
            } satisfies NonNullable<FetchAndApplySessionsParams['cachedSessionListEntries']>,
            applySessionListRenderables: vi.fn(),
        };

        await fetchAndApplySessions(legacyParams);

        await Promise.resolve();
        expect(decryptMetadata).not.toHaveBeenCalled();
        expect(applySessions).not.toHaveBeenCalled();
        const priorityEvent = syncPerformanceTelemetry.snapshot().events.find(
            (event) => event.name === 'sync.sessions.snapshot.hydrationPriority',
        );
        expect(priorityEvent?.fields).toEqual(expect.objectContaining({
            priority: 0,
            skippedBackground: 1,
        }));
    });

    it('starts encrypted metadata and agent-state row decrypts before awaiting either result', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 'encrypted_1',
                        encryptionMode: 'e2ee',
                        dataEncryptionKey: 'dek',
                        metadata: 'enc-meta',
                        metadataVersion: 2,
                        agentState: 'enc-state',
                        agentStateVersion: 3,
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );
        const { encryption, decryptMetadata, decryptAgentState } = createEncryptionHarness();
        const metadataDeferred = createDeferred<{ readStateV1: null }>();
        const agentStateDeferred = createDeferred<{ controlledByUser: true }>();
        decryptMetadata.mockImplementation(async () => metadataDeferred.promise);
        decryptAgentState.mockImplementation(async () => agentStateDeferred.promise);

        const applySessions = vi.fn();
        const fetchPromise = fetchAndApplySessions({
            credentials: { token: 't', secret: 's' } as AuthCredentials,
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        try {
            await expect.poll(() => ({
                metadata: decryptMetadata.mock.calls.length,
                agentState: decryptAgentState.mock.calls.length,
            }), { timeout: 100 }).toEqual({ metadata: 1, agentState: 1 });
        } finally {
            metadataDeferred.resolve({ readStateV1: null });
            agentStateDeferred.resolve({ controlledByUser: true });
            await fetchPromise;
        }

        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 'encrypted_1',
                metadata: { readStateV1: null },
                agentState: { controlledByUser: true },
            }),
        ]);
    });

    it('records snapshot fetch and hydration telemetry when sync performance telemetry is enabled', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
	                    buildSessionRow({
	                        id: 'plain_1',
	                        encryptionMode: 'plain',
	                        dataEncryptionKey: 'unused-plain-key',
	                        metadata: JSON.stringify({ path: '/plain', host: 'plain-host' }),
	                        agentState: JSON.stringify({}),
	                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }, 200, {
                'Server-Timing': 'happier_v2_sessions_cursor;dur=1.500, happier_v2_sessions_query;dur=2.250, happier_v2_sessions_page;dur=0.750, happier_v2_sessions_total;dur=4.500',
            })
        );
	        const { encryption, decryptEncryptionKey, decryptEncryptionKeys, initializeSessions, getSessionEncryption } = createEncryptionHarness();

        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' } as AuthCredentials,
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions: vi.fn(),
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        const events = syncPerformanceTelemetry.snapshot().events;
        expect(events.some((event) => event.name === 'sync.sessions.snapshot.fetchPage')).toBe(true);
        const fetchPageRequestEvent = events.find((event) => event.name === 'sync.sessions.snapshot.fetchPage.request');
        expect(fetchPageRequestEvent?.fields).toEqual(expect.objectContaining({
            loadedSessions: 0,
            limit: 50,
            cursorPresent: 0,
        }));
        const responseBodyEvent = events.find((event) => event.name === 'sync.sessions.snapshot.fetchPage.responseBody');
        expect(responseBodyEvent?.fields).toEqual(expect.objectContaining({
            loadedSessions: 0,
            limit: 50,
            responseChars: expect.any(Number),
            serverTimingCursorMs: 1.5,
            serverTimingQueryMs: 2.25,
            serverTimingPageMs: 0.75,
            serverTimingTotalMs: 4.5,
        }));
        const responseJsonEvent = events.find((event) => event.name === 'sync.sessions.snapshot.fetchPage.responseJson');
        expect(responseJsonEvent?.fields).toEqual(expect.objectContaining({
            loadedSessions: 0,
            limit: 50,
            responseChars: expect.any(Number),
        }));
        const responseSchemaEvent = events.find((event) => event.name === 'sync.sessions.snapshot.fetchPage.responseSchema');
        expect(responseSchemaEvent?.fields).toEqual(expect.objectContaining({
            loadedSessions: 0,
            limit: 50,
            responseChars: expect.any(Number),
        }));
        const fetchPageProcessEvent = events.find((event) => event.name === 'sync.sessions.snapshot.fetchPage.process');
        expect(fetchPageProcessEvent?.fields).toEqual(expect.objectContaining({
            loadedSessions: 0,
            fetchedSessions: 1,
            totalRows: 1,
            hasNext: 0,
            nextCursorPresent: 0,
            sourceV2: 1,
            sourceV1: 0,
        }));
        expect(events.some((event) => event.name === 'sync.sessions.snapshot.initializeSessions')).toBe(false);
        const decryptRowEvent = events.find((event) => event.name === 'sync.sessions.snapshot.decryptRow');
        expect(decryptRowEvent?.fields.plain).toBe(1);
        expect(events.some((event) => event.name === 'sync.sessions.snapshot.applyHydrated')).toBe(true);
        expect(decryptEncryptionKey).not.toHaveBeenCalled();
        expect(decryptEncryptionKeys).not.toHaveBeenCalled();
        expect(initializeSessions).not.toHaveBeenCalled();
        expect(getSessionEncryption).not.toHaveBeenCalled();
    });

    it('can fetch the archived sessions route without falling back to the regular list', async () => {
        const requestSpy = vi.fn(async (path: string) => {
            expect(path).toBe('/v2/sessions/archived?limit=50');
            return jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 'archived_1',
                        encryptionMode: 'plain',
                        archivedAt: 12,
                        metadata: JSON.stringify({ path: '/archived', host: 'archive-host' }),
                        agentState: JSON.stringify({}),
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            });
        });
        const { encryption } = createEncryptionHarness();
        const applySessions = vi.fn();

        await fetchAndApplySessions({
            sessionListPath: '/v2/sessions/archived',
            credentials: { token: 't', secret: 's' } as AuthCredentials,
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 'archived_1',
                archivedAt: 12,
            }),
        ]);
    });

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
            sessionListMaxPages: 2,
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
        const requestSpy = vi
            .fn(async (path: string) => {
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
            '/v2/sessions?limit=50',
            '/v1/sessions',
        ]);
        expect(appliedSessions).toEqual([
            expect.objectContaining({
                id: 'legacy_list_session',
                encryptionMode: 'plain',
            }),
        ]);
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
            getExistingSession: () => buildExistingSession({
                id: 's1',
                agentState: {
                    requests: {},
                    completedRequests: {},
                },
            }),
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
        let storedSession = buildExistingSession({
            id: 's1',
            agentState: {
                requests: {},
                completedRequests: {},
            },
        });

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
                const [nextSession] = sessions;
                if (!nextSession) throw new Error('expected one hydrated session');
                storedSession = buildExistingSession({
                    ...nextSession,
                    presence: nextSession.presence ?? 'online',
                });
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
	                        dataEncryptionKey: 'unused-plain-key',
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

	        const { encryption, decryptEncryptionKey, decryptEncryptionKeys, initializeSessions, getSessionEncryption, decryptMetadata, decryptAgentState } =
	            createEncryptionHarness();
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
	        expect(decryptEncryptionKey).not.toHaveBeenCalled();
	        expect(decryptEncryptionKeys).not.toHaveBeenCalled();
	        expect(initializeSessions).not.toHaveBeenCalled();
	        expect(getSessionEncryption).not.toHaveBeenCalled();
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

    it('builds plaintext row renderables synchronously equivalent to plain hydration without enqueueing hydration', async () => {
        const plainRow = buildSessionRow({
            id: 's_plain_renderable',
            seq: 7,
            createdAt: 100,
            updatedAt: 500,
            active: true,
            activeAt: 450,
            encryptionMode: 'plain',
            metadata: JSON.stringify({
                name: 'Plain row title',
                summary: { text: 'Plain summary', updatedAt: 490 },
                path: '/work/plain',
                homeDir: '/work',
                host: 'dev-host',
                machineId: 'machine-1',
                flavor: 'codex',
                directSessionV1: { v: 1, providerId: 'codex' },
                readStateV1: { v: 1, sessionSeq: 3, pendingActivityAt: 0, updatedAt: 480 },
            }),
            metadataVersion: 3,
            agentState: JSON.stringify({
                requests: {
                    req_user_action: {
                        tool: 'AskUserQuestion',
                        arguments: { question: 'Choose one' },
                        createdAt: 470,
                    },
                },
                completedRequests: {},
            }),
            agentStateVersion: 4,
            latestReadyEventSeq: 6,
            latestReadyEventAt: 490,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 495,
        });

        const renderableRequest = vi.fn(async () =>
            jsonResponse({ sessions: [plainRow], nextCursor: null, hasNext: false }),
        );
        const hydratedRequest = vi.fn(async () =>
            jsonResponse({ sessions: [plainRow], nextCursor: null, hasNext: false }),
        );
        const { encryption } = createEncryptionHarness();
        const currentRenderables: Record<string, SessionListRenderableSession> = {};
        const renderableApplySessions = vi.fn();
        const applySessionListRenderables = vi.fn((renderables: SessionListRenderableSession[]) => {
            for (const renderable of renderables) {
                currentRenderables[renderable.id] = renderable;
            }
        });

        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: renderableRequest,
            applySessions: renderableApplySessions,
            applySessionListRenderables,
            getCurrentSessionListRenderable: (sessionId) => currentRenderables[sessionId] ?? null,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
            sessionListBackgroundHydrationMaxRows: 0,
        });

        const hydratedSessions: Session[] = [];
        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: hydratedRequest,
            applySessions: (sessions) => {
                hydratedSessions.push(...(sessions as Session[]));
            },
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        const syncRenderable = currentRenderables.s_plain_renderable;
        const hydratedRenderable = buildSessionListRenderableFromSession(hydratedSessions[0]!);
        expect(syncRenderable).toEqual(hydratedRenderable);
        expect(syncRenderable).toEqual(expect.objectContaining({
            metadata: expect.objectContaining({
                name: 'Plain row title',
                summaryText: 'Plain summary',
                path: '/work/plain',
                host: 'dev-host',
            }),
            hasPendingUserActionRequests: true,
        }));
        expect(renderableApplySessions).not.toHaveBeenCalled();
        const hydrationCandidatesEvent = syncPerformanceTelemetry.snapshot().events.find(
            (event) => event.name === 'sync.sessions.snapshot.hydrationCandidates',
        );
        expect(hydrationCandidatesEvent?.fields).toEqual(expect.objectContaining({
            candidateRows: 0,
            alreadyWarmRows: 1,
        }));
    });

    it('reuses current plaintext renderable metadata when the row version is unchanged and parsing would fail', async () => {
        const plainRow = buildSessionRow({
            id: 's_plain_current_cache',
            seq: 7,
            createdAt: 100,
            updatedAt: 500,
            active: true,
            activeAt: 450,
            encryptionMode: 'plain',
            metadata: '{broken-json',
            metadataVersion: 3,
            agentState: JSON.stringify({}),
            agentStateVersion: 4,
        });
        const currentRenderable: SessionListRenderableSession = {
            id: 's_plain_current_cache',
            seq: 7,
            createdAt: 100,
            updatedAt: 500,
            active: true,
            activeAt: 450,
            metadataVersion: 3,
            agentStateVersion: 4,
            metadata: {
                name: 'Cached current title',
                path: '/work/current',
                host: 'current-host',
            },
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: false,
        };
        const currentRenderables: Record<string, SessionListRenderableSession> = {
            s_plain_current_cache: currentRenderable,
        };
        const requestSpy = vi.fn(async () =>
            jsonResponse({ sessions: [plainRow], nextCursor: null, hasNext: false }),
        );
        const { encryption } = createEncryptionHarness();
        const applySessions = vi.fn();
        const applySessionListRenderables = vi.fn((renderables: SessionListRenderableSession[]) => {
            for (const renderable of renderables) {
                currentRenderables[renderable.id] = renderable;
            }
        });

        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            applySessionListRenderables,
            getCurrentSessionListRenderable: (sessionId) => currentRenderables[sessionId] ?? null,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
            sessionListBackgroundHydrationMaxRows: 0,
        });

        expect(currentRenderables.s_plain_current_cache?.metadata).toEqual(expect.objectContaining({
            name: 'Cached current title',
            path: '/work/current',
            host: 'current-host',
        }));
        expect(applySessions).not.toHaveBeenCalled();
        const hydrationCandidatesEvent = syncPerformanceTelemetry.snapshot().events.find(
            (event) => event.name === 'sync.sessions.snapshot.hydrationCandidates',
        );
        expect(hydrationCandidatesEvent?.fields).toEqual(expect.objectContaining({
            candidateRows: 0,
            alreadyWarmRows: 1,
        }));
    });

    it('projects canonical readable activity into first-usable session list renderables', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_read',
                        seq: 4,
                        lastViewedSessionSeq: 4,
                        encryptionMode: 'plain',
                        metadata: JSON.stringify({ path: '/repo/read', host: 'dev' }),
                        agentState: JSON.stringify({}),
                    }),
                    buildSessionRow({
                        id: 's_unread',
                        seq: 5,
                        lastViewedSessionSeq: 4,
                        latestTurnStatus: 'completed',
                        latestTurnStatusObservedAt: 2_000,
                        encryptionMode: 'plain',
                        metadata: JSON.stringify({ path: '/repo/unread', host: 'dev' }),
                        agentState: JSON.stringify({}),
                    }),
                    buildSessionRow({
                        id: 's_non_displayable_tail',
                        seq: 6,
                        lastViewedSessionSeq: 5,
                        latestTurnStatus: 'in_progress',
                        encryptionMode: 'plain',
                        metadata: JSON.stringify({ path: '/repo/read-tail', host: 'dev' }),
                        agentState: JSON.stringify({}),
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption } = createEncryptionHarness();
        const applySessionListRenderables = vi.fn();

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions: () => {},
            applySessionListRenderables,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(applySessionListRenderables).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's_read',
                lastViewedSessionSeq: 4,
                hasUnreadMessages: false,
            }),
            expect.objectContaining({
                id: 's_unread',
                lastViewedSessionSeq: 4,
                hasUnreadMessages: true,
            }),
            expect.objectContaining({
                id: 's_non_displayable_tail',
                lastViewedSessionSeq: 5,
                hasUnreadMessages: false,
            }),
        ], { replace: true, coversWholeList: true });
    });

    it('preserves existing ready metadata when v2 list rows have no readable seq projection', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_ready_existing',
                        seq: 946,
                        lastViewedSessionSeq: 945,
                        latestTurnStatus: 'in_progress',
                        encryptionMode: 'plain',
                        metadata: JSON.stringify({ path: '/repo/ready', host: 'dev' }),
                        agentState: JSON.stringify({}),
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption } = createEncryptionHarness();
        const applySessionListRenderables = vi.fn();

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions: () => {},
            applySessionListRenderables,
            getExistingSession: (sessionId) => sessionId === 's_ready_existing'
                ? buildExistingSession({
                    id: sessionId,
                    seq: 946,
                    lastViewedSessionSeq: 945,
                    latestReadyEventSeq: 946,
                    latestReadyEventAt: 2_000,
                    latestTurnStatus: 'in_progress',
                } as Partial<Session> & { id: string })
                : null,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(applySessionListRenderables).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's_ready_existing',
                latestReadyEventSeq: 946,
                latestReadyEventAt: 2_000,
                hasUnreadMessages: true,
            }),
        ], { replace: true, coversWholeList: true });
    });

    it('uses server row attention projection fields when building first-usable renderables and hydrated sessions', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_row_projection',
                        seq: 10,
                        lastViewedSessionSeq: 8,
                        active: true,
                        activeAt: 1_000,
                        thinking: true,
                        thinkingAt: 2_000,
                        pendingPermissionRequestCount: 1,
                        pendingUserActionRequestCount: 0,
                        pendingRequestObservedAt: 2_100,
                        latestReadyEventSeq: 9,
                        latestReadyEventAt: 2_200,
                        latestTurnStatus: 'in_progress',
                        latestTurnStatusObservedAt: 1_900,
                        runtimeActivityState: 'unknown',
                        runtimeActivityActiveCount: 0,
                        runtimeActivityObservedAt: null,
                        runtimeActivityRevision: 0,
                        encryptionMode: 'plain',
                        metadata: JSON.stringify({ path: '/repo/projected', host: 'dev' }),
                        agentState: JSON.stringify({}),
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
            requiredHydrationSessionIds: ['s_row_projection'],
            awaitSessionListHydration: true,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(applySessionListRenderables).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's_row_projection',
                thinking: true,
                thinkingAt: 2_000,
                pendingRequestObservedAt: 2_100,
                latestReadyEventSeq: 9,
                latestReadyEventAt: 2_200,
                hasPendingPermissionRequests: true,
                hasUnreadMessages: true,
            }),
        ], { replace: true, coversWholeList: true });
        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's_row_projection',
                thinking: true,
                thinkingAt: 2_000,
                pendingRequestObservedAt: 2_100,
                latestReadyEventSeq: 9,
                latestReadyEventAt: 2_200,
            }),
        ]);
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

    it('prefers canonical session metadata over matching warm cache while reusing cached agent-state flags', async () => {
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
            } satisfies NonNullable<FetchAndApplySessionsParams['cachedSessionListEntries']>,
            applySessionListRenderables,
            getExistingSession: () => buildExistingSession({
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
        });

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
                    name: 'Hydrated title',
                    summaryText: null,
                    path: '/home/u/repo',
                    homeDir: null,
                    host: 'mbp',
                    machineId: 'm1',
                    flavor: null,
                    directSessionV1: null,
                    hiddenSystemSession: false,
                }),
                hasPendingUserActionRequests: true,
            }),
        ], { replace: true, coversWholeList: true });
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
        ], { replace: true, coversWholeList: true });
        await expect.poll(() => decryptMetadata.mock.calls.length).toBe(1);
        expect(decryptAgentState).toHaveBeenCalledTimes(1);
        await expect.poll(() => applySessions.mock.calls.length).toBe(1);
        expect(applySessions.mock.calls[0]?.[0]).toEqual([
            expect.objectContaining({
                id: 's_cached',
                metadataVersion: 7,
                agentStateVersion: 9,
            }),
        ]);
    });

    it('skips non-required background hydration when the current row renderable is already complete and current', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_current_renderable',
                        seq: 11,
                        updatedAt: 30,
                        metadata: 'encrypted-meta-current',
                        metadataVersion: 7,
                        agentState: 'encrypted-agent-current',
                        agentStateVersion: 9,
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption, decryptMetadata, decryptAgentState } = createEncryptionHarness();
        const applySessions = vi.fn();
        const currentRenderable = buildSessionListRenderableFromSession(buildExistingSession({
            id: 's_current_renderable',
            seq: 11,
            createdAt: 1,
            updatedAt: 30,
            active: true,
            activeAt: 1,
            archivedAt: null,
            metadata: { name: 'Current renderable title', path: '/home/u/current', host: 'localhost' },
            metadataVersion: 7,
            agentState: {
                kind: 'agent_state',
                hasPendingPermissionRequests: false,
                hasPendingUserActionRequests: true,
            },
            agentStateVersion: 9,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        }));

        const sessionListBackgroundHydrationYield = vi.fn(async () => {});

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            applySessionListRenderables: vi.fn(),
            getExistingSession: () => null,
            getCurrentSessionListRenderable: (sessionId) => (
                sessionId === 's_current_renderable' ? currentRenderable : null
            ),
            cachedSessionListEntries: {},
            sessionListBackgroundHydrationYield,
            awaitSessionListHydration: true,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(sessionListBackgroundHydrationYield).not.toHaveBeenCalled();
        expect(decryptMetadata).not.toHaveBeenCalled();
        expect(decryptAgentState).not.toHaveBeenCalled();
        expect(applySessions).not.toHaveBeenCalled();
    });

    it('uses stale warm cache metadata for the first render while hydrating the newer row', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_stale_cache',
                        dataEncryptionKey: 'k-stale-cache',
                        metadata: 'encrypted-meta-v8',
                        metadataVersion: 8,
                        agentState: null,
                        agentStateVersion: 0,
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption, decryptMetadata } = createEncryptionHarness();
        decryptMetadata.mockImplementation(async () => new Promise<never>(() => {}));
        const applySessionListRenderables = vi.fn();
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions: vi.fn(),
            applySessionListRenderables,
            getExistingSession: () => null,
            cachedSessionListEntries: {
                s_stale_cache: {
                    sessionId: 's_stale_cache',
                    metadataVersion: 7,
                    agentStateVersion: 0,
                    updatedAt: 30,
                    createdAt: 10,
                    active: true,
                    activeAt: 30,
                    archivedAt: null,
                    pendingCount: 0,
                    pendingVersion: 0,
                    accessLevel: 'admin',
                    canApprovePermissions: true,
                    name: 'Cached stale title',
                    summaryText: 'Cached stale summary',
                    path: '/home/u/stale',
                    homeDir: '/home/u',
                    host: 'stale-host',
                    machineId: 'stale-machine',
                    flavor: 'claude',
                    directSessionV1: null,
                    hiddenSystemSession: false,
                    hasPendingPermissionRequests: false,
                    hasPendingUserActionRequests: false,
                },
            } satisfies NonNullable<FetchAndApplySessionsParams['cachedSessionListEntries']>,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(applySessionListRenderables).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's_stale_cache',
                metadataVersion: 7,
                metadata: expect.objectContaining({
                    name: 'Cached stale title',
                    summaryText: 'Cached stale summary',
                    path: '/home/u/stale',
                    homeDir: '/home/u',
                    host: 'stale-host',
                    machineId: 'stale-machine',
                    flavor: 'claude',
                    directSessionV1: null,
                    hiddenSystemSession: false,
                }),
            }),
        ], { replace: true, coversWholeList: true });
        const firstUsableEvent = syncPerformanceTelemetry.snapshot().events.find((event) =>
            event.name === 'sync.sessions.snapshot.firstUsableList',
        );
        expect(firstUsableEvent?.fields).toEqual(expect.objectContaining({
            staleMetadataPreserved: 1,
            staleWarmCacheMetadataRows: 1,
        }));
        await expect.poll(() => decryptMetadata.mock.calls.map((call) => call[1])).toEqual(['encrypted-meta-v8']);
    });

    it('uses matching canonical session metadata while hydrating missing agent state when warm cache is missing', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_existing',
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
            getExistingSession: () => buildExistingSession({
                id: 's_existing',
                seq: 1,
                createdAt: 10,
                updatedAt: 30,
                active: true,
                activeAt: 30,
                metadata: {
                    path: '/home/u/repo',
                    homeDir: '/home/u',
                    host: 'mbp',
                    machineId: 'm1',
                    name: 'Canonical title',
                    summary: { text: 'Canonical summary', updatedAt: 30 },
                    flavor: 'codex',
                },
                metadataVersion: 7,
                agentState: null,
                agentStateVersion: 9,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            }),
            cachedSessionListEntries: {},
            awaitSessionListHydration: true,
            requiredHydrationSessionIds: ['s_existing'],
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(applySessionListRenderables).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's_existing',
                metadataVersion: 7,
                agentStateVersion: 9,
                metadata: expect.objectContaining({
                    name: 'Canonical title',
                    summaryText: 'Canonical summary',
                    path: '/home/u/repo',
                    homeDir: '/home/u',
                    host: 'mbp',
                    machineId: 'm1',
                    flavor: 'codex',
                }),
            }),
        ], { replace: true, coversWholeList: true });
        expect(decryptMetadata).toHaveBeenCalledWith(7, 'encrypted-meta');
        expect(decryptAgentState).toHaveBeenCalledWith(9, 'encrypted-state');
        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's_existing',
                metadataVersion: 7,
                agentStateVersion: 9,
                metadata: expect.objectContaining({ decrypted: 'encrypted-meta' }),
            }),
        ]);
    });

    it('hydrates version-zero encrypted metadata when the existing session has no metadata', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_zero_metadata',
                        dataEncryptionKey: 'k-zero',
                        metadata: 'encrypted-zero-meta',
                        metadataVersion: 0,
                        agentState: null,
                        agentStateVersion: 0,
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption, decryptMetadata } = createEncryptionHarness();
        const applySessions = vi.fn();
        const applySessionListRenderables = vi.fn();

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            applySessionListRenderables,
            getExistingSession: () => buildExistingSession({
                id: 's_zero_metadata',
                metadata: null,
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 0,
            }),
            cachedSessionListEntries: {},
            awaitSessionListHydration: true,
            requiredHydrationSessionIds: ['s_zero_metadata'],
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(applySessionListRenderables).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's_zero_metadata',
                metadataVersion: 0,
                metadata: null,
            }),
        ], { replace: true, coversWholeList: true });
        expect(decryptMetadata).toHaveBeenCalledWith(0, 'encrypted-zero-meta');
        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's_zero_metadata',
                metadataVersion: 0,
                metadata: expect.objectContaining({ decrypted: 'encrypted-zero-meta' }),
            }),
        ]);
    });

    it('marks non-required encrypted metadata unavailable after hydration attempts fail without stale metadata', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_unavailable_metadata',
                        dataEncryptionKey: 'k-unavailable',
                        metadata: 'encrypted-unavailable-meta',
                        metadataVersion: 3,
                        agentState: null,
                        agentStateVersion: 0,
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption, decryptMetadata } = createEncryptionHarness();
        decryptMetadata.mockResolvedValue(null);
        const applySessions = vi.fn();
        let currentRenderables: Record<string, SessionListRenderableSession> = {};
        const applySessionListRenderables = vi.fn((sessions: SessionListRenderableSession[]) => {
            currentRenderables = Object.fromEntries(sessions.map((session) => [session.id, session]));
        });
        const applySessionListRenderablePatches = vi.fn((patches: readonly {
            sessionId: string;
            patch: Partial<SessionListRenderableSession> & { metadataUnavailable?: boolean };
        }[]) => {
            for (const { sessionId, patch } of patches) {
                currentRenderables[sessionId] = {
                    ...currentRenderables[sessionId],
                    ...patch,
                } as SessionListRenderableSession;
            }
        });

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            applySessionListRenderables,
            applySessionListRenderablePatches,
            getCurrentSessionListRenderable: (sessionId) => currentRenderables[sessionId],
            cachedSessionListEntries: {},
            awaitSessionListHydration: true,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        await expect.poll(() => currentRenderables.s_unavailable_metadata?.metadataUnavailable).toBe(true);
        expect(decryptMetadata).toHaveBeenCalledWith(3, 'encrypted-unavailable-meta');
        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's_unavailable_metadata',
                metadata: null,
            }),
        ]);
        expect(applySessionListRenderablePatches).toHaveBeenCalledWith([
            expect.objectContaining({
                sessionId: 's_unavailable_metadata',
                patch: expect.objectContaining({ metadataUnavailable: true }),
            }),
        ]);
    });

    it.each([false, true])('rejects required-row hydration when its encrypted data key is unavailable (stale plaintext: %s)', async (withStalePlaintext) => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_missing_data_key',
                        dataEncryptionKey: null,
                        metadata: 'encrypted-missing-key-meta',
                        metadataVersion: 3,
                        agentState: null,
                        agentStateVersion: 0,
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption, getSessionEncryption, decryptMetadata } = createEncryptionHarness();
        getSessionEncryption.mockReturnValue(null);
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const applySessions = vi.fn();
        const applySessionListRenderables = vi.fn();

        await expect(fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            applySessionListRenderables,
            awaitSessionListHydration: true,
            requiredHydrationSessionIds: ['s_missing_data_key'],
            getExistingSession: withStalePlaintext ? () => buildExistingSession({
                id: 's_missing_data_key',
                metadata: { path: '/stale', host: 'host' },
                metadataVersion: 2,
                agentStateVersion: 0,
            }) : undefined,
            cachedSessionListEntries: {},
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        })).rejects.toThrow(/required.*hydration/i);

        expect(applySessionListRenderables).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's_missing_data_key',
                metadata: null,
            }),
        ], { replace: true, coversWholeList: true });
        expect(getSessionEncryption).toHaveBeenCalledWith('s_missing_data_key');
        expect(decryptMetadata).not.toHaveBeenCalled();
        expect(applySessions).not.toHaveBeenCalled();
        expect(consoleError).not.toHaveBeenCalled();
    });

    it('preserves stale non-required metadata instead of marking unavailable when failed hydration has safe metadata', async () => {
        const previousMetadata = {
            path: '/known/repo',
            homeDir: '/known',
            host: 'known-host',
            machineId: 'known-machine',
            flavor: 'codex',
        };
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_stale_metadata',
                        dataEncryptionKey: 'k-stale',
                        metadata: 'encrypted-stale-meta',
                        metadataVersion: 5,
                        agentState: null,
                        agentStateVersion: 0,
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption, decryptMetadata } = createEncryptionHarness();
        decryptMetadata.mockResolvedValue(null);
        const applySessions = vi.fn();
        let currentRenderables: Record<string, SessionListRenderableSession> = {
            s_stale_metadata: {
                id: 's_stale_metadata',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadata: previousMetadata,
                metadataVersion: 4,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            },
        };
        const applySessionListRenderables = vi.fn((sessions: SessionListRenderableSession[]) => {
            currentRenderables = Object.fromEntries(sessions.map((session) => {
                const previous = currentRenderables[session.id];
                return [session.id, preserveSessionListRenderableStaleFields(previous, session)];
            }));
        });
        const applySessionListRenderablePatches = vi.fn();

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            applySessionListRenderables,
            applySessionListRenderablePatches,
            getCurrentSessionListRenderable: (sessionId) => currentRenderables[sessionId],
            cachedSessionListEntries: {},
            awaitSessionListHydration: true,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        await expect.poll(() => applySessionListRenderablePatches.mock.calls.length).toBe(1);
        expect(decryptMetadata).toHaveBeenCalledWith(5, 'encrypted-stale-meta');
        expect(applySessionListRenderablePatches).toHaveBeenCalledWith([
            expect.objectContaining({
                sessionId: 's_stale_metadata',
                patch: expect.objectContaining({
                    metadata: previousMetadata,
                    metadataVersion: 4,
                    metadataUnavailable: false,
                }),
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
            } satisfies NonNullable<FetchAndApplySessionsParams['cachedSessionListEntries']>,
            applySessionListRenderables: vi.fn(),
        });

        await expect.poll(() => decryptMetadata.mock.calls.length).toBe(3);
        expect(decryptMetadata.mock.calls.map((call) => call[1])).toEqual([
            'meta-priority',
            'meta-oldest',
            'meta-next',
        ]);
        await expect.poll(() => applySessions.mock.calls.flatMap((call) => call[0].map((session: { id: string }) => session.id))).toEqual([
            's_priority',
            's_oldest',
            's_next',
        ]);
    });

    it('hydrates pinned priority rows even when eager and background hydration are disabled', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({ id: 's_pinned', active: false, dataEncryptionKey: 'k-pinned', metadata: 'meta-pinned', metadataVersion: 2 }),
                    buildSessionRow({ id: 's_background', active: false, dataEncryptionKey: 'k-background', metadata: 'meta-background', metadataVersion: 2 }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );
        const staleCacheEntry = (sessionId: string, path: string) => ({
            sessionId,
            metadataVersion: 1,
            agentStateVersion: 0,
            updatedAt: 1,
            createdAt: 1,
            active: false,
            activeAt: 1,
            archivedAt: null,
            path,
        });
        const { encryption, decryptMetadata } = createEncryptionHarness();
        const applySessions = vi.fn();
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
            priorityHydrationSessionIds: ['s_pinned'],
            sessionListEagerHydrationCount: 0,
            sessionListBackgroundHydrationMaxRows: 0,
            cachedSessionListEntries: {
                s_pinned: staleCacheEntry('s_pinned', '/pinned'),
                s_background: staleCacheEntry('s_background', '/background'),
            } satisfies NonNullable<FetchAndApplySessionsParams['cachedSessionListEntries']>,
            applySessionListRenderables: vi.fn(),
        });

        await expect.poll(() => decryptMetadata.mock.calls.map((call) => call[1])).toEqual(['meta-pinned']);
        await expect.poll(() =>
            applySessions.mock.calls.flatMap((call) => call[0].map((session: { id: string }) => session.id)),
        ).toEqual(['s_pinned']);
        const priorityEvent = syncPerformanceTelemetry.snapshot().events.find(
            (event) => event.name === 'sync.sessions.snapshot.hydrationPriority',
        );
        expect(priorityEvent?.fields).toEqual(expect.objectContaining({
            priority: 1,
            eager: 0,
            background: 0,
            skippedBackground: 1,
        }));
    });

    it('hydrates required current active and eager rows before background rows', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({ id: 's_eager', active: false, activeAt: 5, dataEncryptionKey: 'k-eager', metadata: 'meta-eager', metadataVersion: 2 }),
                    buildSessionRow({ id: 's_background', active: false, activeAt: 4, dataEncryptionKey: 'k-background', metadata: 'meta-background', metadataVersion: 2 }),
                    buildSessionRow({ id: 's_required', active: false, activeAt: 3, dataEncryptionKey: 'k-required', metadata: 'meta-required', metadataVersion: 2 }),
                    buildSessionRow({ id: 's_active', active: true, activeAt: 6, dataEncryptionKey: 'k-active', metadata: 'meta-active', metadataVersion: 2 }),
                    buildSessionRow({ id: 's_current', active: false, activeAt: 7, dataEncryptionKey: 'k-current', metadata: 'meta-current', metadataVersion: 2 }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );
        const staleCacheEntry = (sessionId: string, path: string) => ({
            sessionId,
            metadataVersion: 1,
            agentStateVersion: 0,
            updatedAt: 1,
            createdAt: 1,
            active: false,
            activeAt: 1,
            archivedAt: null,
            path,
        });

        const { encryption, decryptMetadata } = createEncryptionHarness();
        const applySessions = vi.fn();
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
            prioritizeSessionIds: ['s_current'],
            requiredHydrationSessionIds: ['s_required'],
            sessionListEagerHydrationCount: 1,
            sessionListBackgroundHydrationConcurrencyLimit: 1,
            cachedSessionListEntries: {
                s_eager: staleCacheEntry('s_eager', '/eager'),
                s_background: staleCacheEntry('s_background', '/background'),
                s_required: staleCacheEntry('s_required', '/required'),
                s_active: staleCacheEntry('s_active', '/active'),
                s_current: staleCacheEntry('s_current', '/current'),
            } satisfies NonNullable<FetchAndApplySessionsParams['cachedSessionListEntries']>,
            applySessionListRenderables: vi.fn(),
        });

        await expect.poll(() => decryptMetadata.mock.calls.length).toBe(5);
        expect(decryptMetadata.mock.calls.map((call) => call[1])).toEqual([
            'meta-required',
            'meta-current',
            'meta-active',
            'meta-eager',
            'meta-background',
        ]);
        await expect.poll(() => applySessions.mock.calls.flatMap((call) => call[0].map((session: { id: string }) => session.id))).toEqual([
            's_required',
            's_current',
            's_active',
            's_eager',
            's_background',
        ]);

        const priorityEvent = syncPerformanceTelemetry.snapshot().events.find(
            (event) => event.name === 'sync.sessions.snapshot.hydrationPriority',
        );
        expect(priorityEvent?.fields).toEqual(expect.objectContaining({
            required: 1,
            route: 1,
            active: 1,
            eager: 1,
            background: 1,
        }));
    });

    it('does not treat non-awaited required ids as unbounded hydration work', async () => {
        const rows = Array.from({ length: 6 }, (_, index) =>
            buildSessionRow({
                id: `s_nonblocking_required_${index + 1}`,
                active: false,
                dataEncryptionKey: `k-required-${index + 1}`,
                metadata: `meta-required-${index + 1}`,
                metadataVersion: 2,
            }));
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: rows,
                nextCursor: null,
                hasNext: false,
            }),
        );
        const staleCacheEntries = Object.fromEntries(rows.map((row) => [
            row.id,
            {
                sessionId: row.id,
                metadataVersion: 1,
                agentStateVersion: 0,
                updatedAt: 1,
                createdAt: 1,
                active: false,
                activeAt: 1,
                archivedAt: null,
                path: `/cached/${row.id}`,
            },
        ]));
        const { encryption, decryptMetadata } = createEncryptionHarness();
        const applySessions = vi.fn();
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
            requiredHydrationSessionIds: rows.map((row) => row.id),
            awaitSessionListHydration: false,
            sessionListEagerHydrationCount: 0,
            sessionListBackgroundHydrationMaxRows: 0,
            cachedSessionListEntries: staleCacheEntries satisfies NonNullable<FetchAndApplySessionsParams['cachedSessionListEntries']>,
            applySessionListRenderables: vi.fn(),
        });

        await Promise.resolve();
        expect(decryptMetadata).not.toHaveBeenCalled();
        expect(applySessions).not.toHaveBeenCalled();
        const priorityEvent = syncPerformanceTelemetry.snapshot().events.find(
            (event) => event.name === 'sync.sessions.snapshot.hydrationPriority',
        );
        expect(priorityEvent?.fields).toEqual(expect.objectContaining({
            required: 0,
            eager: 0,
            background: 0,
            skippedBackground: rows.length,
        }));
    });

    it('records hydration candidate attribution after required and warm-row filtering', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_required_candidate',
                        encryptionMode: 'plain',
                        metadata: JSON.stringify({ path: '/required' }),
                        agentState: JSON.stringify({}),
                    }),
                    buildSessionRow({
                        id: 's_warm_current',
                        encryptionMode: 'plain',
                        metadata: JSON.stringify({ path: '/warm' }),
                        agentState: JSON.stringify({}),
                    }),
                    buildSessionRow({
                        id: 's_background_candidate',
                        encryptionMode: 'plain',
                        metadata: JSON.stringify({ path: '/background' }),
                        agentState: JSON.stringify({}),
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );
        const { encryption } = createEncryptionHarness();
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions: vi.fn(),
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
            requiredHydrationSessionIds: ['s_required_candidate', 's_missing_required', 's_required_candidate'],
            awaitSessionListHydration: true,
            sessionListEagerHydrationCount: 0,
            sessionListBackgroundHydrationMaxRows: 0,
            getExistingSession: (sessionId) => sessionId === 's_warm_current'
                ? buildExistingSession({
                    id: sessionId,
                    metadataVersion: 1,
                    metadata: { path: '/warm', host: 'host' },
                    agentStateVersion: 0,
                    agentState: null,
                })
                : null,
            applySessionListRenderables: vi.fn(),
        });

        const candidateEvent = syncPerformanceTelemetry.snapshot().events.find(
            (event) => event.name === 'sync.sessions.snapshot.hydrationCandidates',
        );
        expect(candidateEvent?.fields).toEqual(expect.objectContaining({
            totalRows: 3,
            requiredIds: 2,
            requiredRows: 1,
            missingRequiredRows: 1,
            candidateRows: 2,
            requiredCandidateRows: 1,
            backgroundCandidateRows: 1,
            alreadyWarmRows: 1,
            requiredAlreadyWarmRows: 0,
            missingDataKeyRows: 0,
        }));
        expect(JSON.stringify(candidateEvent)).not.toContain('s_required_candidate');
    });

    it('coalesces awaited required hydration rows into one store apply flush', async () => {
        const rows = [
            buildSessionRow({ id: 'required_a', active: false, activeAt: 3, metadata: 'meta-required-a' }),
            buildSessionRow({ id: 'required_b', active: false, activeAt: 2, metadata: 'meta-required-b' }),
            buildSessionRow({ id: 'required_c', active: false, activeAt: 1, metadata: 'meta-required-c' }),
        ];
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: rows,
                nextCursor: null,
                hasNext: false,
            }),
        );
        const { encryption } = createEncryptionHarness();
        const applySessions = vi.fn();
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        try {
            await fetchAndApplySessions({
                credentials: { token: 't', secret: 's' },
                encryption,
                sessionDataKeys: new Map<string, Uint8Array>(),
                request: requestSpy,
                applySessions,
                repairInvalidReadStateV1: async () => {},
                log: { log: () => {} },
                requiredHydrationSessionIds: rows.map((row) => row.id),
                awaitSessionListHydration: true,
                sessionListEagerHydrationCount: 0,
                sessionListBackgroundHydrationConcurrencyLimit: 1,
                sessionListBackgroundHydrationApplyBatchSize: 10,
                sessionListBackgroundHydrationApplyFlushDelayMs: 60_000,
                applySessionListRenderables: vi.fn(),
            });

            expect(applySessions).toHaveBeenCalledTimes(1);
            expect(applySessions.mock.calls[0]?.[0].map((session: { id: string }) => session.id)).toEqual([
                'required_a',
                'required_b',
                'required_c',
            ]);

            const flushEvent = syncPerformanceTelemetry.snapshot().events.find(
                (event) => event.name === 'sync.sessions.snapshot.hydrationApply.flush',
            );
            expect(flushEvent?.count).toBe(1);
            expect(flushEvent?.fields).toEqual(expect.objectContaining({
                sessions: 3,
                requiredRows: 3,
                byRequired: 1,
            }));
        } finally {
            syncPerformanceTelemetry.configure({ enabled: false });
            syncPerformanceTelemetry.reset();
        }
    });

    it('waits for the background hydration gate before eager rows while allowing required route active and priority rows', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({ id: 's_eager', active: false, activeAt: 5, dataEncryptionKey: 'k-eager', metadata: 'meta-eager', metadataVersion: 2 }),
                    buildSessionRow({ id: 's_priority', active: false, activeAt: 4, dataEncryptionKey: 'k-priority', metadata: 'meta-priority', metadataVersion: 2, pendingUserActionRequestCount: 1 }),
                    buildSessionRow({ id: 's_background', active: false, activeAt: 3, dataEncryptionKey: 'k-background', metadata: 'meta-background', metadataVersion: 2 }),
                    buildSessionRow({ id: 's_required', active: false, activeAt: 2, dataEncryptionKey: 'k-required', metadata: 'meta-required', metadataVersion: 2 }),
                    buildSessionRow({ id: 's_route', active: false, activeAt: 1, dataEncryptionKey: 'k-route', metadata: 'meta-route', metadataVersion: 2 }),
                    buildSessionRow({ id: 's_active_surface', active: false, activeAt: 6, dataEncryptionKey: 'k-active-surface', metadata: 'meta-active-surface', metadataVersion: 2 }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );
        const staleCacheEntry = (sessionId: string, path: string) => ({
            sessionId,
            metadataVersion: 1,
            agentStateVersion: 0,
            updatedAt: 1,
            createdAt: 1,
            active: false,
            activeAt: 1,
            archivedAt: null,
            path,
        });

        const { encryption, decryptMetadata } = createEncryptionHarness();
        const applySessions = vi.fn();
        const gate = createDeferred<void>();
        let gateOpen = false;
        const sessionListBackgroundHydrationGate = vi.fn(() => (gateOpen ? Promise.resolve() : gate.promise));
        const params: FetchAndApplySessionsParams = {
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
            prioritizeSessionIds: ['s_route'],
            activeSessionIds: ['s_active_surface'],
            requiredHydrationSessionIds: ['s_required'],
            sessionListEagerHydrationCount: 1,
            sessionListBackgroundHydrationConcurrencyLimit: 1,
            sessionListBackgroundHydrationYield: async () => {},
            sessionListBackgroundHydrationGate,
            cachedSessionListEntries: {
                s_eager: staleCacheEntry('s_eager', '/eager'),
                s_priority: staleCacheEntry('s_priority', '/priority'),
                s_background: staleCacheEntry('s_background', '/background'),
                s_required: staleCacheEntry('s_required', '/required'),
                s_route: staleCacheEntry('s_route', '/route'),
                s_active_surface: staleCacheEntry('s_active_surface', '/active-surface'),
            } satisfies NonNullable<FetchAndApplySessionsParams['cachedSessionListEntries']>,
            applySessionListRenderables: vi.fn(),
        };

        await fetchAndApplySessions(params);

        await expect.poll(() => decryptMetadata.mock.calls.map((call) => call[1])).toEqual([
            'meta-required',
            'meta-route',
            'meta-active-surface',
            'meta-priority',
        ]);
        expect(sessionListBackgroundHydrationGate).toHaveBeenCalledTimes(1);
        expect(applySessions.mock.calls.flatMap((call) => call[0].map((session: { id: string }) => session.id))).toEqual([
            's_required',
            's_route',
            's_active_surface',
            's_priority',
        ]);

        gateOpen = true;
        gate.resolve();
        await expect.poll(() => decryptMetadata.mock.calls.map((call) => call[1])).toEqual([
            'meta-required',
            'meta-route',
            'meta-active-surface',
            'meta-priority',
            'meta-eager',
            'meta-background',
        ]);
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

        const { encryption, decryptEncryptionKeys, decryptMetadata, decryptAgentState } = createEncryptionHarness();
        let resolveDataKeys!: (value: Array<Uint8Array | null>) => void;
        decryptEncryptionKeys.mockImplementation(async () => new Promise<Array<Uint8Array | null>>((resolve) => {
            resolveDataKeys = resolve;
        }));
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

        await expect.poll(() => applySessionListRenderables.mock.calls.length, { timeout: 100 }).toBe(1);
        const beforeDataKeyRace = await Promise.race([
            fetchPromise.then(() => 'resolved'),
            new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 25)),
        ]);

        expect(beforeDataKeyRace).toBe('timeout');
        expect(applySessionListRenderables).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's_cold',
                metadataVersion: 3,
                metadata: null,
                hasPendingPermissionRequests: false,
                hasPendingUserActionRequests: true,
            }),
        ], { replace: true, coversWholeList: true });
        expect(applySessions).not.toHaveBeenCalled();

        await expect.poll(() => typeof resolveDataKeys).toBe('function');
        resolveDataKeys([new Uint8Array([6])]);
        await fetchPromise;
    });

    it('coalesces fast background hydration into one store apply instead of size-flushing every full batch', async () => {
        const rows = Array.from({ length: 12 }, (_, index) => buildSessionRow({
            id: `s_fast_background_${index + 1}`,
            dataEncryptionKey: `k-fast-${index + 1}`,
            metadata: `meta-fast-${index + 1}`,
            metadataVersion: 2,
        }));
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: rows,
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption, decryptMetadata } = createEncryptionHarness();
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
            sessionListBackgroundHydrationConcurrencyLimit: 4,
            sessionListBackgroundHydrationYield: async () => {},
            sessionListBackgroundHydrationYieldEveryRows: 4,
            sessionListBackgroundHydrationApplyBatchSize: 4,
            sessionListBackgroundHydrationApplyFlushDelayMs: 64,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        await expect.poll(() => decryptMetadata.mock.calls.length).toBe(rows.length);
        await expect.poll(() => applySessions.mock.calls.length).toBe(1);
        expect(new Set((applySessions.mock.calls[0]?.[0] as Session[]).map((session) => session.id))).toEqual(
            new Set(rows.map((row) => row.id)),
        );
    });

    it('defers background hydration and yields between session rows', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({ id: 's_first', dataEncryptionKey: 'k-first', metadata: 'meta-first' }),
                    buildSessionRow({ id: 's_second', dataEncryptionKey: 'k-second', metadata: 'meta-second' }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption, decryptMetadata } = createEncryptionHarness();
        const applySessions = vi.fn();
        let currentRenderables: Record<string, SessionListRenderableSession> = {
            s_first: buildSessionListRenderableFromSession(buildExistingSession({
                id: 's_first',
                metadata: { name: 'Known first', path: '/known-first', host: 'known-host' },
                metadataVersion: 1,
            })),
            s_second: buildSessionListRenderableFromSession(buildExistingSession({
                id: 's_second',
            })),
        };
        const applySessionListRenderables = vi.fn((renderables: SessionListRenderableSession[]) => {
            currentRenderables = Object.fromEntries(renderables.map((renderable) => [renderable.id, renderable]));
        });
        const yieldResolvers: Array<() => void> = [];
        const sessionListBackgroundHydrationYield = vi.fn(
            () => new Promise<void>((resolve) => {
                yieldResolvers.push(resolve);
            }),
        );
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        await fetchAndApplySessions({
            serverId: 'server-a',
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            applySessionListRenderables,
            getCurrentSessionListRenderable: (sessionId) => currentRenderables[sessionId] ?? null,
            cachedSessionListEntries: {},
            sessionListBackgroundHydrationConcurrencyLimit: 1,
            sessionListBackgroundHydrationApplyBatchSize: 2,
            sessionListBackgroundHydrationApplyFlushDelayMs: 1_000,
            sessionListBackgroundHydrationYield,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(applySessionListRenderables).toHaveBeenCalledWith([
            expect.objectContaining({ id: 's_first', metadata: null }),
            expect.objectContaining({ id: 's_second', metadata: null }),
        ], { replace: true, coversWholeList: true });
        expect(decryptMetadata).not.toHaveBeenCalled();
        expect(sessionListBackgroundHydrationYield).toHaveBeenCalledTimes(1);

        yieldResolvers.shift()?.();
        await expect.poll(() => decryptMetadata.mock.calls.map((call) => call[1])).toEqual(['meta-first']);
        expect(applySessions).not.toHaveBeenCalled();
        await expect.poll(() => sessionListBackgroundHydrationYield.mock.calls.length).toBe(2);

        yieldResolvers.shift()?.();
        await expect.poll(() => decryptMetadata.mock.calls.map((call) => call[1])).toEqual(['meta-first', 'meta-second']);
        await expect.poll(() => applySessions.mock.calls.length, { timeout: 2_000 }).toBe(1);
        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({ id: 's_first' }),
            expect.objectContaining({ id: 's_second' }),
        ]);

        const telemetryEvents = syncPerformanceTelemetry.snapshot().events;
        const firstUsableListEvent = telemetryEvents.find((event) => event.name === 'sync.sessions.snapshot.firstUsableList');
        expect(firstUsableListEvent?.count).toBe(1);
        expect(firstUsableListEvent?.fields).toEqual(expect.objectContaining({
            sessions: 2,
            totalRows: 2,
            renderableRows: 2,
            placeholderRows: 2,
            nullMetadataRows: 2,
            requiredRows: 0,
            backgroundRows: 2,
            staleMetadataPreserved: 1,
            serverIdPresent: 1,
        }));
        const renderableBuildEvent = telemetryEvents.find((event) => event.name === 'sync.sessions.snapshot.renderableBuild');
        expect(renderableBuildEvent?.fields).toEqual(expect.objectContaining({
            sessions: 2,
            requiredRows: 0,
            backgroundRows: 2,
        }));
        const applyRenderablesEvent = telemetryEvents.find((event) => event.name === 'sync.sessions.snapshot.applyRenderables');
        expect(applyRenderablesEvent?.fields).toEqual(expect.objectContaining({
            sessions: 2,
            requiredRows: 0,
            backgroundRows: 2,
        }));
        const backgroundHydrationEvent = telemetryEvents.find((event) => event.name === 'sync.sessions.snapshot.backgroundHydration');
        expect(backgroundHydrationEvent?.fields).toEqual(expect.objectContaining({
            sessions: 2,
            requiredRows: 0,
            backgroundRows: 2,
        }));
        const backgroundAttributionEvent = telemetryEvents.find((event) => event.name === 'sync.sessions.snapshot.backgroundHydration.attribution');
        expect(backgroundAttributionEvent?.count).toBe(1);
        expect(backgroundAttributionEvent?.fields).toEqual(expect.objectContaining({
            sessions: 2,
            startedRows: 2,
            completedRows: 2,
            enqueuedRows: 2,
            failedRows: 0,
            cancelledRows: 0,
            staleBeforeEnqueueRows: 0,
            requiredRows: 0,
            backgroundRows: 2,
            applyBatchSize: 2,
            applyFlushDelayMs: 1_000,
        }));
        expect(backgroundAttributionEvent?.fields.yieldMs).toBeGreaterThanOrEqual(0);
        expect(backgroundAttributionEvent?.fields.decryptRowMs).toBeGreaterThanOrEqual(0);
        expect(backgroundAttributionEvent?.fields.applyEnqueueMs).toBeGreaterThanOrEqual(0);
        expect(backgroundAttributionEvent?.fields.rowWorkOverheadMs).toBeGreaterThanOrEqual(0);
        const hydrationRowEvent = telemetryEvents.find((event) => event.name === 'sync.sessions.snapshot.hydrationRow');
        expect(hydrationRowEvent?.fields).toEqual(expect.objectContaining({
            rows: 2,
            requiredRows: 0,
            backgroundRows: 2,
        }));
        const yieldEvent = telemetryEvents.find((event) => event.name === 'sync.sessions.snapshot.hydrationYield');
        expect(yieldEvent?.count).toBe(2);
        expect(yieldEvent?.fields.rows).toBe(2);
        expect(yieldEvent?.fields.requiredRows).toBe(0);
        expect(yieldEvent?.fields.backgroundRows).toBe(2);
        const enqueueEvent = telemetryEvents.find((event) => event.name === 'sync.sessions.snapshot.hydrationApply.enqueue');
        expect(enqueueEvent?.fields).toEqual(expect.objectContaining({
            sessions: 2,
            requiredRows: 0,
            backgroundRows: 2,
        }));
        const queueWaitEvent = telemetryEvents.find((event) => event.name === 'sync.sessions.snapshot.hydrationApply.queueWait');
        expect(queueWaitEvent?.count).toBe(1);
        expect(queueWaitEvent?.fields.sessions).toBe(2);
        expect(queueWaitEvent?.fields.bySize).toBe(1);
        expect(queueWaitEvent?.fields.byFinal).toBe(0);
        expect(queueWaitEvent?.fields.requiredRows).toBe(0);
        expect(queueWaitEvent?.fields.backgroundRows).toBe(2);
        const flushEvent = telemetryEvents.find((event) => event.name === 'sync.sessions.snapshot.hydrationApply.flush');
        expect(flushEvent?.count).toBe(1);
        expect(flushEvent?.fields.sessions).toBe(2);
        expect(flushEvent?.fields.requiredRows).toBe(0);
        expect(flushEvent?.fields.backgroundRows).toBe(2);
        const fullyHydratedListEvent = telemetryEvents.find((event) => event.name === 'sync.sessions.snapshot.fullyHydratedList');
        expect(fullyHydratedListEvent?.count).toBe(1);
        expect(fullyHydratedListEvent?.fields).toEqual(expect.objectContaining({
            sessions: 2,
            totalRows: 2,
            renderableRows: 2,
            hydrationRows: 2,
            requiredRows: 0,
            backgroundRows: 2,
            hydratedRows: 2,
            failedRows: 0,
            staleSkippedRows: 0,
        }));
    });

    it('amortizes background hydration yields over configured row intervals', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({ id: 's_yield_1', active: false, dataEncryptionKey: 'k-yield-1', metadata: 'meta-yield-1' }),
                    buildSessionRow({ id: 's_yield_2', active: false, dataEncryptionKey: 'k-yield-2', metadata: 'meta-yield-2' }),
                    buildSessionRow({ id: 's_yield_3', active: false, dataEncryptionKey: 'k-yield-3', metadata: 'meta-yield-3' }),
                    buildSessionRow({ id: 's_yield_4', active: false, dataEncryptionKey: 'k-yield-4', metadata: 'meta-yield-4' }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption, decryptMetadata } = createEncryptionHarness();
        const applySessions = vi.fn();
        const applySessionListRenderables = vi.fn();
        const sessionListBackgroundHydrationYield = vi.fn(async () => {});
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        const params = {
            serverId: 'server-a',
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            applySessionListRenderables,
            cachedSessionListEntries: {},
            sessionListBackgroundHydrationConcurrencyLimit: 1,
            sessionListBackgroundHydrationApplyBatchSize: 4,
            sessionListBackgroundHydrationApplyFlushDelayMs: 1_000,
            sessionListBackgroundHydrationYieldEveryRows: 2,
            sessionListBackgroundHydrationYield,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        } satisfies FetchAndApplySessionsParams & { sessionListBackgroundHydrationYieldEveryRows: number };

        await fetchAndApplySessions(params);

        await expect.poll(() => decryptMetadata.mock.calls.map((call) => call[1])).toEqual([
            'meta-yield-1',
            'meta-yield-2',
            'meta-yield-3',
            'meta-yield-4',
        ]);
        await expect.poll(() => applySessions.mock.calls.length).toBe(1);
        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({ id: 's_yield_1' }),
            expect.objectContaining({ id: 's_yield_2' }),
            expect.objectContaining({ id: 's_yield_3' }),
            expect.objectContaining({ id: 's_yield_4' }),
        ]);
        expect(sessionListBackgroundHydrationYield).toHaveBeenCalledTimes(2);

        const telemetryEvents = syncPerformanceTelemetry.snapshot().events;
        const backgroundHydrationEvent = telemetryEvents.find((event) => event.name === 'sync.sessions.snapshot.backgroundHydration');
        expect(backgroundHydrationEvent?.fields).toEqual(expect.objectContaining({
            sessions: 4,
            backgroundRows: 4,
            yieldEveryRows: 2,
        }));
        const backgroundAttributionEvent = telemetryEvents.find((event) => event.name === 'sync.sessions.snapshot.backgroundHydration.attribution');
        expect(backgroundAttributionEvent?.fields).toEqual(expect.objectContaining({
            sessions: 4,
            backgroundRows: 4,
            yieldEveryRows: 2,
        }));
        const yieldEvent = telemetryEvents.find((event) => event.name === 'sync.sessions.snapshot.hydrationYield');
        expect(yieldEvent?.count).toBe(2);
        expect(yieldEvent?.fields.rows).toBe(2);
        expect(yieldEvent?.fields.backgroundRows).toBe(2);
    });

    it('skips queued background hydration for a session deleted before apply flush', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({ id: 's_deleted_before_flush', metadata: 'meta-deleted' }),
                    buildSessionRow({ id: 's_survivor_after_delete', metadata: 'meta-survivor' }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption, decryptMetadata } = createEncryptionHarness();
        const applySessions = vi.fn();
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();
        let currentRenderables: Record<string, SessionListRenderableSession> = {};
        const applySessionListRenderables = vi.fn((sessions: SessionListRenderableSession[]) => {
            currentRenderables = Object.fromEntries(sessions.map((session) => [session.id, session]));
        });
        const yieldResolvers: Array<() => void> = [];
        const sessionListBackgroundHydrationYield = vi.fn(
            () => new Promise<void>((resolve) => {
                yieldResolvers.push(resolve);
            }),
        );

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            applySessionListRenderables,
            getCurrentSessionListRenderable: (sessionId: string) => currentRenderables[sessionId] ?? null,
            cachedSessionListEntries: {},
            sessionListBackgroundHydrationConcurrencyLimit: 1,
            sessionListBackgroundHydrationApplyBatchSize: 2,
            sessionListBackgroundHydrationApplyFlushDelayMs: 1_000,
            sessionListBackgroundHydrationYield,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        yieldResolvers.shift()?.();
        await expect.poll(() => decryptMetadata.mock.calls.map((call) => call[1])).toEqual(['meta-deleted']);
        delete currentRenderables.s_deleted_before_flush;

        yieldResolvers.shift()?.();
        await expect.poll(() => applySessions.mock.calls.length, { timeout: 2_000 }).toBe(1);
        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({ id: 's_survivor_after_delete' }),
        ]);
        const staleEvent = syncPerformanceTelemetry
            .snapshot()
            .events
            .find((event) => event.name === 'sync.sessions.snapshot.hydrationApply.stale');
        expect(staleEvent?.fields.sessions).toBe(1);
        expect(staleEvent?.fields.flush).toBe(1);
    });

    it('skips queued background hydration for a session archived before apply flush', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_archived_before_flush',
                        updatedAt: 10,
                        archivedAt: null,
                        metadata: 'meta-archived',
                    }),
                    buildSessionRow({ id: 's_survivor_after_archive', updatedAt: 10, metadata: 'meta-survivor' }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption, decryptMetadata } = createEncryptionHarness();
        const applySessions = vi.fn();
        let currentRenderables: Record<string, SessionListRenderableSession> = {};
        const applySessionListRenderables = vi.fn((sessions: SessionListRenderableSession[]) => {
            currentRenderables = Object.fromEntries(sessions.map((session) => [session.id, session]));
        });
        const yieldResolvers: Array<() => void> = [];
        const sessionListBackgroundHydrationYield = vi.fn(
            () => new Promise<void>((resolve) => {
                yieldResolvers.push(resolve);
            }),
        );

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            applySessionListRenderables,
            getCurrentSessionListRenderable: (sessionId: string) => currentRenderables[sessionId] ?? null,
            cachedSessionListEntries: {},
            sessionListBackgroundHydrationConcurrencyLimit: 1,
            sessionListBackgroundHydrationApplyBatchSize: 2,
            sessionListBackgroundHydrationApplyFlushDelayMs: 1_000,
            sessionListBackgroundHydrationYield,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        yieldResolvers.shift()?.();
        await expect.poll(() => decryptMetadata.mock.calls.map((call) => call[1])).toEqual(['meta-archived']);
        currentRenderables = {
            ...currentRenderables,
            s_archived_before_flush: {
                ...currentRenderables.s_archived_before_flush!,
                archivedAt: 99,
                updatedAt: 99,
            },
        };

        yieldResolvers.shift()?.();
        await expect.poll(() => applySessions.mock.calls.length, { timeout: 2_000 }).toBe(1);
        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({ id: 's_survivor_after_archive' }),
        ]);
    });

    it('patches decrypted list metadata when a newer socket row makes full hydration stale', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_streaming_placeholder',
                        seq: 10,
                        updatedAt: 10,
                        metadata: 'meta-streaming-placeholder',
                        metadataVersion: 2,
                        agentStateVersion: 0,
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption, decryptMetadata } = createEncryptionHarness();
        decryptMetadata.mockResolvedValue({
            name: 'Hydrated streaming row',
            path: '/work/repo',
            homeDir: '/work',
            host: 'devbox',
            machineId: 'machine-1',
        });
        const applySessions = vi.fn();
        let currentRenderables: Record<string, SessionListRenderableSession> = {};
        const applySessionListRenderables = vi.fn((sessions: SessionListRenderableSession[]) => {
            currentRenderables = Object.fromEntries(sessions.map((session) => [session.id, session]));
        });
        const applySessionListRenderablePatches = vi.fn((patches: ReadonlyArray<Readonly<{
            sessionId: string;
            patch: Readonly<Partial<Omit<SessionListRenderableSession, 'id'>>>;
        }>>) => {
            currentRenderables = {
                ...currentRenderables,
                ...Object.fromEntries(patches.map(({ sessionId, patch }) => [
                    sessionId,
                    {
                        ...currentRenderables[sessionId]!,
                        ...patch,
                    },
                ])),
            };
        });
        const yieldResolvers: Array<() => void> = [];
        const sessionListBackgroundHydrationYield = vi.fn(
            () => new Promise<void>((resolve) => {
                yieldResolvers.push(resolve);
            }),
        );

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            applySessionListRenderables,
            applySessionListRenderablePatches,
            getCurrentSessionListRenderable: (sessionId: string) => currentRenderables[sessionId] ?? null,
            cachedSessionListEntries: {},
            sessionListBackgroundHydrationConcurrencyLimit: 1,
            sessionListBackgroundHydrationApplyBatchSize: 2,
            sessionListBackgroundHydrationApplyFlushDelayMs: 1_000,
            sessionListBackgroundHydrationYield,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(currentRenderables.s_streaming_placeholder?.metadata).toBeNull();
        currentRenderables = {
            ...currentRenderables,
            s_streaming_placeholder: {
                ...currentRenderables.s_streaming_placeholder!,
                seq: 11,
                updatedAt: 11,
                agentStateVersion: 1,
                metadata: null,
            },
        };

        yieldResolvers.shift()?.();

        await expect.poll(() => decryptMetadata.mock.calls.map((call) => call[1])).toEqual(['meta-streaming-placeholder']);
        await expect.poll(() => applySessionListRenderablePatches.mock.calls.length).toBe(1);
        expect(applySessions).not.toHaveBeenCalled();
        expect(applySessionListRenderablePatches).toHaveBeenCalledWith([
            {
                sessionId: 's_streaming_placeholder',
                patch: expect.objectContaining({
                    metadataVersion: 2,
                    metadata: expect.objectContaining({
                        name: 'Hydrated streaming row',
                        path: '/work/repo',
                    }),
                }),
            },
        ]);
    });

    it('settles legacy pending flags from a newer hydrated request version after unrelated metadata advances', async () => {
        const existing = buildExistingSession({
            id: 's_legacy_pending', encryptionMode: 'plain', metadataVersion: 1,
            metadata: { path: '/repo', host: 'host' }, agentStateVersion: 2,
            agentState: { requests: { r1: { tool: 'Bash', arguments: {}, createdAt: 50 } } },
            pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 0, pendingRequestObservedAt: 50,
        });
        let current = buildSessionListRenderableFromSession(existing);
        const resumeHydration = createDeferred<void>();
        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption: Encryption.createWithoutKeyMaterial(),
            sessionDataKeys: new Map(),
            request: vi.fn(async () => jsonResponse({
                sessions: [buildSessionRow({
                    id: existing.id, encryptionMode: 'plain', updatedAt: 100,
                    metadata: JSON.stringify(existing.metadata), metadataVersion: 1,
                    agentState: JSON.stringify({ requests: {} }), agentStateVersion: 3,
                })],
                nextCursor: null, hasNext: false,
            })),
            getExistingSession: () => existing,
            getCurrentSessionListRenderable: () => current,
            applySessionListRenderables: rows => {
                for (const row of rows) current = preserveSessionListRenderableStaleFields(current, row);
            },
            applySessionListRenderablePatches: patches => {
                for (const { patch } of patches) current = applySessionListRenderablePatch(current, patch);
            },
            applySessions: () => { throw new Error('The older whole snapshot must not replace current metadata'); },
            cachedSessionListEntries: {},
            sessionListBackgroundHydrationYield: () => resumeHydration.promise,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });
        expect(current).toMatchObject({ agentStateVersion: 2, hasPendingPermissionRequests: true });
        current = applySessionListRenderablePatch(current, {
            metadataVersion: 2, metadata: { path: '/renamed', host: 'host' }, updatedAt: 400,
        });
        resumeHydration.resolve();

        await expect.poll(() => current.agentStateVersion).toBe(3);
        expect(current).toMatchObject({
            hasPendingPermissionRequests: false, hasPendingUserActionRequests: false,
            pendingRequestObservedAt: null, metadataVersion: 2, metadata: { path: '/renamed' },
        });
    });

    it('does not wait for background-yield scheduling before required session hydration', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_stale',
                        dataEncryptionKey: 'k-stale',
                        metadata: 'meta-stale',
                        metadataVersion: 2,
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption, decryptMetadata } = createEncryptionHarness();
        const requiredMetadata = createDeferred<{ decrypted: string }>();
        decryptMetadata.mockImplementation(async () => requiredMetadata.promise);
        const applySessions = vi.fn();
        const applySessionListRenderables = vi.fn();
        const sessionListBackgroundHydrationYield = vi.fn(
            () => new Promise<void>(() => {}),
        );
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        const fetchPromise = fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            applySessionListRenderables,
            cachedSessionListEntries: {
                s_stale: {
                    sessionId: 's_stale',
                    metadataVersion: 1,
                    agentStateVersion: 0,
                    updatedAt: 1,
                    createdAt: 1,
                    active: true,
                    activeAt: 1,
                    archivedAt: null,
                    path: '/stale',
                    summaryText: 'Cached stale title',
                },
            },
            sessionListBackgroundHydrationYield,
            awaitSessionListHydration: true,
            requiredHydrationSessionIds: ['s_stale'],
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        await expect.poll(() => applySessionListRenderables.mock.calls.length).toBe(1);
        await expect.poll(() => decryptMetadata.mock.calls.map((call) => call[1])).toEqual(['meta-stale']);
        expect(sessionListBackgroundHydrationYield).not.toHaveBeenCalled();

        await expect(Promise.race([
            fetchPromise.then(() => 'resolved' as const),
            new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 25)),
        ])).resolves.toBe('pending');

        requiredMetadata.resolve({ decrypted: 'meta-stale' });
        await fetchPromise;

        expect(decryptMetadata).toHaveBeenCalledWith(2, 'meta-stale');
        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's_stale',
                metadataVersion: 2,
                metadata: expect.objectContaining({ decrypted: 'meta-stale' }),
            }),
        ]);

        const requiredWaitEvent = syncPerformanceTelemetry
            .snapshot()
            .events.find((event) => event.name === 'sync.sessions.snapshot.requiredHydration.wait');
        expect(requiredWaitEvent?.count).toBe(1);
        expect(requiredWaitEvent?.fields.requiredRows).toBe(1);
    });

    it('does not wait for unrelated background rows when required session hydration resolves', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_required',
                        dataEncryptionKey: 'k-required',
                        metadata: 'meta-required',
                        metadataVersion: 2,
                    }),
                    buildSessionRow({
                        id: 's_background',
                        dataEncryptionKey: 'k-background',
                        metadata: 'meta-background',
                        metadataVersion: 2,
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption, decryptMetadata } = createEncryptionHarness();
        const applySessions = vi.fn();
        const applySessionListRenderables = vi.fn();
        const yieldResolvers: Array<() => void> = [];
        const sessionListBackgroundHydrationYield = vi.fn(
            () => new Promise<void>((resolve) => {
                yieldResolvers.push(resolve);
            }),
        );

        const fetchPromise = fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            applySessionListRenderables,
            cachedSessionListEntries: {},
            sessionListBackgroundHydrationConcurrencyLimit: 1,
            sessionListBackgroundHydrationApplyBatchSize: 2,
            sessionListBackgroundHydrationApplyFlushDelayMs: 1_000,
            sessionListBackgroundHydrationYield,
            awaitSessionListHydration: true,
            requiredHydrationSessionIds: ['s_required'],
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        await expect.poll(() => decryptMetadata.mock.calls.map((call) => call[1])).toEqual(['meta-required']);
        await expect.poll(() => applySessions.mock.calls.length).toBe(1);
        await expect.poll(() => sessionListBackgroundHydrationYield.mock.calls.length).toBe(1);

        const earlyResult = await Promise.race([
            fetchPromise.then(() => 'resolved' as const),
            new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 25)),
        ]);
        if (earlyResult !== 'resolved') {
            yieldResolvers.splice(0).forEach((resolve) => resolve());
            await fetchPromise.catch(() => undefined);
        }
        expect(earlyResult).toBe('resolved');

        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({ id: 's_required' }),
        ]);

        yieldResolvers.splice(0).forEach((resolve) => resolve());
        await expect.poll(() => decryptMetadata.mock.calls.map((call) => call[1])).toEqual([
            'meta-required',
            'meta-background',
        ]);
    });

    it('does not throw required hydration failure when a newer session fetch supersedes the request', async () => {
        const firstRequest = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_superseded_required',
                        dataEncryptionKey: 'k-superseded-required',
                        metadata: 'meta-superseded-required',
                        metadataVersion: 2,
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );
        const secondRequest = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_newer',
                        dataEncryptionKey: 'k-newer',
                        metadata: 'meta-newer',
                        metadataVersion: 2,
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption, decryptMetadata } = createEncryptionHarness();
        const firstMetadataDecrypt = createDeferred<{ decrypted: string }>();
        decryptMetadata.mockImplementation(async (_version: number, value: string) => {
            if (value === 'meta-superseded-required') {
                return firstMetadataDecrypt.promise;
            }
            return { decrypted: value };
        });
        const applySessions = vi.fn();
        const applySessionListRenderables = vi.fn();

        const firstFetch = fetchAndApplySessions({
            serverId: 'server-superseded-required',
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: firstRequest,
            applySessions,
            applySessionListRenderables,
            cachedSessionListEntries: {},
            awaitSessionListHydration: true,
            requiredHydrationSessionIds: ['s_superseded_required'],
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        await expect.poll(() => decryptMetadata.mock.calls.map((call) => call[1])).toEqual(['meta-superseded-required']);

        await fetchAndApplySessions({
            serverId: 'server-superseded-required',
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: secondRequest,
            applySessions,
            applySessionListRenderables,
            cachedSessionListEntries: {},
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        firstMetadataDecrypt.resolve({ decrypted: 'meta-superseded-required' });
        await expect(firstFetch).resolves.toEqual(expect.objectContaining({
            sessionIds: ['s_superseded_required'],
        }));

        expect(applySessions.mock.calls.flatMap((call) => call[0].map((session: { id: string }) => session.id)))
            .not.toContain('s_superseded_required');
    });

    it('batches hydrated background sessions by default', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({ id: 's_first', dataEncryptionKey: 'k-first', metadata: 'meta-first' }),
                    buildSessionRow({ id: 's_second', dataEncryptionKey: 'k-second', metadata: 'meta-second' }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption, decryptMetadata } = createEncryptionHarness();
        const applySessions = vi.fn();
        const applySessionListRenderables = vi.fn();
        const yieldResolvers: Array<() => void> = [];
        const sessionListBackgroundHydrationYield = vi.fn(
            () => new Promise<void>((resolve) => {
                yieldResolvers.push(resolve);
            }),
        );

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            applySessionListRenderables,
            cachedSessionListEntries: {},
            sessionListBackgroundHydrationConcurrencyLimit: 1,
            sessionListBackgroundHydrationApplyFlushDelayMs: 64,
            sessionListBackgroundHydrationYield,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        yieldResolvers.shift()?.();
        await expect.poll(() => decryptMetadata.mock.calls.map((call) => call[1])).toEqual(['meta-first']);
        expect(applySessions).not.toHaveBeenCalled();
        yieldResolvers.shift()?.();
        await expect.poll(() => decryptMetadata.mock.calls.map((call) => call[1])).toEqual(['meta-first', 'meta-second']);
        await expect.poll(() => applySessions.mock.calls.length, { timeout: 1_000 }).toBe(1);
        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({ id: 's_first' }),
            expect.objectContaining({ id: 's_second' }),
        ]);
    });

    it('defers final non-awaited background hydration applies by the configured apply delay', async () => {
        vi.useFakeTimers();
        syncPerformanceTelemetry.configure({
            enabled: true,
            now: () => Date.now(),
        });
        syncPerformanceTelemetry.reset();
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({ id: 's_delayed_final_first', metadata: 'meta-delayed-first' }),
                    buildSessionRow({ id: 's_delayed_final_second', metadata: 'meta-delayed-second' }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption } = createEncryptionHarness();
        const applySessions = vi.fn();
        const applySessionListRenderables = vi.fn();

        let resolved = false;
        const resultPromise = fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            applySessionListRenderables,
            cachedSessionListEntries: {},
            sessionListEagerHydrationCount: 2,
            sessionListBackgroundHydrationConcurrencyLimit: 1,
            sessionListBackgroundHydrationYieldEveryRows: 100,
            sessionListBackgroundHydrationYield: async () => {},
            sessionListBackgroundHydrationApplyBatchSize: 10,
            sessionListBackgroundHydrationApplyFlushDelayMs: 60_000,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        }).then((result) => {
            resolved = true;
            return result;
        });

        await Promise.resolve();
        expect(resolved).toBe(false);
        expect(applySessions).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(10_000);
        expect(syncPerformanceTelemetry.snapshot().events.filter((event) =>
            event.name === 'sync.sessions.snapshot.hydrationApply.flush'
        )).toEqual([]);
        expect(applySessions).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(50_000);
        const result = await resultPromise;
        expect(result.sessionIds).toEqual(['s_delayed_final_first', 's_delayed_final_second']);
        expect(resolved).toBe(true);
        expect(applySessions).toHaveBeenCalledTimes(1);
        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({ id: 's_delayed_final_first' }),
            expect.objectContaining({ id: 's_delayed_final_second' }),
        ]);
    });

    it('does not spend background hydration yield or decrypt work after the caller scope becomes inactive', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({ id: 's_stale_first', metadata: 'meta-stale-first' }),
                    buildSessionRow({ id: 's_stale_second', metadata: 'meta-stale-second' }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption, decryptMetadata } = createEncryptionHarness();
        const applySessions = vi.fn();
        const applySessionListRenderables = vi.fn();
        const yieldResolvers: Array<() => void> = [];
        const sessionListBackgroundHydrationYield = vi.fn(
            () => new Promise<void>((resolve) => {
                yieldResolvers.push(resolve);
            }),
        );
        let active = true;

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            applySessionListRenderables,
            cachedSessionListEntries: {},
            shouldContinue: () => active,
            sessionListBackgroundHydrationConcurrencyLimit: 1,
            sessionListBackgroundHydrationYield,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        await expect.poll(() => sessionListBackgroundHydrationYield.mock.calls.length).toBe(1);
        active = false;
        yieldResolvers.shift()?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(sessionListBackgroundHydrationYield).toHaveBeenCalledTimes(1);
        expect(decryptMetadata).not.toHaveBeenCalled();
        expect(applySessions).not.toHaveBeenCalled();
        for (const resolve of yieldResolvers) resolve();
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

        const { encryption, decryptEncryptionKeys } = createEncryptionHarness();
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

        expect(decryptEncryptionKeys).not.toHaveBeenCalled();
        expect(applySessions).not.toHaveBeenCalled();
    });

    it('decrypts uncached encrypted session data keys in one batch', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({ id: 's_batch_a', dataEncryptionKey: 'batch-envelope-a' }),
                    buildSessionRow({ id: 's_batch_b', dataEncryptionKey: 'batch-envelope-b' }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );
        const { encryption, decryptEncryptionKey, decryptEncryptionKeys, initializeSessions } = createEncryptionHarness();
        const sessionDataKeys = new Map<string, Uint8Array>();

        await fetchAndApplySessions({
            serverId: 'server-batch',
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys,
            request: requestSpy,
            applySessions: vi.fn(),
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(decryptEncryptionKey).not.toHaveBeenCalled();
        expectDecryptEncryptionKeysCall(decryptEncryptionKeys, ['batch-envelope-a', 'batch-envelope-b'], { serverId: 'server-batch' });
        expectInitializeSessionsCall(initializeSessions, [
            ['s_batch_a', new Uint8Array(['batch-envelope-a'.length])],
            ['s_batch_b', new Uint8Array(['batch-envelope-b'.length])],
        ], { serverId: 'server-batch' });
    });

    it('requires the batch data-key decrypt dependency for encrypted snapshots', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({ id: 's_requires_batch', dataEncryptionKey: 'batch-required-envelope' }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );
        const { encryption, decryptEncryptionKey, initializeSessions } = createSingleDecryptOnlyEncryptionHarness();

        await expect(fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions: vi.fn(),
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        })).rejects.toThrow(/decryptEncryptionKeys/);

        expect(decryptEncryptionKey).not.toHaveBeenCalled();
        expect(initializeSessions).not.toHaveBeenCalled();
    });

    it('keeps valid batch data keys when one encrypted session key is invalid', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({ id: 's_valid_key', dataEncryptionKey: 'valid-envelope' }),
                    buildSessionRow({ id: 's_invalid_key', dataEncryptionKey: 'invalid-envelope' }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );
        const { encryption, decryptEncryptionKeys, initializeSessions, removeSessionEncryption } = createEncryptionHarness();
        decryptEncryptionKeys.mockResolvedValueOnce([new Uint8Array([9, 9]), null]);
        const staleKey = new Uint8Array([1, 1]);
        const sessionDataKeys = new Map<string, Uint8Array>([
            ['s_invalid_key', staleKey],
        ]);
        const sessionDataKeyEnvelopes = new Map<string, string>([
            ['s_invalid_key', 'old-invalid-envelope'],
        ]);

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys,
            sessionDataKeyEnvelopes,
            request: requestSpy,
            applySessions: vi.fn(),
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(decryptEncryptionKeys).toHaveBeenCalledTimes(1);
        expect(sessionDataKeys.get('s_valid_key')).toEqual(new Uint8Array([9, 9]));
        expect(sessionDataKeyEnvelopes.get('s_valid_key')).toBe('valid-envelope');
        expect(sessionDataKeys.has('s_invalid_key')).toBe(false);
        expect(sessionDataKeyEnvelopes.has('s_invalid_key')).toBe(false);
        expectInitializeSessionsCall(initializeSessions, [
            ['s_valid_key', new Uint8Array([9, 9])],
        ]);
        expect(removeSessionEncryption).toHaveBeenCalledTimes(1);
        expect(removeSessionEncryption).toHaveBeenCalledWith('s_invalid_key');
    });

    it('settles unavailable metadata when encrypted row hydration cannot open its data key', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_unopenable_key',
                        dataEncryptionKey: 'unopenable-envelope',
                        metadata: 'encrypted-unopenable-metadata',
                        metadataVersion: 4,
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );
        const { encryption, decryptEncryptionKeys, getSessionEncryption, removeSessionEncryption } = createEncryptionHarness();
        decryptEncryptionKeys.mockResolvedValueOnce([null]);
        getSessionEncryption.mockReturnValue(null);
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        let currentRenderables: Record<string, SessionListRenderableSession> = {};
        const applySessionListRenderables = vi.fn((sessions: SessionListRenderableSession[]) => {
            currentRenderables = Object.fromEntries(sessions.map((session) => [session.id, session]));
        });
        const applySessionListRenderablePatches = vi.fn((patches: readonly {
            sessionId: string;
            patch: Partial<SessionListRenderableSession> & { metadataUnavailable?: boolean };
        }[]) => {
            for (const { sessionId, patch } of patches) {
                currentRenderables[sessionId] = {
                    ...currentRenderables[sessionId],
                    ...patch,
                } as SessionListRenderableSession;
            }
        });

        try {
            await fetchAndApplySessions({
                credentials: { token: 't', secret: 's' },
                encryption,
                sessionDataKeys: new Map<string, Uint8Array>(),
                request: requestSpy,
                applySessions: vi.fn(),
                applySessionListRenderables,
                applySessionListRenderablePatches,
                getCurrentSessionListRenderable: (sessionId) => currentRenderables[sessionId],
                cachedSessionListEntries: {},
                sessionListBackgroundHydrationYield: async () => {},
                repairInvalidReadStateV1: async () => {},
                log: { log: () => {} },
            });

            await expect.poll(() => applySessionListRenderablePatches.mock.calls.length).toBe(1);
            expect(consoleError).not.toHaveBeenCalled();
        } finally {
            consoleError.mockRestore();
        }

        expect(decryptEncryptionKeys).toHaveBeenCalledWith(
            ['unopenable-envelope'],
            expect.objectContaining({ shouldContinue: expect.any(Function) }),
        );
        expect(removeSessionEncryption).toHaveBeenCalledWith('s_unopenable_key');
        expect(applySessionListRenderablePatches).toHaveBeenCalledWith([
            expect.objectContaining({
                sessionId: 's_unopenable_key',
                patch: expect.objectContaining({ metadataUnavailable: true }),
            }),
        ]);
        expect(currentRenderables.s_unopenable_key?.metadataUnavailable).toBe(true);
    });

    it('settles unavailable metadata when empty warm-cache metadata cannot open its data key', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_unopenable_key_empty_cache',
                        dataEncryptionKey: 'unopenable-envelope',
                        metadata: 'encrypted-unopenable-metadata',
                        metadataVersion: 4,
                        seq: 5,
                        lastViewedSessionSeq: 1,
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );
        const { encryption, decryptEncryptionKeys, getSessionEncryption } = createEncryptionHarness();
        decryptEncryptionKeys.mockResolvedValueOnce([null]);
        getSessionEncryption.mockReturnValue(null);
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        let currentRenderables: Record<string, SessionListRenderableSession> = {};
        const applySessionListRenderables = vi.fn((sessions: SessionListRenderableSession[]) => {
            currentRenderables = Object.fromEntries(sessions.map((session) => [session.id, session]));
        });
        const applySessionListRenderablePatches = vi.fn((patches: readonly {
            sessionId: string;
            patch: Partial<SessionListRenderableSession> & { metadataUnavailable?: boolean };
        }[]) => {
            for (const { sessionId, patch } of patches) {
                currentRenderables[sessionId] = {
                    ...currentRenderables[sessionId],
                    ...patch,
                } as SessionListRenderableSession;
            }
        });

        try {
            await fetchAndApplySessions({
                credentials: { token: 't', secret: 's' },
                encryption,
                sessionDataKeys: new Map<string, Uint8Array>(),
                request: requestSpy,
                applySessions: vi.fn(),
                applySessionListRenderables,
                applySessionListRenderablePatches,
                getCurrentSessionListRenderable: (sessionId) => currentRenderables[sessionId],
                cachedSessionListEntries: {
                    s_unopenable_key_empty_cache: {
                        sessionId: 's_unopenable_key_empty_cache',
                        seq: 5,
                        metadataVersion: 4,
                        agentStateVersion: 0,
                        updatedAt: 1,
                        createdAt: 1,
                        active: false,
                        activeAt: 1,
                        archivedAt: null,
                        lastViewedSessionSeq: 1,
                        pendingCount: 0,
                        pendingVersion: 0,
                        summaryText: null,
                        path: '',
                        homeDir: null,
                        host: null,
                        machineId: null,
                        flavor: null,
                        directSessionV1: null,
                        hiddenSystemSession: false,
                        hasPendingPermissionRequests: false,
                        hasPendingUserActionRequests: false,
                        hasUnreadMessages: true,
                    },
                },
                sessionListBackgroundHydrationYield: async () => {},
                repairInvalidReadStateV1: async () => {},
                log: { log: () => {} },
            });

            await expect.poll(() => applySessionListRenderablePatches.mock.calls.length).toBe(1);
        } finally {
            consoleError.mockRestore();
        }

        expect(decryptEncryptionKeys).toHaveBeenCalledWith(
            ['unopenable-envelope'],
            expect.objectContaining({ shouldContinue: expect.any(Function) }),
        );
        expect(applySessionListRenderablePatches).toHaveBeenCalledWith([
            expect.objectContaining({
                sessionId: 's_unopenable_key_empty_cache',
                patch: expect.objectContaining({ metadataUnavailable: true }),
            }),
        ]);
        expect(currentRenderables.s_unopenable_key_empty_cache?.metadataUnavailable).toBe(true);
    });

    it('clears runtime session encryption when an encrypted session no longer has a data-key envelope', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({ id: 's_missing_envelope', dataEncryptionKey: null }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );
        const { encryption, decryptEncryptionKeys, initializeSessions, removeSessionEncryption } = createEncryptionHarness();
        const staleKey = new Uint8Array([4, 4, 4]);
        const sessionDataKeys = new Map<string, Uint8Array>([
            ['s_missing_envelope', staleKey],
        ]);
        const sessionDataKeyEnvelopes = new Map<string, string>([
            ['s_missing_envelope', 'stale-envelope'],
        ]);

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys,
            sessionDataKeyEnvelopes,
            request: requestSpy,
            applySessions: vi.fn(),
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(decryptEncryptionKeys).not.toHaveBeenCalled();
        expect(sessionDataKeys.has('s_missing_envelope')).toBe(false);
        expect(sessionDataKeyEnvelopes.has('s_missing_envelope')).toBe(false);
        expect(initializeSessions).not.toHaveBeenCalled();
        expect(removeSessionEncryption).toHaveBeenCalledTimes(1);
        expect(removeSessionEncryption).toHaveBeenCalledWith('s_missing_envelope');
    });

    it('clears the concrete encryption cache when an encrypted session no longer has a data-key envelope', async () => {
        const sessionId = 's_missing_envelope_real';
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({ id: sessionId, dataEncryptionKey: null }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );
        const encryption = await Encryption.create(new Uint8Array(32).fill(1));
        const staleKey = new Uint8Array(32).fill(4);
        await encryption.initializeSessions(new Map([[sessionId, staleKey]]));
        expect(encryption.getSessionEncryption(sessionId)).not.toBeNull();

        const sessionDataKeys = new Map<string, Uint8Array>([
            [sessionId, staleKey],
        ]);
        const sessionDataKeyEnvelopes = new Map<string, string>([
            [sessionId, 'stale-envelope'],
        ]);

        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await fetchAndApplySessions({
                credentials: { token: 't', secret: 's' },
                encryption,
                sessionDataKeys,
                sessionDataKeyEnvelopes,
                request: requestSpy,
                applySessions: vi.fn(),
                repairInvalidReadStateV1: async () => {},
                log: { log: () => {} },
            });
        } finally {
            consoleError.mockRestore();
        }

        expect(sessionDataKeys.has(sessionId)).toBe(false);
        expect(sessionDataKeyEnvelopes.has(sessionId)).toBe(false);
        expect(encryption.getSessionEncryption(sessionId)).toBeNull();
    });

    it('does not update data-key caches when an account switch cancels the snapshot batch', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({ id: 's_account_switch', dataEncryptionKey: 'account-envelope' }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );
        const { encryption, decryptEncryptionKeys, initializeSessions } = createEncryptionHarness();
        const decryptDeferred = createDeferred<Array<Uint8Array | null>>();
        decryptEncryptionKeys.mockImplementationOnce(async () => decryptDeferred.promise);
        const cachedKey = new Uint8Array([1, 2, 3]);
        const sessionDataKeys = new Map<string, Uint8Array>([
            ['s_account_switch', cachedKey],
        ]);
        const sessionDataKeyEnvelopes = new Map<string, string>([
            ['s_account_switch', 'old-account-envelope'],
        ]);
        let active = true;

        const fetchPromise = fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys,
            sessionDataKeyEnvelopes,
            request: requestSpy,
            applySessions: vi.fn(),
            shouldContinue: () => active,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        await expect.poll(() => decryptEncryptionKeys.mock.calls.length).toBe(1);
        active = false;
        decryptDeferred.resolve([new Uint8Array([9, 9, 9])]);
        await fetchPromise;

        expect(sessionDataKeys.get('s_account_switch')).toBe(cachedKey);
        expect(sessionDataKeyEnvelopes.get('s_account_switch')).toBe('old-account-envelope');
        expect(initializeSessions).not.toHaveBeenCalled();
    });

    it('aborts superseded session-list data-key hydration before queued native work dispatches', async () => {
        const firstRequest = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({ id: 's_superseded_old', dataEncryptionKey: 'old-envelope' }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );
        const secondRequest = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({ id: 's_superseded_new', dataEncryptionKey: 'new-envelope' }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );
        const { encryption, decryptEncryptionKeys, initializeSessions } = createEncryptionHarness();
        const firstDecrypt = createDeferred<Array<Uint8Array | null>>();
        const signals: Array<AbortSignal | null> = [];
        decryptEncryptionKeys.mockImplementation(async (values: readonly string[], scope?: { signal?: AbortSignal }) => {
            signals.push(scope?.signal ?? null);
            if (values[0] === 'old-envelope') {
                return await firstDecrypt.promise;
            }
            return [new Uint8Array([2, 2])];
        });
        const sessionDataKeys = new Map<string, Uint8Array>();

        const firstFetch = fetchAndApplySessions({
            serverId: 'server-superseded',
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys,
            request: firstRequest,
            applySessions: vi.fn(),
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        await expect.poll(() => signals.length).toBe(1);
        expect(signals[0]).toBeInstanceOf(AbortSignal);
        expect(signals[0]?.aborted).toBe(false);

        const secondFetch = fetchAndApplySessions({
            serverId: 'server-superseded',
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys,
            request: secondRequest,
            applySessions: vi.fn(),
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        await expect.poll(() => signals[0]?.aborted).toBe(true);
        await secondFetch;
        firstDecrypt.resolve([new Uint8Array([1, 1])]);
        await firstFetch;

        expect(sessionDataKeys.has('s_superseded_old')).toBe(false);
        expect(sessionDataKeys.get('s_superseded_new')).toEqual(new Uint8Array([2, 2]));
        expect(initializeSessions).toHaveBeenCalledTimes(1);
        expectInitializeSessionsCall(initializeSessions, [
            ['s_superseded_new', new Uint8Array([2, 2])],
        ], { serverId: 'server-superseded' });
    });

    it('aborts inactive session-list data-key hydration before queued native work dispatches', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(4));
        const firstDataKey = new Uint8Array(32).fill(10);
        const secondDataKey = new Uint8Array(32).fill(20);
        const firstEnvelope = encodeBase64(await encryption.encryptEncryptionKey(firstDataKey), 'base64');
        const secondEnvelope = encodeBase64(await encryption.encryptEncryptionKey(secondDataKey), 'base64');
        const firstDispatch = createDeferred<{
            status: 'ok';
            source: 'native';
            items: readonly string[];
        }>();
        const nativeDispatches: string[][] = [];
        const worker: TestNativeCryptoWorker = {
            async probe() {
                return {
                    available: true,
                    failureReason: 0,
                    nativeVersion: 1,
                };
            },
            async decryptDataKeyEnvelopeV1(request) {
                nativeDispatches.push(request.items.map((item) => item.envelopeBase64));
                if (nativeDispatches.length === 1) {
                    return firstDispatch.promise;
                }
                return {
                    status: 'ok',
                    source: 'native',
                    items: [encodeBase64(secondDataKey, 'base64')],
                };
            },
            async decryptSecretboxJson() {
                throw new Error('decryptSecretboxJson should not be called');
            },
            async decryptAesGcmJson() {
                throw new Error('decryptAesGcmJson should not be called');
            },
        };
        encryption.configureNativeCryptoWorker({
            worker,
            routing: {
                mode: 'require',
                maxBatchSize: 1,
                minPayloadBytes: 0,
            },
            scope: {
                accountId: 'account-native-queue-abort',
                serverId: 'server-native-queue-abort',
                generation: 0,
            },
        });
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({ id: 's_native_abort_first', dataEncryptionKey: firstEnvelope }),
                    buildSessionRow({ id: 's_native_abort_second', dataEncryptionKey: secondEnvelope }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );
        const sessionDataKeys = new Map<string, Uint8Array>();
        const initializeSessions = vi.spyOn(encryption, 'initializeSessions');
        let active = true;

        const fetchPromise = fetchAndApplySessions({
            serverId: 'server-native-queue-abort',
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys,
            request: requestSpy,
            applySessions: vi.fn(),
            shouldContinue: () => active,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        await expect.poll(() => nativeDispatches.length).toBe(1);
        active = false;
        firstDispatch.resolve({
            status: 'ok',
            source: 'native',
            items: [encodeBase64(firstDataKey, 'base64')],
        });
        await fetchPromise;

        expect(nativeDispatches).toEqual([[firstEnvelope]]);
        expect(sessionDataKeys.size).toBe(0);
        expect(initializeSessions).not.toHaveBeenCalled();
    });

    it('does not update data-key caches when the account scope changes mid-batch', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({ id: 's_account_scope_switch', dataEncryptionKey: 'account-scope-envelope' }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );
        const { encryption, decryptEncryptionKeys, initializeSessions } = createEncryptionHarness();
        const scope = attachNativeWorkerScopeHarness(encryption, { accountId: 'account-a', serverId: 'server-a' });
        const cachedKey = new Uint8Array([2, 2, 2]);
        const sessionDataKeys = new Map<string, Uint8Array>([
            ['s_account_scope_switch', cachedKey],
        ]);
        const sessionDataKeyEnvelopes = new Map<string, string>([
            ['s_account_scope_switch', 'old-account-scope-envelope'],
        ]);
        const decryptDeferred = createDeferred<Array<Uint8Array | null>>();
        decryptEncryptionKeys.mockImplementationOnce(async () => decryptDeferred.promise);

        const fetchPromise = fetchAndApplySessions({
            serverId: 'server-a',
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys,
            sessionDataKeyEnvelopes,
            request: requestSpy,
            applySessions: vi.fn(),
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        await expect.poll(() => decryptEncryptionKeys.mock.calls.length).toBe(1);
        scope.switchAccount('account-b');
        decryptDeferred.resolve([new Uint8Array([3, 3, 3])]);
        await fetchPromise;

        expect(sessionDataKeys.get('s_account_scope_switch')).toBe(cachedKey);
        expect(sessionDataKeyEnvelopes.get('s_account_scope_switch')).toBe('old-account-scope-envelope');
        expect(initializeSessions).not.toHaveBeenCalled();
    });

    it('does not update data-key caches when the server scope changes mid-batch', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({ id: 's_server_switch', dataEncryptionKey: 'server-envelope' }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );
        const { encryption, decryptEncryptionKeys, initializeSessions } = createEncryptionHarness();
        const scope = attachNativeWorkerScopeHarness(encryption, { accountId: 'account-a', serverId: 'server-a' });
        const cachedKey = new Uint8Array([4, 4, 4]);
        const sessionDataKeys = new Map<string, Uint8Array>([
            ['s_server_switch', cachedKey],
        ]);
        const sessionDataKeyEnvelopes = new Map<string, string>([
            ['s_server_switch', 'old-server-envelope'],
        ]);
        const decryptDeferred = createDeferred<Array<Uint8Array | null>>();
        decryptEncryptionKeys.mockImplementationOnce(async () => decryptDeferred.promise);

        const fetchPromise = fetchAndApplySessions({
            serverId: 'server-a',
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys,
            sessionDataKeyEnvelopes,
            request: requestSpy,
            applySessions: vi.fn(),
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        await expect.poll(() => decryptEncryptionKeys.mock.calls.length).toBe(1);
        scope.switchServer('server-b');
        decryptDeferred.resolve([new Uint8Array([8, 8, 8])]);
        await fetchPromise;

        expect(sessionDataKeys.get('s_server_switch')).toBe(cachedKey);
        expect(sessionDataKeyEnvelopes.get('s_server_switch')).toBe('old-server-envelope');
        expect(initializeSessions).not.toHaveBeenCalled();
    });

    it('does not clear data-key caches when deletion invalidates generation mid-batch', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({ id: 's_deleted_mid_batch', dataEncryptionKey: 'deleted-envelope' }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );
        const { encryption, decryptEncryptionKeys, initializeSessions } = createEncryptionHarness();
        const scope = attachNativeWorkerScopeHarness(encryption);
        const cachedKey = new Uint8Array([5, 5, 5]);
        const sessionDataKeys = new Map<string, Uint8Array>([
            ['s_deleted_mid_batch', cachedKey],
        ]);
        const sessionDataKeyEnvelopes = new Map<string, string>([
            ['s_deleted_mid_batch', 'old-deleted-envelope'],
        ]);
        const decryptDeferred = createDeferred<Array<Uint8Array | null>>();
        decryptEncryptionKeys.mockImplementationOnce(async () => decryptDeferred.promise);

        const fetchPromise = fetchAndApplySessions({
            serverId: 'server-a',
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys,
            sessionDataKeyEnvelopes,
            request: requestSpy,
            applySessions: vi.fn(),
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        await expect.poll(() => decryptEncryptionKeys.mock.calls.length).toBe(1);
        scope.bumpGeneration();
        decryptDeferred.resolve([null]);
        await fetchPromise;

        expect(sessionDataKeys.get('s_deleted_mid_batch')).toBe(cachedKey);
        expect(sessionDataKeyEnvelopes.get('s_deleted_mid_batch')).toBe('old-deleted-envelope');
        expect(initializeSessions).not.toHaveBeenCalled();
    });

    it('does not overwrite data-key caches when key rotation invalidates generation mid-batch', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({ id: 's_rotated_mid_batch', dataEncryptionKey: 'rotated-envelope' }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );
        const { encryption, decryptEncryptionKeys, initializeSessions } = createEncryptionHarness();
        const scope = attachNativeWorkerScopeHarness(encryption);
        const cachedKey = new Uint8Array([6, 6, 6]);
        const sessionDataKeys = new Map<string, Uint8Array>([
            ['s_rotated_mid_batch', cachedKey],
        ]);
        const sessionDataKeyEnvelopes = new Map<string, string>([
            ['s_rotated_mid_batch', 'old-rotated-envelope'],
        ]);
        const decryptDeferred = createDeferred<Array<Uint8Array | null>>();
        decryptEncryptionKeys.mockImplementationOnce(async () => decryptDeferred.promise);

        const fetchPromise = fetchAndApplySessions({
            serverId: 'server-a',
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys,
            sessionDataKeyEnvelopes,
            request: requestSpy,
            applySessions: vi.fn(),
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        await expect.poll(() => decryptEncryptionKeys.mock.calls.length).toBe(1);
        scope.bumpGeneration();
        decryptDeferred.resolve([new Uint8Array([7, 7, 7])]);
        await fetchPromise;

        expect(sessionDataKeys.get('s_rotated_mid_batch')).toBe(cachedKey);
        expect(sessionDataKeyEnvelopes.get('s_rotated_mid_batch')).toBe('old-rotated-envelope');
        expect(initializeSessions).not.toHaveBeenCalled();
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

        const { encryption, decryptEncryptionKey, decryptEncryptionKeys, initializeSessions, decryptMetadata, decryptAgentState } =
            createEncryptionHarness();
        const credentials: AuthCredentials = { token: 't', secret: 's' };
        const appliedSessions: Array<Record<string, unknown>> = [];
        const sessionDataKeys = new Map<string, Uint8Array>();

        await fetchAndApplySessions({
            credentials,
            encryption,
            sessionDataKeys,
            request: requestSpy,
            sessionListMaxPages: 2,
            applySessions: (sessions) => {
                appliedSessions.push(...(sessions as unknown as Array<Record<string, unknown>>));
            },
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(requestSpy).toHaveBeenCalledTimes(2);
        expect(decryptEncryptionKey).not.toHaveBeenCalled();
        expectDecryptEncryptionKeysCall(decryptEncryptionKeys, ['k2', 'k0']);
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

    it('does not repair read state for a stale hydrated session skipped before apply', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_stale_read_state',
                        seq: 1,
                        metadata: 'meta-stale-read-state',
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption, decryptMetadata } = createEncryptionHarness();
        decryptMetadata.mockResolvedValue({ readStateV1: { sessionSeq: 5 } });
        const applySessions = vi.fn();
        const repairInvalidReadStateV1 = vi.fn(async () => {});

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            getCurrentSessionListRenderable: () => null,
            applySessions,
            repairInvalidReadStateV1,
            log: { log: () => {} },
        });

        expect(applySessions).not.toHaveBeenCalled();
        expect(repairInvalidReadStateV1).not.toHaveBeenCalled();
    });

    it('reuses cached session data keys only when the encrypted envelope is unchanged', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_cached',
                        dataEncryptionKey: 'cached-envelope',
                    }),
                    buildSessionRow({
                        id: 's_rotated',
                        dataEncryptionKey: 'new-envelope',
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption, decryptEncryptionKey, decryptEncryptionKeys, initializeSessions } = createEncryptionHarness();
        const cachedKey = new Uint8Array([9, 9, 9]);
        const rotatedCachedKey = new Uint8Array([1, 1, 1]);
        const sessionDataKeys = new Map<string, Uint8Array>([
            ['s_cached', cachedKey],
            ['s_rotated', rotatedCachedKey],
        ]);
        const sessionDataKeyEnvelopes = new Map<string, string>([
            ['s_cached', 'cached-envelope'],
            ['s_rotated', 'old-envelope'],
        ]);

        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys,
            sessionDataKeyEnvelopes,
            request: requestSpy,
            applySessions: () => {},
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(decryptEncryptionKey).not.toHaveBeenCalled();
        expectDecryptEncryptionKeysCall(decryptEncryptionKeys, ['new-envelope']);
        expectInitializeSessionsCall(initializeSessions, [
            ['s_cached', cachedKey],
            ['s_rotated', new Uint8Array(['new-envelope'.length])],
        ]);
        expect(sessionDataKeys.get('s_cached')).toBe(cachedKey);
        expect(sessionDataKeys.get('s_rotated')).toEqual(new Uint8Array(['new-envelope'.length]));
        expect(sessionDataKeyEnvelopes.get('s_cached')).toBe('cached-envelope');
        expect(sessionDataKeyEnvelopes.get('s_rotated')).toBe('new-envelope');

        const decryptDataKeysEvent = syncPerformanceTelemetry.snapshot().events.find(
            (event) => event.name === 'sync.sessions.snapshot.decryptDataKeys',
        );
        expect(decryptDataKeysEvent?.fields.cached).toBe(1);
        expect(decryptDataKeysEvent?.fields.decrypts).toBe(1);
    });

    it('does not clear plain data-key caches after the server scope has been reset', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 'plain_reset',
                        encryptionMode: 'plain',
                        dataEncryptionKey: 'stale-plain-envelope',
                        metadata: JSON.stringify({ path: '/plain-reset' }),
                        agentState: JSON.stringify({}),
                    }),
                    buildSessionRow({
                        id: 'encrypted_reset',
                        encryptionMode: 'e2ee',
                        dataEncryptionKey: 'fresh-envelope',
                        metadata: 'encrypted-metadata',
                        metadataVersion: 2,
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption, initializeSessions } = createEncryptionHarness();
        const stalePlainKey = new Uint8Array([7, 7, 7]);
        const sessionDataKeys = new Map<string, Uint8Array>([
            ['plain_reset', stalePlainKey],
        ]);
        const sessionDataKeyEnvelopes = new Map<string, string>([
            ['plain_reset', 'stale-plain-envelope'],
        ]);
        const applySessions = vi.fn();

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys,
            sessionDataKeyEnvelopes,
            request: requestSpy,
            shouldContinue: () => false,
            applySessions,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(sessionDataKeys.get('plain_reset')).toBe(stalePlainKey);
        expect(sessionDataKeyEnvelopes.get('plain_reset')).toBe('stale-plain-envelope');
        expect(sessionDataKeys.has('encrypted_reset')).toBe(false);
        expect(sessionDataKeyEnvelopes.has('encrypted_reset')).toBe(false);
        expect(initializeSessions).not.toHaveBeenCalled();
        expect(applySessions).not.toHaveBeenCalled();
    });

    it.each([401, 403] as const)('throws terminal auth for session list status %s', async (status) => {
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
        });
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

    it('completes a required-row wait when a newer update supersedes the required row mid-hydration', async () => {
        // The required-row gate exists so a caller that names `requiredHydrationSessionIds` never
        // observes a half-applied list. A row that is superseded by strictly newer state while it
        // decrypted has a terminal, already-applied disposition (the stale patch below), so the
        // refresh completed. Reporting it as a failed refresh made the resume tail repeat the whole
        // session-list refresh — the second foreground catch-up wave measured on device.
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_superseded',
                        dataEncryptionKey: 'k-superseded',
                        metadata: 'meta-superseded',
                        metadataVersion: 2,
                        seq: 2,
                        updatedAt: 2,
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption, decryptMetadata } = createEncryptionHarness();
        let currentRenderables: Record<string, SessionListRenderableSession> = {};
        const applySessionListRenderables = vi.fn((sessions: SessionListRenderableSession[]) => {
            currentRenderables = Object.fromEntries(sessions.map((session) => [session.id, session]));
        });
        const applySessionListRenderablePatches = vi.fn();
        // A socket update for the same session lands while the required row is still decrypting.
        decryptMetadata.mockImplementation(async (_version: number, encrypted: string) => {
            currentRenderables.s_superseded = {
                ...currentRenderables.s_superseded,
                seq: 9,
                updatedAt: 9,
                metadataVersion: 9,
            } as SessionListRenderableSession;
            return { decrypted: encrypted };
        });
        const applySessions = vi.fn();

        const result = await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            applySessionListRenderables,
            applySessionListRenderablePatches,
            getCurrentSessionListRenderable: (sessionId) => currentRenderables[sessionId],
            cachedSessionListEntries: {},
            awaitSessionListHydration: true,
            requiredHydrationSessionIds: ['s_superseded'],
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(result.sessionIds).toEqual(['s_superseded']);
        // The superseded row is not re-applied over the newer state that overtook it.
        expect(applySessions).not.toHaveBeenCalled();
    });
});
