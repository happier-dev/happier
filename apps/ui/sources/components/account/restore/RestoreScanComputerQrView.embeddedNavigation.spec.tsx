import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { initializeTerminalRouteRuntimeForTests } from '@/__tests__/routes/(app)/terminal/terminalRouteTestHelpers';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';

import {
    installRestoreScanComputerQrViewCommonModuleMocks,
    restoreScanComputerQrViewModuleState,
} from './restoreScanComputerQrViewTestHelpers';

installRestoreScanComputerQrViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            ScrollView: 'ScrollView',
            ActivityIndicator: 'ActivityIndicator',
            Platform: {
                OS: 'ios',
                select: (options: Record<string, unknown>) => options.ios ?? options.default,
            },
        });
    },
});

vi.mock('expo-constants', () => ({
    default: { deviceName: 'Test iPhone' },
}));

// The native SDK owns camera permission/hardware; scanner and footer decisions stay real.
vi.mock('expo-camera', () => ({ CameraView: 'CameraView', useCameraPermissions: () => [
    { granted: false, canAskAgain: false }, async () => ({ granted: false, canAskAgain: false }),
] }));
vi.mock('expo-device', () => ({ isDevice: false }));
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

await initializeTerminalRouteRuntimeForTests();
afterEach(async () => { await standardCleanup(); resetServerFeaturesClientForTests(); });

describe('RestoreScanComputerQrView (embedded navigation)', () => {
    it('uses the embedded callback for “Show QR instead” rather than pushing the /restore/show-qr route', async () => {
        const features = createRootLayoutFeaturesResponse();
        if (!tryWriteServerEnabledBitInPlace(features, 'auth.pairing.boundQrV2', true)) throw new Error('Expected canonical pairing feature');
        setRuntimeFetch(async (input) => new URL(String(input)).pathname === '/v1/features'
            ? Response.json(features) : new Response('{}', { status: 404 }));
        const home = await upsertAndActivateServer({ serverUrl: 'https://embedded-restore.example.test', source: 'manual', scope: 'device' });
        expect((await getServerFeaturesSnapshot({ serverId: home.id, force: true })).status).toBe('ready');
        restoreScanComputerQrViewModuleState.routerPushSpy.mockClear();
        const onShowQrInstead = vi.fn();
        const { RestoreScanComputerQrView } = await import('./RestoreScanComputerQrView');
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
            <RestoreScanComputerQrView entryIntent="add_home" embedded onShowQrInstead={onShowQrInstead} />
        </InjectedAuthProvider>);
        await screen.pressByTestIdAsync('restore-show-qr-instead');
        expect(onShowQrInstead).toHaveBeenCalledOnce();
        expect(restoreScanComputerQrViewModuleState.routerPushSpy).not.toHaveBeenCalled();
    });
});
