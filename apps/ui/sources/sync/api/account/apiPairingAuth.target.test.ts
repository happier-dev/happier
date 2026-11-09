import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    pairingConsume,
    pairingRequest,
    pairingStart,
    pairingStatus,
} from './apiPairingAuth';
import { resolveHomeEnrollmentTransport } from '@/auth/enrollment/homeEnrollmentTransport';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';

const endpointFetchMock = vi.hoisted(() => vi.fn());
const createServerFetchAtEndpointMock = vi.hoisted(() => vi.fn<(input: unknown) => typeof endpointFetchMock>(() => endpointFetchMock));
const serverFetchMock = vi.hoisted(() => vi.fn());
const requestedPublicKey = encodeBase64(new Uint8Array(32).fill(8));
const bindingProof = encodeBase64(new Uint8Array(32).fill(9), 'base64url');

vi.mock('@/sync/http/client', () => ({
    createServerFetchAtEndpoint: (input: unknown) => createServerFetchAtEndpointMock(input),
    serverFetch: (...args: unknown[]) => serverFetchMock(...args),
}));

function json(status: number, payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

async function target(endpointUrl: string, serverId?: string) {
    const homeServerIdentityId = endpointUrl.includes('home-b') ? 'srv_home_b' : 'srv_home_a';
    const descriptor = {
            v: 1 as const,
            homeServerIdentityId,
            canonicalServerUrl: endpointUrl.startsWith('http') ? endpointUrl : 'https://home.test',
            revision: 1,
            endpoints: [{ kind: 'https' as const, url: endpointUrl.startsWith('http') ? endpointUrl : 'https://home.test' }],
    };
    const resolved = await resolveHomeEnrollmentTransport(descriptor);
    if (!resolved.ok) throw new Error('Expected test Home transport');
    return { ...resolved.transport, endpointUrl, ...(serverId ? { serverId } : {}) };
}

describe('pairing auth client explicit target', () => {
    afterEach(() => {
        endpointFetchMock.mockReset();
        createServerFetchAtEndpointMock.mockClear();
        createServerFetchAtEndpointMock.mockImplementation(() => endpointFetchMock);
        serverFetchMock.mockReset();
    });

    it('sends the joining-device pairing request to the explicit target endpoint', async () => {
        endpointFetchMock.mockResolvedValueOnce(json(200, { state: 'requested' }));
        const controller = new AbortController();

        await expect(pairingRequest({
            pairId: 'pair-1',
            secret: 'rendezvous-secret',
            publicKey: 'public-key',
            deviceLabel: 'Phone',
            homeServerIdentityId: 'srv_home_b',
            expiresAtMs: 1234,
            bindingProof: 'proof',
        }, await target('https://home-b.test', 'profile-b'), { signal: controller.signal })).resolves.toEqual({
            ok: true,
            data: { state: 'requested' },
        });

        expect(createServerFetchAtEndpointMock).toHaveBeenCalledWith(expect.objectContaining({
            endpointUrl: 'https://home-b.test',
            serverId: 'profile-b',
            credentials: null,
        }));
        expect(endpointFetchMock.mock.calls[0]?.[0]).toBe('/v1/auth/pairing/request');
        const init = endpointFetchMock.mock.calls[0]?.[1] as RequestInit;
        expect(init.signal).toBe(controller.signal);
        expect(JSON.parse(String(init.body))).toEqual({
            pairId: 'pair-1',
            secret: 'rendezvous-secret',
            publicKey: 'public-key',
            deviceLabel: 'Phone',
            homeServerIdentityId: 'srv_home_b',
            expiresAtMs: 1234,
            bindingProof: 'proof',
        });
        expect(serverFetchMock).not.toHaveBeenCalled();
    });

    it('targets the trusted-device pairing start request and its Home-authenticated reads at the explicit endpoint', async () => {
        const controller = new AbortController();
        endpointFetchMock
            .mockResolvedValueOnce(json(200, { pairId: 'pair-9', expiresAt: '2026-01-01T00:00:00.000Z' }))
            .mockResolvedValueOnce(json(200, {
                state: 'requested',
                pairId: 'pair-9',
                expiresAt: '2026-01-01T00:00:00.000Z',
                requestedPublicKey,
                requestedDeviceLabel: 'Phone',
                homeServerIdentityId: 'srv_home_a',
                bindingProof,
            }))
            .mockResolvedValueOnce(json(200, { success: true }));

        await expect(pairingStart(
            { direction: 'trusted_home_displays', secretHash: 'hash' },
            await target('https://home-a.test', 'profile-a'),
            { signal: controller.signal },
        )).resolves.toEqual({ ok: true, data: { pairId: 'pair-9', expiresAt: '2026-01-01T00:00:00.000Z' } });
        await expect(pairingStatus({ pairId: 'pair-9' }, await target('https://home-a.test', 'profile-a'))).resolves.toEqual({
            ok: true,
            data: {
                state: 'requested',
                pairId: 'pair-9',
                expiresAt: '2026-01-01T00:00:00.000Z',
                requestedPublicKey,
                requestedDeviceLabel: 'Phone',
                homeServerIdentityId: 'srv_home_a',
                bindingProof,
            },
        });
        await expect(pairingConsume({ pairId: 'pair-9' }, await target('https://home-a.test', 'profile-a'))).resolves.toEqual({ ok: true });

        // Trusted-device routes authenticate with the target Home's own stored
        // credentials (never the focused active server's token).
        expect(createServerFetchAtEndpointMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            endpointUrl: 'https://home-a.test',
            serverId: 'profile-a',
        }));
        expect(JSON.parse(String((endpointFetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
            direction: 'trusted_home_displays',
            secretHash: 'hash',
        });
        expect((endpointFetchMock.mock.calls[0]?.[1] as RequestInit).signal).toBe(controller.signal);
        expect(createServerFetchAtEndpointMock).not.toHaveBeenCalledWith(expect.objectContaining({
            credentials: null,
        }));
        expect(serverFetchMock).not.toHaveBeenCalled();
    });

    it.each([
        ['wrong_home', { error: 'wrong_home' }],
        ['wrong_expiry', { error: 'wrong_expiry' }],
    ])('maps a pairing-request 403 %s body to the typed invalid_target result', async (_reason, body) => {
        endpointFetchMock.mockResolvedValueOnce(json(403, body));

        await expect(pairingRequest({
            pairId: 'pair-403',
            secret: 'rendezvous-secret',
            publicKey: 'public-key',
            homeServerIdentityId: 'srv_other_home',
            expiresAtMs: 1234,
            bindingProof: 'proof',
        }, await target('https://home-b.test', 'profile-b'))).resolves.toEqual({
            ok: false,
            reason: 'invalid_target',
            status: 403,
        });
    });

    it('keeps a 403 pairing-request rejection generic when the body names no target defect', async () => {
        endpointFetchMock.mockResolvedValueOnce(json(403, { error: 'rate_limited' }));

        await expect(pairingRequest({
            pairId: 'pair-403-generic',
            secret: 'rendezvous-secret',
            publicKey: 'public-key',
            homeServerIdentityId: 'srv_home_b',
            expiresAtMs: 1234,
            bindingProof: 'proof',
        }, await target('https://home-b.test', 'profile-b'))).resolves.toEqual({
            ok: false,
            reason: 'http_error',
            status: 403,
        });
    });

    it('distinguishes malformed status JSON from a transient Home HTTP failure', async () => {
        const malformed = new Response('not-json{', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
        endpointFetchMock
            .mockResolvedValueOnce(malformed)
            .mockResolvedValueOnce(json(200, { state: 'pending' }));

        await expect(pairingStart({ direction: 'trusted_home_displays', secretHash: 'hash' }, await target('https://home-a.test', 'profile-a'))).resolves.toEqual({
            ok: false,
            reason: 'http_error',
            status: 502,
        });
        await expect(pairingStatus({ pairId: 'pair-x' }, await target('https://home-a.test', 'profile-a'))).resolves.toEqual({
            ok: false,
            reason: 'invalid_response',
            status: 502,
        });
    });

    it('preserves the typed requester-owned pair id conflict', async () => {
        endpointFetchMock.mockResolvedValueOnce(json(409, { error: 'pair_id_conflict' }));
        await expect(pairingStart({
            direction: 'requester_displays',
            secretHash: 'hash',
            pairId: 'pair-conflict',
            expiresAtMs: 1234,
        }, await target('https://home-a.test', 'profile-a'))).resolves.toEqual({
            ok: false,
            reason: 'pair_id_conflict',
            status: 409,
        });
    });

    it('rejects unknown fields and malformed success bodies instead of widening the pairing wire', async () => {
        endpointFetchMock
            .mockResolvedValueOnce(json(200, {
                pairId: 'pair-extra',
                expiresAt: '2026-01-01T00:00:00.000Z',
                smuggled: true,
            }))
            .mockResolvedValueOnce(json(200, { state: 'requested', smuggled: true }))
            .mockResolvedValueOnce(json(200, {}));

        await expect(pairingStart({ direction: 'trusted_home_displays', secretHash: 'hash' }, await target('https://home-a.test', 'profile-a'))).resolves.toEqual({
            ok: false,
            reason: 'http_error',
            status: 502,
        });
        await expect(pairingRequest({
            pairId: 'pair-extra',
            secret: 'rendezvous-secret',
            publicKey: 'public-key',
            homeServerIdentityId: 'srv_home_b',
            expiresAtMs: 1234,
            bindingProof: 'proof',
        }, await target('https://home-b.test', 'profile-b'))).resolves.toEqual({
            ok: false,
            reason: 'http_error',
            status: 502,
        });
        await expect(pairingConsume({ pairId: 'pair-extra' }, await target('https://home-a.test', 'profile-a'))).resolves.toEqual({
            ok: false,
            reason: 'http_error',
            status: 502,
        });
    });

    it('maps an explicit reject that lost to approval to the typed already_decided result', async () => {
        endpointFetchMock.mockResolvedValueOnce(json(409, { error: 'already_decided' }));

        await expect(pairingConsume({ pairId: 'pair-decided', intent: 'reject' }, await target('https://home-a.test', 'profile-a'))).resolves.toEqual({
            ok: false,
            reason: 'already_decided',
            status: 409,
        });
        expect(JSON.parse(String((endpointFetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
            pairId: 'pair-decided',
            intent: 'reject',
        });
    });

    it('fails a malformed explicit target without consulting the focused Home', async () => {
        await expect(pairingRequest({
            pairId: 'pair-3',
            secret: 's',
            publicKey: 'pk',
            homeServerIdentityId: 'srv_home_a',
            expiresAtMs: 1234,
            bindingProof: 'proof',
        }, await target('not-a-home-endpoint'))).resolves.toEqual({
            ok: false,
            reason: 'invalid_target',
            status: 0,
        });

        expect(serverFetchMock).not.toHaveBeenCalled();
        expect(createServerFetchAtEndpointMock).not.toHaveBeenCalled();
    });
});
