import { describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { AccountEncryptionCurrentnessResponse, V2SessionRecord } from '@happier-dev/protocol';

import { fetchAndApplySessions as fetchAndApplySessionsSource, type SessionListEncryption } from './sessionSnapshot';
import { createCompactSessionListFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { fetchAndApplySessionById, type SessionByIdEncryption } from './sessionById';

function fetchAndApplySessions(params: Parameters<typeof fetchAndApplySessionsSource>[0]) {
    const request = params.request;
    return fetchAndApplySessionsSource({ ...params,
        ...(request ? { request: createCompactSessionListFetchBoundary(async (path, init) => path === '/v2/sessions/read-batch'
            ? undefined : request(path, init)) } : {}),
    });
}

/**
 * Session-list hydration and single-Session hydration must agree about what an absent envelope
 * means. Absence is owner-only compatibility material; a present envelope that will not open, and
 * any envelope at all for a non-owner, must settle instead of reaching Account-scoped material.
 */

const PLAIN_ACCOUNT_CURRENTNESS = {
    mode: 'plain',
    version: 1,
    signingKeyFingerprint: null,
    contentKeyFingerprint: null,
    updatedAt: 1,
    recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
} satisfies AccountEncryptionCurrentnessResponse;

const LEGACY_CREDENTIALS = { token: 't', secret: 's' } as AuthCredentials;
const KEYLESS_CREDENTIALS = { token: 't' } as AuthCredentials;

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

function buildSessionRow(overrides: Partial<V2SessionRecord> & Pick<V2SessionRecord, 'id'>): V2SessionRecord {
    const { id, ...rest } = overrides;
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        archivedAt: null,
        metadata: `metadata-${id}`,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        dataEncryptionKey: null,
        share: null,
        ...rest,
    } as V2SessionRecord;
}

/**
 * `getSessionEncryption` only answers for Sessions the runtime was actually asked to initialize,
 * so a cleared Session cannot silently keep decrypting through a stale mock.
 */
function createEncryptionHarness(
    openEnvelope: (value: string) => Uint8Array | null = () => new Uint8Array(32).fill(7),
) {
    const initializedSessionIds = new Set<string>();
    const decryptEncryptionKeys = vi.fn(async (values: readonly string[]) => values.map(openEnvelope));
    const decryptEncryptionKey = vi.fn(async (value: string) => openEnvelope(value));
    const initializeSessions = vi.fn(async (
        sessionKeys: Map<string, Uint8Array | null>,
        _scope?: Parameters<SessionByIdEncryption['initializeSessions']>[1],
    ) => {
        for (const sessionId of sessionKeys.keys()) initializedSessionIds.add(sessionId);
    });
    const removeSessionEncryption = vi.fn((sessionId: string) => {
        initializedSessionIds.delete(sessionId);
    });
    const getSessionEncryption = vi.fn((sessionId: string) => (
        initializedSessionIds.has(sessionId)
            ? {
                decryptMetadata: async (_version: number, value: string) => ({ decrypted: value }),
                decryptMetadataPayload: async (_version: number, value: string) => ({ decrypted: value }),
                decryptAgentState: async () => null,
                decryptAgentStateResult: async () => ({ status: 'available' as const, value: null }),
            }
            : null
    ));
    const encryption: SessionListEncryption & SessionByIdEncryption = {
        decryptEncryptionKey,
        decryptEncryptionKeys,
        initializeSessions,
        removeSessionEncryption,
        getSessionEncryption,
    };
    return {
        encryption,
        decryptEncryptionKeys,
        initializeSessions,
        removeSessionEncryption,
    };
}

async function fetchRow(params: Readonly<{
    row: V2SessionRecord;
    credentials: AuthCredentials;
    harness: ReturnType<typeof createEncryptionHarness>;
    encryption?: SessionListEncryption | null;
}>) {
    const request = vi.fn(async (path: string) => {
        if (path === '/v2/sessions?limit=50') {
            return jsonResponse({ sessions: [params.row], nextCursor: null, hasNext: false });
        }
        throw new Error(`Unexpected path ${path}`);
    });
    const applySessions = vi.fn();
    await fetchAndApplySessions({
        credentials: params.credentials,
        accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
        encryption: params.encryption === undefined
            ? params.harness.encryption
            : params.encryption,
        sessionDataKeys: new Map<string, Uint8Array>(),
        sessionDataKeyEnvelopes: new Map<string, string>(),
        request,
        applySessions,
        log: { log: () => {} },
    });
    return { applySessions };
}

function initializedSessionKeys(
    initializeSessions: ReturnType<typeof createEncryptionHarness>['initializeSessions'],
): Array<readonly [string, Uint8Array | null]> {
    return initializeSessions.mock.calls.flatMap((call) => [
        ...(call[0] as Map<string, Uint8Array | null>).entries(),
    ]);
}

describe('session-list data-key hydration states', () => {
    it('distinguishes an absent envelope from malformed or unopened presence without a local encryption runtime', async () => {
        const rows = [
            buildSessionRow({ id: 'keyless-absent', encryptionMode: 'e2ee', dataEncryptionKey: null, share: null }),
            buildSessionRow({ id: 'keyless-malformed', encryptionMode: 'e2ee', dataEncryptionKey: '', share: null }),
            buildSessionRow({ id: 'keyless-present', encryptionMode: 'e2ee', dataEncryptionKey: 'opaque-envelope', share: null }),
        ];
        const applySessions = vi.fn();

        await fetchAndApplySessions({
            credentials: KEYLESS_CREDENTIALS,
            accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
            encryption: null,
            sessionDataKeys: new Map<string, Uint8Array>(),
            sessionDataKeyEnvelopes: new Map<string, string>(),
            request: async (path) => {
                expect(path).toBe('/v2/sessions?limit=50');
                return jsonResponse({ sessions: rows, nextCursor: null, hasNext: false });
            },
            applySessions,
            log: { log: () => {} },
        });

        const applied = applySessions.mock.calls.flatMap((call) => call[0]) as Array<{
            id: string;
            encryptedContentAvailability?: string;
        }>;
        expect(Object.fromEntries(applied.map((row) => [row.id, row.encryptedContentAvailability])))
            .toEqual({
                'keyless-absent': 'recipient_encryption_setup_required',
                'keyless-malformed': 'encrypted_access_needs_repair',
                'keyless-present': 'encrypted_access_needs_repair',
            });
    });

    it('keeps the owner-only account reader for a legacy-credential Session with no envelope', async () => {
        const harness = createEncryptionHarness();
        const { applySessions } = await fetchRow({
            row: buildSessionRow({ id: 'legacy-owner', encryptionMode: 'e2ee', dataEncryptionKey: null, share: null }),
            credentials: LEGACY_CREDENTIALS,
            harness,
        });

        expect(harness.decryptEncryptionKeys).not.toHaveBeenCalled();
        expect(initializedSessionKeys(harness.initializeSessions)).toEqual([['legacy-owner', null]]);
        expect(harness.removeSessionEncryption).not.toHaveBeenCalledWith('legacy-owner');
        expect(applySessions).toHaveBeenCalledWith(expect.arrayContaining([
            expect.objectContaining({
                id: 'legacy-owner',
                metadata: expect.objectContaining({ decrypted: 'metadata-legacy-owner' }),
            }),
        ]));
    });

    it('never hands account material to a non-owner whose envelope is absent', async () => {
        const harness = createEncryptionHarness();
        await fetchRow({
            row: buildSessionRow({
                id: 'shared-missing',
                encryptionMode: 'e2ee',
                dataEncryptionKey: null,
                share: { accessLevel: 'edit', canApprovePermissions: false },
            } as Partial<V2SessionRecord> & Pick<V2SessionRecord, 'id'>),
            credentials: LEGACY_CREDENTIALS,
            harness,
        });

        expect(initializedSessionKeys(harness.initializeSessions)).toEqual([]);
        expect(harness.removeSessionEncryption).toHaveBeenCalledWith('shared-missing');
    });

    it('never hands account material to a keyless owner whose envelope is absent', async () => {
        const harness = createEncryptionHarness();
        await fetchRow({
            row: buildSessionRow({ id: 'keyless-owner', encryptionMode: 'e2ee', dataEncryptionKey: null, share: null }),
            credentials: KEYLESS_CREDENTIALS,
            harness,
        });

        expect(initializedSessionKeys(harness.initializeSessions)).toEqual([]);
        expect(harness.removeSessionEncryption).toHaveBeenCalledWith('keyless-owner');
    });

    it.each([
        [null, 'recipient_encryption_setup_required'],
        ['', 'encrypted_access_needs_repair'],
        ['published-envelope', 'encrypted_access_needs_repair'],
    ] as const)(
        'matches by-ID token-only locked classification for envelope %j',
        async (dataEncryptionKey, encryptedContentAvailability) => {
            const harness = createEncryptionHarness(() => null);
            const { applySessions } = await fetchRow({
                row: buildSessionRow({
                    id: 'token-only-row',
                    encryptionMode: 'e2ee',
                    dataEncryptionKey,
                    share: { accessLevel: 'view', canApprovePermissions: false },
                } as Partial<V2SessionRecord> & Pick<V2SessionRecord, 'id'>),
                credentials: KEYLESS_CREDENTIALS,
                harness,
                encryption: null,
            });

            const listRow = applySessions.mock.calls.flatMap((call) => call[0]).find((row) => row.id === 'token-only-row');
            expect(listRow).toMatchObject({
                id: 'token-only-row',
                metadata: null,
                encryptedContentAvailability,
            });

            const applyByIdSessions = vi.fn();
            const byIdResult = await fetchAndApplySessionById({
                sessionId: 'token-only-row',
                credentials: KEYLESS_CREDENTIALS,
                accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
                encryption: harness.encryption,
                sessionDataKeys: new Map<string, Uint8Array>(),
                sessionDataKeyEnvelopes: new Map<string, string>(),
                request: async (path) => {
                    expect(path).toBe('/v2/sessions/token-only-row');
                    return jsonResponse({ session: buildSessionRow({
                        id: 'token-only-row',
                        encryptionMode: 'e2ee',
                        dataEncryptionKey,
                        share: { accessLevel: 'view', canApprovePermissions: false },
                    } as Partial<V2SessionRecord> & Pick<V2SessionRecord, 'id'>), });
                },
                applySessions: applyByIdSessions,
                includeTurnsProjection: false,
                log: { log: () => {} },
            });
            expect(byIdResult.ok).toBe(true);
            const byIdRow = applyByIdSessions.mock.calls.flatMap((call) => call[0])[0];
            expect(byIdRow).toMatchObject({
                id: 'token-only-row',
                metadata: null,
                encryptedContentAvailability,
            });
            expect(byIdRow.encryptedContentAvailability).toBe(listRow?.encryptedContentAvailability);
        },
    );

    it('settles a present envelope that will not open instead of falling back', async () => {
        const harness = createEncryptionHarness(() => null);
        await fetchRow({
            row: buildSessionRow({
                id: 'unopenable',
                encryptionMode: 'e2ee',
                dataEncryptionKey: 'envelope-unopenable',
                share: null,
            }),
            credentials: LEGACY_CREDENTIALS,
            harness,
        });

        expect(harness.decryptEncryptionKeys).toHaveBeenCalledTimes(1);
        expect(initializedSessionKeys(harness.initializeSessions)).toEqual([]);
        expect(harness.removeSessionEncryption).toHaveBeenCalledWith('unopenable');
    });

    it('does not publish opened keys after the Account/Home encryption generation changes during initialization', async () => {
        let generation = 3;
        let releaseInitialization!: () => void;
        const initialization = new Promise<void>((resolve) => {
            releaseInitialization = resolve;
        });
        const sessionDataKeys = new Map<string, Uint8Array>();
        const sessionDataKeyEnvelopes = new Map<string, string>();
        const initializeSessions = vi.fn(async () => await initialization);
        const applySessions = vi.fn();
        const row = buildSessionRow({
            id: 'generation-scoped-list-row',
            encryptionMode: 'e2ee',
            dataEncryptionKey: 'current-envelope',
            share: { accessLevel: 'view', canApprovePermissions: false },
        } as Partial<V2SessionRecord> & Pick<V2SessionRecord, 'id'>);

        const hydration = fetchAndApplySessions({
            serverId: 'server-a',
            credentials: LEGACY_CREDENTIALS,
            accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
            encryption: {
                decryptEncryptionKeys: async () => [new Uint8Array(32).fill(8)],
                initializeSessions,
                removeSessionEncryption: vi.fn(),
                getSessionEncryption: () => null,
                getCurrentEncryptionGenerationScope: (scope) => ({
                    accountId: scope?.accountId ?? 'account-a',
                    serverId: scope?.serverId ?? null,
                    generation,
                }),
                isCurrentEncryptionGenerationScope: (scope) => scope.generation === generation,
            },
            sessionDataKeys,
            sessionDataKeyEnvelopes,
            request: async (path) => {
                expect(path).toBe('/v2/sessions?limit=50');
                return jsonResponse({ sessions: [row], nextCursor: null, hasNext: false });
            },
            applySessions,
            log: { log: () => {} },
        });

        await vi.waitFor(() => expect(initializeSessions).toHaveBeenCalledTimes(1));
        generation += 1;
        releaseInitialization();
        await hydration;

        expect(sessionDataKeys.has(row.id)).toBe(false);
        expect(sessionDataKeyEnvelopes.has(row.id)).toBe(false);
        expect(applySessions).not.toHaveBeenCalled();
        expect(initializeSessions).toHaveBeenCalledWith(
            new Map([[row.id, new Uint8Array(32).fill(8)]]),
            expect.objectContaining({ serverId: 'server-a', shouldContinue: expect.any(Function) }),
        );
    });
});
