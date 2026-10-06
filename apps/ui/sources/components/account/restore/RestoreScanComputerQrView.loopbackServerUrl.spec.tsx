import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol';

import { InjectedAuthProvider } from '@/auth/context/AuthContext';
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

await initializeTerminalRouteRuntimeForTests();
afterEach(async () => { await standardCleanup(); resetServerFeaturesClientForTests(); });

describe('RestoreScanComputerQrView (loopback serverUrl)', () => {
    it('recognizes the retired V1 link only to show safe Home-QR recovery guidance', async () => {
        const features = createRootLayoutFeaturesResponse();
        if (!tryWriteServerEnabledBitInPlace(features, 'auth.pairing.boundQrV2', true)) throw new Error('Expected canonical pairing feature');
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
