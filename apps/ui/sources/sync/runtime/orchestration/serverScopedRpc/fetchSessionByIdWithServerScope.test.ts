import {
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION} from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import {
    computeAccountEncryptionMigrateKeyFingerprintV1} from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import {
    createAccountScopedCryptoMaterialSnapshotV1,
    deriveAccountMachineKeyFromRecoverySecret,
} from '@happier-dev/protocol/crypto/accountScopedCipher';
import tweetnacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { createOperationAccountCurrentnessSource, fetchSessionByIdWithServerScope } from './fetchSessionByIdWithServerScope';

// Mutation writers escape the read; this test invocation owns their finite
// Account observation through assertions, including cleanup on assertion failure.
function fetchMutationSnapshotForTest(params: Omit<Parameters<typeof fetchSessionByIdWithServerScope>[0],
    'includeMetadataTupleMutationSnapshot' | 'accountCurrentnessSource'>) {
    const source = createOperationAccountCurrentnessSource({
        credentials: params.activeCredentials,
        request: params.activeRequest,
        serverId: params.serverId,
    });
    onTestFinished(() => source.dispose());
    return fetchSessionByIdWithServerScope({ ...params,
        includeMetadataTupleMutationSnapshot: true, accountCurrentnessSource: source });
}

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
const getCachedServerFeaturesSnapshotSpy = vi.hoisted(() => vi.fn());

// Counts each full Account proof; the real derivation still runs beneath it.
const accountProofs = vi.hoisted(() => ({ count: 0 }));
vi.mock('@happier-dev/protocol/crypto/accountScopedCipher', async importOriginal => {
    const actual = await importOriginal<typeof import('@happier-dev/protocol/crypto/accountScopedCipher')>();
    return { ...actual, createAccountScopedCryptoMaterialSnapshotV1: (
        ...args: Parameters<typeof actual.createAccountScopedCryptoMaterialSnapshotV1>
    ) => {
        accountProofs.count += 1;
        return actual.createAccountScopedCryptoMaterialSnapshotV1(...args);
    } };
});

vi.mock('./resolveServerAccountRequestContext', () => ({
    resolveServerAccountRequestContext: (params: unknown) => resolveContextSpy(params),
}));

vi.mock('@/sync/engine/sessions/sessionById', () => ({
    fetchAndApplySessionById: (params: unknown) => fetchAndApplySessionByIdSpy(params),
}));

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (...args: unknown[]) => runtimeFetchSpy(...args),
    get runtimeFetchManualResponse() { return this.runtimeFetch; },
}));

vi.mock('@/sync/api/account/apiAccountEncryptionMode', async importOriginal => ({
    ...await importOriginal<typeof import('@/sync/api/account/apiAccountEncryptionMode')>(),
    fetchAccountEncryptionCurrentness: (...args: unknown[]) =>
        fetchAccountEncryptionCurrentnessSpy(...args),
    fetchOperationAccountEncryptionIdentity: (...args: unknown[]) =>
        fetchAccountEncryptionCurrentnessSpy(...args),
    subscribeAccountEncryptionModeCacheInvalidation: () => () => {},
}));

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getCachedServerFeaturesSnapshot: (...args: unknown[]) =>
        getCachedServerFeaturesSnapshotSpy(...args),
}));

describe('fetchSessionByIdWithServerScope', () => {
    beforeEach(() => {
        getCachedServerFeaturesSnapshotSpy.mockReturnValue(null);
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
        getCachedServerFeaturesSnapshotSpy.mockReset();
    });

    it.each(['active', 'scoped', 'frame'] as const)('preserves encryption-context demand through the %s reader', async scope => {
        resolveContextSpy.mockResolvedValue(scope === 'scoped' ? {
            scope: 'scoped', targetServerId: 'server-b', targetAccountId: 'account-b',
            targetServerUrl: 'https://server-b.example.test', token: 'scoped-token',
            credentials: { token: 'scoped-token', secret: 'scoped-secret' }, encryption: null,
        } : { scope: 'active' });
        fetchAndApplySessionByIdSpy.mockImplementation(async (params: { contentDemand?: string }) => (
            params.contentDemand === 'encryption-context'
                ? { ok: true, session: null, encryptionMode: 'plain' }
                : { ok: true, session: { id: 'session-1' } }
        ));
        const params: Parameters<typeof fetchSessionByIdWithServerScope>[0] = {
            sessionId: 'session-1', serverId: scope === 'scoped' ? 'server-b' : 'server-a',
            contentDemand: 'encryption-context',
            activeCredentials: { token: 'active-token' }, activeEncryption: null,
            ...(scope === 'frame' ? { sessionKey: null } : {}),
            sessionDataKeys: new Map(), activeRequest: vi.fn(), applySessions: vi.fn(), log: { log() {} },
        };
        await expect(fetchSessionByIdWithServerScope(params)).resolves.toEqual({
            ok: true, session: null, encryptionMode: 'plain',
        });
        expect(fetchAndApplySessionByIdSpy).toHaveBeenCalledWith(expect.objectContaining({
            contentDemand: 'encryption-context',
        }));
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
        expect(fetchAndApplySessionByIdSpy.mock.calls[0]?.[0].accessProjectionVersion).toBeUndefined();
    });

    it('requests effective detail access only for an enabled exact Home decision', async () => {
        resolveContextSpy.mockResolvedValue({ scope: 'active', timeoutMs: 5000 });
        getCachedServerFeaturesSnapshotSpy.mockReturnValue({
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                    },
                    sharing: {
                        session: { enabled: true },
                    },
                },
            },
        });
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
        });

        expect(getCachedServerFeaturesSnapshotSpy).toHaveBeenCalledWith({ serverId: 'server-a' });
        expect(fetchAndApplySessionByIdSpy.mock.calls[0]?.[0].accessProjectionVersion).toBe(1);
    });

    it('uses a scoped session-by-id request after discovering V3 server support', async () => {
        const decryptEncryptionKey = vi.fn(async () => new Uint8Array([1]));
        const initializeSessions = vi.fn(async () => {});
        const generationScope = {
            accountId: 'account-b',
            serverId: 'server-b',
            generation: 4,
        } as const;
        const getCurrentEncryptionGenerationScope = vi.fn(() => generationScope);
        const isCurrentEncryptionGenerationScope = vi.fn(() => true);
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
                getCurrentEncryptionGenerationScope,
                isCurrentEncryptionGenerationScope,
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
        expect(params.encryption.getCurrentEncryptionGenerationScope({
            serverId: 'server-b',
        })).toEqual(generationScope);
        expect(params.encryption.isCurrentEncryptionGenerationScope(
            generationScope,
        )).toBe(true);
        expect(getCurrentEncryptionGenerationScope).toHaveBeenCalledWith({
            serverId: 'server-b',
        });
        expect(isCurrentEncryptionGenerationScope).toHaveBeenCalledWith(
            generationScope,
        );
    });

    it('hydrates a scoped session over its browser-Iroh carrier when its runtime origin is unreachable', async () => {
        const requestOverCarrier = vi.fn(async () => new Response(null, { status: 200 }));
        const releaseCarrier = vi.fn(async () => {});
        const homeCarrier = {
            leaseId: 'browser-lease-session-read',
            homeServerIdentityId: 'server-iroh',
            endpointId: 'a'.repeat(64),
            appliedRelayUrls: ['https://relay.example.test'],
            readObservedPath: () => 'relay' as const,
            request: requestOverCarrier,
            createWebSocket: () => {
                throw new Error('session hydration must not create a WebSocket');
            },
            release: releaseCarrier,
        };
        resolveContextSpy.mockResolvedValue({
            scope: 'scoped',
            targetServerId: 'server-iroh',
            targetServerUrl: 'https://ingressless.happier.invalid',
            runtimeOrigin: 'https://ingressless.happier.invalid',
            token: 'scoped-token',
            credentials: { token: 'scoped-token', secret: 'scoped-secret' },
            timeoutMs: 5000,
            encryption: null,
            carrier: 'iroh',
            homeCarrier,
            release: releaseCarrier,
        });
        runtimeFetchSpy.mockRejectedValue(new Error('unreachable Iroh runtime origin'));
        fetchAndApplySessionByIdSpy.mockImplementationOnce(async (input: {
            request: (path: string, init?: RequestInit) => Promise<Response>;
        }) => {
            await input.request('/v1/sessions/session-iroh', { method: 'GET' });
            return { ok: true, session: { id: 'session-iroh' } };
        });

        const { fetchSessionByIdWithServerScope } = await import('./fetchSessionByIdWithServerScope');
        await expect(fetchSessionByIdWithServerScope({
            sessionId: 'session-iroh',
            serverId: 'server-iroh',
            activeCredentials: { token: 'active-token', secret: 'active-secret' },
            activeEncryption: {} as any,
            sessionDataKeys: new Map<string, Uint8Array>(),
            activeRequest: vi.fn(),
            applySessions: vi.fn(),
            log: { log: vi.fn() },
        })).resolves.toEqual({ ok: true, session: { id: 'session-iroh' } });

        expect(requestOverCarrier).toHaveBeenCalledWith(
            'https://ingressless.happier.invalid/v1/sessions/session-iroh',
            expect.objectContaining({ method: 'GET' }),
        );
        expect(runtimeFetchSpy).not.toHaveBeenCalled();
        expect(releaseCarrier).toHaveBeenCalledTimes(1);
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

    it('proves Account material once for one mutation snapshot read and its writer', async () => {
        resolveContextSpy.mockResolvedValue({ scope: 'active', timeoutMs: 5000 });
        fetchAndApplySessionByIdSpy.mockResolvedValue({
            ok: true,
            session: { id: 'session-1', encryptionMode: 'e2ee' },
            metadataTupleMutationSnapshot: {
                mode: 'owner', metadataLayoutVersion: 1, metadataVersion: 3,
                sharedMetadataCiphertext: 'shared-current',
                ownerMetadataEnvelope: { t: 'encrypted', c: 'owner-current' },
                agentStateVersion: 4, agentStateCiphertext: null,
                displayProjectionV1: { v: 1, shared: { t: 'plain', v: {} }, owner: { t: 'plain', v: {} } },
                value: { metadata: {}, sharedMetadata: { v: 1 }, ownerMetadata: { v: 1 }, agentState: null },
            },
        });
        accountProofs.count = 0;
        const result = await fetchMutationSnapshotForTest({
            sessionId: 'session-1',
            activeCredentials: { token: 'active-token', secret: Buffer.from(ACCOUNT_SECRET).toString('base64url') },
            activeEncryption: { getSessionEncryption: vi.fn(() => ({
                encryptRaw: vi.fn(async () => 'encrypted-payload'),
                decryptAgentState: vi.fn(async () => null),
                decryptMetadata: vi.fn(async () => null),
            })) } as any,
            sessionDataKeys: new Map(),
            activeRequest: vi.fn(),
            applySessions: vi.fn(),
            log: { log: vi.fn() },
        });

        expect(result.metadataTupleWriterContext?.ownerMigrationCurrentness).toEqual({
            expectedAccountEncryptionMode: 'e2ee',
            expectedAccountContentPublicKeyFingerprint: ACCOUNT_CONTENT_PUBLIC_KEY_FINGERPRINT,
        });
        expect(result.metadataTupleWriterContext?.encodeOwnerMetadata({ v: 1 }).t).toBe('encrypted');
        expect(accountProofs.count).toBe(1);
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

        const result = await fetchMutationSnapshotForTest({
            sessionId: 'session-1',
            activeCredentials: {
                token: 'active-token',
                secret: Buffer.from(ACCOUNT_SECRET).toString('base64'),
            },
            activeEncryption,
            sessionDataKeys: new Map(),
            activeRequest: vi.fn(),
            applySessions: vi.fn(),
            log: { log: vi.fn() },
        });

        expect(fetchAndApplySessionByIdSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                includeMetadataTupleMutationSnapshot: true,
            }),
        );
        expect(result.metadataTupleMutationSnapshot).toEqual({ ...snapshot,
            displayProjectionV1Availability: { shared: false, owner: false } });
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

        const result = await fetchMutationSnapshotForTest({
            sessionId: 'session-1',
            activeCredentials: { token: 'active-token' },
            activeEncryption: null,
            sessionDataKeys: new Map(),
            activeRequest: vi.fn(),
            applySessions: vi.fn(),
            log: { log: vi.fn() },
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
            const result = await fetchMutationSnapshotForTest({
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

        await expect(fetchMutationSnapshotForTest({
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
        })).rejects.toThrow(
            'Account encryption material does not match current Account state',
        );
    });
});
