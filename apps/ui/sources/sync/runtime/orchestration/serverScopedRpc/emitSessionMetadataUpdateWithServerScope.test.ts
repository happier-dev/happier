import {
    SESSION_METADATA_LAYOUT_VERSION_V1,
    type SessionMetadataInactiveModelIntentOwnerPatchV1,
    type SessionMetadataTuplePatchV1,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

const emitWithAckSpy = vi.hoisted(() => vi.fn());
const activeRequestSpy = vi.hoisted(() => vi.fn());
const resolvePreferredServerIdForSessionIdSpy = vi.hoisted(() => vi.fn());
const resolveContextSpy = vi.hoisted(() => vi.fn());
const createSocketSpy = vi.hoisted(() => vi.fn());
const createResolvedRequestSpy = vi.hoisted(() => vi.fn());
const resolvedRequestSpy = vi.hoisted(() => vi.fn());

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

vi.mock('./resolveServerScopedSessionContext', () => ({
    resolveServerScopedSessionContext: (params: unknown) =>
        resolveContextSpy(params),
}));

vi.mock('./createEphemeralServerSocketClient', () => ({
    createEphemeralServerSocketClient: (params: unknown) =>
        createSocketSpy(params),
}));

vi.mock('./createSessionRequestWithServerScope', () => ({
    createSessionRequestForResolvedServerScope: (params: unknown) =>
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

const ownerMetadataCiphertext =
    'oQoBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGDb9gtt8Xqs3gDuzJU/wWRuslcRY3OZA==';
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
    afterEach(() => {
        vi.useRealTimers();
        emitWithAckSpy.mockReset();
        activeRequestSpy.mockReset();
        resolvePreferredServerIdForSessionIdSpy.mockReset();
        resolveContextSpy.mockReset();
        createSocketSpy.mockReset();
        createResolvedRequestSpy.mockReset();
        resolvedRequestSpy.mockReset();
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
            },
            { timeoutMs: 4000 },
        );
        expect(createResolvedRequestSpy).not.toHaveBeenCalled();
        expect(createSocketSpy).not.toHaveBeenCalled();
    });

    it('keeps an ordinary layout-0 scoped write on the ephemeral legacy socket RPC', async () => {
        resolvePreferredServerIdForSessionIdSpy.mockReturnValue('server-b');
        resolveContextSpy.mockResolvedValue({
            scope: 'scoped',
            targetServerId: 'server-b',
            targetServerUrl: 'https://server-b.example.test',
            token: 'token-b',
            timeoutMs: 5000,
            encryption: null,
        });
        const emitWithAck = vi.fn(async () => ({
            result: 'success',
            version: 4,
            metadata: 'committed',
        }));
        const disconnect = vi.fn();
        createSocketSpy.mockResolvedValue({
            timeout: vi.fn(() => ({ emitWithAck })),
            disconnect,
        });

        const { emitSessionMetadataUpdateWithServerScope } =
            await import('./emitSessionMetadataUpdateWithServerScope');

        await expect(emitSessionMetadataUpdateWithServerScope({
            sessionId: 'session-1',
            expectedVersion: 3,
            metadata: 'ciphertext',
            timeoutMs: 5000,
        })).resolves.toEqual({
            result: 'success',
            version: 4,
            metadata: 'committed',
        });

        expect(createSocketSpy).toHaveBeenCalledWith({
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            timeoutMs: 5000,
        });
        expect(emitWithAck).toHaveBeenCalledWith(
            'update-metadata',
            {
                sid: 'session-1',
                expectedVersion: 3,
                metadata: 'ciphertext',
            },
        );
        expect(disconnect).toHaveBeenCalledTimes(1);
        expect(createResolvedRequestSpy).not.toHaveBeenCalled();
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
                body: JSON.stringify({
                    inactiveModelIntent: {
                        metadata: {
                            ciphertext: 'ciphertext',
                            expectedVersion: 3,
                        },
                        sessionExpectation: {
                            kind: 'inactive_model_intent',
                        },
                    },
                }),
            },
        );
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
            name: 'other error',
            status: 500,
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
