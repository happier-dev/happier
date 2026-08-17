import {
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    computeAccountEncryptionMigrateKeyFingerprintV1,
    createAccountScopedCryptoMaterialSnapshotV1,
    deriveAccountMachineKeyFromRecoverySecret,
} from '@happier-dev/protocol';
import tweetnacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT_SECRET = new Uint8Array(32).fill(7);
const ACCOUNT_CONTENT_PUBLIC_KEY = new Uint8Array(
    tweetnacl.box.keyPair.fromSecretKey(
        deriveAccountMachineKeyFromRecoverySecret(ACCOUNT_SECRET),
    ).publicKey,
);
const ACCOUNT_CONTENT_PUBLIC_KEY_FINGERPRINT =
    createAccountScopedCryptoMaterialSnapshotV1({
        accountEncryptionMode: 'e2ee',
        material: { type: 'legacy', secret: ACCOUNT_SECRET },
    }).contentPublicKeyFingerprint;
const ACCOUNT_MIGRATION_CONTENT_KEY_FINGERPRINT =
    computeAccountEncryptionMigrateKeyFingerprintV1(
        ACCOUNT_CONTENT_PUBLIC_KEY,
    );

const resolveContextSpy = vi.hoisted(() => vi.fn());
const fetchAndApplySessionByIdSpy = vi.hoisted(() => vi.fn());
const runtimeFetchSpy = vi.hoisted(() => vi.fn());
const fetchAccountEncryptionCurrentnessSpy = vi.hoisted(() => vi.fn());

vi.mock('./resolveServerScopedSessionContext', () => ({
    resolveServerScopedSessionContext: (params: unknown) => resolveContextSpy(params),
}));

vi.mock('@/sync/engine/sessions/sessionById', () => ({
    fetchAndApplySessionById: (params: unknown) => fetchAndApplySessionByIdSpy(params),
}));

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (...args: unknown[]) => runtimeFetchSpy(...args),
}));

vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({
    fetchAccountEncryptionCurrentness: (...args: unknown[]) =>
        fetchAccountEncryptionCurrentnessSpy(...args),
}));

describe('fetchSessionByIdWithServerScope', () => {
    beforeEach(() => {
        fetchAccountEncryptionCurrentnessSpy.mockResolvedValue({
            mode: 'e2ee',
            version: 1,
            signingKeyFingerprint: 'signing-1',
            contentKeyFingerprint:
                ACCOUNT_MIGRATION_CONTENT_KEY_FINGERPRINT,
            updatedAt: 1,
        });
    });

    afterEach(() => {
        resolveContextSpy.mockReset();
        fetchAndApplySessionByIdSpy.mockReset();
        runtimeFetchSpy.mockReset();
        fetchAccountEncryptionCurrentnessSpy.mockReset();
    });

    it('uses the active session-by-id request when the preferred owner server is active', async () => {
        resolveContextSpy.mockResolvedValue({ scope: 'active', timeoutMs: 5000 });
        fetchAndApplySessionByIdSpy.mockImplementationOnce(async (params: {
            fetchAccountCurrentness: () => Promise<unknown>;
        }) => {
            await params.fetchAccountCurrentness();
            return { ok: true, session: { id: 'session-1' } };
        });
        const activeRequest = vi.fn(async () => new Response(null, { status: 200 }));

        const { fetchSessionByIdWithServerScope } = await import('./fetchSessionByIdWithServerScope');

        const result = await fetchSessionByIdWithServerScope({
            sessionId: 'session-1',
            serverId: 'server-a',
            activeCredentials: { token: 'active-token', secret: 'active-secret' },
            activeEncryption: {} as any,
            sessionDataKeys: new Map<string, Uint8Array>(),
            activeRequest,
            applySessions: vi.fn(),
            log: { log: vi.fn() },
        });

        expect(result).toEqual({ ok: true, session: { id: 'session-1' } });
        expect(resolveContextSpy).toHaveBeenCalledWith({ serverId: 'server-a' });
        expect(fetchAndApplySessionByIdSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            credentials: { token: 'active-token', secret: 'active-secret' },
            request: activeRequest,
            fetchAccountCurrentness: expect.any(Function),
        }));
        expect(fetchAccountEncryptionCurrentnessSpy).toHaveBeenCalledWith(
            { token: 'active-token', secret: 'active-secret' },
            { request: activeRequest },
        );
        expect(runtimeFetchSpy).not.toHaveBeenCalled();
    });

    it('uses a scoped session-by-id request after discovering V3 server support', async () => {
        const decryptEncryptionKey = vi.fn(async () => new Uint8Array([1]));
        const initializeSessions = vi.fn(async () => {});
        const getSessionEncryption = vi.fn(() => ({
            decryptAgentState: vi.fn(async () => null),
            decryptMetadata: vi.fn(async () => null),
        }));
        resolveContextSpy.mockResolvedValue({
            scope: 'scoped',
            targetServerId: 'server-b',
            targetServerUrl: 'https://server-b.example.test',
            token: 'scoped-token',
            credentials: {
                token: 'scoped-token',
                secret: 'scoped-secret',
            },
            timeoutMs: 5000,
            encryption: {
                decryptEncryptionKey,
                initializeSessions,
                getSessionEncryption,
            },
        });
        fetchAndApplySessionByIdSpy.mockImplementationOnce(async (params: {
            fetchAccountCurrentness: () => Promise<unknown>;
        }) => {
            await params.fetchAccountCurrentness();
            return { ok: true, session: { id: 'session-1' } };
        });
        runtimeFetchSpy.mockResolvedValue(new Response(null, { status: 200 }));

        const { recordAccountStoredContentServerRequirements } = await import(
            '@/sync/http/accountStoredContentCompatibility'
        );
        recordAccountStoredContentServerRequirements({
            serverUrl: 'https://server-b.example.test',
            requirements: {
                v: 1,
                minimumProtocolVersion: 2,
                currentProtocolVersion: 3,
                declarationTransport: 'http-header-and-socket-auth-v1',
            },
        });
        const { fetchSessionByIdWithServerScope } = await import('./fetchSessionByIdWithServerScope');

        const result = await fetchSessionByIdWithServerScope({
            sessionId: 'session-1',
            serverId: 'server-b',
            activeCredentials: { token: 'active-token', secret: 'active-secret' },
            activeEncryption: {} as any,
            sessionDataKeys: new Map<string, Uint8Array>(),
            activeRequest: vi.fn(),
            applySessions: vi.fn(),
            log: { log: vi.fn() },
        });

        expect(result).toEqual({ ok: true, session: { id: 'session-1' } });
        const params = fetchAndApplySessionByIdSpy.mock.calls[0]?.[0];
        expect(params.credentials).toEqual({
            token: 'scoped-token',
            secret: 'scoped-secret',
        });
        await params.request('/v2/sessions/session-1', { method: 'GET', headers: { 'X-Test': '1' } });
        const requestCall = runtimeFetchSpy.mock.calls.find(([input]) =>
            String(input) === 'https://server-b.example.test/v2/sessions/session-1');
        expect(requestCall?.[1]).toEqual(expect.objectContaining({
            method: 'GET',
        }));
        const headers = new Headers(requestCall?.[1]?.headers);
        expect(headers.get('Authorization')).toBe('Bearer scoped-token');
        expect(headers.get('X-Test')).toBe('1');
        expect(headers.get('x-happier-account-stored-content-protocol')).toBe(
            String(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION.protocolVersion),
        );
        expect(fetchAccountEncryptionCurrentnessSpy).toHaveBeenCalledWith(
            {
                token: 'scoped-token',
                secret: 'scoped-secret',
            },
            { request: params.request },
        );
    });

    it('forwards shell-only hydration options to the session-by-id reader', async () => {
        resolveContextSpy.mockResolvedValue({ scope: 'active', timeoutMs: 5000 });
        fetchAndApplySessionByIdSpy.mockResolvedValue({ ok: true, session: { id: 'session-1' } });

        const { fetchSessionByIdWithServerScope } = await import('./fetchSessionByIdWithServerScope');

        await fetchSessionByIdWithServerScope({
            sessionId: 'session-1',
            serverId: 'server-a',
            activeCredentials: { token: 'active-token', secret: 'active-secret' },
            activeEncryption: {} as any,
            sessionDataKeys: new Map<string, Uint8Array>(),
            activeRequest: vi.fn(),
            applySessions: vi.fn(),
            log: { log: vi.fn() },
            includeTurnsProjection: false,
        });

        expect(fetchAndApplySessionByIdSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            includeTurnsProjection: false,
        }));
        expect(fetchAccountEncryptionCurrentnessSpy).not.toHaveBeenCalled();
    });

    it('returns an ephemeral tuple writer context only for an explicit mutation snapshot read', async () => {
        resolveContextSpy.mockResolvedValue({ scope: 'active', timeoutMs: 5000 });
        const snapshot = {
            mode: 'owner',
            metadataLayoutVersion: 1,
            metadataVersion: 3,
            sharedMetadataCiphertext: 'shared-current',
            ownerMetadataEnvelope: {
                t: 'encrypted',
                c: 'owner-current',
            },
            agentStateVersion: 4,
            agentStateCiphertext: null,
            value: {
                metadata: { summary: { text: 'Before', updatedAt: 1 } },
                sharedMetadata: { v: 1 },
                ownerMetadata: { v: 1 },
                agentState: null,
            },
        };
        fetchAndApplySessionByIdSpy.mockResolvedValue({
            ok: true,
            session: { id: 'session-1', encryptionMode: 'e2ee' },
            metadataTupleMutationSnapshot: snapshot,
        });
        const encryptRaw = vi.fn(async () => 'encrypted-payload');
        const activeEncryption = {
            getSessionEncryption: vi.fn(() => ({
                encryptRaw,
                decryptAgentState: vi.fn(async () => null),
                decryptMetadata: vi.fn(async () => null),
            })),
        } as any;

        const { fetchSessionByIdWithServerScope } =
            await import('./fetchSessionByIdWithServerScope');
        const result = await fetchSessionByIdWithServerScope({
            sessionId: 'session-1',
            activeCredentials: {
                token: 'active-token',
                secret: 'active-secret',
            },
            activeEncryption,
            sessionDataKeys: new Map(),
            activeRequest: vi.fn(),
            applySessions: vi.fn(),
            log: { log: vi.fn() },
            includeMetadataTupleMutationSnapshot: true,
        });

        expect(fetchAndApplySessionByIdSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                includeMetadataTupleMutationSnapshot: true,
            }),
        );
        expect(result.metadataTupleMutationSnapshot).toBe(snapshot);
        expect(result.metadataTupleWriterContext).not.toHaveProperty(
            'credentials',
        );
        expect(
            result.metadataTupleWriterContext?.encodeOwnerMetadata,
        ).toEqual(expect.any(Function));
        await expect(
            result.metadataTupleWriterContext?.encryptPayload({ v: 1 }),
        ).resolves.toBe('encrypted-payload');
        expect(encryptRaw).toHaveBeenCalledWith({ v: 1 });
    });

    it('does not require Account currentness for a shared-editor mutation snapshot', async () => {
        resolveContextSpy.mockResolvedValue({ scope: 'active', timeoutMs: 5000 });
        fetchAndApplySessionByIdSpy.mockResolvedValue({
            ok: true,
            session: { id: 'session-1', encryptionMode: 'plain' },
            metadataTupleMutationSnapshot: {
                mode: 'shared_editor',
                metadataLayoutVersion: 1,
                metadataVersion: 3,
                sharedMetadataCiphertext: '{}',
                ownerMetadataEnvelope: null,
                agentStateVersion: 0,
                agentStateCiphertext: null,
                value: {
                    metadata: {},
                    sharedMetadata: { v: 1 },
                    ownerMetadata: null,
                    agentState: null,
                },
            },
        });

        const { fetchSessionByIdWithServerScope } =
            await import('./fetchSessionByIdWithServerScope');
        const result = await fetchSessionByIdWithServerScope({
            sessionId: 'session-1',
            activeCredentials: { token: 'active-token' },
            activeEncryption: null,
            sessionDataKeys: new Map(),
            activeRequest: vi.fn(),
            applySessions: vi.fn(),
            log: { log: vi.fn() },
            includeMetadataTupleMutationSnapshot: true,
        });

        expect(fetchAccountEncryptionCurrentnessSpy).not.toHaveBeenCalled();
        await expect(
            result.metadataTupleWriterContext?.encryptPayload({ v: 1 }),
        ).resolves.toBe('{"v":1}');
        expect(() => result.metadataTupleWriterContext?.encodeOwnerMetadata({
            v: 1,
        })).toThrow('Shared Session metadata cannot encode owner metadata');
    });

    it.each([
        {
            transcriptMode: 'plain' as const,
            ownerEnvelope: {
                t: 'encrypted' as const,
                c: 'owner-current',
            },
            accountMode: 'e2ee' as const,
            snapshotMode: 'legacy_owner' as const,
            expectedOwnerEnvelopeKind: 'encrypted' as const,
        },
        {
            transcriptMode: 'e2ee' as const,
            ownerEnvelope: {
                t: 'plain' as const,
                v: { v: 1 as const },
            },
            accountMode: 'plain' as const,
            snapshotMode: 'owner' as const,
            expectedOwnerEnvelopeKind: 'plain' as const,
        },
    ])(
        'keeps owner-envelope mode independent from $transcriptMode transcript mode',
        async ({
            transcriptMode,
            ownerEnvelope,
            accountMode,
            snapshotMode,
            expectedOwnerEnvelopeKind,
        }) => {
            const contentKeyFingerprint = accountMode === 'e2ee'
                ? ACCOUNT_MIGRATION_CONTENT_KEY_FINGERPRINT
                : null;
            fetchAccountEncryptionCurrentnessSpy.mockResolvedValue({
                mode: accountMode,
                version: 2,
                signingKeyFingerprint:
                    accountMode === 'e2ee' ? 'signing-2' : null,
                contentKeyFingerprint,
                updatedAt: 2,
            });
            resolveContextSpy.mockResolvedValue({
                scope: 'active',
                timeoutMs: 5000,
            });
            fetchAndApplySessionByIdSpy.mockResolvedValue({
                ok: true,
                session: {
                    id: 'session-1',
                    encryptionMode: transcriptMode,
                },
                metadataTupleMutationSnapshot:
                    snapshotMode === 'legacy_owner'
                        ? {
                            mode: snapshotMode,
                            metadataLayoutVersion: 0,
                            metadataVersion: 3,
                            metadataCiphertext: 'metadata-current',
                            ownerMetadata: null,
                            agentStateVersion: 4,
                            agentStateCiphertext: null,
                            value: {
                                metadata: {},
                                agentState: null,
                            },
                        }
                        : {
                            mode: snapshotMode,
                            metadataLayoutVersion: 1,
                            metadataVersion: 3,
                            sharedMetadataCiphertext: 'shared-current',
                            ownerMetadataEnvelope: ownerEnvelope,
                            agentStateVersion: 4,
                            agentStateCiphertext: null,
                            value: {
                                metadata: {},
                                sharedMetadata: { v: 1 },
                                ownerMetadata: { v: 1 },
                                agentState: null,
                            },
                        },
            });
            const activeEncryption = {
                getSessionEncryption: vi.fn(() => ({
                    encryptRaw: vi.fn(async () => 'encrypted-payload'),
                    decryptAgentState: vi.fn(async () => null),
                    decryptMetadata: vi.fn(async () => null),
                })),
            } as any;
            const { fetchSessionByIdWithServerScope } =
                await import('./fetchSessionByIdWithServerScope');
            const result = await fetchSessionByIdWithServerScope({
                sessionId: 'session-1',
                activeCredentials: accountMode === 'plain'
                    ? { token: 'active-token' }
                    : {
                        token: 'active-token',
                        secret: Buffer.from(
                            ACCOUNT_SECRET,
                        ).toString('base64url'),
                    },
                activeEncryption,
                sessionDataKeys: new Map(),
                activeRequest: vi.fn(),
                applySessions: vi.fn(),
                log: { log: vi.fn() },
                includeMetadataTupleMutationSnapshot: true,
            });

            expect(
                result.metadataTupleWriterContext
                    ?.encodeOwnerMetadata({ v: 1 }).t,
            ).toBe(expectedOwnerEnvelopeKind);
            if (accountMode === 'e2ee') {
                expect(
                    result.metadataTupleWriterContext
                        ?.ownerMigrationCurrentness,
                ).toEqual({
                    expectedAccountEncryptionMode: 'e2ee',
                    expectedAccountContentPublicKeyFingerprint:
                        ACCOUNT_CONTENT_PUBLIC_KEY_FINGERPRINT,
                });
            }
        },
    );

    it('fails closed when the local Account content key does not match E2EE currentness', async () => {
        fetchAccountEncryptionCurrentnessSpy.mockResolvedValue({
            mode: 'e2ee',
            version: 2,
            signingKeyFingerprint: 'signing-2',
            contentKeyFingerprint:
                computeAccountEncryptionMigrateKeyFingerprintV1(
                    new Uint8Array(32).fill(9),
                ),
            updatedAt: 2,
        });
        resolveContextSpy.mockResolvedValue({
            scope: 'active',
            timeoutMs: 5000,
        });
        fetchAndApplySessionByIdSpy.mockResolvedValue({
            ok: true,
            session: { id: 'session-1', encryptionMode: 'plain' },
            metadataTupleMutationSnapshot: {
                mode: 'legacy_owner',
                metadataLayoutVersion: 0,
                metadataVersion: 3,
                metadataCiphertext: 'metadata-current',
                ownerMetadata: null,
                agentStateVersion: 4,
                agentStateCiphertext: null,
                value: {
                    metadata: {},
                    agentState: null,
                },
            },
        });

        const { fetchSessionByIdWithServerScope } =
            await import('./fetchSessionByIdWithServerScope');
        await expect(fetchSessionByIdWithServerScope({
            sessionId: 'session-1',
            activeCredentials: {
                token: 'active-token',
                secret: Buffer.from(ACCOUNT_SECRET).toString('base64url'),
            },
            activeEncryption: null,
            sessionDataKeys: new Map(),
            activeRequest: vi.fn(),
            applySessions: vi.fn(),
            log: { log: vi.fn() },
            includeMetadataTupleMutationSnapshot: true,
        })).rejects.toThrow(
            'Account encryption material does not match current Account state',
        );
    });
});
