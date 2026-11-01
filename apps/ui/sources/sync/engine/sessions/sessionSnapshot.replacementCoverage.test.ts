import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { V2SessionRecord } from '@happier-dev/protocol';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';

import { fetchAndApplySessions, type SessionListEncryption } from './sessionSnapshot';

/**
 * Voice announcements are a genuine side-effect boundary reached by the hydrated
 * apply path; the session-list logic under test runs unchanged beneath it.
 */
vi.mock('@/voice/context/voiceHooks', () => ({
    voiceHooks: {
        onAgentRequest: vi.fn(),
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

function buildPlainRow(id: string): V2SessionRecord {
    return {
        id,
        seq: 1,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        meaningfulActivityAt: 1_700_000_000_000,
        active: false,
        activeAt: 1_700_000_000_000,
        archivedAt: null,
        encryptionMode: 'plain',
        metadata: JSON.stringify({ path: '/repo', host: 'host' }),
        metadataVersion: 1,
        agentState: JSON.stringify({}),
        agentStateVersion: 1,
        lastViewedSessionSeq: 1,
        pendingPermissionRequestCount: 0,
        pendingUserActionRequestCount: 0,
        pendingBlockedCount: 0,
        dataEncryptionKey: null,
        share: null,
    };
}

function createEncryptionHarness(): SessionListEncryption {
    return {
        decryptEncryptionKeys: vi.fn(async (values: readonly string[]) => values.map(() => null)),
        initializeSessions: vi.fn(async () => {}),
        removeSessionEncryption: vi.fn(),
        getSessionEncryption: vi.fn(() => null),
    };
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

async function snapshotCoverage(input: Readonly<{
    page?: { hasNext?: unknown; nextCursor: string | null };
    request?: (path: string) => Promise<Response>;
    sessionListCursor?: string | null;
}>): Promise<boolean | undefined> {
    const coverage: Array<boolean | undefined> = [];
    const page = input.page ?? { hasNext: false, nextCursor: null };
    await fetchAndApplySessions({
        credentials: { token: 't', secret: 's' } as AuthCredentials,
        encryption: createEncryptionHarness(),
        sessionDataKeys: new Map<string, Uint8Array>(),
        sessionListCursor: input.sessionListCursor ?? null,
        request: input.request ?? (async () => jsonResponse({ sessions: [buildPlainRow('s1')], ...page })),
        applySessionListRenderables: (_renderables, options) => {
            coverage.push(options?.coversWholeList);
        },
        applySessions: () => {},
        repairInvalidReadStateV1: async () => {},
        log: { log: () => {} },
    });
    expect(coverage).toHaveLength(1);
    return coverage[0];
}

afterEach(() => {
    vi.clearAllMocks();
});

describe('session-list snapshot replacement coverage', () => {
    it('requires readable metadata for a targeted row without a separate hydration option', async () => {
        const encryption = createEncryptionHarness();
        encryption.getSessionEncryption = () => ({
            decryptMetadata: async () => null,
            decryptAgentState: async () => ({}),
        });
        await expect(fetchAndApplySessions({
            credentials: { token: 't', secret: 's' } as AuthCredentials,
            encryption,
            sessionDataKeys: new Map(),
            sessionListScope: 'required',
            requiredSessionIds: ['required'],
            request: async () => jsonResponse({
                sessions: [{ ...buildPlainRow('required'), encryptionMode: 'e2ee' }],
                nextCursor: null,
                hasNext: false,
            }),
            applySessionListRenderables: () => {},
            applySessions: () => {},
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        })).rejects.toThrow(/required.*hydration/i);
    });

    it('keeps account hydration running when targeted changed rows hydrate through the same owner', async () => {
        const accountStarted = createDeferred<void>();
        const accountMetadata = createDeferred<{ path: string; host: string }>();
        const encryption = createEncryptionHarness();
        encryption.getSessionEncryption = () => ({
            decryptMetadata: async (_version, value) => {
                if (value === 'account-payload') {
                    accountStarted.resolve(undefined);
                    return accountMetadata.promise;
                }
                return { path: '/targeted', host: 'host' };
            },
            decryptAgentState: async () => ({}),
        });
        const appliedIds: string[] = [];
        const fetchRow = (id: string, scope: 'account' | 'required') => fetchAndApplySessions({
            credentials: { token: 't', secret: 's' } as AuthCredentials,
            encryption,
            sessionDataKeys: new Map(),
            sessionListScope: scope,
            requiredSessionIds: [id],
            requiredHydrationSessionIds: [id],
            awaitSessionListHydration: true,
            request: async () => jsonResponse({
                sessions: [{ ...buildPlainRow(id), encryptionMode: 'e2ee', metadata: `${id}-payload` }],
                nextCursor: null,
                hasNext: false,
            }),
            applySessionListRenderables: () => {},
            applySessions: (sessions) => { appliedIds.push(...sessions.map((session) => session.id)); },
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        const accountFetch = fetchRow('account', 'account');
        await accountStarted.promise;
        try {
            await fetchRow('targeted', 'required');
        } finally {
            accountMetadata.resolve({ path: '/account', host: 'host' });
            await accountFetch;
        }
        expect(appliedIds.sort()).toEqual(['account', 'targeted']);
    });

    it.each([true, false])('rejects awaited required-row hydration when its encrypted payload cannot be decrypted (renderables: %s)', async (withRenderables) => {
        const encryption = createEncryptionHarness();
        encryption.getSessionEncryption = () => ({
            decryptMetadata: async () => { throw new Error('invalid encrypted payload'); },
            decryptAgentState: async () => ({}),
        });
        const applySessions = vi.fn();
        await expect(fetchAndApplySessions({
            credentials: { token: 't', secret: 's' } as AuthCredentials,
            encryption,
            sessionDataKeys: new Map(),
            requiredHydrationSessionIds: ['required'],
            awaitSessionListHydration: true,
            request: async () => jsonResponse({
                sessions: [{ ...buildPlainRow('required'), encryptionMode: 'e2ee' }],
                nextCursor: null,
                hasNext: false,
            }),
            applySessionListRenderables: withRenderables ? () => {} : undefined,
            applySessions,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        })).rejects.toThrow(/required.*hydration/i);
        expect(applySessions).not.toHaveBeenCalled();
    });

    it('hydrates a required-only response without replacing the account list or reporting whole-list coverage', async () => {
        const applySessionListRenderables = vi.fn();
        const applySessions = vi.fn();
        const requestedPaths: string[] = [];
        const result = await fetchAndApplySessions({
            credentials: { token: 't', secret: 's' } as AuthCredentials,
            encryption: createEncryptionHarness(),
            sessionDataKeys: new Map(),
            sessionListScope: 'required',
            requiredSessionIds: ['required', 'omitted'],
            requiredHydrationSessionIds: ['required', 'omitted'],
            includeActiveSessionRows: true,
            includeSessionListAttentionRows: true,
            awaitSessionListHydration: true,
            request: async (path) => {
                requestedPaths.push(path);
                return jsonResponse({
                    sessions: [buildPlainRow('unrelated'), buildPlainRow('required')],
                    nextCursor: 'ordinary-page-2',
                    hasNext: true,
                });
            },
            applySessionListRenderables,
            applySessions,
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });

        expect(result).toMatchObject({ sessionIds: ['required'], nextCursor: null, hasNext: false });
        expect(applySessionListRenderables).toHaveBeenCalledWith(
            [expect.objectContaining({ id: 'required' })],
            { replace: false, coversWholeList: false },
        );
        expect(applySessions.mock.calls.flatMap(([sessions]) => sessions.map((session: { id: string }) => session.id))).toEqual(['required']);
        expect(requestedPaths).toHaveLength(1);
        const query = new URL(requestedPaths[0], 'https://example.test').searchParams;
        expect(query.get('requiredOnly')).toBe('true');
        expect(query.has('includeActive')).toBe(false);
        expect(query.has('includeAttention')).toBe(false);
    });

    it('declares the replacement authoritative for the whole list when the server has no further page', async () => {
        await expect(snapshotCoverage({ page: { hasNext: false, nextCursor: null } })).resolves.toBe(true);
    });

    it('declares the replacement partial when the server has a further page', async () => {
        await expect(snapshotCoverage({ page: { hasNext: true, nextCursor: 'cursor_2' } })).resolves.toBe(false);
    });

    it.each([undefined, 0])('keeps coverage partial without an explicit end-of-list signal (%s)', async (hasNext) => {
        await expect(snapshotCoverage({ page: { hasNext, nextCursor: null } })).resolves.toBe(false);
    });

    it('keeps the replacement partial when the server reports a further page it cannot page to', async () => {
        await expect(snapshotCoverage({ page: { hasNext: true, nextCursor: null } })).resolves.toBe(false);
    });

    it('keeps the replacement partial when it starts from a cursor below the list head', async () => {
        await expect(snapshotCoverage({
            sessionListCursor: 'cursor_1',
            page: { hasNext: false, nextCursor: null },
        })).resolves.toBe(false);
    });

    it('keeps the replacement partial for the capped /v1/sessions fallback', async () => {
        await expect(snapshotCoverage({
            request: async (path) => path.startsWith('/v2/sessions')
                ? jsonResponse({ error: 'Not found' }, 404)
                : jsonResponse({ sessions: [buildPlainRow('s1')] }),
        })).resolves.toBe(false);
    });
});
