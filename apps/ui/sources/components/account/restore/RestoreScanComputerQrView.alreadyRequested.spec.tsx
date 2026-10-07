import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tryWriteServerEnabledBitInPlace, type HomeQrInviteV2 } from '@happier-dev/protocol';

import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { buildHomeQrInviteDeepLink } from '@/auth/pairing/pairingUrl';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { initializeTerminalRouteRuntimeForTests } from '@/__tests__/routes/(app)/terminal/terminalRouteTestHelpers';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { installRestoreScanComputerQrViewCommonModuleMocks } from './restoreScanComputerQrViewTestHelpers';
import { RestoreScanComputerQrView } from './RestoreScanComputerQrView';

const modalAlertAsyncSpy = vi.hoisted(() => vi.fn(async () => {}));
installRestoreScanComputerQrViewCommonModuleMocks({
    modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
        spies: { alertAsync: modalAlertAsyncSpy },
    }).module,
});
// Only camera permission/preview and device identification cross native SDKs.
vi.mock('expo-camera', () => ({ CameraView: 'CameraView', useCameraPermissions: () => [
    { granted: false, canAskAgain: false }, async () => ({ granted: false, canAskAgain: false }),
] }));
vi.mock('expo-device', () => ({ isDevice: false }));
vi.mock('expo-constants', () => ({ default: { deviceName: undefined } }));
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

await initializeTerminalRouteRuntimeForTests();
afterEach(async () => { await standardCleanup(); resetServerFeaturesClientForTests(); });

describe('RestoreScanComputerQrView (already requested)', () => {
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
                const features = createRootLayoutFeaturesResponse({
                    capabilities: { serverIdentity: { serverIdentityId: isTarget ? 'srv_test' : 'srv_retained' },
                        server: { canonicalServerUrl: url.origin } },
                    ...(isTarget ? { homeConnectionDescriptor: invite.home } : {}),
                });
                if (!tryWriteServerEnabledBitInPlace(features, 'auth.pairing.boundQrV2', true)) throw new Error('Expected canonical pairing feature');
                return Response.json(features);
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
});
