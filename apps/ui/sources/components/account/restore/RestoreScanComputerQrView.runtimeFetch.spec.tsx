import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
import { tryWriteServerEnabledBitInPlace} from '@happier-dev/protocol/features/serverEnabledBit';
import { type HomeQrInviteV2 } from '@happier-dev/protocol/crypto/qrProvisioningV2';

import { buildHomeQrInviteDeepLink } from '@/auth/pairing/pairingUrl';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { initializeAuthRouteRuntimeForTests } from '@/dev/testkit/harness/authRouteRuntimeHarness';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { installRestoreScanComputerQrViewCommonModuleMocks } from './restoreScanComputerQrViewTestHelpers';

const modalAlertAsyncSpy = vi.hoisted(() => vi.fn(async () => {}));
installRestoreScanComputerQrViewCommonModuleMocks({
    reactNative: async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
        Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
    }),
    modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
        spies: { alertAsync: modalAlertAsyncSpy },
    }).module,
});
// Only camera permission/preview and device identification cross native SDKs.
vi.mock('expo-camera', () => ({ CameraView: 'CameraView', useCameraPermissions: () => [
    { granted: false, canAskAgain: false }, async () => ({ granted: false, canAskAgain: false }),
] }));
vi.mock('expo-device', () => ({ isDevice: false }));
vi.mock('expo-constants', () => ({ default: { deviceName: 'Test iPhone' } }));
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

// The helper registers its boundary mocks at call time, so load the owner graph after it.
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { RestoreScanComputerQrView } = await import('./RestoreScanComputerQrView');

await initializeAuthRouteRuntimeForTests();
afterEach(async () => { await standardCleanup(); resetServerFeaturesClientForTests(); });

function createBoundQrV2Features(overrides?: Parameters<typeof createRootLayoutFeaturesResponse>[0]) {
    const features = createRootLayoutFeaturesResponse(overrides);
    if (!tryWriteServerEnabledBitInPlace(features, 'auth.pairing.boundQrV2', true)) throw new Error('Expected canonical pairing feature');
    return features;
}

describe('RestoreScanComputerQrView (real runtime fetch boundary)', () => {
    it('renders precise retry guidance when the pairing session already has a requested device', async () => {
        const targetUrl = 'https://stack.example.test';
        const invite = {
            v: 2, intent: 'home_device', direction: 'trusted_home_displays', pairId: 'pair_123',
            home: { v: 1, homeServerIdentityId: 'srv_test', canonicalServerUrl: targetUrl, revision: 1,
                endpoints: [{ kind: 'https', url: targetUrl }] },
            qrSecretBase64Url: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
            issuedAtMs: Date.now() - 1_000, expiresAtMs: Date.now() + 60_000,
        } satisfies HomeQrInviteV2;
        const pairingRequests: Array<{ origin: string; init?: RequestInit }> = [];
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/features') {
                const isTarget = url.origin === targetUrl;
                return Response.json(createBoundQrV2Features({
                    capabilities: { serverIdentity: { serverIdentityId: isTarget ? 'srv_test' : 'srv_retained' },
                        server: { canonicalServerUrl: url.origin } },
                    ...(isTarget ? { homeConnectionDescriptor: invite.home } : {}),
                }));
            }
            if (url.origin === targetUrl && url.pathname === '/v2/auth/account/request') return Response.json({});
            if (url.origin === targetUrl && url.pathname === '/v1/auth/pairing/request') {
                pairingRequests.push({ origin: url.origin, init });
                return Response.json({ error: 'already_requested' }, { status: 409 });
            }
            return new Response('{}', { status: 404 });
        });
        const home = await upsertAndActivateServer({ serverUrl: 'https://retained-restore.example.test', source: 'manual', scope: 'device' });
        expect((await getServerFeaturesSnapshot({ serverId: home.id, force: true })).status).toBe('ready');
        const focusBefore = getActiveServerSnapshot();
        modalAlertAsyncSpy.mockClear();
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
            <RestoreScanComputerQrView entryIntent="add_home" initialPairingLink={buildHomeQrInviteDeepLink({ invite })} />
        </InjectedAuthProvider>);

        await vi.waitFor(() => expect(screen.findByTestId('restore-enrollment-retry')).not.toBeNull());
        expect(screen.getTextContent()).toContain('connect.pairingAlreadyRequestedBody');
        expect(modalAlertAsyncSpy).not.toHaveBeenCalled();
        expect(pairingRequests).toHaveLength(1);
        expect(pairingRequests[0]?.origin).toBe(targetUrl);
        expect(new Headers(pairingRequests[0]?.init?.headers).has('Authorization')).toBe(false);
        expect(JSON.parse(String(pairingRequests[0]?.init?.body))).toMatchObject({
            pairId: invite.pairId, homeServerIdentityId: invite.home.homeServerIdentityId,
            expiresAtMs: invite.expiresAtMs, publicKey: expect.any(String), bindingProof: expect.any(String),
        });
        expect(getActiveServerSnapshot()).toEqual(focusBefore);
        expect(listServerProfiles().some(profile => profile.serverUrl === targetUrl)).toBe(false);
    });

    it('routes the embedded “Show QR instead” footer action to the owner callback', async () => {
        const features = createBoundQrV2Features();
        setRuntimeFetch(async (input) => new URL(String(input)).pathname === '/v1/features'
            ? Response.json(features) : new Response('{}', { status: 404 }));
        const home = await upsertAndActivateServer({ serverUrl: 'https://embedded-restore.example.test', source: 'manual', scope: 'device' });
        expect((await getServerFeaturesSnapshot({ serverId: home.id, force: true })).status).toBe('ready');
        const onShowQrInstead = vi.fn();
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
            <RestoreScanComputerQrView entryIntent="add_home" embedded onShowQrInstead={onShowQrInstead} />
        </InjectedAuthProvider>);
        await screen.pressByTestIdAsync('restore-show-qr-instead');
        expect(onShowQrInstead).toHaveBeenCalledOnce();
    });

    it('recognizes the retired V1 link only to show safe Home-QR recovery guidance', async () => {
        const features = createBoundQrV2Features();
        const requests: string[] = [];
        setRuntimeFetch(async (input) => {
            const url = new URL(String(input));
            requests.push(url.href);
            return url.pathname === '/v1/features' ? Response.json(features) : new Response('{}', { status: 404 });
        });
        const home = await upsertAndActivateServer({ serverUrl: 'https://retained-legacy-restore.example.test', source: 'manual', scope: 'device' });
        expect((await getServerFeaturesSnapshot({ serverId: home.id, force: true })).status).toBe('ready');
        const focusBefore = getActiveServerSnapshot();
        const profilesBefore = listServerProfiles();
        requests.length = 0;
        modalAlertAsyncSpy.mockClear();
        await renderScreen(<InjectedAuthProvider credentials={null}>
            <RestoreScanComputerQrView entryIntent="add_home"
                initialPairingLink="happier:///pair?v=1&pairId=p&secret=s&server=http%3A%2F%2Flocalhost%3A53288" />
        </InjectedAuthProvider>);

        await vi.waitFor(() => expect(modalAlertAsyncSpy).toHaveBeenCalledWith(
            'connect.updateRequiredTitle',
            'connect.legacyPairingUpdateRequiredBody',
            [
                expect.objectContaining({ text: 'connect.scanNewQr' }),
                expect.objectContaining({ text: 'common.cancel', style: 'cancel' }),
            ],
        ));
        expect(getActiveServerSnapshot()).toEqual(focusBefore);
        expect(listServerProfiles()).toEqual(profilesBefore);
        expect(requests.some(url => new URL(url).origin === 'http://localhost:53288')).toBe(false);
        expect(requests.some(url => /\/auth\//.test(new URL(url).pathname))).toBe(false);
    });
});
