import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { createCompactSessionListFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { AgentStateSchema } from '@happier-dev/session-core/state';
import { createSessionDataKeyFixture } from '@/dev/testkit';
import { encodeBase64 } from '@/encryption/base64';
import {
    buildSessionListRenderableFromSession,
    preserveSessionListRenderableStaleFields,
    type SessionListRenderableSession,
} from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { SessionListCacheEntryV1Schema, type SessionListCacheEntryV1 } from '@/sync/domains/state/warmCachePersistence';
import { buildSessionListCacheEntriesFromRenderables } from '@/sync/domains/state/warmCacheAdapters';
import { Encryption } from '@/sync/encryption/encryption';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { HappyError } from '@/utils/errors/errors';
import {
    createPlainSessionOwnerMetadataEnvelopeV1,
    projectSessionSharedMetadataV1,
    SessionOwnerMetadataV1Schema} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import {
    encodeV2SessionListCursorV1,
    V2SessionRecordSchema,
    type V2SessionRecord,
} from '@happier-dev/protocol/sessions/control/contract';
import {
    projectLegacySessionAccessCapabilitiesV1} from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import {
    type AccountEncryptionCurrentnessResponse} from '@happier-dev/protocol/account/encryptionMode';

import {
    buildRenderableFromRowAndCache,
    fetchAndApplySessions as fetchAndApplySessionsSource,
    type SessionListEncryption,
} from './sessionSnapshot';

const PLAIN_ACCOUNT_CURRENTNESS = {
    mode: 'plain',
    version: 1,
    signingKeyFingerprint: null,
    contentKeyFingerprint: null,
    updatedAt: 1,
    recipientEnvelopeReadiness: {
        status: 'unavailable',
        reason: 'plain_account',
    },
} satisfies AccountEncryptionCurrentnessResponse;

const E2EE_ACCOUNT_CURRENTNESS = {
    mode: 'e2ee',
    version: 2,
    signingKeyFingerprint: 'signing-current',
    contentKeyFingerprint: 'content-current',
    updatedAt: 2,
    recipientEnvelopeReadiness: { status: 'available' },
} satisfies AccountEncryptionCurrentnessResponse;

function fetchAndApplySessions(
    params: Omit<
        Parameters<typeof fetchAndApplySessionsSource>[0],
        'accountCurrentness'
    > & Readonly<{
        accountCurrentness?: AccountEncryptionCurrentnessResponse;
    }>,
) {
    return fetchWithoutDefaultCurrentness({ ...params,
        accountCurrentness: params.accountCurrentness ?? PLAIN_ACCOUNT_CURRENTNESS });
}

function fetchWithoutDefaultCurrentness(params: Parameters<typeof fetchAndApplySessionsSource>[0]) {
    const request = params.request;
    return fetchAndApplySessionsSource({
        ...params,
        ...(request ? { request: createCompactSessionListFetchBoundary(async (path, init) => path === '/v2/sessions/read-batch'
            ? undefined : request(path, init)) } : {}),
    });
}

const onAgentRequest = vi.fn();
const OWNER_METADATA_CIPHERTEXT =
    'oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==';

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
    getActiveServerHomeCarrier: () => null,
    // The fixed active server never changes here; module-level readers still subscribe (192e2b47e5).
    subscribeActiveServer: () => () => {},
}));

type SessionRow = V2SessionRecord;
type FetchAndApplySessionsParams = Parameters<typeof fetchAndApplySessions>[0];
type TestNativeCryptoWorker = NonNullable<Parameters<Encryption['configureNativeCryptoWorker']>[0]['worker']>;
const TEST_NATIVE_CRYPTO_WORKER_PROBE_OK_FAILURE_REASON = 0;

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

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
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
    decryptMetadataPayload: ReturnType<typeof vi.fn>;
    decryptAgentState: ReturnType<typeof vi.fn>;
} {
    const decryptEncryptionKeys = vi.fn(async (values: readonly string[], _scope?: { signal?: AbortSignal }) =>
        values.map((value) => createSessionDataKeyFixture(value.length)),
    );
    const decryptEncryptionKey = vi.fn(async (value: string) => {
        const [decrypted] = await decryptEncryptionKeys([value]);
        return decrypted ?? null;
    });
    // Mirrors the real Encryption boundary: a Session reader exists only after initializeSessions
    // opened it (and until it is removed). Returning a reader for every id would make each plain
    // row look like an admitted E2EE Session, which the mode admission refuses as a downgrade.
    const openedSessionIds = new Set<string>();
    const initializeSessions = vi.fn(async (sessions: Map<string, Uint8Array | null>) => {
        for (const sessionId of sessions.keys()) openedSessionIds.add(sessionId);
    });
    const removeSessionEncryption = vi.fn((sessionId: string) => { openedSessionIds.delete(sessionId); });
    const decryptMetadata = vi.fn(async (_version: number, value: string) => ({ decrypted: value }));
    const decryptMetadataPayload = vi.fn(async (_version: number, value: string) => ({ decrypted: value }));
    const decryptAgentState = vi.fn(async (_version: number, _value: string | null | undefined) => null);
    const sessionReader = {
        decryptMetadata,
        decryptMetadataPayload,
        decryptAgentState,
        // Keep scheduler gates at the crypto boundary while honoring the typed full-document result.
        decryptAgentStateResult: vi.fn(async (version: number, value: string | null | undefined) => value === undefined
            ? { status: 'unavailable' as const }
            : { status: 'available' as const, value: await decryptAgentState(version, value) }),
    };
    const getSessionEncryption = vi.fn((sessionId: string) => openedSessionIds.has(sessionId) ? sessionReader : null);
    const encryption: EncryptionHarnessEncryption = {
        decryptEncryptionKey,
        decryptEncryptionKeys,
        initializeSessions,
        removeSessionEncryption,
        getSessionEncryption,
    };
    return {
        encryption,
        decryptEncryptionKey,
        decryptEncryptionKeys,
        initializeSessions,
        removeSessionEncryption,
        getSessionEncryption,
        decryptMetadata,
        decryptMetadataPayload,
        decryptAgentState,
    };
}

async function openSessionFixture(request: () => Promise<Response>, fixture: Session): Promise<Session> {
    const body: unknown = await (await request()).json();
    if (!body || typeof body !== 'object' || !('sessions' in body) || !Array.isArray(body.sessions)) {
        throw new Error('Expected full external Session source facts');
    }
    const source = body.sessions.map(row => V2SessionRecordSchema.parse(row)).find(row => row.id === fixture.id);
    if (!source) throw new Error('Missing Session fixture source');
    // This is the earlier external revision, opened through the production reader before the measured refresh.
    const row = { ...source, metadataVersion: fixture.metadataVersion, agentStateVersion: fixture.agentStateVersion,
        ...(source.encryptionMode === 'plain' ? { metadata: JSON.stringify(fixture.metadata),
            agentState: fixture.agentState == null ? null : JSON.stringify(fixture.agentState) } : {}) };
    const { encryption, decryptMetadata, decryptAgentState } = createEncryptionHarness();
    decryptMetadata.mockResolvedValue(fixture.metadata);
    decryptAgentState.mockResolvedValue(fixture.agentState);
    let opened: Session | undefined;
    await fetchAndApplySessions({ credentials: { token: 't', secret: 's' }, encryption,
        sessionDataKeys: new Map(), request: async () => jsonResponse({ sessions: [row], nextCursor: null, hasNext: false }),
        applySessions: sessions => { opened = sessions[0]; }, log: { log() {} } });
    if (!opened) throw new Error('Session fixture did not open');
    return opened;
}

function cacheOpenedSession(session: Session): SessionListCacheEntryV1 {
    const entry = buildSessionListCacheEntriesFromRenderables({ [session.id]: buildSessionListRenderableFromSession(session) })[session.id];
    return SessionListCacheEntryV1Schema.parse(JSON.parse(JSON.stringify(entry)));
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

function attachEncryptionGenerationScopeHarness(
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
        switchServer: (nextServerId) => {
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

function staleCacheEntry(
    sessionId: string,
    path: string,
): NonNullable<FetchAndApplySessionsParams['cachedSessionListEntries']>[string] {
    return {
        sessionId,
        metadataVersion: 1,
        agentStateVersion: 0,
        updatedAt: 1,
        createdAt: 1,
        active: true,
        activeAt: 1,
        archivedAt: null,
        path,
    };
}

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    syncPerformanceTelemetry.configure({ enabled: false });
});

describe('fetchAndApplySessions (/v2/sessions snapshot)', () => {
    it('prefers matching hydrated Agent identity over a same-version compact cache', async () => {
        const row = buildSessionRow({ id: 's_agent_identity', metadataVersion: 7, dataEncryptionKey: 'dek-agent-identity' });
        // Only a Session opened through the production reader carries document admission.
        const existing = await openSessionFixture(async () => jsonResponse({ sessions: [row], nextCursor: null, hasNext: false }),
            buildExistingSession({ id: row.id, metadataVersion: 7,
                metadata: { path: '/repo', host: 'home', flavor: 'claude', runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: {}, provider: {} } } }));
        const cached = { ...staleCacheEntry(row.id, '/repo'), metadataVersion: 7, flavor: 'claude' };
        expect(buildRenderableFromRowAndCache(row, { token: 't', secret: 's' },
            PLAIN_ACCOUNT_CURRENTNESS, cached, existing).metadata?.flavor).toBe('codex');
    });


    it('hydrates plaintext sessions for token-only accounts without an account encryption runtime', async () => {
        const row = buildSessionRow({
            id: 's_token_only_plain',
            encryptionMode: 'plain',
            metadata: JSON.stringify({ path: '/plain/project', host: 'plain-host' }),
            agentState: JSON.stringify({}),
        });
        const applySessions = vi.fn();

        await fetchAndApplySessions({
            credentials: { token: 'token-only' },
            encryption: null,
            sessionDataKeys: new Map(),
            request: vi.fn(async () => jsonResponse({
                sessions: [row],
                nextCursor: null,
                hasNext: false,
            })),
            applySessions,
            log: { log: () => {} },
        });

        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's_token_only_plain',
                encryptionMode: 'plain',
                metadata: expect.objectContaining({
                    path: '/plain/project',
                    host: 'plain-host',
                }),
            }),
        ]);
    });

    it('preserves omitted lifecycle facts as unobserved while hydrating a session row', async () => {
        const row = buildSessionRow({
            id: 's_unobserved_lifecycle',
            encryptionMode: 'plain',
            metadata: JSON.stringify({ path: '/plain/project', host: 'plain-host' }),
            agentState: JSON.stringify({}),
        });
        const applySessions = vi.fn();

        await fetchAndApplySessions({
            credentials: { token: 'token-only' },
            encryption: null,
            sessionDataKeys: new Map(),
            request: vi.fn(async () => jsonResponse({
                sessions: [row],
                nextCursor: null,
                hasNext: false,
            })),
            applySessions,
            log: { log: () => {} },
        });

        const hydrated = applySessions.mock.calls[0]?.[0]?.[0];
        expect(hydrated).not.toHaveProperty('latestTurnStatus');
        expect(hydrated).not.toHaveProperty('latestTurnStatusObservedAt');
    });

    it('hydrates plaintext layout-v1 owner metadata and authoritative Agent state without account material', async () => {
        const sharedMetadata = projectSessionSharedMetadataV1({
            metadata: {
                summary: { text: 'Shared title', updatedAt: 10 },
            },
        });
        const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
            v: 1,
            workspace: {
                path: '/plain/private-worktree',
                machineId: 'plain-owner-machine',
            },
        });
        const agentState = AgentStateSchema.parse({
            controlledByUser: false,
            requests: {
                privateRequest: { tool: 'owner-only', arguments: {} },
            },
        });
        const row = buildSessionRow({
            id: 's_token_only_layout1_owner',
            encryptionMode: 'plain',
            metadataLayoutVersion: 1,
            metadata: JSON.stringify(sharedMetadata),
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata),
            agentStateVersion: 7,
            agentState: JSON.stringify(agentState),
        });
        const applySessions = vi.fn();

        await fetchAndApplySessions({
            credentials: { token: 'token-only' },
            encryption: null,
            sessionDataKeys: new Map(),
            request: vi.fn(async () => jsonResponse({
                sessions: [row],
                nextCursor: null,
                hasNext: false,
            })),
            applySessions,
            awaitSessionListHydration: true,
            requiredHydrationSessionIds: [row.id],
            log: { log: () => {} },
        });

        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({
                id: row.id,
                metadata: sharedMetadata,
                ownerMetadataView: expect.objectContaining({
                    path: '/plain/private-worktree',
                    machineId: 'plain-owner-machine',
                }),
                agentState,
                agentStateVersion: 7,
            }),
        ]);
    });

    it('loads identity once through an unbound list request without exporting an exact Account witness', async () => {
        const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
            v: 1,
            workspace: { path: '/plain/private-worktree' },
        });
        const ownerRow = buildSessionRow({
            id: 's_owner_currentness',
            encryptionMode: 'plain',
            metadataLayoutVersion: 1,
            metadata: JSON.stringify({ v: 1 }),
            ownerMetadata:
                createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata),
        });
        const request = vi.fn(async (path: string) => {
            if (path === '/v1/account/encryption/currentness') {
                return jsonResponse(PLAIN_ACCOUNT_CURRENTNESS);
            }
            return jsonResponse({
                sessions: [ownerRow],
                nextCursor: null,
                hasNext: false,
            });
        });

        const result = await fetchWithoutDefaultCurrentness({
            credentials: { token: 'scoped-token' },
            encryption: null,
            sessionDataKeys: new Map(),
            request,
            applySessions: vi.fn(),
            awaitSessionListHydration: true,
            requiredHydrationSessionIds: [ownerRow.id],
            log: { log: () => {} },
        });

        expect(result.accountCurrentness).toBeUndefined();
        expect(request.mock.calls.filter(
            ([path]) => path === '/v1/account/encryption/currentness',
        )).toHaveLength(1);

        const legacyRequest = vi.fn(async () => jsonResponse({
            sessions: [buildSessionRow({
                id: 's_layout0',
                encryptionMode: 'plain',
                metadata: JSON.stringify({ path: '/legacy' }),
            })],
            nextCursor: null,
            hasNext: false,
        }));
        await fetchWithoutDefaultCurrentness({
            credentials: { token: 'scoped-token' },
            encryption: null,
            sessionDataKeys: new Map(),
            request: legacyRequest,
            applySessions: vi.fn(),
            awaitSessionListHydration: true,
            log: { log: () => {} },
        });
        expect(legacyRequest).not.toHaveBeenCalledWith(
            '/v1/account/encryption/currentness',
            expect.anything(),
        );
    });

    it('treats layout-v1 recipient hydration as an authoritative privacy contraction over newer private cache state', async () => {
        const row = buildSessionRow({
            id: 's_privacy_contraction',
            encryptionMode: 'plain',
            metadataLayoutVersion: 1,
            metadataVersion: 1,
            metadata: JSON.stringify({
                v: 1,
                summary: { text: 'Safe title', updatedAt: 10 },
            }),
            ownerMetadata: undefined,
            agentStateVersion: 7,
            agentState: null,
            share: {
                accessLevel: 'view',
                canApprovePermissions: false,
            },
            effectiveAccess: { v: 1, level: 'view', sources: [{ kind: 'direct', shareId: 'share-view' }],
                capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'view' }) },
            responsibleAccountId: null,
            responsibleAccount: null,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
        } as Partial<SessionRow> & Pick<SessionRow, 'id'>);
        const legacyExternalSession = {
            v: 1,
            agentId: 'codex',
            machineId: 'private-machine',
            remoteSessionId: 'private-native-id',
            source: { kind: 'codexHome', home: 'local' },
        } satisfies NonNullable<SessionListCacheEntryV1['externalSessionV1']>;
        const legacyPrivateMetadata = {
            path: '/private/worktree',
            host: 'private-host',
            machineId: 'private-machine',
            flavor: 'codex',
            externalSessionV1: legacyExternalSession,
        } satisfies NonNullable<Session['metadata']>;
        const cachedSessionListEntries = {
            s_privacy_contraction: {
                sessionId: 's_privacy_contraction',
                seq: 7,
                metadataVersion: 9,
                agentStateVersion: 8,
                updatedAt: 10,
                createdAt: 1,
                active: true,
                activeAt: 10,
                archivedAt: null,
                name: 'Legacy cached title',
                summaryText: null,
                path: legacyPrivateMetadata.path,
                homeDir: '/private',
                host: legacyPrivateMetadata.host,
                machineId: legacyPrivateMetadata.machineId,
                flavor: legacyPrivateMetadata.flavor,
                externalSessionV1: legacyPrivateMetadata.externalSessionV1,
                hasPendingPermissionRequests: true,
                hasPendingUserActionRequests: true,
            },
        } satisfies NonNullable<FetchAndApplySessionsParams['cachedSessionListEntries']>;
        const existingSession = buildExistingSession({
            id: 's_privacy_contraction',
            metadataVersion: 9,
            metadata: legacyPrivateMetadata,
            ownerMetadataView: {
                path: '/private/owner-worktree',
                host: 'private-owner-host',
                machineId: 'private-owner-machine',
                externalSessionV1: legacyExternalSession,
            },
            agentStateVersion: 8,
            agentState: {
                requests: {
                    privateRequest: {
                        tool: 'private-tool',
                        arguments: 'private-tool-arguments',
                    },
                },
            },
        });
        storage.setState(storage.getInitialState(), true);
        storage.getState().applySessions([existingSession]);
        const applySessions = vi.fn((
            sessions: Parameters<FetchAndApplySessionsParams['applySessions']>[0],
        ) => {
            storage.getState().applySessions(sessions);
        });
        const applySessionListRenderables = vi.fn();

        await fetchAndApplySessions({
            credentials: { token: 't', secret: encodeBase64(new Uint8Array(32).fill(3), 'base64url') },
            encryption: createEncryptionHarness().encryption,
            sessionDataKeys: new Map(),
            request: vi.fn(async () => jsonResponse({
                sessions: [row],
                nextCursor: null,
                hasNext: false,
            })),
            applySessions,
            applySessionListRenderables,
            cachedSessionListEntries,
            getExistingSession: () => existingSession,
            awaitSessionListHydration: true,
            requiredHydrationSessionIds: [row.id],
            log: { log: () => {} },
        });

        const hydrated = storage.getState().sessions.s_privacy_contraction;
        expect(hydrated).toBeDefined();
        expect(hydrated.metadata).toEqual({
            v: 1,
            summary: { text: 'Safe title', updatedAt: 10 },
        });
        expect(hydrated.metadataVersion).toBe(1);
        expect(hydrated.ownerMetadataView ?? null).toBeNull();
        expect(hydrated.agentState).toBeNull();
        expect(hydrated.agentStateVersion).toBe(7);
        expect(JSON.stringify(hydrated)).not.toMatch(
            /private-native-id|private-tool-arguments|private-owner-worktree/,
        );

        const rendered = applySessionListRenderables.mock.calls[0]?.[0]?.[0];
        expect(rendered.metadata ?? {}).not.toHaveProperty('path', '/private/worktree');
        expect(rendered.metadata ?? {}).not.toHaveProperty('host', 'private-host');
        expect(rendered.metadata ?? {}).not.toHaveProperty('machineId', 'private-machine');
        expect(rendered.metadata?.externalSessionV1 ?? null).toBeNull();
        expect(rendered.hasPendingPermissionRequests).toBe(false);
        expect(rendered.hasPendingUserActionRequests).toBe(false);
    });

    it('does not fetch Account currentness or Agent state for a shared recipient', async () => {
        const sharedMetadata = projectSessionSharedMetadataV1({
            metadata: {
                summary: { text: 'Shared title', updatedAt: 10 },
            },
        });
        const row = buildSessionRow({
            id: 's_shared_overprojection',
            encryptionMode: 'plain',
            metadataLayoutVersion: 1,
            metadata: JSON.stringify(sharedMetadata),
            ownerMetadata: undefined,
            agentStateVersion: 7,
            agentState: null,
            share: {
                accessLevel: 'edit',
                canApprovePermissions: false,
            },
            effectiveAccess: { v: 1, level: 'edit', sources: [{ kind: 'direct', shareId: 'share-edit' }],
                capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'edit' }) },
            responsibleAccountId: null,
            responsibleAccount: null,
        });
        let currentnessRequests = 0;
        const applySessions = vi.fn();

        await fetchWithoutDefaultCurrentness({
            credentials: { token: 'scoped-token' },
            encryption: null,
            sessionDataKeys: new Map(),
            request: vi.fn(async (path: string) => {
                if (path === '/v1/account/encryption/currentness') {
                    currentnessRequests += 1;
                    return jsonResponse(PLAIN_ACCOUNT_CURRENTNESS);
                }
                return jsonResponse({
                    sessions: [row],
                    nextCursor: null,
                    hasNext: false,
                });
            }),
            applySessions,
            awaitSessionListHydration: true,
            requiredHydrationSessionIds: [row.id],
            log: { log: () => {} },
        });

        expect(currentnessRequests).toBe(0);
        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({
                metadata: sharedMetadata,
                ownerMetadataView: null,
                agentState: null,
            }),
        ]);
    });

    it.each([
        {
            name: 'plain envelope after Account migration to E2EE',
            sessionMode: 'plain' as const,
            accountCurrentness: E2EE_ACCOUNT_CURRENTNESS,
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(
                SessionOwnerMetadataV1Schema.parse({
                    v: 1,
                    workspace: { path: '/old-plain-owner' },
                }),
            ),
        },
        {
            name: 'encrypted envelope after Account migration to plain',
            sessionMode: 'e2ee' as const,
            accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
            ownerMetadata: {
                t: 'encrypted' as const,
                c: OWNER_METADATA_CIPHERTEXT,
            },
        },
    ])('locks $name without preserving cached or current private metadata', async ({
        sessionMode,
        accountCurrentness,
        ownerMetadata,
    }) => {
        const id = `s_mismatch_${sessionMode}`;
        const sharedMetadata = projectSessionSharedMetadataV1({
            metadata: {
                summary: { text: 'Shared title', updatedAt: 10 },
            },
        });
        const row = buildSessionRow({
            id,
            encryptionMode: sessionMode,
            metadataLayoutVersion: 1,
            metadataVersion: 5,
            metadata: sessionMode === 'plain'
                ? JSON.stringify(sharedMetadata)
                : 'encrypted-shared-metadata',
            ownerMetadata,
            agentStateVersion: 5,
            agentState: sessionMode === 'plain'
                ? JSON.stringify({ requests: { private: true } })
                : 'encrypted-private-agent-state',
            dataEncryptionKey: sessionMode === 'plain' ? null : 'encrypted-dek',
            share: null,
        });
        const privateMetadata = {
            path: '/private/stale-worktree',
            host: 'private-stale-host',
            machineId: 'private-stale-machine',
        };
        const existingSession = buildExistingSession({
            id,
            metadataLayoutVersion: 1,
            metadataVersion: 4,
            metadata: privateMetadata,
            ownerMetadataView: privateMetadata,
            agentStateVersion: 4,
            agentState: {
                requests: {
                    private: {
                        tool: 'private-tool',
                        arguments: {},
                    },
                },
            },
        });
        const currentRenderable = buildSessionListRenderableFromSession(
            existingSession,
        );
        const cachedSessionListEntries = {
            [id]: {
                sessionId: id,
                seq: 1,
                metadataLayoutVersion: 1,
                metadataVersion: 4,
                agentStateVersion: 4,
                updatedAt: 1,
                createdAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                name: 'Private stale title',
                summaryText: null,
                path: privateMetadata.path,
                homeDir: '/private',
                host: privateMetadata.host,
                machineId: privateMetadata.machineId,
                flavor: 'codex',
                externalSessionV1: null,
                hasPendingPermissionRequests: true,
                hasPendingUserActionRequests: true,
            },
        } satisfies NonNullable<FetchAndApplySessionsParams['cachedSessionListEntries']>;
        const encryptionHarness = createEncryptionHarness();
        encryptionHarness.decryptMetadataPayload.mockResolvedValue(
            sharedMetadata,
        );
        storage.setState(storage.getInitialState(), true);
        storage.getState().applySessions([existingSession]);
        storage.getState().applyServerScopedSessionListRows('test', [currentRenderable], { source: 'rowOnly', mode: 'replace' });
        const applySessions = vi.fn((sessions: Parameters<FetchAndApplySessionsParams['applySessions']>[0]) => storage.getState().applySessions(sessions));
        const applySessionListRenderables = vi.fn((rows: SessionListRenderableSession[]) =>
            storage.getState().applyServerScopedSessionListRows('test', rows, { source: 'rowOnly', mode: 'replace' }));

        await fetchAndApplySessions({
            serverId: 'test',
            credentials: { token: 't', secret: 's' },
            accountCurrentness,
            encryption: encryptionHarness.encryption,
            sessionDataKeys: new Map(),
            request: vi.fn(async () => jsonResponse({
                sessions: [row],
                nextCursor: null,
                hasNext: false,
            })),
            cachedSessionListEntries,
            getExistingSession: () => storage.getState().sessions[id],
            getCurrentSessionListRenderable: () => storage.getState().sessionListRowsByServerId.test?.[id],
            applySessions,
            applySessionListRenderables,
            applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches('test', patches),
            awaitSessionListHydration: true,
            requiredHydrationSessionIds: [id],
            log: { log: () => {} },
        });

        const rendered = storage.getState().sessionListRowsByServerId.test?.[id];
        expect(rendered).toEqual(expect.objectContaining({
            metadata: null,
            metadataVersion: 5,
            metadataUnavailable: true,
        }));
        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({
                metadata: null,
                ownerMetadataView: null,
                agentState: null,
                // The locked shell states a settled content fact; an unset one read as locked in
                // the list and readable in the detail pane.
                encryptedContentAvailability: expect.any(String),
            }),
        ]);
        expect(encryptionHarness.decryptAgentState).not.toHaveBeenCalled();
        expect(JSON.stringify({
            renderables: applySessionListRenderables.mock.calls,
            sessions: applySessions.mock.calls,
        })).not.toMatch(/private\/stale|Private stale|private-stale/);
    });

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
        const session = buildSessionRow({
            id: 'cached-session',
            encryptionMode: 'plain',
            metadata: JSON.stringify({ path: '/cached', host: 'host' }),
            agentState: JSON.stringify({}),
        });
        const requestSpy = vi.fn(async (path: string) => {
            if (path === '/v2/sessions?limit=50') {
                return jsonResponse({ sessions: [session], nextCursor: null, hasNext: false });
            }
            throw new Error(`Unexpected path ${path}`);
        });

        const { encryption } = createEncryptionHarness();
        const log = { log: vi.fn() };

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' } as AuthCredentials,
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions: vi.fn(),
            log,
        });

        expect(log.log).not.toHaveBeenCalled();
    });

    it('ignores legacy client-derived pinned ids when building the initial sessions request', async () => {
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
        const params = {
            credentials: { token: 't', secret: 's' } as AuthCredentials,
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            sessionListPinnedSessionIds: ['s_pinned_outside_first_page'],
            includeSessionListAttentionRows: true,
            applySessions,
            log: { log: () => {} },
        } satisfies FetchAndApplySessionsParams & { sessionListPinnedSessionIds: readonly string[] };

        const result = await fetchAndApplySessions(params);

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

    it('keeps attention continuation at the list frontier until another page is demanded', async () => {
        const requestSpy = vi.fn(async () => jsonResponse({
            sessions: [buildSessionRow({ id: 's_first_attention', encryptionMode: 'plain' })],
            nextCursor: 'ordinary_cursor',
            hasNext: true,
            attentionNextCursor: 'attention_cursor_1',
            attentionHasNext: true,
        }));
        const { encryption } = createEncryptionHarness();

        const result = await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' } as AuthCredentials,
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            includeSessionListAttentionRows: true,
            applySessions: vi.fn(),
            log: { log: () => {} },
        });

        expect(requestSpy.mock.calls).toHaveLength(1);
        expect(result).toMatchObject({
            nextCursor: 'ordinary_cursor',
            hasNext: true,
            attentionNextCursor: 'attention_cursor_1',
            attentionHasNext: true,
        });
        expect(result.sessionIds).toEqual(['s_first_attention']);
    });

    it('drains an explicitly requested attention continuation and deduplicates rows from ordinary pagination', async () => {
        const newerAttention = buildSessionRow({
            id: 's_newer_attention',
            encryptionMode: 'plain',
            metadata: JSON.stringify({ path: '/newer', host: 'host' }),
            agentState: JSON.stringify({}),
        });
        const olderPermission = buildSessionRow({
            id: 's_older_hidden_permission',
            encryptionMode: 'plain',
            metadata: JSON.stringify({
                path: '/hidden',
                host: 'host',
                systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
            }),
            agentState: JSON.stringify({
                requests: {
                    approve: {
                        tool: 'Bash',
                        kind: 'permission',
                        arguments: { command: 'git status' },
                        createdAt: 1,
                    },
                },
            }),
            agentStateVersion: 1,
            pendingPermissionRequestCount: 1,
        });
        const regularRow = buildSessionRow({
            id: 's_regular',
            encryptionMode: 'plain',
            metadata: JSON.stringify({ path: '/regular', host: 'host' }),
            agentState: JSON.stringify({}),
        });
        const requestSpy = vi.fn(async (path: string) => {
            if (path === '/v2/sessions?includeAttention=true&limit=50') {
                return jsonResponse({
                    sessions: [newerAttention, regularRow],
                    nextCursor: 'ordinary_cursor',
                    hasNext: true,
                    attentionNextCursor: 'attention_cursor_1',
                    attentionHasNext: true,
                });
            }
            if (path === '/v2/sessions?limit=50&attentionCursor=attention_cursor_1') {
                return jsonResponse({
                    sessions: [newerAttention, olderPermission],
                    nextCursor: null,
                    hasNext: false,
                    attentionNextCursor: null,
                    attentionHasNext: false,
                });
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
            includeSessionListAttentionRows: true,
            sessionListAttentionMaxPages: 1,
            applySessions,
            log: { log: () => {} },
        });

        expect(requestSpy.mock.calls.map((call) => call[0])).toEqual([
            '/v2/sessions?includeAttention=true&limit=50',
            '/v2/sessions?limit=50&attentionCursor=attention_cursor_1',
        ]);
        expect(result).toMatchObject({
            nextCursor: 'ordinary_cursor',
            hasNext: true,
        });
        expect(result.sessionIds).toEqual([
            's_newer_attention',
            's_regular',
            's_older_hidden_permission',
        ]);
        expect(applySessions.mock.calls[0]?.[0].map((session: { id: string }) => session.id)).toEqual([
            's_newer_attention',
            's_regular',
            's_older_hidden_permission',
        ]);
    });

    it('stops an attention drain when the server repeats a cursor', async () => {
        const attentionRow = buildSessionRow({
            id: 's_attention',
            encryptionMode: 'plain',
            metadata: JSON.stringify({ path: '/attention', host: 'host' }),
            agentState: JSON.stringify({}),
        });
        const requestSpy = vi.fn(async (path: string) => {
            if (path === '/v2/sessions?includeAttention=true&limit=50') {
                return jsonResponse({
                    sessions: [attentionRow],
                    nextCursor: null,
                    hasNext: false,
                    attentionNextCursor: 'attention_cursor_repeat',
                    attentionHasNext: true,
                });
            }
            if (path === '/v2/sessions?limit=50&attentionCursor=attention_cursor_repeat') {
                return jsonResponse({
                    sessions: [attentionRow],
                    nextCursor: null,
                    hasNext: false,
                    attentionNextCursor: 'attention_cursor_repeat',
                    attentionHasNext: true,
                });
            }
            throw new Error(`Unexpected path ${path}`);
        });
        const { encryption } = createEncryptionHarness();

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' } as AuthCredentials,
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            includeSessionListAttentionRows: true,
            sessionListAttentionMaxPages: 2,
            applySessions: vi.fn(),
            log: { log: () => {} },
        });

        expect(requestSpy).toHaveBeenCalledTimes(2);
    });

    it('stops an attention drain at its bounded continuation ceiling', async () => {
        const requestSpy = vi.fn(async (path: string) => {
            const cursor = new URL(path, 'https://example.test').searchParams.get('attentionCursor');
            if (cursor === null) {
                return jsonResponse({
                    sessions: [buildSessionRow({ id: 's_attention_0', encryptionMode: 'plain' })],
                    nextCursor: null,
                    hasNext: false,
                    attentionNextCursor: 'attention_cursor_1',
                    attentionHasNext: true,
                });
            }
            const page = Number(cursor.slice('attention_cursor_'.length));
            return jsonResponse({
                sessions: [buildSessionRow({ id: `s_attention_${page}`, encryptionMode: 'plain' })],
                nextCursor: null,
                hasNext: false,
                attentionNextCursor: `attention_cursor_${page + 1}`,
                attentionHasNext: true,
            });
        });
        const { encryption } = createEncryptionHarness();

        const result = await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' } as AuthCredentials,
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            includeSessionListAttentionRows: true,
            sessionListAttentionMaxPages: 2,
            applySessions: vi.fn(),
            log: { log: () => {} },
        });

        expect(requestSpy).toHaveBeenCalledTimes(3);
        expect(result.sessionIds).toEqual([
            's_attention_0',
            's_attention_1',
            's_attention_2',
        ]);
    });

    it('leaves a failed attention drain unapplied so the next cold sync can retry it', async () => {
        const olderPermission = buildSessionRow({
            id: 's_retry_permission',
            encryptionMode: 'plain',
            metadata: JSON.stringify({ path: '/hidden', host: 'host' }),
            agentState: JSON.stringify({}),
            pendingPermissionRequestCount: 1,
        });
        let failContinuation = true;
        const requestSpy = vi.fn(async (path: string) => {
            if (path === '/v2/sessions?includeAttention=true&limit=50') {
                return jsonResponse({
                    sessions: [],
                    nextCursor: null,
                    hasNext: false,
                    attentionNextCursor: 'attention_cursor_retry',
                    attentionHasNext: true,
                });
            }
            if (path === '/v2/sessions?limit=50&attentionCursor=attention_cursor_retry') {
                if (failContinuation) throw new Error('transient attention failure');
                return jsonResponse({
                    sessions: [olderPermission],
                    nextCursor: null,
                    hasNext: false,
                    attentionNextCursor: null,
                    attentionHasNext: false,
                });
            }
            throw new Error(`Unexpected path ${path}`);
        });
        const { encryption } = createEncryptionHarness();
        const applySessions = vi.fn();
        const params = {
            credentials: { token: 't', secret: 's' } as AuthCredentials,
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            includeSessionListAttentionRows: true,
            sessionListAttentionMaxPages: 1,
            applySessions,
            log: { log: () => {} },
        } satisfies FetchAndApplySessionsParams;

        await expect(fetchAndApplySessions(params)).rejects.toThrow('transient attention failure');
        expect(applySessions).not.toHaveBeenCalled();

        failContinuation = false;
        const result = await fetchAndApplySessions(params);
        expect(result.sessionIds).toEqual(['s_retry_permission']);
        expect(applySessions).toHaveBeenCalledTimes(1);
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

    it('attributes active-row and list-page request timings separately', async () => {
        const requestSpy = vi.fn(async (path: string) => {
            if (path === '/v2/sessions/active?limit=500') {
                return jsonResponse({
                    sessions: [buildSessionRow({ id: 's_active', encryptionMode: 'plain' })],
                    nextCursor: null,
                    hasNext: false,
                });
            }
            if (path === '/v2/sessions?includeAttention=true&limit=50') {
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
            log: { log: () => {} },
        });

        expect(requestSpy.mock.calls.map((call) => call[0])).toEqual([
            '/v2/sessions/active?limit=500',
            '/v2/sessions?includeAttention=true&limit=50',
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

    it('decrypts layout-v1 list metadata without requesting omitted owner Agent state', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 'encrypted_1',
                        encryptionMode: 'e2ee',
                        dataEncryptionKey: 'dek',
                        metadataLayoutVersion: 1,
                        metadata: 'enc-meta',
                        metadataVersion: 2,
                        ownerMetadata: undefined,
                        agentState: null,
                        agentStateVersion: 7,
                        share: {
                            accessLevel: 'view',
                            canApprovePermissions: false,
                        },
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );
        const {
            encryption,
            decryptMetadata,
            decryptMetadataPayload,
            decryptAgentState,
        } = createEncryptionHarness();
        const sharedMetadata = projectSessionSharedMetadataV1({ metadata: {} });
        const metadataDeferred = createDeferred<typeof sharedMetadata>();
        decryptMetadataPayload.mockImplementation(async () => metadataDeferred.promise);

        const applySessions = vi.fn();
        const fetchPromise = fetchAndApplySessions({
            credentials: { token: 't', secret: 's' } as AuthCredentials,
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            log: { log: () => {} },
        });

        try {
            await expect.poll(() => ({
                metadata: decryptMetadataPayload.mock.calls.length,
                agentState: decryptAgentState.mock.calls.length,
            }), { timeout: 100 }).toEqual({ metadata: 1, agentState: 0 });
        } finally {
            metadataDeferred.resolve(sharedMetadata);
            await fetchPromise;
        }

        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 'encrypted_1',
                metadata: sharedMetadata,
                agentState: null,
                agentStateVersion: 7,
            }),
        ]);
        expect(decryptMetadata).not.toHaveBeenCalled();
    });

    it('records snapshot fetch and hydration telemetry when sync performance telemetry is enabled', async () => {
        const requestSpy = vi.fn(async () =>
            new Response(JSON.stringify({
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
            }), {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Server-Timing': 'happier_v2_sessions_cursor;dur=1.500, happier_v2_sessions_query;dur=2.250, happier_v2_sessions_page;dur=0.750, happier_v2_sessions_total;dur=4.500',
                },
            }),
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
            serverTimingCursorMs: 1.5,
            serverTimingQueryMs: 2.25,
            serverTimingPageMs: 0.75,
            serverTimingTotalMs: 4.5,
        }));
        const responseSchemaEvent = events.find((event) => event.name === 'sync.sessions.snapshot.fetchPage.responseSchema');
        expect(responseSchemaEvent?.fields).toEqual(expect.objectContaining({
            loadedSessions: 0,
            limit: 50,
            responseChars: expect.any(Number),
            serverTimingCursorMs: 1.5,
            serverTimingQueryMs: 2.25,
            serverTimingPageMs: 0.75,
            serverTimingTotalMs: 4.5,
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
        // Mode admission consults the reader registry for a reported-plain row; none is open.
        expect(getSessionEncryption.mock.results.every(({ value }) => value === null)).toBe(true);
    });

    it('uses a custom session list path when fetching a secondary snapshot', async () => {
        const requestSpy = vi.fn(async (_path: string, _init: RequestInit) =>
            jsonResponse({
                sessions: [],
                nextCursor: null,
                hasNext: false,
            }),
        );
        const { encryption } = createEncryptionHarness();

        await fetchAndApplySessions({
            sessionListPath: '/v2/sessions/archived',
            credentials: { token: 't', secret: 's' } as AuthCredentials,
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions: () => {},
            log: { log: () => {} },
        });

        expect(requestSpy.mock.calls[0]?.[0]).toBe('/v2/sessions/archived?limit=50');
    });

    it('rejects a full live row that omits the compact document contract', async () => {
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

        await expect(fetchAndApplySessions({
            credentials: { token: 't', secret: 's' } as AuthCredentials,
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions: (sessions) => {
                appliedSessions.push(...(sessions as unknown as Array<Record<string, unknown>>));
            },
            log: { log: () => {} },
        })).rejects.toMatchObject({ code: 'invalid_response' });
        expect(appliedSessions).toEqual([]);
    });

    it('reports a missing current list route without requesting an old full-list endpoint', async () => {
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

        await expect(fetchAndApplySessions({
            credentials: { token: 't', secret: 's' } as AuthCredentials,
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions: (sessions) => {
                appliedSessions.push(...(sessions as unknown as Array<Record<string, unknown>>));
            },
            log: { log: () => {} },
        })).rejects.toMatchObject({ status: 404 });

        expect(requestSpy.mock.calls.map((call) => call[0])).toEqual([
            '/v2/sessions?limit=50',
        ]);
        expect(appliedSessions).toEqual([]);
    });

    it('keeps retained membership and rows untouched when the current list route is unavailable', async () => {
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

        await expect(fetchAndApplySessions({
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
                    externalSessionV1: null,
                    hiddenSystemSession: false,
                    hasPendingPermissionRequests: false,
                    hasPendingUserActionRequests: false,
                },
            },
            log: { log: () => {} },
        })).rejects.toMatchObject({ status: 404 });

        expect(onSnapshotFetched).not.toHaveBeenCalled();
        expect(applySessionListRenderables).not.toHaveBeenCalled();
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
            serverId: 'test',
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
            log: { log: () => {} },
        });

        expect(onAgentRequest).toHaveBeenCalledWith(
            { serverId: 'test', sessionId: 's1' },
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
            serverId: 'test',
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
            log: { log: () => {} },
        });

        expect(onAgentRequest).toHaveBeenCalledWith(
            { serverId: 'test', sessionId: 's1' },
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
                        // A reported-plain row carrying a data-key envelope is a refused mode
                        // downgrade (admitReportedSessionMode); a genuinely plain row has none.
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
            log: { log: () => {} },
        });

	        expect(decryptMetadata).not.toHaveBeenCalled();
	        expect(decryptAgentState).not.toHaveBeenCalled();
        expect(decryptEncryptionKey).not.toHaveBeenCalled();
        expect(decryptEncryptionKeys).not.toHaveBeenCalled();
        expect(initializeSessions).not.toHaveBeenCalled();
	        // Mode admission consults the reader registry for a reported-plain row; none is open.
	        expect(getSessionEncryption.mock.results.every(({ value }) => value === null)).toBe(true);
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
            log: { log: () => {} },
        });

        expect(appliedSessions[0]).toEqual(
            expect.objectContaining({
                id: 's_owned',
                serverId: 'server-owned',
            }),
        );
    });

    it('projects read cursors into first-usable session list renderables', async () => {
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
                        encryptionMode: 'plain',
                        metadata: JSON.stringify({ path: '/repo/unread', host: 'dev' }),
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
        ], { replace: true });
    });

    it('does not mark first-usable non-terminal rows unread from raw seq alone', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_non_displayable_tail',
                        seq: 946,
                        lastViewedSessionSeq: 945,
                        latestTurnStatus: 'in_progress',
                        encryptionMode: 'plain',
                        metadata: JSON.stringify({ path: '/repo/tail', host: 'dev' }),
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
            log: { log: () => {} },
        });

        expect(applySessionListRenderables).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's_non_displayable_tail',
                lastViewedSessionSeq: 945,
                hasUnreadMessages: false,
            }),
        ], { replace: true });
    });

    it('preserves cached unread for first-usable non-terminal rows when readable transcript activity is unavailable', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_cached_unread_tail',
                        seq: 946,
                        lastViewedSessionSeq: 945,
                        latestTurnStatus: 'in_progress',
                        encryptionMode: 'plain',
                        metadataVersion: 2,
                        agentStateVersion: 0,
                        metadata: JSON.stringify({ path: '/repo/tail', host: 'dev' }),
                        agentState: JSON.stringify({}),
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption } = createEncryptionHarness();
        const applySessionListRenderables = vi.fn();

        const admittedSession = await openSessionFixture(requestSpy, buildExistingSession({
            id: 's_cached_unread_tail', metadataVersion: 2, metadata: { path: '/repo/tail', host: 'dev' },
        }));
        const cachedEntry = { ...cacheOpenedSession(admittedSession), hasUnreadMessages: true };

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions: () => {},
            applySessionListRenderables,
            cachedSessionListEntries: { s_cached_unread_tail: cachedEntry },
            log: { log: () => {} },
        });

        expect(applySessionListRenderables).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's_cached_unread_tail',
                lastViewedSessionSeq: 945,
                hasUnreadMessages: true,
            }),
        ], { replace: true });
    });

    it('preserves current ready metadata for first-usable non-terminal rows when v2 refetch omits it', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_ready_refetch',
                        seq: 10,
                        lastViewedSessionSeq: 8,
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
        // The current renderable must come from the production reader: a hand-built row has no
        // document admission, so the custody boundary would rightly refuse to carry it forward.
        const admittedSession = await openSessionFixture(requestSpy, buildExistingSession({
            id: 's_ready_refetch', metadataVersion: 1, agentStateVersion: 1, metadata: { path: '/repo/ready', host: 'dev' },
        }));
        const currentRenderable: SessionListRenderableSession = { ...buildSessionListRenderableFromSession(admittedSession),
            latestReadyEventSeq: 9, latestReadyEventAt: 9_000, hasUnreadMessages: true };

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions: () => {},
            applySessionListRenderables,
            getCurrentSessionListRenderable: (sessionId) => sessionId === 's_ready_refetch' ? currentRenderable : null,
            log: { log: () => {} },
        });

        expect(applySessionListRenderables).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's_ready_refetch',
                latestReadyEventSeq: 9,
                latestReadyEventAt: 9_000,
                hasUnreadMessages: true,
            }),
        ], { replace: true });
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
                        runtimeActivityState: 'active',
                        runtimeActivityActiveCount: 1,
                        runtimeActivityObservedAt: 2_300,
                        runtimeActivityRevision: 9_999,
                        rollbackEligibleTurnStarts: [1, 3],
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
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: 2_300,
                runtimeActivityRevision: 9_999,
                rollbackEligibleTurnStarts: [1, 3],
                hasPendingPermissionRequests: true,
                hasUnreadMessages: true,
            }),
        ], { replace: true });
        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's_row_projection',
                thinking: true,
                thinkingAt: 2_000,
                pendingRequestObservedAt: 2_100,
                latestReadyEventSeq: 9,
                latestReadyEventAt: 2_200,
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: 2_300,
                runtimeActivityRevision: 9_999,
                rollbackEligibleTurnStarts: [1, 3],
            }),
        ]);
    });

    it('hydrates an explicitly demanded cold plain permission row into the canonical session store', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_cold_permission',
                        seq: 2,
                        encryptionMode: 'plain',
                        metadata: JSON.stringify({ path: '/repo/cold-permission', host: 'dev' }),
                        metadataVersion: 1,
                        agentState: JSON.stringify({
                            controlledByUser: null,
                            requests: {
                                approve: {
                                    tool: 'Bash',
                                    kind: 'permission',
                                    arguments: { command: 'git status' },
                                    createdAt: 10,
                                },
                            },
                        }),
                        agentStateVersion: 1,
                        pendingPermissionRequestCount: 1,
                        pendingUserActionRequestCount: 0,
                        pendingRequestObservedAt: 10,
                        lastViewedSessionSeq: 2,
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );
        const { encryption } = createEncryptionHarness();
        const applySessions = vi.fn();
        let currentRenderables: Record<string, SessionListRenderableSession> = {};

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            applySessionListRenderables: (renderables) => {
                currentRenderables = Object.fromEntries(renderables.map((renderable) => [renderable.id, renderable]));
            },
            getCurrentSessionListRenderable: (sessionId) => currentRenderables[sessionId] ?? null,
            priorityHydrationSessionIds: ['s_cold_permission'],
            sessionListBackgroundHydrationYield: async () => {},
            sessionListBackgroundHydrationApplyFlushDelayMs: 0,
            log: { log: () => {} },
        });

        await expect.poll(() => applySessions.mock.calls.flatMap(
            (call) => call[0].map((session: { id: string }) => session.id),
        )).toEqual(['s_cold_permission']);
        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's_cold_permission',
                agentState: expect.objectContaining({
                    requests: {
                        approve: expect.objectContaining({
                            kind: 'permission',
                            tool: 'Bash',
                        }),
                    },
                }),
            }),
        ]);
    });

    it('builds non-required plain first-usable renderables from the full plain parse without background hydration', async () => {
        const metadata = {
            name: 'Plain live title',
            summary: { text: 'Live summary', updatedAt: 2_400 },
            path: '/repo/plain-live',
            host: 'dev-host',
            machineId: 'machine-live',
            hiddenSystemSession: true,
        };
        const agentState = {
            requests: {
                req_1: {
                    tool: 'Bash',
                    arguments: { command: 'make test' },
                    createdAt: 2_500,
                },
            },
        };
        const plainRow = buildSessionRow({
            id: 's_plain_fast',
            seq: 11,
            createdAt: 1_000,
            updatedAt: 2_000,
            active: true,
            activeAt: 2_000,
            archivedAt: null,
            encryptionMode: 'plain',
            metadata: JSON.stringify(metadata),
            metadataVersion: 4,
            agentState: JSON.stringify(agentState),
            agentStateVersion: 5,
            pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 0,
            pendingCount: 3,
            pendingBlockedCount: 2,
            pendingVersion: 6,
            lastViewedSessionSeq: 8,
            latestReadyEventSeq: 10,
            latestReadyEventAt: 2_600,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 2_550,
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 2,
            runtimeActivityObservedAt: 2_700,
            runtimeActivityRevision: 3_000,
            rollbackEligibleTurnStarts: [4, 9],
        });
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [plainRow],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption } = createEncryptionHarness();
        const applySessions = vi.fn();
        let currentRenderables: Record<string, SessionListRenderableSession> = {};
        const applySessionListRenderables = vi.fn((renderables: SessionListRenderableSession[]) => {
            currentRenderables = Object.fromEntries(renderables.map((renderable) => [renderable.id, renderable]));
        });
        const expectedRenderable = buildSessionListRenderableFromSession(buildExistingSession({
            id: 's_plain_fast',
            seq: 11,
            createdAt: 1_000,
            updatedAt: 2_000,
            active: true,
            activeAt: 2_000,
            archivedAt: null,
            metadata,
            metadataVersion: 4,
            agentState,
            agentStateVersion: 5,
            pendingCount: 3,
            pendingBlockedCount: 2,
            pendingVersion: 6,
            lastViewedSessionSeq: 8,
            latestReadyEventSeq: 10,
            latestReadyEventAt: 2_600,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 2_550,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
            encryptionMode: 'plain',
            encryptedContentAvailability: 'ready',
            access: {
                role: 'owner',
                level: 'owner',
                capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner' }),
            },
            canApprovePermissions: true,
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 2,
            runtimeActivityObservedAt: 2_700,
            runtimeActivityRevision: 3_000,
            rollbackEligibleTurnStarts: [4, 9],
        }));
        // HTTP supplies durable Session facts, not device-observed runtime presence.
        expectedRenderable.presence = undefined;

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            contentDemand: 'list-projection',
            applySessionListRenderables,
            getCurrentSessionListRenderable: (sessionId) => currentRenderables[sessionId] ?? null,
            cachedSessionListEntries: {
                s_plain_fast: {
                    sessionId: 's_plain_fast',
                    metadataVersion: 3,
                    agentStateVersion: 4,
                    updatedAt: 1_500,
                    createdAt: 1_000,
                    active: true,
                    activeAt: 1_500,
                    archivedAt: null,
                    name: 'Cached stale title',
                    path: '/repo/stale',
                    host: 'stale-host',
                    hasPendingPermissionRequests: false,
                    hasPendingUserActionRequests: false,
                },
            },
            sessionListBackgroundHydrationYield: vi.fn(async () => {}),
            awaitSessionListHydration: true,
            log: { log: () => {} },
        });

        expect(currentRenderables.s_plain_fast).toMatchObject(expectedRenderable);
        expect(applySessions).not.toHaveBeenCalled();
    });

    it('reuses canonical Session details without decrypting matching warm rows', async () => {
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

        const admittedSession = await openSessionFixture(requestSpy, buildExistingSession({
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
            }));

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            onSnapshotFetched,
            priorityHydrationSessionIds: ['s_cached'],
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
                    externalSessionV1: {
                        v: 1,
                        agentId: 'codex',
                        machineId: 'm1',
                        remoteSessionId: 'remote-cached',
                        source: { kind: 'codexHome', home: 'user' },
                    },
                    hiddenSystemSession: false,
                    hasPendingPermissionRequests: false,
                    hasPendingUserActionRequests: true,
                },
            } satisfies NonNullable<FetchAndApplySessionsParams['cachedSessionListEntries']>,
            applySessionListRenderables,
            getExistingSession: () => admittedSession,
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
                    externalSessionV1: null,
                    hiddenSystemSession: false,
                }),
            }),
        ], { replace: true });
    });

    it('hydrates explicitly demanded matching warm cache rows when the canonical sessions map is empty', async () => {
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

        const admittedSession = await openSessionFixture(requestSpy, buildExistingSession({
            id: 's_cached', metadataVersion: 7, agentStateVersion: 9,
            metadata: { name: 'Cached title', path: '/home/u/repo', host: 'mbp' },
        }));

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            applySessionListRenderables,
            priorityHydrationSessionIds: ['s_cached'],
            getExistingSession: () => null,
            cachedSessionListEntries: { s_cached: cacheOpenedSession(admittedSession) },
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
        await expect.poll(() => applySessions.mock.calls.length).toBe(1);
        expect(applySessions).toHaveBeenCalledWith([
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
        const admittedSession = await openSessionFixture(requestSpy, buildExistingSession({
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
        const currentRenderable = buildSessionListRenderableFromSession(admittedSession);
        const sessionListBackgroundHydrationYield = vi.fn(async () => {});

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            applySessionListRenderables: vi.fn(),
            contentDemand: 'list-projection',
            getExistingSession: () => null,
            getCurrentSessionListRenderable: (sessionId) => (
                sessionId === 's_current_renderable' ? currentRenderable : null
            ),
            priorityHydrationSessionIds: ['s_current_renderable'],
            cachedSessionListEntries: {},
            sessionListBackgroundHydrationYield,
            awaitSessionListHydration: true,
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
        const metadataGate = createDeferred<Session['metadata']>();
        decryptMetadata.mockImplementation(async () => metadataGate.promise);
        const applySessionListRenderables = vi.fn();
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        const admittedSession = await openSessionFixture(requestSpy, buildExistingSession({
            id: 's_stale_cache', metadataVersion: 7, metadata: {
                name: 'Cached stale title', summary: { text: 'Cached stale summary', updatedAt: 30 },
                path: '/home/u/stale', homeDir: '/home/u', host: 'stale-host', machineId: 'stale-machine', flavor: 'claude',
            },
        }));
        const fetchPromise = fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions: vi.fn(),
            applySessionListRenderables,
            priorityHydrationSessionIds: ['s_stale_cache'],
            getExistingSession: () => null,
            cachedSessionListEntries: { s_stale_cache: cacheOpenedSession(admittedSession) },
            log: { log: () => {} },
        });

        await expect.poll(() => applySessionListRenderables.mock.calls.length).toBe(1);
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
                    externalSessionV1: null,
                    hiddenSystemSession: false,
                }),
            }),
        ], { replace: true });
        const firstUsableEvent = syncPerformanceTelemetry.snapshot().events.find((event) =>
            event.name === 'sync.sessions.snapshot.firstUsableList',
        );
        expect(firstUsableEvent?.fields).toEqual(expect.objectContaining({
            staleMetadataPreserved: 1,
            staleWarmCacheMetadataRows: 1,
        }));
        await expect.poll(() => decryptMetadata.mock.calls.map((call) => call[1])).toEqual(['encrypted-meta-v8']);
        metadataGate.resolve({ name: 'Updated title', path: '/home/u/stale', host: 'stale-host' });
        await fetchPromise;
    });

    it('hydrates version-zero encrypted metadata when warm cache exists but the existing session has no metadata', async () => {
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

        const admittedSession = await openSessionFixture(requestSpy, buildExistingSession({
            id: 's_zero_metadata', metadataVersion: 0, metadata: { path: '/cached-zero', host: 'host' },
        }));

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
            cachedSessionListEntries: { s_zero_metadata: cacheOpenedSession(admittedSession) },
            awaitSessionListHydration: true,
            requiredHydrationSessionIds: ['s_zero_metadata'],
            log: { log: () => {} },
        });

        expect(applySessionListRenderables).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's_zero_metadata',
                metadataVersion: 0,
                metadata: expect.objectContaining({ path: '/cached-zero' }),
            }),
        ], { replace: true });
        expect(decryptMetadata).toHaveBeenCalledWith(
            0,
            'encrypted-zero-meta',
            expect.objectContaining({ onAuthenticationFailure: expect.any(Function) }),
        );
        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's_zero_metadata',
                metadataVersion: 0,
                metadata: expect.objectContaining({ decrypted: 'encrypted-zero-meta' }),
            }),
        ]);
    });

    it('uses matching canonical session metadata while warm cache is missing', async () => {
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

        const admittedSession = await openSessionFixture(requestSpy, buildExistingSession({
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
            }));

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            applySessionListRenderables,
            getExistingSession: () => admittedSession,
            cachedSessionListEntries: {},
            awaitSessionListHydration: true,
            requiredHydrationSessionIds: ['s_existing'],
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
        ], { replace: true });
        expect(decryptMetadata).not.toHaveBeenCalled();
        expect(decryptAgentState).not.toHaveBeenCalled();
        expect(applySessions).not.toHaveBeenCalled();
    });

    it('marks encrypted metadata unavailable after hydration attempts fail without stale metadata', async () => {
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
            requiredHydrationSessionIds: ['s_unavailable_metadata'],
            log: { log: () => {} },
        });

        expect(decryptMetadata).toHaveBeenCalledWith(
            3,
            'encrypted-unavailable-meta',
            expect.objectContaining({ onAuthenticationFailure: expect.any(Function) }),
        );
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

    // A non-owner row is the case with genuinely no reader: owner-only absent-envelope
    // compatibility material must never be reached through a grant.
    it('does not open a Session cipher for shared encrypted rows that are missing data keys', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_missing_data_key',
                        dataEncryptionKey: null,
                        share: { accessLevel: 'view', canApprovePermissions: false },
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

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            applySessionListRenderables,
            awaitSessionListHydration: true,
            requiredHydrationSessionIds: ['s_missing_data_key'],
            cachedSessionListEntries: {},
            log: { log: () => {} },
        });

        expect(applySessionListRenderables).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's_missing_data_key',
                metadata: null,
            }),
        ], { replace: true });
        expect(getSessionEncryption).not.toHaveBeenCalled();
        expect(decryptMetadata).not.toHaveBeenCalled();
        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's_missing_data_key',
                metadata: null,
                encryptedContentAvailability: 'recipient_encryption_setup_required',
            }),
        ]);
        expect(consoleError).not.toHaveBeenCalled();
    });

    it('preserves stale metadata instead of marking unavailable when failed hydration has safe metadata', async () => {
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
        const admittedSession = await openSessionFixture(requestSpy, buildExistingSession({
            id: 's_stale_metadata', metadataVersion: 4, metadata: previousMetadata,
        }));
        let currentRenderables: Record<string, SessionListRenderableSession> = {
            s_stale_metadata: buildSessionListRenderableFromSession(admittedSession),
        };
        const retainedMetadata = currentRenderables.s_stale_metadata!.metadata;
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
            requiredHydrationSessionIds: ['s_stale_metadata'],
            log: { log: () => {} },
        });

        expect(decryptMetadata).toHaveBeenCalledWith(
            5,
            'encrypted-stale-meta',
            expect.objectContaining({ onAuthenticationFailure: expect.any(Function) }),
        );
        expect(applySessionListRenderablePatches).toHaveBeenCalledWith([
            expect.objectContaining({
                sessionId: 's_stale_metadata',
                patch: expect.objectContaining({
                    metadata: retainedMetadata,
                    metadataVersion: 4,
                    metadataUnavailable: false,
                }),
            }),
        ]);
    });

    // Compact display opening precedes scheduling; observe the full document at its Agent-state crypto boundary.
    function buildHydrationSchedulingRow(overrides: Partial<SessionRow> & Pick<SessionRow, 'id'>): SessionRow {
        const row = buildSessionRow(overrides);
        return { ...row, agentState: row.agentState ?? row.metadata };
    }

    it('hydrates prioritized stale rows before eager background rows', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildHydrationSchedulingRow({ id: 's_oldest', dataEncryptionKey: 'k-oldest', metadata: 'meta-oldest', metadataVersion: 2 }),
                    buildHydrationSchedulingRow({ id: 's_priority', dataEncryptionKey: 'k-priority', metadata: 'meta-priority', metadataVersion: 2 }),
                    buildHydrationSchedulingRow({ id: 's_next', dataEncryptionKey: 'k-next', metadata: 'meta-next', metadataVersion: 2 }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption, decryptAgentState: fullDocumentOpens } = createEncryptionHarness();
        const applySessions = vi.fn();

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            log: { log: () => {} },
            prioritizeSessionIds: ['s_priority'],
            sessionListEagerHydrationCount: 1,
            sessionListBackgroundHydrationMaxRows: 1,
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

        await expect.poll(() => fullDocumentOpens.mock.calls.length).toBe(3);
        expect(fullDocumentOpens.mock.calls.map((call) => call[1])).toEqual([
            'meta-priority',
            'meta-oldest',
            'meta-next',
        ]);
        expect(applySessions.mock.calls.flatMap((call) => call[0].map((session: { id: string }) => session.id))).toEqual([
            's_priority',
            's_oldest',
            's_next',
        ]);
    });

    it('hydrates required current active and eager rows before background rows', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildHydrationSchedulingRow({ id: 's_eager', active: false, activeAt: 5, dataEncryptionKey: 'k-eager', metadata: 'meta-eager', metadataVersion: 2 }),
                    buildHydrationSchedulingRow({ id: 's_background', active: false, activeAt: 4, dataEncryptionKey: 'k-background', metadata: 'meta-background', metadataVersion: 2 }),
                    buildHydrationSchedulingRow({ id: 's_required', active: false, activeAt: 3, dataEncryptionKey: 'k-required', metadata: 'meta-required', metadataVersion: 2 }),
                    buildHydrationSchedulingRow({ id: 's_active', active: true, activeAt: 6, dataEncryptionKey: 'k-active', metadata: 'meta-active', metadataVersion: 2 }),
                    buildHydrationSchedulingRow({ id: 's_current', active: false, activeAt: 7, dataEncryptionKey: 'k-current', metadata: 'meta-current', metadataVersion: 2 }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption, decryptAgentState: fullDocumentOpens } = createEncryptionHarness();
        const applySessions = vi.fn();

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            log: { log: () => {} },
            prioritizeSessionIds: ['s_current'],
            requiredHydrationSessionIds: ['s_required'],
            activeSessionIds: ['s_active'],
            sessionListEagerHydrationCount: 1,
            sessionListBackgroundHydrationMaxRows: 1,
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

        await expect.poll(() => fullDocumentOpens.mock.calls.length).toBe(5);
        expect(fullDocumentOpens.mock.calls.map((call) => call[1])).toEqual([
            'meta-required',
            'meta-current',
            'meta-active',
            'meta-eager',
            'meta-background',
        ]);
    });

    it('waits for the background hydration gate before eager rows while allowing required route active and priority rows', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildHydrationSchedulingRow({ id: 's_eager', active: false, activeAt: 5, dataEncryptionKey: 'k-eager', metadata: 'meta-eager', metadataVersion: 2 }),
                    buildHydrationSchedulingRow({ id: 's_priority', active: false, activeAt: 4, dataEncryptionKey: 'k-priority', metadata: 'meta-priority', metadataVersion: 2, pendingUserActionRequestCount: 1 }),
                    buildHydrationSchedulingRow({ id: 's_background', active: false, activeAt: 3, dataEncryptionKey: 'k-background', metadata: 'meta-background', metadataVersion: 2 }),
                    buildHydrationSchedulingRow({ id: 's_required', active: false, activeAt: 2, dataEncryptionKey: 'k-required', metadata: 'meta-required', metadataVersion: 2 }),
                    buildHydrationSchedulingRow({ id: 's_route', active: false, activeAt: 1, dataEncryptionKey: 'k-route', metadata: 'meta-route', metadataVersion: 2 }),
                    buildHydrationSchedulingRow({ id: 's_active_surface', active: false, activeAt: 6, dataEncryptionKey: 'k-active-surface', metadata: 'meta-active-surface', metadataVersion: 2 }),
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

        const { encryption, decryptAgentState: fullDocumentOpens } = createEncryptionHarness();
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
            log: { log: () => {} },
            prioritizeSessionIds: ['s_route'],
            activeSessionIds: ['s_active_surface'],
            requiredHydrationSessionIds: ['s_required'],
            priorityHydrationSessionIds: ['s_priority'],
            sessionListEagerHydrationCount: 1,
            sessionListBackgroundHydrationMaxRows: 1,
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

        await expect.poll(() => fullDocumentOpens.mock.calls.map((call) => call[1])).toEqual([
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
        await expect.poll(() => fullDocumentOpens.mock.calls.map((call) => call[1])).toEqual([
            'meta-required',
            'meta-route',
            'meta-active-surface',
            'meta-priority',
            'meta-eager',
            'meta-background',
        ]);
    });

    it('renders demanded placeholder rows immediately on empty cache before hydrating their metadata', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildHydrationSchedulingRow({
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

        const { encryption, decryptEncryptionKeys } = createEncryptionHarness();
        let resolveDataKeys!: (value: Array<Uint8Array | null>) => void;
        decryptEncryptionKeys.mockImplementation(async () => new Promise<Array<Uint8Array | null>>((resolve) => {
            resolveDataKeys = resolve;
        }));
        const applySessions = vi.fn();
        const applySessionListRenderables = vi.fn();

        const fetchPromise = fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            applySessionListRenderables,
            priorityHydrationSessionIds: ['s_cold'],
            cachedSessionListEntries: {},
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
                // The remote descriptor does not make an unopened document current.
                metadataVersion: 0,
                metadata: null,
                hasPendingPermissionRequests: false,
                hasPendingUserActionRequests: true,
            }),
        ], { replace: true });
        expect(applySessions).not.toHaveBeenCalled();

        await expect.poll(() => typeof resolveDataKeys).toBe('function');
        resolveDataKeys([createSessionDataKeyFixture(6)]);
        await fetchPromise;
        expect(applySessionListRenderables).toHaveBeenLastCalledWith([
            expect.objectContaining({ id: 's_cold', metadataVersion: 3, metadata: expect.any(Object) }),
        ], { replace: true });
        await expect.poll(() => applySessions.mock.calls.length).toBe(1);
        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({ id: 's_cold', metadataVersion: 3 }),
        ]);
    });

    it('defers background hydration and yields between session rows', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildHydrationSchedulingRow({ id: 's_first', dataEncryptionKey: 'k-first', metadata: 'meta-first' }),
                    buildHydrationSchedulingRow({ id: 's_second', dataEncryptionKey: 'k-second', metadata: 'meta-second' }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption, decryptAgentState: fullDocumentOpens } = createEncryptionHarness();
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
            sessionListBackgroundHydrationMaxRows: 2,
            sessionListBackgroundHydrationConcurrencyLimit: 1,
            sessionListBackgroundHydrationApplyBatchSize: 2,
            sessionListBackgroundHydrationApplyFlushDelayMs: 1_000,
            sessionListBackgroundHydrationYield,
            log: { log: () => {} },
        });

        expect(applySessionListRenderables).toHaveBeenCalledWith([
            expect.objectContaining({ id: 's_first', metadata: null }),
            expect.objectContaining({ id: 's_second', metadata: null }),
        ], { replace: true });
        expect(fullDocumentOpens).not.toHaveBeenCalled();
        expect(sessionListBackgroundHydrationYield).toHaveBeenCalledTimes(1);

        yieldResolvers.shift()?.();
        await expect.poll(() => fullDocumentOpens.mock.calls.map((call) => call[1])).toEqual(['meta-first']);
        expect(applySessions).not.toHaveBeenCalled();
        await expect.poll(() => sessionListBackgroundHydrationYield.mock.calls.length).toBe(2);

        yieldResolvers.shift()?.();
        await expect.poll(() => fullDocumentOpens.mock.calls.map((call) => call[1])).toEqual(['meta-first', 'meta-second']);
        await expect.poll(() => applySessions.mock.calls.length).toBe(1);
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
                    buildHydrationSchedulingRow({ id: 's_yield_1', active: false, dataEncryptionKey: 'k-yield-1', metadata: 'meta-yield-1' }),
                    buildHydrationSchedulingRow({ id: 's_yield_2', active: false, dataEncryptionKey: 'k-yield-2', metadata: 'meta-yield-2' }),
                    buildHydrationSchedulingRow({ id: 's_yield_3', active: false, dataEncryptionKey: 'k-yield-3', metadata: 'meta-yield-3' }),
                    buildHydrationSchedulingRow({ id: 's_yield_4', active: false, dataEncryptionKey: 'k-yield-4', metadata: 'meta-yield-4' }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption, decryptAgentState: fullDocumentOpens } = createEncryptionHarness();
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
            sessionListBackgroundHydrationMaxRows: 4,
            sessionListBackgroundHydrationConcurrencyLimit: 1,
            sessionListBackgroundHydrationApplyBatchSize: 4,
            sessionListBackgroundHydrationApplyFlushDelayMs: 1,
            sessionListBackgroundHydrationYieldEveryRows: 2,
            sessionListBackgroundHydrationYield,
            log: { log: () => {} },
        } satisfies FetchAndApplySessionsParams & { sessionListBackgroundHydrationYieldEveryRows: number };

        await fetchAndApplySessions(params);

        await expect.poll(() => fullDocumentOpens.mock.calls.map((call) => call[1])).toEqual([
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
                    buildHydrationSchedulingRow({ id: 's_deleted_before_flush', metadata: 'meta-deleted' }),
                    buildHydrationSchedulingRow({ id: 's_survivor_after_delete', metadata: 'meta-survivor' }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption, decryptAgentState: fullDocumentOpens } = createEncryptionHarness();
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
            sessionListBackgroundHydrationMaxRows: 2,
            sessionListBackgroundHydrationConcurrencyLimit: 1,
            sessionListBackgroundHydrationApplyBatchSize: 2,
            sessionListBackgroundHydrationApplyFlushDelayMs: 1_000,
            sessionListBackgroundHydrationYield,
            log: { log: () => {} },
        });

        yieldResolvers.shift()?.();
        await expect.poll(() => fullDocumentOpens.mock.calls.map((call) => call[1])).toEqual(['meta-deleted']);
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
                    buildHydrationSchedulingRow({
                        id: 's_archived_before_flush',
                        updatedAt: 10,
                        archivedAt: null,
                        metadata: 'meta-archived',
                    }),
                    buildHydrationSchedulingRow({ id: 's_survivor_after_archive', updatedAt: 10, metadata: 'meta-survivor' }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption, decryptAgentState: fullDocumentOpens } = createEncryptionHarness();
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
            sessionListBackgroundHydrationMaxRows: 2,
            sessionListBackgroundHydrationConcurrencyLimit: 1,
            sessionListBackgroundHydrationApplyBatchSize: 2,
            sessionListBackgroundHydrationApplyFlushDelayMs: 1_000,
            sessionListBackgroundHydrationYield,
            log: { log: () => {} },
        });

        yieldResolvers.shift()?.();
        await expect.poll(() => fullDocumentOpens.mock.calls.map((call) => call[1])).toEqual(['meta-archived']);
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
                    buildHydrationSchedulingRow({
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

        const { encryption, decryptMetadata, decryptAgentState: fullDocumentOpens } = createEncryptionHarness();
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
            sessionListBackgroundHydrationMaxRows: 1,
            sessionListBackgroundHydrationConcurrencyLimit: 1,
            sessionListBackgroundHydrationApplyBatchSize: 2,
            sessionListBackgroundHydrationApplyFlushDelayMs: 1_000,
            sessionListBackgroundHydrationYield,
            log: { log: () => {} },
        });

        expect(currentRenderables.s_streaming_placeholder?.metadata).toEqual(expect.objectContaining({
            name: 'Hydrated streaming row',
        }));
        applySessionListRenderablePatches.mockClear();
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

        await expect.poll(() => fullDocumentOpens.mock.calls.map((call) => call[1])).toEqual(['meta-streaming-placeholder']);
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

    it('does not wait for background-yield scheduling before required session hydration', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildHydrationSchedulingRow({
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

        const { encryption, decryptAgentState: fullDocumentOpens } = createEncryptionHarness();
        const requiredAgentState = createDeferred<null>();
        fullDocumentOpens.mockImplementation(async () => requiredAgentState.promise);
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
            log: { log: () => {} },
        });

        await expect.poll(() => applySessionListRenderables.mock.calls.length).toBeGreaterThanOrEqual(1);
        await expect.poll(() => fullDocumentOpens.mock.calls.map((call) => call[1])).toEqual(['meta-stale']);
        expect(sessionListBackgroundHydrationYield).not.toHaveBeenCalled();

        await expect(Promise.race([
            fetchPromise.then(() => 'resolved' as const),
            new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 25)),
        ])).resolves.toBe('pending');

        requiredAgentState.resolve(null);
        await fetchPromise;

        expect(fullDocumentOpens).toHaveBeenCalledWith(0, 'meta-stale');
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
                    buildHydrationSchedulingRow({
                        id: 's_required',
                        dataEncryptionKey: 'k-required',
                        metadata: 'meta-required',
                        metadataVersion: 2,
                    }),
                    buildHydrationSchedulingRow({
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

        const { encryption, decryptAgentState: fullDocumentOpens } = createEncryptionHarness();
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
            sessionListBackgroundHydrationMaxRows: 1,
            sessionListBackgroundHydrationConcurrencyLimit: 1,
            sessionListBackgroundHydrationApplyBatchSize: 2,
            sessionListBackgroundHydrationApplyFlushDelayMs: 1_000,
            sessionListBackgroundHydrationYield,
            awaitSessionListHydration: true,
            requiredHydrationSessionIds: ['s_required'],
            log: { log: () => {} },
        });

        await expect.poll(() => fullDocumentOpens.mock.calls.map((call) => call[1])).toEqual(['meta-required']);
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
        await expect.poll(() => fullDocumentOpens.mock.calls.map((call) => call[1])).toEqual([
            'meta-required',
            'meta-background',
        ]);
    });

    it('does not throw required hydration failure when the caller supersedes the request', async () => {
        const firstRequest = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildHydrationSchedulingRow({
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
                    buildHydrationSchedulingRow({
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

        const { encryption, decryptAgentState: fullDocumentOpens } = createEncryptionHarness();
        const firstAgentStateDecrypt = createDeferred<null>();
        fullDocumentOpens.mockImplementation(async (_version: number, value: string) => {
            if (value === 'meta-superseded-required') {
                return firstAgentStateDecrypt.promise;
            }
            return null;
        });
        const applySessions = vi.fn();
        const applySessionListRenderables = vi.fn();
        const firstAbort = new AbortController();

        const firstFetch = fetchAndApplySessions({
            serverId: 'server-superseded-required',
            signal: firstAbort.signal,
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: firstRequest,
            applySessions,
            applySessionListRenderables,
            cachedSessionListEntries: {},
            awaitSessionListHydration: true,
            requiredHydrationSessionIds: ['s_superseded_required'],
            log: { log: () => {} },
        });

        try {
            await expect.poll(() => fullDocumentOpens.mock.calls.map((call) => call[1])).toEqual(['meta-superseded-required']);

            firstAbort.abort();
            await fetchAndApplySessions({
                serverId: 'server-superseded-required',
                credentials: { token: 't', secret: 's' },
                encryption,
                sessionDataKeys: new Map<string, Uint8Array>(),
                request: secondRequest,
                applySessions,
                applySessionListRenderables,
                cachedSessionListEntries: {},
                log: { log: () => {} },
            });

            firstAgentStateDecrypt.resolve(null);
            await expect(firstFetch).resolves.toEqual(expect.objectContaining({
                sessionIds: ['s_superseded_required'],
                current: false,
            }));

            expect(applySessions.mock.calls.flatMap((call) => call[0].map((session: { id: string }) => session.id)))
                .not.toContain('s_superseded_required');
        } finally {
            firstAbort.abort();
            firstAgentStateDecrypt.resolve(null);
            await firstFetch.catch(() => undefined);
        }
    });

    it('applies one hydrated background session at a time by default', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildHydrationSchedulingRow({ id: 's_first', dataEncryptionKey: 'k-first', metadata: 'meta-first' }),
                    buildHydrationSchedulingRow({ id: 's_second', dataEncryptionKey: 'k-second', metadata: 'meta-second' }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        const { encryption, decryptAgentState: fullDocumentOpens } = createEncryptionHarness();
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
            sessionListBackgroundHydrationMaxRows: 2,
            sessionListBackgroundHydrationConcurrencyLimit: 1,
            sessionListBackgroundHydrationApplyFlushDelayMs: 1,
            sessionListBackgroundHydrationYield,
            log: { log: () => {} },
        });

        yieldResolvers.shift()?.();
        await expect.poll(() => fullDocumentOpens.mock.calls.map((call) => call[1])).toEqual(['meta-first']);
        await expect.poll(() => applySessions.mock.calls.length, { timeout: 100 }).toBe(1);
        expect(applySessions).toHaveBeenLastCalledWith([
            expect.objectContaining({ id: 's_first' }),
        ]);
    });

    it('preserves direct-session classification from stale cache rows while a newer row rehydrates', async () => {
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
        const metadataGate = createDeferred<Session['metadata']>();
        decryptMetadata.mockImplementation(async () => metadataGate.promise);
        const applySessions = vi.fn();
        const applySessionListRenderables = vi.fn();

        const admittedSession = await openSessionFixture(requestSpy, buildExistingSession({
            id: 's_direct', metadataVersion: 2, metadata: { name: 'Direct session', summary: { text: 'Cached direct summary', updatedAt: 3 },
                path: '/tmp/direct', homeDir: '/tmp', host: 'host', machineId: 'm1', flavor: 'claude',
                externalSessionV1: { v: 1, agentId: 'claude', machineId: 'm1', remoteSessionId: 'remote-direct',
                    source: { kind: 'claudeConfig', configDir: '/tmp/.claude' } },
            },
        }));
        const fetchPromise = fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            applySessionListRenderables,
            priorityHydrationSessionIds: ['s_direct'],
            cachedSessionListEntries: { s_direct: cacheOpenedSession(admittedSession) },
            log: { log: () => {} },
        });

        const raceResult = await Promise.race([
            fetchPromise.then(() => 'resolved'),
            new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 25)),
        ]);

        expect(raceResult).toBe('timeout');
        expect(applySessionListRenderables).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's_direct',
                metadataVersion: 2,
                metadata: expect.objectContaining({
                    externalSessionV1: expect.objectContaining({
                        v: 1,
                        agentId: 'claude',
                    }),
                }),
            }),
        ], { replace: true });
        expect(applySessions).not.toHaveBeenCalled();
        expect(decryptAgentState).not.toHaveBeenCalled();
        metadataGate.resolve(admittedSession.metadata);
        await fetchPromise;
    });

    it('does not promote cached direct-session identity into full metadata that omits it', async () => {
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
                            externalSessionAttentionV1: {
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

        const admittedSession = await openSessionFixture(requestSpy, buildExistingSession({
            id: 's_direct', metadataVersion: 2, metadata: { name: 'Direct session', summary: { text: 'Cached direct summary', updatedAt: 3 },
                path: '/tmp/direct', homeDir: '/tmp', host: 'host', machineId: 'm1', flavor: 'claude',
                externalSessionV1: { v: 1, agentId: 'claude', machineId: 'm1', remoteSessionId: 'remote-direct',
                    source: { kind: 'claudeConfig', configDir: '/tmp/.claude' } },
            },
        }));
        const applySessionListRenderables = vi.fn();
        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            applySessionListRenderables,
            awaitSessionListHydration: true,
            requiredHydrationSessionIds: ['s_direct'],
            cachedSessionListEntries: { s_direct: cacheOpenedSession(admittedSession) },
            log: { log: () => {} },
        });

        expect(applySessionListRenderables.mock.calls[0]?.[0]).toEqual([
            expect.objectContaining({ id: 's_direct', metadataVersion: 2, metadata: expect.objectContaining({
                externalSessionV1: expect.objectContaining({ agentId: 'claude' }),
            }) }),
        ]);
        expect(applySessions).toHaveBeenCalledWith([expect.objectContaining({
            id: 's_direct', metadataVersion: 3, encryptedContentAvailability: 'ready',
            metadata: expect.objectContaining({ path: '/tmp/direct', host: 'host',
                externalSessionAttentionV1: expect.objectContaining({ observedProgressToken: '20:msg-2' }),
            }),
        })]);
        const full = applySessions.mock.calls[0]?.[0][0] as Session;
        expect(full.metadata?.externalSessionV1).toBeUndefined();
        expect(full.metadata?.machineId).toBeUndefined();
    });

    it('does not promote cached direct-session identity into full metadata that clears it', async () => {
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
                            externalSessionV1: null,
                            externalSessionAttentionV1: {
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

        const admittedSession = await openSessionFixture(requestSpy, buildExistingSession({
            id: 's_direct', metadataVersion: 2, metadata: { name: 'Direct session', summary: { text: 'Cached direct summary', updatedAt: 3 },
                path: '/tmp/direct', homeDir: '/tmp', host: 'host', machineId: 'm1', flavor: 'claude',
                externalSessionV1: { v: 1, agentId: 'claude', machineId: 'm1', remoteSessionId: 'remote-direct',
                    source: { kind: 'claudeConfig', configDir: '/tmp/.claude' } },
            },
        }));
        const applySessionListRenderables = vi.fn();
        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            applySessionListRenderables,
            awaitSessionListHydration: true,
            requiredHydrationSessionIds: ['s_direct'],
            cachedSessionListEntries: { s_direct: cacheOpenedSession(admittedSession) },
            log: { log: () => {} },
        });

        expect(applySessionListRenderables.mock.calls[0]?.[0]).toEqual([
            expect.objectContaining({ id: 's_direct', metadataVersion: 2, metadata: expect.objectContaining({
                externalSessionV1: expect.objectContaining({ agentId: 'claude' }),
            }) }),
        ]);
        expect(applySessions).toHaveBeenCalledWith([expect.objectContaining({
            id: 's_direct', metadataVersion: 3, encryptedContentAvailability: 'ready',
            metadata: expect.objectContaining({ path: '/tmp/direct', host: 'host',
                externalSessionAttentionV1: expect.objectContaining({ observedProgressToken: '20:msg-2' }),
            }),
        })]);
        const full = applySessions.mock.calls[0]?.[0][0] as Session;
        expect(full.metadata?.externalSessionV1).toBeNull();
        expect(full.metadata?.machineId).toBeUndefined();
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

        const { encryption, decryptMetadata, decryptAgentState } = createEncryptionHarness();
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
            sessionListBackgroundHydrationMaxRows: 2,
            shouldContinue: () => active,
            sessionListBackgroundHydrationConcurrencyLimit: 1,
            sessionListBackgroundHydrationYield,
            log: { log: () => {} },
        });

        await expect.poll(() => sessionListBackgroundHydrationYield.mock.calls.length).toBe(1);
        expect(decryptMetadata.mock.calls.map(call => call[1])).toEqual(['meta-stale-first', 'meta-stale-second']);
        active = false;
        yieldResolvers.shift()?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(sessionListBackgroundHydrationYield).toHaveBeenCalledTimes(1);
        expect(decryptMetadata).toHaveBeenCalledTimes(2);
        expect(decryptAgentState).not.toHaveBeenCalled();
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
            sessionListBackgroundHydrationMaxRows: 1,
            shouldContinue: () => false,
            log: { log: () => {} },
        });

        // Yield to allow any background tasks to run if they were scheduled.
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));

        expect(decryptEncryptionKeys).not.toHaveBeenCalled();
        expect(applySessions).not.toHaveBeenCalled();
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

    it('does not apply hydrated sessions when the caller scope becomes inactive during decrypt', async () => {
        const requestSpy = vi.fn(async () =>
            jsonResponse({
                sessions: [
                    buildSessionRow({
                        id: 's_archived_stale',
                        dataEncryptionKey: 'k-archived-stale',
                        metadata: 'meta-archived-stale',
                        metadataVersion: 3,
                    }),
                ],
                nextCursor: null,
                hasNext: false,
            }),
        );

        let shouldContinue = true;
        const decryptGate: { resolve: (() => void) | null } = { resolve: null };
        let markDecryptStarted: (() => void) | null = null;
        const decryptStarted = new Promise<void>((resolve) => {
            markDecryptStarted = resolve;
        });
        const { encryption, decryptMetadata } = createEncryptionHarness();
        decryptMetadata.mockImplementation(
            async () => {
                markDecryptStarted?.();
                await new Promise<void>((resolve) => {
                    decryptGate.resolve = resolve;
                });
                return { decrypted: 'meta-archived-stale' };
            },
        );
        const applySessions = vi.fn();

        const fetchPromise = fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            applySessions,
            shouldContinue: () => shouldContinue,
            log: { log: () => {} },
        });

        await decryptStarted;
        shouldContinue = false;
        decryptGate.resolve?.();
        await fetchPromise;

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
            log: { log: () => {} },
        });

        expect(decryptEncryptionKey).not.toHaveBeenCalled();
        expectDecryptEncryptionKeysCall(decryptEncryptionKeys, ['batch-envelope-a', 'batch-envelope-b'], { serverId: 'server-batch' });
        expectInitializeSessionsCall(initializeSessions, [
            ['s_batch_a', createSessionDataKeyFixture('batch-envelope-a'.length)],
            ['s_batch_b', createSessionDataKeyFixture('batch-envelope-b'.length)],
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
        const validKey = createSessionDataKeyFixture(9);
        decryptEncryptionKeys.mockResolvedValueOnce([validKey, null]);
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
            log: { log: () => {} },
        });

        expect(decryptEncryptionKeys).toHaveBeenCalledTimes(1);
        expect(sessionDataKeys.get('s_valid_key')).toEqual(validKey);
        expect(sessionDataKeyEnvelopes.get('s_valid_key')).toBe('valid-envelope');
        expect(sessionDataKeys.has('s_invalid_key')).toBe(false);
        expect(sessionDataKeyEnvelopes.has('s_invalid_key')).toBe(false);
        expectInitializeSessionsCall(initializeSessions, [
            ['s_valid_key', validKey],
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
                priorityHydrationSessionIds: ['s_unopenable_key'],
                cachedSessionListEntries: {},
                sessionListBackgroundHydrationYield: async () => {},
                log: { log: () => {} },
            });

            await expect.poll(() => currentRenderables.s_unopenable_key?.metadataUnavailable).toBe(true);
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
                        id: 's_empty_cached_identity',
                        dataEncryptionKey: 'unopenable-envelope',
                        metadata: 'encrypted-unopenable-metadata',
                        metadataVersion: 4,
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
                priorityHydrationSessionIds: ['s_empty_cached_identity'],
                cachedSessionListEntries: {
                    s_empty_cached_identity: {
                        sessionId: 's_empty_cached_identity',
                        metadataVersion: 4,
                        agentStateVersion: 0,
                        updatedAt: 1,
                        createdAt: 1,
                        active: true,
                        activeAt: 1,
                        archivedAt: null,
                        path: '',
                    },
                } satisfies NonNullable<FetchAndApplySessionsParams['cachedSessionListEntries']>,
                sessionListBackgroundHydrationYield: async () => {},
                log: { log: () => {} },
            });

            await expect.poll(() => currentRenderables.s_empty_cached_identity?.metadataUnavailable).toBe(true);
        } finally {
            consoleError.mockRestore();
        }

        expect(applySessionListRenderablePatches).toHaveBeenCalledWith([
            expect.objectContaining({
                sessionId: 's_empty_cached_identity',
                patch: expect.objectContaining({ metadataUnavailable: true }),
            }),
        ]);
        expect(currentRenderables.s_empty_cached_identity?.metadata).toBeNull();
        expect(currentRenderables.s_empty_cached_identity?.metadataUnavailable).toBe(true);
    });

    it('replaces stale runtime session encryption with the owner account reader when an encrypted session no longer has a data-key envelope', async () => {
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
            log: { log: () => {} },
        });

        expect(decryptEncryptionKeys).not.toHaveBeenCalled();
        // The stale per-Session key must go even though the owner keeps a reader.
        expect(sessionDataKeys.has('s_missing_envelope')).toBe(false);
        expect(sessionDataKeyEnvelopes.has('s_missing_envelope')).toBe(false);
        expect(initializeSessions).toHaveBeenCalledTimes(1);
        expect([...(initializeSessions.mock.calls[0]?.[0] as Map<string, Uint8Array | null>).entries()])
            .toEqual([['s_missing_envelope', null]]);
        expect(removeSessionEncryption).not.toHaveBeenCalled();
    });

    it('drops the stale concrete session key when an encrypted session no longer has a data-key envelope', async () => {
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
        const staleSessionEncryption = encryption.getSessionEncryption(sessionId);
        expect(staleSessionEncryption).not.toBeNull();

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
                log: { log: () => {} },
            });
        } finally {
            consoleError.mockRestore();
        }

        expect(sessionDataKeys.has(sessionId)).toBe(false);
        expect(sessionDataKeyEnvelopes.has(sessionId)).toBe(false);
        // The owner keeps a reader, but never the superseded per-Session key.
        const currentSessionEncryption = encryption.getSessionEncryption(sessionId);
        expect(currentSessionEncryption).not.toBeNull();
        expect(currentSessionEncryption).not.toBe(staleSessionEncryption);
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

    it('aborts caller-superseded session-list data-key hydration before queued native work dispatches', async () => {
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
            return [createSessionDataKeyFixture(2)];
        });
        const sessionDataKeys = new Map<string, Uint8Array>();
        const firstAbort = new AbortController();

        const firstFetch = fetchAndApplySessions({
            serverId: 'server-superseded',
            signal: firstAbort.signal,
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys,
            request: firstRequest,
            applySessions: vi.fn(),
            log: { log: () => {} },
        });

        await expect.poll(() => signals.length).toBe(1);
        expect(signals[0]).toBeInstanceOf(AbortSignal);
        expect(signals[0]?.aborted).toBe(false);

        // Only the owning reader knows that this request is a replacement.
        firstAbort.abort();
        const secondFetch = fetchAndApplySessions({
            serverId: 'server-superseded',
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys,
            request: secondRequest,
            applySessions: vi.fn(),
            log: { log: () => {} },
        });

        await expect.poll(() => signals[0]?.aborted).toBe(true);
        await secondFetch;
        firstDecrypt.resolve([new Uint8Array([1, 1])]);
        await firstFetch;

        expect(sessionDataKeys.has('s_superseded_old')).toBe(false);
        expect(sessionDataKeys.get('s_superseded_new')).toEqual(createSessionDataKeyFixture(2));
        expect(initializeSessions).toHaveBeenCalledTimes(1);
        expectInitializeSessionsCall(initializeSessions, [
            ['s_superseded_new', createSessionDataKeyFixture(2)],
        ], { serverId: 'server-superseded' });
    });

    // DataKeyOpenings (ecb31634bf2) isolates a borrower's cancellation from the shared opening it
    // joined: the opening completes under the Encryption scope and retains its keys for the next
    // borrower. The inactive borrower publishes nothing; the superseding read opens nothing again.
    it('publishes nothing for an inactive session-list hydration and reuses its shared openings', async () => {
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
                    failureReason: TEST_NATIVE_CRYPTO_WORKER_PROBE_OK_FAILURE_REASON,
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

        expect(sessionDataKeys.size).toBe(0);
        expect(initializeSessions).not.toHaveBeenCalled();

        await fetchAndApplySessions({
            serverId: 'server-native-queue-abort',
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys,
            request: requestSpy,
            applySessions: vi.fn(),
            log: { log: () => {} },
        });
        expect(nativeDispatches).toEqual([[firstEnvelope], [secondEnvelope]]);
        expect([...sessionDataKeys.keys()].sort()).toEqual(['s_native_abort_first', 's_native_abort_second']);
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
        const scope = attachEncryptionGenerationScopeHarness(encryption, { accountId: 'account-a', serverId: 'server-a' });
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
        const scope = attachEncryptionGenerationScopeHarness(encryption, { accountId: 'account-a', serverId: 'server-a' });
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
        const scope = attachEncryptionGenerationScopeHarness(encryption);
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
        const scope = attachEncryptionGenerationScopeHarness(encryption);
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
            if (path === '/v1/account/encryption/currentness') {
                return jsonResponse(E2EE_ACCOUNT_CURRENTNESS);
            }
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
            log: { log: () => {} },
        });

        expect(requestSpy.mock.calls.filter(([path]) =>
            new URL(path, 'https://example.test').pathname === '/v2/sessions'
        )).toHaveLength(2);
        expect(decryptEncryptionKey).not.toHaveBeenCalled();
        expectDecryptEncryptionKeysCall(decryptEncryptionKeys, ['k2', 'k0']);
        expect(initializeSessions).toHaveBeenCalledTimes(1);
        expect(decryptMetadata).toHaveBeenCalledTimes(2);
        expect(decryptAgentState).toHaveBeenCalledTimes(2);

        expect(appliedSessions).toHaveLength(3);
        expect(appliedSessions.map((session) => session.id)).toEqual(['s2', 's1', 's0']);

        const sharedSession = appliedSessions.find((session) => session.id === 's1');
        expect(sharedSession?.accessLevel).toBe('view');
        expect(sharedSession?.canApprovePermissions).toBe(false);

        expect(sessionDataKeys.has('s2')).toBe(true);
        expect(sessionDataKeys.has('s0')).toBe(true);
        expect(sessionDataKeys.has('s1')).toBe(false);
    });

    it('does not apply a stale hydrated session with legacy read state', async () => {
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

        await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            request: requestSpy,
            getCurrentSessionListRenderable: () => null,
            applySessions,
            log: { log: () => {} },
        });

        expect(applySessions).not.toHaveBeenCalled();
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
        const cachedKey = createSessionDataKeyFixture(9);
        const rotatedCachedKey = createSessionDataKeyFixture(1);
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
            log: { log: () => {} },
        });

        expect(decryptEncryptionKey).not.toHaveBeenCalled();
        expectDecryptEncryptionKeysCall(decryptEncryptionKeys, ['new-envelope']);
        expectInitializeSessionsCall(initializeSessions, [
            ['s_cached', cachedKey],
            ['s_rotated', createSessionDataKeyFixture('new-envelope'.length)],
        ]);
        expect(sessionDataKeys.get('s_cached')).toBe(cachedKey);
        expect(sessionDataKeys.get('s_rotated')).toEqual(createSessionDataKeyFixture('new-envelope'.length));
        expect(sessionDataKeyEnvelopes.get('s_cached')).toBe('cached-envelope');
        expect(sessionDataKeyEnvelopes.get('s_rotated')).toBe('new-envelope');

        const decryptDataKeysEvent = syncPerformanceTelemetry.snapshot().events.find(
            (event) => event.name === 'sync.sessions.snapshot.decryptDataKeys',
        );
        expect(decryptDataKeysEvent?.fields.cached).toBe(1);
        expect(decryptDataKeysEvent?.fields.decrypts).toBe(1);
    });

    it('does not repopulate session encryption caches after the server scope has been reset', async () => {
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
            log: { log: () => {} },
        });

        expect(sessionDataKeys.get('plain_reset')).toBe(stalePlainKey);
        expect(sessionDataKeyEnvelopes.get('plain_reset')).toBe('stale-plain-envelope');
        expect(sessionDataKeys.has('encrypted_reset')).toBe(false);
        expect(sessionDataKeyEnvelopes.has('encrypted_reset')).toBe(false);
        expect(initializeSessions).not.toHaveBeenCalled();
        expect(applySessions).not.toHaveBeenCalled();
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
                log: { log: () => {} },
            }),
        ).rejects.toBeInstanceOf(HappyError);
    });

    it('rejects an invalid current list response without publishing an older endpoint response', async () => {
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

        await expect(fetchAndApplySessions({
            credentials: { token: 't', secret: 's' },
            encryption,
            sessionDataKeys: new Map<string, Uint8Array>(),
            applySessions: (sessions) => {
                appliedSessions.push(...(sessions as unknown as Array<Record<string, unknown>>));
            },
            log: { log: () => {} },
        })).rejects.toMatchObject({ code: 'invalid_response' });

        expect(appliedSessions).toEqual([]);
    });

    it('reports the current endpoint parse failure even when an older endpoint also has malformed rows', async () => {
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
                log: { log: () => {} },
            }),
        ).rejects.toMatchObject({ code: 'invalid_response' });
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
            log: { log: () => {} },
        });

        expect(requestSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(appliedSessions.map((session) => session.id)).toEqual(['s1']);
    });
});
