import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';

import { authQRStart, generateAuthKeyPair } from './qrStart';
import { resolveHomeEnrollmentTransport } from '@/auth/enrollment/homeEnrollmentTransport';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

const endpointFetchMock = vi.hoisted(() => vi.fn());
describe('authQRStart explicit target', () => {
    const descriptor = HomeConnectionDescriptorV1Schema.parse({
        v: 1 as const,
        homeServerIdentityId: 'srv_home_b',
        canonicalServerUrl: 'https://home-b.test',
        revision: 1,
        endpoints: [{ kind: 'https' as const, url: 'https://home-b.test' }],
    });
    const enrollmentTarget = async (endpointUrl: string, serverId?: string) => {
        const resolved = await resolveHomeEnrollmentTransport(descriptor);
        if (!resolved.ok) throw new Error('Expected test Home transport');
        return { ...resolved.transport, endpointUrl, ...(serverId ? { serverId } : {}) };
    };
    beforeEach(() => setRuntimeFetch(endpointFetchMock));
    afterEach(() => {
        endpointFetchMock.mockReset();
        resetRuntimeFetch();
    });

    it('generates an X25519 public key from the retained secret scalar', () => {
        const keypair = generateAuthKeyPair();
        expect(keypair.secretKey).toHaveLength(tweetnacl.box.secretKeyLength);
        expect(keypair.publicKey).toEqual(tweetnacl.box.keyPair.fromSecretKey(keypair.secretKey).publicKey);
    });

    it('sends the enrollment request to the explicit Home endpoint without consulting the active server', async () => {
        endpointFetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

        await expect(authQRStart(
            generateAuthKeyPair(),
            await enrollmentTarget('https://home-b.test', 'profile-b'),
        )).resolves.toEqual({ ok: true });

        expect(endpointFetchMock.mock.calls[0]?.[0]).toBe('https://home-b.test/v2/auth/account/request');
        const init = endpointFetchMock.mock.calls[0]?.[1] as RequestInit;
        expect(JSON.parse(String(init.body))).toEqual({
            publicKey: expect.any(String),
        });
    });

    it('reports cancellation when the initiating lifecycle aborts the actual network request', async () => {
        const controller = new AbortController();
        endpointFetchMock.mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init?.signal?.reason), { once: true });
            controller.abort();
        }));
        await expect(authQRStart(generateAuthKeyPair(), await enrollmentTarget('https://home-b.test'), {
            signal: controller.signal,
        })).resolves.toEqual({ ok: false, reason: 'cancelled', status: 0 });
    });

    it('reports failure without retrying through the active-server wrapper', async () => {
        endpointFetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));

        await expect(authQRStart(generateAuthKeyPair(), await enrollmentTarget('https://home-b.test'))).resolves.toEqual({
            ok: false,
            reason: 'transient',
            status: 0,
        });

    });

    it('rejects a target without a usable endpoint URL', async () => {
        await expect(authQRStart(generateAuthKeyPair(), await enrollmentTarget('   '))).resolves.toEqual({
            ok: false,
            reason: 'invalid_target',
            status: 0,
        });
        expect(endpointFetchMock).not.toHaveBeenCalled();
    });
});
