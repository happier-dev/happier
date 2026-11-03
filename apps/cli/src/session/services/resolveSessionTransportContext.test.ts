import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveBoxPublicKeyFromSeed } from '@happier-dev/protocol';
import { encodeBase64, encrypt } from '@/api/encryption';

const { resolveSessionIdOrPrefix, fetchSessionById, fetchAccountEncryptionCurrentness } = vi.hoisted(() => ({
    resolveSessionIdOrPrefix: vi.fn(),
    fetchSessionById: vi.fn(),
    fetchAccountEncryptionCurrentness: vi.fn(),
}));

vi.mock('@/session/query/resolveSessionId', () => ({
    resolveSessionIdOrPrefix,
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
    fetchSessionById,
}));

vi.mock('@/api/client/connectedServiceCredentialApi', () => ({
    fetchAccountEncryptionCurrentness,
}));

const plainAccountEncryptionCurrentness = {
    mode: 'plain' as const,
    version: 1,
    signingKeyFingerprint: null,
    contentKeyFingerprint: null,
    updatedAt: 1,
} as const;

describe('resolveSessionTransportContext', () => {
    beforeEach(() => {
        resolveSessionIdOrPrefix.mockReset();
        fetchSessionById.mockReset();
        fetchAccountEncryptionCurrentness.mockReset();
        fetchAccountEncryptionCurrentness.mockResolvedValue(plainAccountEncryptionCurrentness);
    });

    it('reuses an exact full-id session row returned by id resolution instead of fetching it again', async () => {
        resolveSessionIdOrPrefix.mockResolvedValue({
            ok: true,
            sessionId: 'sess-full-id',
            rawSession: {
                id: 'sess-full-id',
                active: false,
                activeAt: 1,
                encryptionMode: 'plain',
                metadata: {},
            },
        });

        const { resolveSessionTransportContext } = await import('./resolveSessionTransportContext');

        const result = await resolveSessionTransportContext({
            reason: 'session-control',
            credentials: {
                token: 'token',
                encryption: null,
            },
            idOrPrefix: 'sess-full-id',
        });

        expect(fetchSessionById).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            ok: true,
            sessionId: 'sess-full-id',
            rawSession: {
                id: 'sess-full-id',
                active: false,
            },
            mode: 'plain',
            ctx: null,
        });
    });

    it('threads cancellation through id, session, and account-currentness reads', async () => {
        const cancellation = new AbortController();
        resolveSessionIdOrPrefix.mockResolvedValue({
            ok: true,
            sessionId: 'sess-1',
        });
        fetchSessionById.mockResolvedValue({
            id: 'sess-1',
            active: false,
            activeAt: 1,
            encryptionMode: 'plain',
            metadata: {},
        });

        const { resolveSessionTransportContext } = await import('./resolveSessionTransportContext');

        await resolveSessionTransportContext({
            reason: 'session-control',
            credentials: { token: 'token', encryption: null },
            idOrPrefix: 'sess-1',
            signal: cancellation.signal,
        });

        expect(resolveSessionIdOrPrefix).toHaveBeenCalledWith({
            reason: 'session-control',
            credentials: { token: 'token', encryption: null },
            idOrPrefix: 'sess-1',
            signal: cancellation.signal,
            accountEncryptionMode: expect.any(Function),
        });
        expect(fetchSessionById).toHaveBeenCalledWith({
            reason: 'session-control',
            token: 'token',
            sessionId: 'sess-1',
            signal: cancellation.signal,
        });
        expect(fetchAccountEncryptionCurrentness).toHaveBeenCalledWith({
            token: 'token',
            signal: cancellation.signal,
        });
    });

    it('threads one exact-Home feature snapshot through resolution and fallback detail hydration', async () => {
        const serverFeaturesSnapshot = {
            status: 'unsupported' as const,
            reason: 'endpoint_missing' as const,
        };
        resolveSessionIdOrPrefix.mockResolvedValue({ ok: true, sessionId: 'sess-1' });
        fetchSessionById.mockResolvedValue({
            id: 'sess-1',
            active: false,
            activeAt: 1,
            encryptionMode: 'plain',
            metadata: {},
        });

        const { resolveSessionTransportContext } = await import('./resolveSessionTransportContext');
        await resolveSessionTransportContext({
            reason: 'session-control',
            credentials: { token: 'token', encryption: null },
            idOrPrefix: 'sess-1',
            serverFeaturesSnapshot,
        });

        expect(resolveSessionIdOrPrefix).toHaveBeenCalledWith({
            reason: 'session-control',
            credentials: { token: 'token', encryption: null },
            idOrPrefix: 'sess-1',
            serverFeaturesSnapshot,
            accountEncryptionMode: expect.any(Function),
        });
        expect(fetchSessionById).toHaveBeenCalledWith({
            reason: 'session-control',
            token: 'token',
            sessionId: 'sess-1',
            serverFeaturesSnapshot,
        });
    });

    it('checks cancellation after the exact one-shot Session read', async () => {
        const cancellation = new AbortController();
        const machineKey = new Uint8Array(32).fill(7);
        const publicKey = deriveBoxPublicKeyFromSeed(machineKey);
        const sessionDataKey = new Uint8Array(32).fill(9);
        const encryptedMetadata = encodeBase64(
            encrypt(sessionDataKey, 'dataKey', { path: '/tmp/project', permissionMode: 'safe-yolo' }),
            'base64',
        );
        resolveSessionIdOrPrefix.mockResolvedValue({
            ok: true,
            sessionId: 'sess-1',
        });
        fetchSessionById.mockImplementationOnce(async () => {
            cancellation.abort();
            return {
                id: 'sess-1',
                active: true,
                activeAt: 1,
                encryptionMode: 'e2ee',
                dataEncryptionKey: null,
                metadata: encryptedMetadata,
            };
        });

        const { resolveSessionTransportContext } = await import('./resolveSessionTransportContext');

        await expect(resolveSessionTransportContext({
            reason: 'session-control',
            credentials: {
                token: 'token',
                encryption: { type: 'dataKey', publicKey, machineKey },
            },
            idOrPrefix: 'sess-1',
            signal: cancellation.signal,
        })).rejects.toMatchObject({ name: 'AbortError' });
        expect(fetchSessionById).toHaveBeenCalledTimes(1);
    });

    it('settles a missing recipient envelope without an encryption-specific retry loop', async () => {
        const machineKey = new Uint8Array(32).fill(7);
        const publicKey = deriveBoxPublicKeyFromSeed(machineKey);
        const sessionDataKey = new Uint8Array(32).fill(9);
        const encryptedMetadata = encodeBase64(
            encrypt(sessionDataKey, 'dataKey', { path: '/tmp/project', permissionMode: 'safe-yolo' }),
            'base64',
        );
        resolveSessionIdOrPrefix.mockResolvedValue({
            ok: true,
            sessionId: 'sess-1',
        });
        fetchSessionById.mockResolvedValueOnce({
            id: 'sess-1',
            active: true,
            activeAt: 1,
            encryptionMode: 'e2ee',
            dataEncryptionKey: null,
            share: { accessLevel: 'view', canApprovePermissions: false },
            metadata: encryptedMetadata,
        });

        const { resolveSessionTransportContext } = await import('./resolveSessionTransportContext');

        const result = await resolveSessionTransportContext({
            reason: 'session-control',
            credentials: {
                token: 'token',
                encryption: {
                    type: 'dataKey',
                    publicKey,
                    machineKey,
                },
            },
            idOrPrefix: 'sess-1',
        });

        expect(fetchSessionById).toHaveBeenCalledTimes(1);
        expect(result).toEqual({
            ok: false,
            code: 'encryption_material_unavailable',
            sessionId: 'sess-1',
        });
    });
});
