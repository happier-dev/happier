import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveBoxPublicKeyFromSeed, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
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
    const prevRetryAttempts = process.env.HAPPIER_SESSION_E2EE_DEK_FETCH_RETRY_ATTEMPTS;
    const prevRetryDelayMs = process.env.HAPPIER_SESSION_E2EE_DEK_FETCH_RETRY_DELAY_MS;

    beforeEach(() => {
        resolveSessionIdOrPrefix.mockReset();
        fetchSessionById.mockReset();
        fetchAccountEncryptionCurrentness.mockReset();
        fetchAccountEncryptionCurrentness.mockResolvedValue(plainAccountEncryptionCurrentness);
        process.env.HAPPIER_SESSION_E2EE_DEK_FETCH_RETRY_ATTEMPTS = '2';
        process.env.HAPPIER_SESSION_E2EE_DEK_FETCH_RETRY_DELAY_MS = '1';
    });

    afterEach(() => {
        if (prevRetryAttempts === undefined) {
            delete process.env.HAPPIER_SESSION_E2EE_DEK_FETCH_RETRY_ATTEMPTS;
        } else {
            process.env.HAPPIER_SESSION_E2EE_DEK_FETCH_RETRY_ATTEMPTS = prevRetryAttempts;
        }

        if (prevRetryDelayMs === undefined) {
            delete process.env.HAPPIER_SESSION_E2EE_DEK_FETCH_RETRY_DELAY_MS;
        } else {
            process.env.HAPPIER_SESSION_E2EE_DEK_FETCH_RETRY_DELAY_MS = prevRetryDelayMs;
        }
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
            credentials: { token: 'token', encryption: null },
            idOrPrefix: 'sess-1',
            signal: cancellation.signal,
        });

        expect(resolveSessionIdOrPrefix).toHaveBeenCalledWith({
            credentials: { token: 'token', encryption: null },
            idOrPrefix: 'sess-1',
            signal: cancellation.signal,
        });
        expect(fetchSessionById).toHaveBeenCalledWith({
            token: 'token',
            sessionId: 'sess-1',
            signal: cancellation.signal,
        });
        expect(fetchAccountEncryptionCurrentness).toHaveBeenCalledWith({
            token: 'token',
            signal: cancellation.signal,
        });
    });

    it('stops the e2ee key retry before issuing another session read after cancellation', async () => {
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
            credentials: {
                token: 'token',
                encryption: { type: 'dataKey', publicKey, machineKey },
            },
            idOrPrefix: 'sess-1',
            signal: cancellation.signal,
        })).rejects.toMatchObject({ name: 'AbortError' });
        expect(fetchSessionById).toHaveBeenCalledTimes(1);
    });

    it('refetches active e2ee sessions when the published dataEncryptionKey is briefly missing', async () => {
        const machineKey = new Uint8Array(32).fill(7);
        const publicKey = deriveBoxPublicKeyFromSeed(machineKey);
        const sessionDataKey = new Uint8Array(32).fill(9);
        const encryptedMetadata = encodeBase64(
            encrypt(sessionDataKey, 'dataKey', { path: '/tmp/project', permissionMode: 'safe-yolo' }),
            'base64',
        );
        const publishedDataEncryptionKey = encodeBase64(
            sealEncryptedDataKeyEnvelopeV1({
                dataKey: sessionDataKey,
                recipientPublicKey: publicKey,
                randomBytes: (length) => new Uint8Array(length).fill(3),
            }),
            'base64',
        );

        resolveSessionIdOrPrefix.mockResolvedValue({
            ok: true,
            sessionId: 'sess-1',
        });
        fetchSessionById
            .mockResolvedValueOnce({
                id: 'sess-1',
                active: true,
                activeAt: 1,
                encryptionMode: 'e2ee',
                dataEncryptionKey: null,
                metadata: encryptedMetadata,
            })
            .mockResolvedValueOnce({
                id: 'sess-1',
                active: true,
                activeAt: 1,
                encryptionMode: 'e2ee',
                dataEncryptionKey: publishedDataEncryptionKey,
                metadata: encryptedMetadata,
            });

        const { resolveSessionTransportContext } = await import('./resolveSessionTransportContext');

        const result = await resolveSessionTransportContext({
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

        expect(fetchSessionById).toHaveBeenCalledTimes(2);
        expect(result).toMatchObject({
            ok: true,
            sessionId: 'sess-1',
            mode: 'e2ee',
        });
        if (!result.ok) {
            throw new Error(`Expected resolved session transport context, got ${JSON.stringify(result)}`);
        }
        expect(result.mode).toBe('e2ee');
        if (result.mode !== 'e2ee') {
            throw new Error('Expected an encrypted Session transport context');
        }
        expect(Array.from(result.ctx.encryptionKey)).toEqual(Array.from(sessionDataKey));
    });
});
