import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    computeHomeQrBindingProofV2,
    deriveHomeQrBindingKeyV2,
    deriveHomeQrRendezvousSecretV2} from '@happier-dev/protocol/crypto/qrProvisioningV2';
import {
    tryWriteServerEnabledBitInPlace,
} from '@happier-dev/protocol/features/serverEnabledBit';

import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { renderHook } from '@/dev/testkit';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createAccountTokenForTests, createHomeGovernanceHarness } from '@/dev/testkit/harness/homeGovernanceHarness';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';

installTokenStorageWebPlatformMocks();

const boundary = vi.hoisted(() => ({
    fetch: vi.fn(),
}));
await initializeRealAppRuntimeForTests();

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('trusted-Home-displayed QR two-client composition', () => {
    const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
    let restoreLocalStorage: (() => void) | null = null;
    const homes = createHomeGovernanceHarness();
    let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;

    afterEach(async () => {
        vi.useRealTimers();
        await connection?.dispose();
        connection = null;
        await homes.reset();
        restoreLocalStorage?.();
        restoreLocalStorage = null;
        if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        vi.restoreAllMocks();
        boundary.fetch.mockReset();
    });

    it('composes trusted display, credentialless requester, authenticated completion, and requester credential open', async () => {
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
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');

        const descriptor = {
            v: 1 as const,
            homeServerIdentityId: 'srv_forward_home',
            canonicalServerUrl: 'https://forward-home.test',
            revision: 2,
            endpoints: [{ kind: 'https' as const, url: 'https://forward-home.test' }],
        };
        const trustedToken = createAccountTokenForTests('trusted-account', { currentAccount: true });
        const trustedHomeId = await homes.addHome({ name: 'Trusted Home', serverUrl: descriptor.canonicalServerUrl,
            serverIdentityId: descriptor.homeServerIdentityId, accountId: 'trusted-account',
            credentials: { token: trustedToken }, currentAccount: true, active: false });
        await profiles.adoptHomeProfile({
            descriptor,
            source: 'qr',
            descriptorAuthority: 'current_connection_observation',
        });
        const features = { ...createRootLayoutFeaturesResponse(), homeConnectionDescriptor: descriptor };
        features.capabilities.serverIdentity.serverIdentityId = descriptor.homeServerIdentityId;
        features.capabilities.server.canonicalServerUrl = descriptor.canonicalServerUrl;
        tryWriteServerEnabledBitInPlace(features, 'auth.pairing.boundQrV2', true);
        const requests: Array<Readonly<{ origin: string; path: string; token: string | null }>> = [];
        const request: Parameters<typeof setRuntimeFetch>[0] = async (input, init) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            const authorization = new Headers(init?.headers).get('Authorization');
            const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
            const path = `${url.pathname}${url.search}`;
            requests.push({ origin: url.origin, path, token });
            if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') return json(200, {});
            if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') return json(200, features);
            if (url.pathname === '/v1/account/encryption/currentness') return json(200, createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname.startsWith('/v1/auth/') || url.pathname === '/v2/auth/account/request') {
                return boundary.fetch(path, init, { includeAuth: token !== null });
            }
            return createEmptyAccountBootstrapHttpResponse(path, init) ?? homes.request(input, init);
        };
        setRuntimeFetch(request);
        connection = await restoreServerAccountForTest({ serverUrl: descriptor.canonicalServerUrl,
            serverIdentityId: descriptor.homeServerIdentityId, accountId: 'trusted-account',
            credentials: { token: trustedToken }, request });
        await homes.setActionPolicy(trustedHomeId, 'machines.pairing.create', 'ui', 'allowed');
        // Restore the real runtime and persist the Home before freezing its polling clock.
        vi.useFakeTimers({ now: new Date('2026-09-06T13:00:00.000Z') });

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

        let setupLayout: Parameters<typeof setHomeSetupStepHidden>[0] = { v: 1, order: ['setup'], hidden: [], items: [] };
        const trusted = await renderHook(() => usePairingSession({
            enabled: true, isAuthenticated: true,
            onCompleted: () => {
                const next = setHomeSetupStepHidden(setupLayout, 'addPhone', true);
                setupLayout = next;
            },
        }));
        let started: unknown;
        await act(async () => {
            started = await trusted.getCurrent().startPairing();
        });
        expect(started, JSON.stringify({ paths: requests.map(request => request.path.split('?')[0]) })).toEqual({ ok: true });
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

        expect(requests.find(request => request.path === '/v1/auth/pairing/start')).toEqual({
            origin: descriptor.canonicalServerUrl,
            path: '/v1/auth/pairing/start',
            token: trustedToken,
        });
        expect(profiles.getActiveServerId()).toBe(descriptor.homeServerIdentityId);
        expect(profiles.getActiveServerUrl()).toBe(descriptor.canonicalServerUrl);
        await expect(TokenStorage.getCredentialsForServerUrl(descriptor.canonicalServerUrl, {
            serverId: descriptor.homeServerIdentityId,
        })).resolves.toEqual({ token: trustedToken });
        expect(pairRow.current?.authorized).toMatchObject({ state: 'authorized' });

        await trusted.unmount();
        await requesterTransport.transport.close();
    });
});
