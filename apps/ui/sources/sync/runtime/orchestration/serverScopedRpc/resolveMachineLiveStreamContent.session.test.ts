import { afterEach, describe, expect, it, vi } from 'vitest';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { V2SessionByIdResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { encodeBase64 } from '@/encryption/base64';
import { Encryption } from '@/sync/encryption/encryption';
import { AES256Encryption } from '@/sync/encryption/encryptor';
import { resetSessionByIdHttpReadsForTests } from '@/sync/engine/sessions/sessionByIdHttp';
import { createSessionAccessFixture, createSessionFixture, createPlainSessionByIdResponseFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { resolveMachineLiveStreamContent } from './resolveMachineLiveStreamContent';

// HTTP is the boundary: Session access projection, key admission and cipher stay real.
const fetchBoundary = vi.hoisted(() => vi.fn());
vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (...args: unknown[]) => fetchBoundary(...args),
    get runtimeFetchManualResponse() { return this.runtimeFetch; },
}));

afterEach(() => { fetchBoundary.mockReset(); resetSessionByIdHttpReadsForTests(); });
const requestUrl = (input: unknown) => input instanceof Request ? input.url : String(input);

describe('Session Browser live-stream content', () => {
    it.each(['plain', 'e2ee', 'missing-key'] as const)('uses the shared Session material without opening a Machine key (%s)', async mode => {
        const accountSecret = new Uint8Array(32).fill(7);
        const encryption = await Encryption.create(accountSecret);
        const sessionId = `session-${mode}`;
        const sessionKey = new Uint8Array(32).fill(9);
        const fixture = createPlainSessionByIdResponseFixture(createSessionFixture({ id: sessionId,
            metadataLayoutVersion: 1, metadata: null, ownerMetadataView: null, access: createSessionAccessFixture('view') }));
        const dataEncryptionKey = mode === 'missing-key' ? null : encodeBase64(sealEncryptedDataKeyEnvelopeV1({
            dataKey: sessionKey, recipientPublicKey: encryption.contentDataKey,
            randomBytes: length => new Uint8Array(length).fill(3),
        }), 'base64');
        const [metadata] = await new AES256Encryption(sessionKey).encrypt([{}]);
        const response = mode === 'plain' ? fixture : V2SessionByIdResponseSchema.parse({ session: {
            ...fixture.session, encryptionMode: 'e2ee', metadataLayoutVersion: 0,
            metadata: encodeBase64(metadata!, 'base64'), dataEncryptionKey,
        } });
        fetchBoundary.mockImplementation(async (input: RequestInfo | URL) => {
            if (requestUrl(input).includes('/machines')) throw new Error('Session Browser must not open Machine material');
            return Response.json(response);
        });
        const content = resolveMachineLiveStreamContent({ machineId: 'owner-machine', targetServerId: 'home',
            targetServerUrl: 'https://session-browser.test', token: 'token',
            credentials: mode === 'plain' ? { token: 'token' } : { token: 'token', secret: encodeBase64(accountSecret, 'base64') },
            ...(mode === 'plain' ? {} : { encryption }) }, sessionId);
        if (mode === 'missing-key') await expect(content).rejects.toMatchObject({ code: 'stream_encryption_material_unavailable' });
        else {
            const resolved = await content;
            expect(resolved.mode).toBe(mode);
            if (resolved.mode === 'e2ee') {
                const [sealed] = await new AES256Encryption(sessionKey).encrypt([{ frame: 'private browser pixels' }]);
                expect(await resolved.cipher.decryptRaw(encodeBase64(sealed!, 'base64'))).toEqual({ frame: 'private browser pixels' });
            }
        }
        expect(fetchBoundary.mock.calls.some(([url]) => requestUrl(url).includes('/machines'))).toBe(false);
    });
});
