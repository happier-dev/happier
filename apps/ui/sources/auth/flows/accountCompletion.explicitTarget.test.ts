import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { completeAccountAuthRequest } from './accountCompletion';
import { resolveHomeEnrollmentTransport } from '@/auth/enrollment/homeEnrollmentTransport';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import tweetnacl from 'tweetnacl';
import { sealTerminalProvisioningV3Payload, sealTerminalProvisioningV3TokenOnlyPayload } from '@happier-dev/protocol/crypto/terminalProvisioningV2';
import { encodeBase64 } from '@/encryption/base64';
import { generateAuthKeyPair } from './qrStart';
import type { HomeQrEnrollmentTarget } from './qrStart';

const endpointFetchMock = vi.hoisted(() => vi.fn());
const descriptor = HomeConnectionDescriptorV1Schema.parse({
        v: 1 as const,
        homeServerIdentityId: 'srv_home_b',
        canonicalServerUrl: 'https://home-b.test',
        revision: 1,
        endpoints: [{ kind: 'https' as const, url: 'https://home-b.test' }],
});
let target: HomeQrEnrollmentTarget;

let publicKey: Uint8Array;
let responses: Record<'tokenOnly' | 'dataKey', Uint8Array>;

describe('completeAccountAuthRequest explicit target', () => {
    beforeAll(async () => {
        const resolution = await resolveHomeEnrollmentTransport(descriptor);
        if (!resolution.ok) throw new Error('Expected test Home transport');
        target = { ...resolution.transport, serverId: 'profile-b' };
    });
    beforeEach(() => {
        setRuntimeFetch(endpointFetchMock);
        publicKey = generateAuthKeyPair().publicKey;
        const createdAtMs = Date.now();
        const input = { terminalEphemeralPublicKey: publicKey, pairingSecret: new Uint8Array(32).fill(7),
            createdAtMs, expiresAtMs: createdAtMs + 60_000, randomBytes: tweetnacl.randomBytes };
        responses = { tokenOnly: sealTerminalProvisioningV3TokenOnlyPayload(input),
            dataKey: sealTerminalProvisioningV3Payload({ ...input, contentPrivateKey: new Uint8Array(32).fill(9) }) };
    });
    afterEach(() => {
        endpointFetchMock.mockReset();
        resetRuntimeFetch();
    });

    it('sends the strict bound terminal-v3 admission body only to the selected Home', async () => {
        endpointFetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

        await expect(completeAccountAuthRequest({
            token: 'home-b-token',
            target,
            pairId: 'pair-b',
            publicKey,
            response: responses.tokenOnly,
            homeServerIdentityId: 'srv_home_b',
            responseKind: 'tokenOnly',
        })).resolves.toBe('completed');

        expect(endpointFetchMock).toHaveBeenCalledWith('https://home-b.test/v1/auth/account/response', expect.objectContaining({
            body: JSON.stringify({
                pairId: 'pair-b',
                publicKey: encodeBase64(publicKey),
                response: encodeBase64(responses.tokenOnly),
                homeServerIdentityId: 'srv_home_b',
                responseKind: 'tokenOnly',
            }),
        }));
        expect(new Headers((endpointFetchMock.mock.calls[0]?.[1] as RequestInit).headers).get('Authorization')).toBe('Bearer home-b-token');
    });

    it('forwards lifecycle cancellation to the authenticated completion request', async () => {
        const controller = new AbortController();
        endpointFetchMock.mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init?.signal?.reason), { once: true });
            controller.abort();
        }));

        await expect(completeAccountAuthRequest({
            token: 'home-b-token',
            target,
            pairId: 'pair-b',
            publicKey,
            response: responses.tokenOnly,
            homeServerIdentityId: 'srv_home_b',
            responseKind: 'tokenOnly',
            signal: controller.signal,
        })).rejects.toMatchObject({ code: 'account_completion_failed', status: 0, retryable: true });
        expect((endpointFetchMock.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(true);
    });

    it('rejects a mismatched target identity before any request', async () => {
        await expect(completeAccountAuthRequest({
            token: 'home-b-token',
            target,
            pairId: 'pair-b',
            publicKey,
            response: responses.tokenOnly,
            homeServerIdentityId: 'srv_home_a',
            responseKind: 'tokenOnly',
        })).rejects.toMatchObject({ code: 'invalid_target' });
        expect(endpointFetchMock).not.toHaveBeenCalled();
    });

    it('treats the typed already-completed replay as successful completion', async () => {
        endpointFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'already_completed' }), {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
        }));
        await expect(completeAccountAuthRequest({
            token: 'home-b-token',
            target,
            pairId: 'pair-b',
            publicKey,
            response: responses.tokenOnly,
            homeServerIdentityId: 'srv_home_b',
            responseKind: 'tokenOnly',
        })).resolves.toBe('already_completed');

        endpointFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'provisioning_kind_mismatch' }), {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
        }));
        await expect(completeAccountAuthRequest({
            token: 'home-b-token',
            target,
            pairId: 'pair-b',
            publicKey,
            response: responses.tokenOnly,
            homeServerIdentityId: 'srv_home_b',
            responseKind: 'tokenOnly',
        })).rejects.toMatchObject({ code: 'account_completion_failed', status: 409, retryable: false });
    });
});
