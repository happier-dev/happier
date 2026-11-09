import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import {
    sealTerminalProvisioningV3Payload,
    sealTerminalProvisioningV3TokenOnlyPayload,
} from '@happier-dev/protocol/crypto/terminalProvisioningV2';

import { encodeBase64 } from '@/encryption/base64';
import { encryptBox } from '@/encryption/libsodium';
import { generateAuthKeyPair } from './qrStart';
import { authQRWait, type AuthQrWaitOptions, type HomeQrEnrollmentTarget } from './qrWait';
import { resolveHomeEnrollmentTransport } from '@/auth/enrollment/homeEnrollmentTransport';

const endpointFetchMock = vi.hoisted(() => vi.fn());
const createServerFetchAtEndpointMock = vi.hoisted(() => vi.fn<(input: unknown) => typeof endpointFetchMock>(() => endpointFetchMock));
const serverFetchMock = vi.hoisted(() => vi.fn());
const trackAuthEnrollmentTransientRetryMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/http/client', () => ({
    createServerFetchAtEndpoint: (input: unknown) => createServerFetchAtEndpointMock(input),
    serverFetch: (...args: unknown[]) => serverFetchMock(...args),
}));
vi.mock('@/utils/runtime/isRuntimeActive', () => ({ isRuntimeActive: () => true }));
vi.mock('@/track', () => ({
    trackAuthEnrollmentTransientRetry: trackAuthEnrollmentTransientRetryMock,
}));

function json(status: number, payload: unknown): Response {
    return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

const HOME_B_DESCRIPTOR = {
        v: 1 as const,
        homeServerIdentityId: 'srv_home_b',
        canonicalServerUrl: 'https://home-b.test',
        revision: 1,
        endpoints: [{ kind: 'https' as const, url: 'https://home-b.test' }],
};
let HOME_B_TARGET: HomeQrEnrollmentTarget;

function createV2Context(overrides: Partial<NonNullable<AuthQrWaitOptions['v2Context']>> = {}) {
    const issuedAtMs = Date.now();
    return {
        pairId: 'pair-home-b',
        homeServerIdentityId: 'srv_home_b',
        bindingSecret: new Uint8Array(32).fill(17),
        bindingProof: 'bound-proof',
        direction: 'trusted_home_displays' as const,
        issuedAtMs,
        expiresAtMs: issuedAtMs + 60_000,
        ...overrides,
    };
}

function authorizedV2(params: Readonly<{
    keypair: ReturnType<typeof generateAuthKeyPair>;
    context: NonNullable<AuthQrWaitOptions['v2Context']>;
    token: string;
    dataKey?: Uint8Array;
    rawResponse?: Uint8Array;
}>) {
    const response = params.rawResponse ?? (params.dataKey
        ? sealTerminalProvisioningV3Payload({
            contentPrivateKey: params.dataKey,
            terminalEphemeralPublicKey: params.keypair.publicKey,
            pairingSecret: params.context.bindingSecret,
            createdAtMs: params.context.issuedAtMs,
            expiresAtMs: params.context.expiresAtMs,
            randomBytes: tweetnacl.randomBytes,
        })
        : sealTerminalProvisioningV3TokenOnlyPayload({
            terminalEphemeralPublicKey: params.keypair.publicKey,
            pairingSecret: params.context.bindingSecret,
            createdAtMs: params.context.issuedAtMs,
            expiresAtMs: params.context.expiresAtMs,
            randomBytes: tweetnacl.randomBytes,
        }));
    return {
        state: 'authorized',
        tokenEncrypted: encodeBase64(encryptBox(new TextEncoder().encode(params.token), params.keypair.publicKey)),
        response: encodeBase64(response),
    };
}

beforeAll(async () => {
    const resolution = await resolveHomeEnrollmentTransport(HOME_B_DESCRIPTOR);
    if (!resolution.ok) throw new Error('Expected test Home transport');
    HOME_B_TARGET = { ...resolution.transport, serverId: 'profile-b' };
});

async function settle<T>(promise: Promise<T>): Promise<T> {
    await vi.advanceTimersByTimeAsync(50);
    return promise;
}

describe('authQRWait explicit-target enrollment', () => {
    afterEach(() => {
        endpointFetchMock.mockReset();
        createServerFetchAtEndpointMock.mockClear();
        createServerFetchAtEndpointMock.mockImplementation(() => endpointFetchMock);
        serverFetchMock.mockReset();
        trackAuthEnrollmentTransientRetryMock.mockReset();
        vi.useRealTimers();
    });

    it('polls only the explicit Home and opens canonical token-only v3 material', async () => {
        vi.useFakeTimers();
        const keypair = generateAuthKeyPair();
        const context = createV2Context();
        endpointFetchMock.mockResolvedValueOnce(json(200, authorizedV2({ keypair, context, token: 'home-b-token' })));

        const result = await settle(authQRWait(keypair, HOME_B_TARGET, { v2Context: context }));

        expect(result).toEqual({ ok: true, credentials: { token: 'home-b-token' }, homeServerIdentityId: 'srv_home_b' });
        expect(createServerFetchAtEndpointMock).toHaveBeenCalledWith(expect.objectContaining({
            endpointUrl: 'https://home-b.test',
            serverId: 'profile-b',
            credentials: null,
        }));
        expect(endpointFetchMock).toHaveBeenCalledWith('/v2/auth/account/request', expect.objectContaining({
            body: JSON.stringify({
                publicKey: encodeBase64(keypair.publicKey),
                pairId: context.pairId,
                homeServerIdentityId: context.homeServerIdentityId,
            }),
        }), expect.anything());
        expect(serverFetchMock).not.toHaveBeenCalled();
    });

    it('maps canonical dataKey v3 material using X25519 scalar public derivation', async () => {
        vi.useFakeTimers();
        const keypair = generateAuthKeyPair();
        const context = createV2Context();
        const dataKey = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1));
        const publicKey = tweetnacl.box.keyPair.fromSecretKey(dataKey).publicKey;
        endpointFetchMock.mockResolvedValueOnce(json(200, authorizedV2({ keypair, context, token: 'data-key-token', dataKey })));

        await expect(settle(authQRWait(keypair, HOME_B_TARGET, { v2Context: context }))).resolves.toEqual({
            ok: true,
            credentials: {
                token: 'data-key-token',
                encryption: { machineKey: encodeBase64(dataKey), publicKey: encodeBase64(publicKey) },
            },
            homeServerIdentityId: 'srv_home_b',
        });
    });

    it('rejects raw legacy/custom JSON instead of opening a competing envelope', async () => {
        vi.useFakeTimers();
        const keypair = generateAuthKeyPair();
        const context = createV2Context();
        endpointFetchMock.mockResolvedValueOnce(json(200, authorizedV2({
            keypair,
            context,
            token: 'must-not-leak',
            rawResponse: new TextEncoder().encode(JSON.stringify({ token: 'raw', secret: 'legacy' })),
        })));

        const result = await settle(authQRWait(keypair, HOME_B_TARGET, { v2Context: context }));
        expect(result).toEqual({ ok: false, reason: 'malformed_response' });
        expect(JSON.stringify(result)).not.toContain('must-not-leak');
    });

    it.each([
        ['oversized', 'malformed_response'],
        ['tampered', 'malformed_response'],
    ])('rejects %s response terminally', async (variant, expectedReason) => {
        vi.useFakeTimers();
        const keypair = generateAuthKeyPair();
        const context = createV2Context();
        const valid = authorizedV2({ keypair, context, token: 't' });
        const payload = variant === 'oversized'
                ? { ...valid, response: 'A'.repeat(20_000) }
                : { ...valid, response: `${valid.response.startsWith('A') ? 'B' : 'A'}${valid.response.slice(1)}` };
        endpointFetchMock.mockResolvedValueOnce(json(200, payload));

        await expect(settle(authQRWait(keypair, HOME_B_TARGET, { v2Context: context })))
            .resolves.toEqual({ ok: false, reason: expectedReason });
    });

    it.each([
        ['padding-mutated', (value: string) => value.endsWith('=') ? value.replace(/=+$/, '') : `${value}=`],
        ['whitespace-contaminated', (value: string) => `${value.slice(0, 4)} ${value.slice(4)}`],
    ])('rejects noncanonical %s tokenEncrypted base64 instead of lenient decoding', async (_variant, mutateTokenEncrypted) => {
        vi.useFakeTimers();
        const keypair = generateAuthKeyPair();
        const context = createV2Context();
        const valid = authorizedV2({ keypair, context, token: 'home-b-token' });
        endpointFetchMock.mockResolvedValueOnce(json(200, {
            ...valid,
            tokenEncrypted: mutateTokenEncrypted(valid.tokenEncrypted),
        }));

        const result = await settle(authQRWait(keypair, HOME_B_TARGET, { v2Context: context }));
        expect(result).toEqual({ ok: false, reason: 'malformed_response' });
        expect(JSON.stringify(result)).not.toContain('home-b-token');
    });

    it.each([
        ['surrounding whitespace', '  home-b-token  '],
        ['whitespace-only', '   '],
    ])('rejects %s in the decrypted raw token', async (_variant, token) => {
        vi.useFakeTimers();
        const keypair = generateAuthKeyPair();
        const context = createV2Context();
        endpointFetchMock.mockResolvedValueOnce(json(200, authorizedV2({ keypair, context, token })));

        const result = await settle(authQRWait(keypair, HOME_B_TARGET, { v2Context: context }));
        expect(result).toEqual({ ok: false, reason: 'malformed_response' });
        expect(JSON.stringify(result)).not.toContain(token);
    });

    it('retries transient transport failure and then succeeds', async () => {
        vi.useFakeTimers();
        const keypair = generateAuthKeyPair();
        const context = createV2Context();
        endpointFetchMock
            .mockRejectedValueOnce(new TypeError('network'))
            .mockResolvedValueOnce(json(200, authorizedV2({ keypair, context, token: 'after-retry' })));

        const resultPromise = authQRWait(keypair, HOME_B_TARGET, { v2Context: context });
        await vi.advanceTimersByTimeAsync(10_000);
        await expect(resultPromise).resolves.toEqual({
            ok: true,
            credentials: { token: 'after-retry' },
            homeServerIdentityId: 'srv_home_b',
        });
        expect(endpointFetchMock).toHaveBeenCalledTimes(2);
        expect(trackAuthEnrollmentTransientRetryMock).toHaveBeenCalledTimes(1);
    });

    it('returns a direct-QR rejection as a typed terminal result', async () => {
        vi.useFakeTimers();
        const keypair = generateAuthKeyPair();
        const context = createV2Context();
        endpointFetchMock.mockResolvedValueOnce(json(200, { state: 'rejected' }));

        await expect(settle(authQRWait(keypair, HOME_B_TARGET, { v2Context: context })))
            .resolves.toEqual({ ok: false, reason: 'rejected' });
        expect(endpointFetchMock).toHaveBeenCalledTimes(1);
    });

    it('aborts the in-flight poll without scheduling another request', async () => {
        const keypair = generateAuthKeyPair();
        const context = createV2Context();
        const controller = new AbortController();
        endpointFetchMock.mockImplementationOnce((_path: string, init: RequestInit) => new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }));

        const resultPromise = authQRWait(keypair, HOME_B_TARGET, {
            v2Context: context,
            signal: controller.signal,
        });
        await vi.waitFor(() => expect(endpointFetchMock).toHaveBeenCalledTimes(1));

        controller.abort();

        await expect(resultPromise).resolves.toEqual({ ok: false, reason: 'cancelled' });
        expect(endpointFetchMock).toHaveBeenCalledTimes(1);
        expect(trackAuthEnrollmentTransientRetryMock).not.toHaveBeenCalled();
    });

    it('cancels immediately during transient retry backoff', async () => {
        vi.useFakeTimers();
        const keypair = generateAuthKeyPair();
        const context = createV2Context();
        const controller = new AbortController();
        endpointFetchMock.mockRejectedValueOnce(new TypeError('network'));

        const resultPromise = authQRWait(keypair, HOME_B_TARGET, {
            v2Context: context,
            signal: controller.signal,
        });
        await vi.waitFor(() => expect(endpointFetchMock).toHaveBeenCalledTimes(1));

        controller.abort();

        await expect(resultPromise).resolves.toEqual({ ok: false, reason: 'cancelled' });
        expect(endpointFetchMock).toHaveBeenCalledTimes(1);
    });

    it('stops at the invite expiry instead of sleeping through a longer retry backoff', async () => {
        vi.useFakeTimers();
        const keypair = generateAuthKeyPair();
        const issuedAtMs = Date.now();
        const context = createV2Context({
            issuedAtMs,
            expiresAtMs: issuedAtMs + 500,
        });
        endpointFetchMock.mockRejectedValueOnce(new TypeError('network'));

        let settledResult: Awaited<ReturnType<typeof authQRWait>> | null = null;
        const resultPromise = authQRWait(keypair, HOME_B_TARGET, { v2Context: context })
            .then((result) => {
                settledResult = result;
                return result;
            });
        await vi.waitFor(() => expect(endpointFetchMock).toHaveBeenCalledTimes(1));

        await vi.advanceTimersByTimeAsync(500);

        expect(settledResult).toEqual({ ok: false, reason: 'expired' });
        await resultPromise;
        expect(endpointFetchMock).toHaveBeenCalledTimes(1);
    });

    it('aborts an in-flight status request at the invite deadline', async () => {
        vi.useFakeTimers();
        const keypair = generateAuthKeyPair();
        const issuedAtMs = Date.now();
        const context = createV2Context({ issuedAtMs, expiresAtMs: issuedAtMs + 500 });
        // Collected rather than held in a single `let`: a variable only ever assigned inside
        // this callback narrows to `null` at the assertion below.
        const requestSignals: AbortSignal[] = [];
        endpointFetchMock.mockImplementationOnce((_path: string, init: RequestInit) => new Promise((_resolve, reject) => {
            if (init.signal) requestSignals.push(init.signal);
            init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }));

        const resultPromise = authQRWait(keypair, HOME_B_TARGET, { v2Context: context });
        await vi.waitFor(() => expect(endpointFetchMock).toHaveBeenCalledTimes(1));
        await vi.advanceTimersByTimeAsync(500);

        expect(requestSignals[0]?.aborted).toBe(true);
        await expect(resultPromise).resolves.toEqual({ ok: false, reason: 'expired' });
        expect(endpointFetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([
        // An authorized answer carrying a plaintext token is not the bound v3 envelope.
        { label: 'a plaintext authorized token', status: 200, reason: 'malformed_response' },
        { label: 'an expired request', status: 404, reason: 'expired' },
        { label: 'a request bound to another target', status: 403, reason: 'wrong_target' },
    ])('never falls back from V2 to V1 or accepts plaintext token response ($label)', async ({ status, reason }) => {
        vi.useFakeTimers();
        const keypair = generateAuthKeyPair();
        const context = createV2Context();
        endpointFetchMock.mockResolvedValueOnce(json(status, { state: 'authorized', token: 'plaintext' }));

        const result = await settle(authQRWait(keypair, HOME_B_TARGET, { v2Context: context }));
        expect(result).toEqual({ ok: false, reason });
        expect(JSON.stringify(result)).not.toContain('plaintext');
        expect(endpointFetchMock.mock.calls.map((call) => call[0])).toEqual(['/v2/auth/account/request']);
    });

    it('fails closed before network use without immutable V2 binding context', async () => {
        const keypair = generateAuthKeyPair();
        await expect(authQRWait(keypair, HOME_B_TARGET)).resolves.toEqual({
            ok: false,
            reason: 'update_required',
        });
        expect(endpointFetchMock).not.toHaveBeenCalled();
        expect(serverFetchMock).not.toHaveBeenCalled();
    });
});
