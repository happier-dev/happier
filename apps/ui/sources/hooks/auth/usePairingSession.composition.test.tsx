import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    computeHomeQrBindingProofV2,
    deriveHomeQrBindingKeyV2,
    deriveHomeQrRendezvousSecretV2,
} from '@happier-dev/protocol';

import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { renderHook } from '@/dev/testkit';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';

installTokenStorageWebPlatformMocks();

const boundary = vi.hoisted(() => ({
    createRequest: vi.fn(),
    fetch: vi.fn(),
    featureSnapshot: vi.fn(),
}));

vi.mock('@/sync/http/client', () => ({
    createServerFetchAtEndpoint: (input: unknown) => {
        boundary.createRequest(input);
        return boundary.fetch;
    },
    serverFetch: vi.fn(() => {
        throw new Error('Focused request wrapper must not own explicit QR calls');
    }),
}));

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getServerFeaturesSnapshot: (...args: unknown[]) => boundary.featureSnapshot(...args),
    observeAuthenticatedServerFeaturesFresh: (...args: unknown[]) => boundary.featureSnapshot(...args),
}));

vi.mock('@/utils/runtime/isRuntimeActive', () => ({ isRuntimeActive: () => true }));

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('trusted-Home-displayed QR two-client composition', () => {
    const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
    let restoreLocalStorage: (() => void) | null = null;

    afterEach(() => {
        restoreLocalStorage?.();
        restoreLocalStorage = null;
        if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.resetModules();
        boundary.createRequest.mockReset();
        boundary.fetch.mockReset();
        boundary.featureSnapshot.mockReset();
    });

    it('composes trusted display, credentialless requester, authenticated completion, and requester credential open', async () => {
        vi.useFakeTimers({ now: new Date('2026-09-06T13:00:00.000Z') });
        vi.spyOn(Math, 'random').mockReturnValue(0);
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `forward_qr_composition_${Date.now()}`;
        restoreLocalStorage = installLocalStorageMock().restore;

        const profiles = await import('@/sync/domains/server/serverProfiles');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { resolveHomeEnrollmentTransport } = await import('@/auth/enrollment/homeEnrollmentTransport');
        const { authQRStart, generateAuthKeyPair } = await import('@/auth/flows/qrStart');
        const { authQRWait } = await import('@/auth/flows/qrWait');
        const { pairingRequest } = await import('@/sync/api/account/apiPairingAuth');
        const { parseHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
        const { usePairingSession } = await import('./usePairingSession');
        const { setHomeSetupStepHidden } = await import('@/components/hub/layout/homeHubLayout');

        const descriptor = {
            v: 1 as const,
            homeServerIdentityId: 'srv_forward_home',
            canonicalServerUrl: 'https://forward-home.test',
            revision: 2,
            endpoints: [{ kind: 'https' as const, url: 'https://forward-home.test' }],
        };
        const trustedProfile = await profiles.adoptHomeProfile({
            descriptor,
            source: 'qr',
            descriptorAuthority: 'current_connection_observation',
        });
        await profiles.setActiveServerId(trustedProfile.id);
        await TokenStorage.setCredentialsForServerUrl(descriptor.canonicalServerUrl, {
            serverId: descriptor.homeServerIdentityId,
        }, { token: 'trusted-home-token' });

        boundary.featureSnapshot.mockResolvedValue({
            status: 'ready',
            serverIdentityId: descriptor.homeServerIdentityId,
            features: {
                features: {
                    auth: { pairing: { boundQrV2: { enabled: true } } },
                },
                homeConnectionDescriptor: descriptor,
            },
        });

        // A `let` assigned only inside a callback narrows to `never` at the outer read, so the
        // pair row lives in a holder the way the other composition suites keep callback state.
        const pairRow: { current: {
            pairId: string;
            expiresAtMs: number;
            request: Record<string, unknown> | null;
            authorized: Record<string, unknown> | null;
        } | null } = { current: null };
        boundary.fetch.mockImplementation(async (path: string, init?: RequestInit, options?: { includeAuth?: boolean }) => {
            const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
            if (path === '/v1/auth/pairing/start') {
                expect(options?.includeAuth).toBe(true);
                expect(body.direction).toBe('trusted_home_displays');
                pairRow.current = {
                    pairId: 'forward-pair',
                    expiresAtMs: Date.now() + 60_000,
                    request: null,
                    authorized: null,
                };
                return json(200, {
                    pairId: pairRow.current.pairId,
                    expiresAt: new Date(pairRow.current.expiresAtMs).toISOString(),
                });
            }
            if (path.startsWith('/v1/auth/pairing/status?')) {
                expect(options?.includeAuth).toBe(true);
                if (!pairRow.current) return json(404, { error: 'not_found' });
                if (!pairRow.current.request) {
                    return json(200, {
                        state: 'pending',
                        pairId: pairRow.current.pairId,
                        expiresAt: new Date(pairRow.current.expiresAtMs).toISOString(),
                    });
                }
                return json(200, {
                    state: 'requested',
                    pairId: pairRow.current.pairId,
                    expiresAt: new Date(pairRow.current.expiresAtMs).toISOString(),
                    requestedPublicKey: pairRow.current.request.publicKey,
                    requestedDeviceLabel: null,
                    bindingProof: pairRow.current.request.bindingProof,
                    homeServerIdentityId: pairRow.current.request.homeServerIdentityId,
                });
            }
            if (path === '/v2/auth/account/request' && !('pairId' in body)) {
                expect(options?.includeAuth).toBe(false);
                return json(200, { state: 'requested' });
            }
            if (path === '/v1/auth/pairing/request') {
                expect(options?.includeAuth).toBe(false);
                if (!pairRow.current) return json(404, { error: 'not_found' });
                pairRow.current.request = body;
                return json(200, { state: 'requested' });
            }
            if (path === '/v1/auth/account/response') {
                expect(options?.includeAuth).toBe(true);
                if (!pairRow.current?.request || body.pairId !== pairRow.current.pairId) return json(404, { error: 'not_found' });
                pairRow.current.authorized = {
                    state: 'authorized',
                    tokenEncrypted: body.publicKey === pairRow.current.request.publicKey
                        ? await (async () => {
                            const { encryptBox } = await import('@/encryption/libsodium');
                            return encodeBase64(encryptBox(
                                new TextEncoder().encode('requester-home-token'),
                                decodeBase64(String(pairRow.current!.request!.publicKey)),
                            ));
                        })()
                        : '',
                    response: body.response,
                };
                return json(200, { success: true });
            }
            if (path === '/v2/auth/account/request' && 'pairId' in body) {
                if (!pairRow.current) return json(404, { error: 'not_found' });
                return json(200, pairRow.current.authorized ?? { state: 'requested' });
            }
            if (path === '/v1/auth/pairing/consume') return json(200, { success: true });
            throw new Error(`Unexpected QR boundary request: ${path}`);
        });

        let setupLayout: Parameters<typeof setHomeSetupStepHidden>[0] = { v: 1, order: ['setup'], hidden: [], instances: [] };
        const trusted = await renderHook(() => usePairingSession({
            enabled: true, isAuthenticated: true,
            onCompleted: () => {
                const next = setHomeSetupStepHidden(setupLayout, 'addPhone', true);
                setupLayout = next;
            },
        }));
        await act(async () => {
            await trusted.getCurrent().startPairing();
        });
        await vi.waitFor(() => expect(trusted.getCurrent().presentation.phase).toBe('ready'));
        const trustedReady = trusted.getCurrent().presentation;
        if (trustedReady.phase !== 'ready') throw new Error('Expected trusted QR invite');
        const parsed = parseHomeQrInviteDeepLink(trustedReady.deepLink, {
            homeServerIdentityId: descriptor.homeServerIdentityId,
            direction: 'trusted_home_displays',
        });
        if (!parsed) throw new Error('Expected strict current QR invite');
        expect(setupLayout.hidden).toEqual([]);

        const requesterTransport = await resolveHomeEnrollmentTransport(descriptor);
        if (!requesterTransport.ok) throw new Error('Expected HTTPS enrollment transport');
        const requesterKeypair = generateAuthKeyPair();
        const qrSecret = decodeBase64(parsed.invite.qrSecretBase64Url, 'base64url');
        const bindingProof = computeHomeQrBindingProofV2({
            direction: parsed.invite.direction,
            qrSecret,
            pairId: parsed.invite.pairId,
            homeServerIdentityId: descriptor.homeServerIdentityId,
            requesterPublicKey: requesterKeypair.publicKey,
            expiresAtMs: parsed.invite.expiresAtMs,
        });
        await expect(authQRStart(requesterKeypair, requesterTransport.transport)).resolves.toEqual({ ok: true });
        await expect(pairingRequest({
            pairId: parsed.invite.pairId,
            secret: encodeBase64(deriveHomeQrRendezvousSecretV2(qrSecret), 'base64url'),
            publicKey: encodeBase64(requesterKeypair.publicKey),
            homeServerIdentityId: descriptor.homeServerIdentityId,
            expiresAtMs: parsed.invite.expiresAtMs,
            bindingProof,
        }, requesterTransport.transport)).resolves.toMatchObject({ ok: true });

        const wait = authQRWait(requesterKeypair, requesterTransport.transport, {
            v2Context: {
                direction: parsed.invite.direction,
                pairId: parsed.invite.pairId,
                homeServerIdentityId: descriptor.homeServerIdentityId,
                bindingSecret: deriveHomeQrBindingKeyV2(qrSecret),
                bindingProof,
                issuedAtMs: parsed.invite.issuedAtMs,
                expiresAtMs: parsed.invite.expiresAtMs,
            },
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1_000);
        });
        await expect(wait).resolves.toEqual({
            ok: true,
            credentials: { token: 'requester-home-token' },
            homeServerIdentityId: descriptor.homeServerIdentityId,
        });
        await vi.waitFor(() => expect(trusted.getCurrent().presentation.phase).toBe('succeeded'));
        expect(setupLayout.hidden).toEqual(['setup:addPhone']);

        expect(boundary.createRequest).toHaveBeenCalledWith(expect.objectContaining({
            endpointUrl: descriptor.canonicalServerUrl,
            runtimeOrigin: descriptor.canonicalServerUrl,
            serverId: descriptor.homeServerIdentityId,
            credentials: { token: 'trusted-home-token' },
        }));
        expect(profiles.getActiveServerId()).toBe(descriptor.homeServerIdentityId);
        expect(profiles.getActiveServerUrl()).toBe(descriptor.canonicalServerUrl);
        await expect(TokenStorage.getCredentialsForServerUrl(descriptor.canonicalServerUrl, {
            serverId: descriptor.homeServerIdentityId,
        })).resolves.toEqual({ token: 'trusted-home-token' });
        expect(pairRow.current?.authorized).toMatchObject({ state: 'authorized' });

        await trusted.unmount();
        await requesterTransport.transport.close();
    });
});
