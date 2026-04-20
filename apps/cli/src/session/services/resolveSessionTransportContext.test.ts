import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveBoxPublicKeyFromSeed, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { encodeBase64, encrypt } from '@/api/encryption';

const { resolveSessionIdOrPrefix, fetchSessionById } = vi.hoisted(() => ({
    resolveSessionIdOrPrefix: vi.fn(),
    fetchSessionById: vi.fn(),
}));

vi.mock('@/session/query/resolveSessionId', () => ({
    resolveSessionIdOrPrefix,
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
    fetchSessionById,
}));

describe('resolveSessionTransportContext', () => {
    const prevRetryAttempts = process.env.HAPPIER_SESSION_E2EE_DEK_FETCH_RETRY_ATTEMPTS;
    const prevRetryDelayMs = process.env.HAPPIER_SESSION_E2EE_DEK_FETCH_RETRY_DELAY_MS;

    beforeEach(() => {
        resolveSessionIdOrPrefix.mockReset();
        fetchSessionById.mockReset();
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
        expect(Array.from(result.ctx.encryptionKey)).toEqual(Array.from(sessionDataKey));
    });
});
