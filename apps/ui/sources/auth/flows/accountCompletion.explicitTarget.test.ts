import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { completeHomeQrRequest } from '@happier-dev/cli-common/homeEnrollment';
import { deriveHomeQrBindingKeyV2 } from '@happier-dev/protocol/crypto/qrProvisioningV2';

import { createAccountCompletionTarget } from './accountCompletion';
import { resolveHomeEnrollmentTransport } from '@/auth/enrollment/homeEnrollmentTransport';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import tweetnacl from 'tweetnacl';
import { openTerminalProvisioningV3Response } from '@happier-dev/protocol/crypto/terminalProvisioningV2';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
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

const qrSecret = new Uint8Array(32).fill(7);
const keypair = tweetnacl.box.keyPair();
const issuedAtMs = Date.now();
const expiresAtMs = issuedAtMs + 60_000;

function complete(input: Readonly<{ homeServerIdentityId?: string; signal?: AbortSignal }> = {}) {
    return completeHomeQrRequest({
        target: createAccountCompletionTarget(target, 'home-b-token'),
        context: {
            pairId: 'pair-b', homeServerIdentityId: input.homeServerIdentityId ?? 'srv_home_b',
            qrSecret, issuedAtMs, expiresAtMs,
        },
        requesterPublicKey: keypair.publicKey,
        material: { type: 'tokenOnly' },
        randomBytes: tweetnacl.randomBytes,
        signal: input.signal,
    });
}

describe('Home QR completion through the explicit UI target', () => {
    beforeAll(async () => {
        const resolution = await resolveHomeEnrollmentTransport(descriptor);
        if (!resolution.ok) throw new Error('Expected test Home transport');
        target = { ...resolution.transport, serverId: 'profile-b' };
    });
    beforeEach(() => {
        setRuntimeFetch(endpointFetchMock);
    });
    afterEach(() => {
        endpointFetchMock.mockReset();
        resetRuntimeFetch();
    });

    it('sends the strict bound terminal-v3 admission body only to the selected Home', async () => {
        endpointFetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

        await expect(complete()).resolves.toBe('completed');

        const [url, init] = endpointFetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://home-b.test/v1/auth/account/response');
        expect(new Headers(init.headers).get('Authorization')).toBe('Bearer home-b-token');
        const body = JSON.parse(String(init.body));
        expect(body).toEqual({
            pairId: 'pair-b',
            publicKey: encodeBase64(keypair.publicKey),
            response: expect.any(String),
            homeServerIdentityId: 'srv_home_b',
            responseKind: 'tokenOnly',
        });
        expect(openTerminalProvisioningV3Response({
            payload: decodeBase64(body.response),
            recipientSecretKeyOrSeed: keypair.secretKey,
            terminalEphemeralPublicKey: keypair.publicKey,
            pairingSecret: deriveHomeQrBindingKeyV2(qrSecret),
            createdAtMs: issuedAtMs,
            expiresAtMs,
            nowMs: Date.now(),
        })).toEqual({ type: 'tokenOnly' });
    });

    it('forwards lifecycle cancellation to the authenticated completion request', async () => {
        const controller = new AbortController();
        endpointFetchMock.mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init?.signal?.reason), { once: true });
            controller.abort();
        }));

        await expect(complete({ signal: controller.signal })).rejects.toMatchObject({ code: 'account_completion_failed', status: 0, retryable: true });
        expect((endpointFetchMock.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(true);
    });

    it('rejects a mismatched target identity before any request', async () => {
        await expect(complete({ homeServerIdentityId: 'srv_home_a' })).rejects.toMatchObject({ code: 'invalid_target' });
        expect(endpointFetchMock).not.toHaveBeenCalled();
    });

    it('treats the typed already-completed replay as successful completion', async () => {
        endpointFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'already_completed' }), {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
        }));
        await expect(complete()).resolves.toBe('already_completed');

        endpointFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'provisioning_kind_mismatch' }), {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
        }));
        await expect(complete()).rejects.toMatchObject({ code: 'account_completion_failed', status: 409, retryable: false });
    });
});
