import {
    SESSION_METADATA_LAYOUT_VERSION_V1,
    type SessionMetadataInactiveModelIntentOwnerPatchV1,
    type SessionMetadataTuplePatchV1,
} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { afterEach, describe, expect, it, vi } from 'vitest';

const emitWithAckSpy = vi.hoisted(() => vi.fn());
const activeRequestSpy = vi.hoisted(() => vi.fn());
const resolvePreferredServerIdForSessionIdSpy = vi.hoisted(() => vi.fn());
const resolveContextSpy = vi.hoisted(() => vi.fn());
const createSocketSpy = vi.hoisted(() => vi.fn());
const createResolvedRequestSpy = vi.hoisted(() => vi.fn());
const resolvedRequestSpy = vi.hoisted(() => vi.fn());
const credentialListeners = vi.hoisted(() => new Set<(event: { serverId: string }) => void>());

// Home credential mutation is an environment boundary; transport and ACK
// cancellation beneath it remain real.
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/auth/storage/tokenStorage')>(),
    subscribeHomeCredentialMutations: (listener: (event: { serverId: string }) => void) => {
        credentialListeners.add(listener);
        return () => { credentialListeners.delete(listener); };
    },
}));

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        emitWithAck: (...args: unknown[]) => emitWithAckSpy(...args),
        request: (...args: unknown[]) => activeRequestSpy(...args),
    },
}));

vi.mock('./resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: (sessionId: string) =>
        resolvePreferredServerIdForSessionIdSpy(sessionId),
}));

vi.mock('./resolveServerAccountRequestContext', () => ({
    resolveServerAccountRequestContext: (params: unknown) =>
        resolveContextSpy(params),
}));

vi.mock('./createEphemeralServerSocketClient', () => ({
    createEphemeralServerSocketClient: (params: unknown) =>
        createSocketSpy(params),
}));

vi.mock('./createServerRequestWithServerScope', () => ({
    createServerRequestForResolvedServerScope: (params: unknown) =>
        createResolvedRequestSpy(params),
}));

const sharedEditorPatch: SessionMetadataTuplePatchV1 = {
    mode: 'shared_editor',
    metadataLayoutVersion: SESSION_METADATA_LAYOUT_VERSION_V1,
    sharedMetadata: {
        ciphertext: 'shared-ciphertext',
        expectedVersion: 3,
    },
};
const usageTimingV1 = { v: 1 as const,
    metadata: { v: 1 as const, minMs: 123, maxMs: 123 }, agentState: null };

const ownerMetadataCiphertext =
    'oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==';
const ownerMetadataEnvelope = {
    t: 'encrypted' as const,
    c: ownerMetadataCiphertext,
};
const ownerPatch: SessionMetadataTuplePatchV1 = {
    mode: 'owner',
    metadataLayoutVersion: SESSION_METADATA_LAYOUT_VERSION_V1,
    expectedOwnerMetadata: ownerMetadataEnvelope,
    sharedMetadata: {
        ciphertext: 'shared-ciphertext',
        expectedVersion: 3,
    },
    ownerMetadata: ownerMetadataEnvelope,
    agentState: {
        ciphertext: null,
        expectedVersion: 5,
    },
};
const migrationPatch: SessionMetadataTuplePatchV1 = {
    mode: 'owner_migration',
    expectedAccountEncryptionMode: 'e2ee',
    expectedAccountContentPublicKeyFingerprint:
        `content-public-key-sha256:${'a'.repeat(64)}`,
    source: {
        metadataLayoutVersion: 0,
        metadata: {
            version: 3,
            ciphertext: 'metadata-exact',
        },
        ownerMetadata: null,
        agentState: {
            version: 5,
            ciphertext: null,
        },
    },
    target: {
        metadataLayoutVersion: 1,
        sharedMetadata: { ciphertext: 'shared-target' },
        ownerMetadata: ownerMetadataEnvelope,
        agentState: { ciphertext: null },
    },
};

function jsonResponse(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('emitSessionMetadataUpdateWithServerScope', () => {
    it.each([
        { name: 'unchanged owner AgentState', patch: ownerPatch, agentStateVersion: 5, accepted: true },
        { name: 'advanced owner AgentState', patch: ownerPatch, agentStateVersion: 6, accepted: true },
        { name: 'skipped owner AgentState version', patch: ownerPatch, agentStateVersion: 7, accepted: false },
        { name: 'unchanged migration AgentState', patch: migrationPatch, agentStateVersion: 5, accepted: false },
        { name: 'unexpected shared-editor AgentState', patch: sharedEditorPatch, agentStateVersion: 5, accepted: false },
    ])('matches the committed HTTP receipt for $name', async ({ patch, agentStateVersion, accepted }) => {
        const { emitSessionMetadataUpdateWithServerScope } = await import('./emitSessionMetadataUpdateWithServerScope');
        // Inject only the HTTP boundary; receipt parsing and version matching remain real.
        const result = await emitSessionMetadataUpdateWithServerScope({
            sessionId: 'session-1', patch,
            authority: {
                scope: { serverId: 'server-a', accountId: 'account-a' },
                context: { scope: 'scoped', timeoutMs: 4000, targetServerId: 'server-a',
                    targetServerUrl: 'https://home.example', targetAccountId: 'account-a', token: 'token', encryption: null },
                request: async () => jsonResponse({
                    success: true, metadataLayoutVersion: 1,
                    sharedMetadata: { version: 4 }, agentState: { version: agentStateVersion },
                }, 200),
                release: async () => {},
            },
        });
        expect(result).toEqual(accepted ? {
            result: 'success', metadataLayoutVersion: 1, version: 4, agentStateVersion,
        } : {
            result: 'error', message: 'Invalid Session metadata tuple response',
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        emitWithAckSpy.mockReset();
        activeRequestSpy.mockReset();
        resolvePreferredServerIdForSessionIdSpy.mockReset();
        resolveContextSpy.mockReset();
        createSocketSpy.mockReset();
        createResolvedRequestSpy.mockReset();
        resolvedRequestSpy.mockReset();
        credentialListeners.clear();
    });

    it.each(['tuple', 'inactive_model_intent'] as const)(
        'preserves confirmed HTTP rollback as retryable for %s writes', async (mode) => {
            const { emitSessionMetadataUpdateWithServerScope } = await import('./emitSessionMetadataUpdateWithServerScope');
            // The injected authority's request is the HTTP boundary; response
            // parsing and error classification use the production adapter.
            const request = vi.fn(async () => jsonResponse({
                error: 'database_transaction_conflict_exhausted', statusCode: 503,
            }, 503));
            const authority = {
                scope: { serverId: 'server-a', accountId: 'account-a' },
                context: { scope: 'scoped' as const, timeoutMs: 4000, targetServerId: 'server-a',
                    targetServerUrl: 'https://home.example', targetAccountId: 'account-a', token: 'token', encryption: null },
                request, release: async () => {},
            };
            const write = mode === 'tuple'
                ? { patch: ownerPatch }
                : { expectedVersion: 3, metadata: 'ciphertext', sessionExpectation: { kind: 'inactive_model_intent' as const } };
            await expect(emitSessionMetadataUpdateWithServerScope({
                sessionId: 'session-1', authority, ...write,
            })).rejects.toMatchObject({
                name: 'HappyError', code: 'database_transaction_conflict_exhausted',
                status: 503, kind: 'server', canTryAgain: true,
            });
        },
    );

    it.each([408, 429, 500, 502, 503, 504])('classifies HTTP %s without exposing server prose or calling it an invalid tuple', async (status) => {
        resolveContextSpy.mockResolvedValue({ scope: 'active', timeoutMs: 4000 });
        createResolvedRequestSpy.mockReturnValue(resolvedRequestSpy);
        resolvedRequestSpy.mockResolvedValue(new Response('private upstream failure', { status }));
        const { emitSessionMetadataUpdateWithServerScope } = await import('./emitSessionMetadataUpdateWithServerScope');
        const error: unknown = await emitSessionMetadataUpdateWithServerScope({ sessionId: 'session-1', patch: ownerPatch })
            .catch((failure: unknown) => failure);
        expect(error).toMatchObject({ code: 'service_temporarily_unavailable', status, canTryAgain: true });
        expect(String(error)).not.toContain('private upstream failure');
    });

    it('keeps an ordinary layout-0 write on the active legacy socket RPC', async () => {
        resolvePreferredServerIdForSessionIdSpy.mockReturnValue('server-a');
        resolveContextSpy.mockResolvedValue({
            scope: 'active',
            timeoutMs: 4000,
        });
        emitWithAckSpy.mockResolvedValue({
            result: 'success',
            version: 4,
            metadata: 'committed',
        });

        const { emitSessionMetadataUpdateWithServerScope } =
            await import('./emitSessionMetadataUpdateWithServerScope');

        await expect(emitSessionMetadataUpdateWithServerScope({
            sessionId: 'session-1',
            expectedVersion: 3,
            metadata: 'ciphertext',
            timeoutMs: 4000,
            usageTimingV1,
        })).resolves.toEqual({
            result: 'success',
            version: 4,
            metadata: 'committed',
        });

        expect(emitWithAckSpy).toHaveBeenCalledWith(
            'update-metadata',
            {
                sid: 'session-1',
                expectedVersion: 3,
                metadata: 'ciphertext',
                usageTimingV1,
            },
            { timeoutMs: null, signal: expect.any(AbortSignal) },
        );
        expect(createResolvedRequestSpy).toHaveBeenCalledTimes(1);
        expect(createSocketSpy).not.toHaveBeenCalled();
    });

    it('retains the exact Home write through unrelated credential retirement and cancels when its own credentials retire', async () => {
        vi.useFakeTimers();
        resolvePreferredServerIdForSessionIdSpy.mockReturnValue('server-b');
        resolveContextSpy.mockResolvedValue({
            scope: 'scoped', targetServerId: 'server-b', targetServerUrl: 'https://server-b.example.test',
            targetAccountId: 'account-b', token: 'token-b', timeoutMs: 5000, encryption: null,
        });
        const disconnect = vi.fn();
        let issued = false;
        createSocketSpy.mockResolvedValue({
            emitWithAck: () => { issued = true; return new Promise(() => {}); },
            emit: vi.fn(), disconnect,
        });
        const { emitSessionMetadataUpdateWithServerScope } = await import('./emitSessionMetadataUpdateWithServerScope');
        let failure: unknown = null;
        const pending = emitSessionMetadataUpdateWithServerScope({
            sessionId: 'session-1', expectedVersion: 3, metadata: 'ciphertext',
        }).catch((error: unknown) => { failure = error; });
        await vi.advanceTimersByTimeAsync(0);
        expect(issued).toBe(true);
        credentialListeners.forEach((listener) => listener({ serverId: 'server-a' }));
        await vi.advanceTimersByTimeAsync(0);
        expect(failure).toBeNull();
        expect(disconnect).not.toHaveBeenCalled();
        credentialListeners.forEach((listener) => listener({ serverId: 'server-b' }));
        await vi.advanceTimersByTimeAsync(0);
        expect(failure).toMatchObject({ name: 'AbortError', code: 'SOCKET_RPC_ABORTED' });
        await pending;
        expect(disconnect).toHaveBeenCalledTimes(1);
        expect(credentialListeners.size).toBe(0);
    });

    it('waits for a delayed layout-0 scoped write beyond its connection timeout', async () => {
        vi.useFakeTimers();
        resolvePreferredServerIdForSessionIdSpy.mockReturnValue('server-b');
        resolveContextSpy.mockResolvedValue({
            scope: 'scoped',
            targetServerId: 'server-b',
            targetServerUrl: 'https://server-b.example.test',
            token: 'token-b',
            timeoutMs: 5000,
            encryption: null,
        });
        let acknowledge!: (value: unknown) => void;
        const emitWithAck = vi.fn((..._args: unknown[]) => new Promise((resolve) => { acknowledge = resolve; }));
        const disconnect = vi.fn();
        createSocketSpy.mockResolvedValue({
            emitWithAck,
            timeout: vi.fn((timeoutMs: number) => ({ emitWithAck: (...args: unknown[]) => Promise.race([
                emitWithAck(...args),
                new Promise((_, reject) => setTimeout(() => reject(new Error('operation has timed out')), timeoutMs)),
            ]) })),
            disconnect,
        });

        const { emitSessionMetadataUpdateWithServerScope } =
            await import('./emitSessionMetadataUpdateWithServerScope');

        const pending = emitSessionMetadataUpdateWithServerScope({
            sessionId: 'session-1',
            expectedVersion: 3,
            metadata: 'ciphertext',
            timeoutMs: 5000,
        });
        const outcome = pending.then((value) => value, (error: unknown) => error);
        await vi.advanceTimersByTimeAsync(250_000);
        acknowledge({ result: 'success', version: 4, metadata: 'committed' });
        await expect(outcome).resolves.toEqual({
            result: 'success',
            version: 4,
            metadata: 'committed',
        });

        expect(createSocketSpy).toHaveBeenCalledWith(expect.objectContaining({
            serverUrl: 'https://server-b.example.test',
            reachabilityServerUrl: 'https://server-b.example.test',
            token: 'token-b',
            timeoutMs: 5000,
            takeCarrierRelease: expect.any(Function),
        }));
        expect(emitWithAck).toHaveBeenCalledWith(
            'update-metadata',
            {
                sid: 'session-1',
                expectedVersion: 3,
                metadata: 'ciphertext',
            },
        );
        expect(disconnect).toHaveBeenCalledTimes(1);
        expect(createResolvedRequestSpy).toHaveBeenCalledTimes(1);
    });

    it('transfers an authority-owned browser-Iroh carrier to the pooled legacy socket without allowing authority release to tear it down', async () => {
        const releaseCarrier = vi.fn(async () => {});
        let authorityOwnsCarrier = true;
        const authorityRelease = vi.fn(async () => {
            if (authorityOwnsCarrier) await releaseCarrier();
        });
        const transferCarrierCustody = vi.fn(() => {
            authorityOwnsCarrier = false;
            return releaseCarrier;
        });
        const homeCarrier = {
            leaseId: 'browser-lease-1',
            homeServerIdentityId: 'server-b',
            endpointId: 'a'.repeat(64),
            appliedRelayUrls: ['https://relay.example.test'],
            readObservedPath: () => 'relay' as const,
            request: async () => new Response(null, { status: 200 }),
            createWebSocket: () => ({}),
            release: releaseCarrier,
        };
        const emitWithAck = vi.fn(async () => ({
            result: 'success',
            version: 4,
            metadata: 'committed',
        }));
        const disconnect = vi.fn();
        createSocketSpy.mockImplementation(async (params: {
            takeCarrierRelease?: () => (() => Promise<void>) | undefined;
        }) => {
            expect(params.takeCarrierRelease?.()).toBe(releaseCarrier);
            return {
                emitWithAck,
                timeout: vi.fn(() => ({ emitWithAck })),
                disconnect,
            };
        });

        const { emitSessionMetadataUpdateWithServerScope } =
            await import('./emitSessionMetadataUpdateWithServerScope');

        await expect(emitSessionMetadataUpdateWithServerScope({
            sessionId: 'session-1',
            expectedVersion: 3,
            metadata: 'ciphertext',
            authority: {
                scope: { serverId: 'server-b', accountId: 'account-b' },
                context: {
                    scope: 'scoped',
                    targetServerId: 'server-b',
                    targetServerUrl: 'https://server-b.example.test',
                    targetAccountId: 'account-b',
                    token: 'token-b',
                    timeoutMs: 5000,
                    encryption: null,
                    runtimeOrigin: 'https://server-b.example.test',
                    carrier: 'iroh',
                    homeCarrier,
                    release: releaseCarrier,
                },
                request: vi.fn(),
                release: authorityRelease,
                transferCarrierCustody,
            },
        })).resolves.toEqual({
            result: 'success',
            version: 4,
            metadata: 'committed',
        });

        await authorityRelease();

        expect(transferCarrierCustody).toHaveBeenCalledTimes(1);
        expect(createSocketSpy).toHaveBeenCalledWith(expect.objectContaining({
            carrier: 'iroh',
            homeCarrier,
            takeCarrierRelease: expect.any(Function),
        }));
        expect(disconnect).toHaveBeenCalledTimes(1);
        expect(releaseCarrier).not.toHaveBeenCalled();
    });

    it('reuses an authority-backed pooled carrier across legacy metadata retries without consuming a second carrier release', async () => {
        const releaseCarrier = vi.fn(async () => {});
        let authorityOwnsCarrier = true;
        const authorityRelease = vi.fn(async () => {
            if (authorityOwnsCarrier) await releaseCarrier();
        });
        const transferCarrierCustody = vi.fn(() => {
            if (!authorityOwnsCarrier) {
                throw new Error('carrier custody is no longer available');
            }
            authorityOwnsCarrier = false;
            return releaseCarrier;
        });
        const homeCarrier = {
            leaseId: 'browser-lease-1',
            homeServerIdentityId: 'server-b',
            endpointId: 'a'.repeat(64),
            appliedRelayUrls: ['https://relay.example.test'],
            readObservedPath: () => 'relay' as const,
            request: async () => new Response(null, { status: 200 }),
            createWebSocket: () => ({}),
            release: releaseCarrier,
        };
        const emitWithAck = vi.fn(async () => ({
            result: 'success',
            version: 4,
            metadata: 'committed',
        }));
        const disconnect = vi.fn();
        let physicalPoolEntryExists = false;
        createSocketSpy.mockImplementation(async (params: {
            takeCarrierRelease?: () => (() => Promise<void>) | undefined;
        }) => {
            if (!physicalPoolEntryExists) {
                physicalPoolEntryExists = true;
                expect(params.takeCarrierRelease?.()).toBe(releaseCarrier);
            }
            return {
                emitWithAck,
                timeout: vi.fn(() => ({ emitWithAck })),
                disconnect,
            };
        });
        const authority = {
            scope: { serverId: 'server-b', accountId: 'account-b' },
            context: {
                scope: 'scoped' as const,
                targetServerId: 'server-b',
                targetServerUrl: 'https://server-b.example.test',
                targetAccountId: 'account-b',
                token: 'token-b',
                timeoutMs: 5000,
                encryption: null,
                runtimeOrigin: 'https://server-b.example.test',
                carrier: 'iroh' as const,
                homeCarrier,
                release: releaseCarrier,
            },
            request: vi.fn(),
            release: authorityRelease,
            transferCarrierCustody,
        };
        const { emitSessionMetadataUpdateWithServerScope } =
            await import('./emitSessionMetadataUpdateWithServerScope');

        await expect(emitSessionMetadataUpdateWithServerScope({
            sessionId: 'session-1',
            expectedVersion: 3,
            metadata: 'ciphertext-1',
            authority,
        })).resolves.toMatchObject({ result: 'success' });
        await expect(emitSessionMetadataUpdateWithServerScope({
            sessionId: 'session-1',
            expectedVersion: 4,
            metadata: 'ciphertext-2',
            authority,
        })).resolves.toMatchObject({ result: 'success' });

        await authorityRelease();

        expect(transferCarrierCustody).toHaveBeenCalledTimes(1);
        expect(disconnect).toHaveBeenCalledTimes(2);
        expect(releaseCarrier).not.toHaveBeenCalled();
    });

    it.each([
        {
            name: 'active',
            context: { scope: 'active' as const, timeoutMs: 4000 },
        },
        {
            name: 'scoped',
            context: {
                scope: 'scoped' as const,
                targetServerId: 'server-b',
                targetServerUrl: 'https://server-b.example.test',
                token: 'token-b',
                timeoutMs: 4000,
                encryption: null,
            },
        },
    ])('uses the fail-closed conditioned HTTP branch for $name layout-0 model intents', async ({ context }) => {
        resolvePreferredServerIdForSessionIdSpy.mockReturnValue('server-b');
        resolveContextSpy.mockResolvedValue(context);
        createResolvedRequestSpy.mockReturnValue(resolvedRequestSpy);
        resolvedRequestSpy.mockResolvedValue(jsonResponse({
            code: 'session_active',
        }, 409));

        const { emitSessionMetadataUpdateWithServerScope } =
            await import('./emitSessionMetadataUpdateWithServerScope');

        await expect(emitSessionMetadataUpdateWithServerScope({
            sessionId: 'session/1',
            expectedVersion: 3,
            metadata: 'ciphertext',
            sessionExpectation: { kind: 'inactive_model_intent' },
            timeoutMs: 4000,
            usageTimingV1,
        })).resolves.toEqual({
            result: 'session-active',
        });

        expect(createResolvedRequestSpy).toHaveBeenCalledWith({
            context,
            activeRequest: expect.any(Function),
        });
        expect(resolvedRequestSpy).toHaveBeenCalledWith(
            '/v2/sessions/session%2F1',
            {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: expect.any(String),
            },
        );
        expect(JSON.parse(String(resolvedRequestSpy.mock.calls[0][1].body))).toEqual({
            usageTimingV1,
            inactiveModelIntent: {
                metadata: { ciphertext: 'ciphertext', expectedVersion: 3 },
                sessionExpectation: { kind: 'inactive_model_intent' },
            },
        });
        expect(emitWithAckSpy).not.toHaveBeenCalled();
        expect(createSocketSpy).not.toHaveBeenCalled();
    });

    it('does not retry through a legacy socket when an old server rejects the conditioned branch', async () => {
        resolveContextSpy.mockResolvedValue({
            scope: 'active',
            timeoutMs: 4000,
        });
        createResolvedRequestSpy.mockReturnValue(resolvedRequestSpy);
        resolvedRequestSpy.mockResolvedValue(jsonResponse({
            error: 'Invalid request',
        }, 400));

        const { emitSessionMetadataUpdateWithServerScope } =
            await import('./emitSessionMetadataUpdateWithServerScope');

        await expect(emitSessionMetadataUpdateWithServerScope({
            sessionId: 'session-1',
            expectedVersion: 3,
            metadata: 'ciphertext',
            sessionExpectation: { kind: 'inactive_model_intent' },
        })).resolves.toEqual({
            result: 'error',
            message: 'Invalid Session metadata tuple response',
        });

        expect(resolvedRequestSpy).toHaveBeenCalledTimes(1);
        expect(emitWithAckSpy).not.toHaveBeenCalled();
        expect(createSocketSpy).not.toHaveBeenCalled();
    });

    it.each([
        {
            name: 'committed result',
            body: {
                success: true,
                metadata: { version: 4 },
            },
            expected: {
                result: 'success',
                version: 4,
            },
        },
        {
            name: 'version conflict',
            body: {
                success: false,
                error: 'version-mismatch',
                metadata: {
                    version: 5,
                    value: 'current-ciphertext',
                },
            },
            expected: {
                result: 'version-mismatch',
                version: 5,
                metadata: 'current-ciphertext',
            },
        },
        {
            name: 'response carrying private extras',
            body: {
                success: true,
                metadata: {
                    version: 4,
                    value: 'must-not-cross',
                },
            },
            expected: {
                result: 'error',
                message: 'Invalid Session metadata tuple response',
            },
        },
    ])('strictly parses the conditioned layout-0 $name', async ({ body, expected }) => {
        resolveContextSpy.mockResolvedValue({
            scope: 'active',
            timeoutMs: 4000,
        });
        createResolvedRequestSpy.mockReturnValue(resolvedRequestSpy);
        resolvedRequestSpy.mockResolvedValue(jsonResponse(body, 200));

        const { emitSessionMetadataUpdateWithServerScope } =
            await import('./emitSessionMetadataUpdateWithServerScope');

        await expect(emitSessionMetadataUpdateWithServerScope({
            sessionId: 'session-1',
            expectedVersion: 3,
            metadata: 'ciphertext',
            sessionExpectation: { kind: 'inactive_model_intent' },
        })).resolves.toEqual(expected);

        expect(emitWithAckSpy).not.toHaveBeenCalled();
        expect(createSocketSpy).not.toHaveBeenCalled();
    });

    it.each([
        {
            name: 'active',
            context: { scope: 'active' as const, timeoutMs: 4000 },
        },
        {
            name: 'scoped',
            context: {
                scope: 'scoped' as const,
                targetServerId: 'server-b',
                targetServerUrl: 'https://server-b.example.test',
                token: 'token-b',
                timeoutMs: 4000,
                encryption: null,
            },
        },
    ])('uses the authenticated HTTP tuple route for $name layout-1 writes', async ({ context }) => {
        resolvePreferredServerIdForSessionIdSpy.mockReturnValue('server-b');
        resolveContextSpy.mockResolvedValue(context);
        createResolvedRequestSpy.mockReturnValue(resolvedRequestSpy);
        resolvedRequestSpy.mockResolvedValue(jsonResponse({
            success: true,
            metadataLayoutVersion: 1,
            sharedMetadata: { version: 4 },
        }, 200));

        const { emitSessionMetadataUpdateWithServerScope } =
            await import('./emitSessionMetadataUpdateWithServerScope');

        await expect(emitSessionMetadataUpdateWithServerScope({
            sessionId: 'session/1',
            patch: sharedEditorPatch,
            timeoutMs: 4000,
        })).resolves.toEqual({
            result: 'success',
            metadataLayoutVersion: 1,
            version: 4,
        });

        expect(resolveContextSpy).toHaveBeenCalledWith({
            serverId: 'server-b',
            timeoutMs: 4000,
        });
        expect(createResolvedRequestSpy).toHaveBeenCalledWith({
            context,
            activeRequest: expect.any(Function),
        });
        expect(resolvedRequestSpy).toHaveBeenCalledWith(
            '/v2/sessions/session%2F1',
            {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(sharedEditorPatch),
            },
        );
        expect(emitWithAckSpy).not.toHaveBeenCalled();
        expect(createSocketSpy).not.toHaveBeenCalled();
    });

    it('strictly parses a version conflict without returning ciphertext', async () => {
        resolveContextSpy.mockResolvedValue({ scope: 'active', timeoutMs: 5000 });
        createResolvedRequestSpy.mockReturnValue(resolvedRequestSpy);
        resolvedRequestSpy.mockResolvedValue(jsonResponse({
            code: 'session_metadata_version_conflict',
            metadataLayoutVersion: 1,
            sharedMetadata: { version: 8 },
        }, 409));

        const { emitSessionMetadataUpdateWithServerScope } =
            await import('./emitSessionMetadataUpdateWithServerScope');

        await expect(emitSessionMetadataUpdateWithServerScope({
            sessionId: 'session-1',
            patch: sharedEditorPatch,
        })).resolves.toEqual({
            result: 'version-mismatch',
            metadataLayoutVersion: 1,
            version: 8,
        });
    });

    it('maps the dedicated conditioned owner tuple active conflict without retrying another transport', async () => {
        resolveContextSpy.mockResolvedValue({ scope: 'active', timeoutMs: 5000 });
        createResolvedRequestSpy.mockReturnValue(resolvedRequestSpy);
        resolvedRequestSpy.mockResolvedValue(jsonResponse({
            code: 'session_active',
        }, 409));
        const conditionedOwnerPatch:
            SessionMetadataInactiveModelIntentOwnerPatchV1 = {
            ...ownerPatch,
            mode: 'owner_inactive_model_intent',
            sessionExpectation: { kind: 'inactive_model_intent' },
        };

        const { emitSessionMetadataUpdateWithServerScope } =
            await import('./emitSessionMetadataUpdateWithServerScope');

        await expect(emitSessionMetadataUpdateWithServerScope({
            sessionId: 'session-1',
            patch: conditionedOwnerPatch,
        })).resolves.toEqual({
            result: 'session-active',
        });

        expect(resolvedRequestSpy).toHaveBeenCalledWith(
            '/v2/sessions/session-1',
            expect.objectContaining({
                method: 'PATCH',
                body: JSON.stringify(conditionedOwnerPatch),
            }),
        );
        expect(emitWithAckSpy).not.toHaveBeenCalled();
        expect(createSocketSpy).not.toHaveBeenCalled();
    });

    it('returns the typed privacy-upgrade response', async () => {
        resolveContextSpy.mockResolvedValue({ scope: 'active', timeoutMs: 5000 });
        createResolvedRequestSpy.mockReturnValue(resolvedRequestSpy);
        resolvedRequestSpy.mockResolvedValue(jsonResponse({
            error: 'Session metadata privacy upgrade required',
            code: 'metadata_privacy_upgrade_required',
        }, 409));

        const { emitSessionMetadataUpdateWithServerScope } =
            await import('./emitSessionMetadataUpdateWithServerScope');

        await expect(emitSessionMetadataUpdateWithServerScope({
            sessionId: 'session-1',
            patch: sharedEditorPatch,
        })).resolves.toEqual({
            result: 'metadata_privacy_upgrade_required',
            message: 'Session metadata privacy upgrade required',
        });
    });

    it('sends the exact owner tuple over HTTP and returns both committed versions', async () => {
        resolveContextSpy.mockResolvedValue({ scope: 'active', timeoutMs: 5000 });
        createResolvedRequestSpy.mockReturnValue(resolvedRequestSpy);
        resolvedRequestSpy.mockResolvedValue(jsonResponse({
            success: true,
            metadataLayoutVersion: 1,
            sharedMetadata: { version: 4 },
            agentState: { version: 6 },
        }, 200));

        const { emitSessionMetadataUpdateWithServerScope } =
            await import('./emitSessionMetadataUpdateWithServerScope');

        await expect(emitSessionMetadataUpdateWithServerScope({
            sessionId: 'session-1',
            patch: ownerPatch,
        })).resolves.toEqual({
            result: 'success',
            metadataLayoutVersion: 1,
            version: 4,
            agentStateVersion: 6,
        });
        expect(resolvedRequestSpy).toHaveBeenCalledWith(
            '/v2/sessions/session-1',
            {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(ownerPatch),
            },
        );
        expect(emitWithAckSpy).not.toHaveBeenCalled();
        expect(createSocketSpy).not.toHaveBeenCalled();
    });

    it.each([
        {
            name: 'malformed success',
            status: 200,
            body: {
                success: true,
                metadataLayoutVersion: 1,
                sharedMetadata: { version: 4 },
                ownerMetadata: { ciphertext: 'must-not-cross' },
            },
        },
        {
            name: 'malformed conflict',
            status: 409,
            body: {
                code: 'session_metadata_version_conflict',
                metadataLayoutVersion: 1,
                sharedMetadata: { version: 4, ciphertext: 'must-not-cross' },
            },
        },
        {
            name: 'invalid request',
            status: 400,
            body: { error: 'Failed to update session' },
        },
    ])('fails closed for $name responses', async ({ status, body }) => {
        resolveContextSpy.mockResolvedValue({ scope: 'active', timeoutMs: 5000 });
        createResolvedRequestSpy.mockReturnValue(resolvedRequestSpy);
        resolvedRequestSpy.mockResolvedValue(jsonResponse(body, status));

        const { emitSessionMetadataUpdateWithServerScope } =
            await import('./emitSessionMetadataUpdateWithServerScope');

        await expect(emitSessionMetadataUpdateWithServerScope({
            sessionId: 'session-1',
            patch: sharedEditorPatch,
        })).resolves.toEqual({
            result: 'error',
            message: 'Invalid Session metadata tuple response',
        });
    });

    it('sends the strict owner-migration request only to receive its typed privacy refusal', async () => {
        resolvePreferredServerIdForSessionIdSpy.mockReturnValue('server-a');
        resolveContextSpy.mockResolvedValue({ scope: 'active', timeoutMs: 4000 });
        createResolvedRequestSpy.mockReturnValue(resolvedRequestSpy);
        resolvedRequestSpy.mockResolvedValue(jsonResponse({
            error: 'Session metadata privacy upgrade required',
            code: 'metadata_privacy_upgrade_required',
        }, 409));
        const { emitSessionMetadataUpdateWithServerScope } =
            await import('./emitSessionMetadataUpdateWithServerScope');

        await expect(emitSessionMetadataUpdateWithServerScope({
            sessionId: 'session-1',
            patch: migrationPatch,
            timeoutMs: 4000,
        })).resolves.toEqual({
            result: 'metadata_privacy_upgrade_required',
            message: 'Session metadata privacy upgrade required',
        });
        expect(resolvedRequestSpy).toHaveBeenCalledWith(
            '/v2/sessions/session-1',
            expect.objectContaining({
                method: 'PATCH',
                body: expect.any(String),
            }),
        );
        expect(JSON.parse(
            resolvedRequestSpy.mock.calls[0]?.[1]?.body as string,
        )).toEqual(migrationPatch);
        expect(emitWithAckSpy).not.toHaveBeenCalled();
        expect(createSocketSpy).not.toHaveBeenCalled();
    });

    it.each([
        {
            name: 'privacy refusal with a private extra',
            status: 409,
            body: {
                error: 'Session metadata privacy upgrade required',
                code: 'metadata_privacy_upgrade_required',
                privateOwnerField: 'must-not-be-accepted',
            },
        },
        {
            name: 'privacy refusal missing its canonical error',
            status: 409,
            body: {
                code: 'metadata_privacy_upgrade_required',
            },
        },
    ])('does not accept $name as an owner-migration result', async ({
        status,
        body,
    }) => {
        resolveContextSpy.mockResolvedValue({
            scope: 'active',
            timeoutMs: 4000,
        });
        createResolvedRequestSpy.mockReturnValue(resolvedRequestSpy);
        resolvedRequestSpy.mockResolvedValue(jsonResponse(body, status));

        const { emitSessionMetadataUpdateWithServerScope } =
            await import('./emitSessionMetadataUpdateWithServerScope');

        await expect(emitSessionMetadataUpdateWithServerScope({
            sessionId: 'session-1',
            patch: migrationPatch,
            timeoutMs: 4000,
        })).resolves.toEqual({
            result: 'error',
            message: 'Invalid Session metadata tuple response',
        });
    });

    it.each([
        {
            status: 200,
            body: {
                success: true,
                metadataLayoutVersion: 1,
                sharedMetadata: { version: 4 },
                agentState: { version: 6 },
            },
            expected: {
                result: 'success',
                metadataLayoutVersion: 1,
                version: 4,
                agentStateVersion: 6,
            },
        },
        {
            status: 409,
            body: {
                code: 'session_metadata_version_conflict',
                metadataLayoutVersion: 1,
                sharedMetadata: { version: 4 },
                agentState: { version: 6 },
            },
            expected: {
                result: 'version-mismatch',
                metadataLayoutVersion: 1,
                version: 4,
                agentStateVersion: 6,
            },
        },
    ])('accepts strict owner-migration response status $status', async ({
        status,
        body,
        expected,
    }) => {
        resolveContextSpy.mockResolvedValue({
            scope: 'active',
            timeoutMs: 4000,
        });
        createResolvedRequestSpy.mockReturnValue(resolvedRequestSpy);
        resolvedRequestSpy.mockResolvedValue(jsonResponse(body, status));
        const { emitSessionMetadataUpdateWithServerScope } =
            await import('./emitSessionMetadataUpdateWithServerScope');

        await expect(emitSessionMetadataUpdateWithServerScope({
            sessionId: 'session-1',
            patch: migrationPatch,
            timeoutMs: 4000,
        })).resolves.toEqual(expected);
    });
});
