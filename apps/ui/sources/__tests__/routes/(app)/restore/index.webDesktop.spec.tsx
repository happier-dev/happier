import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { initializeTerminalRouteRuntimeForTests } from '../terminal/terminalRouteTestHelpers';
import { createDirectoryHttpFixture } from '@/sync/ops/accountDirectory/accountDirectoryTestFixtures';
import { adoptHomeProfile, resetServerProfilesRuntimeForTests } from '@/sync/domains/server/serverProfiles';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { installRestoreRouteCommonModuleMocks } from './restoreRouteTestHelpers';

installTokenStorageWebPlatformMocks();
installRestoreRouteCommonModuleMocks({
    reactNative: async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
        useWindowDimensions: () => ({ width: 1400, height: 900, scale: 2, fontScale: 1 }),
    }),
});
// Camera permission is a native SDK boundary. The desktop branch must not mount it.
vi.mock('expo-camera', () => ({
    CameraView: 'CameraView',
    useCameraPermissions: () => [{ granted: false, canAskAgain: false }, vi.fn()],
}));
await initializeTerminalRouteRuntimeForTests();
const Screen = (await import('@/app/(app)/restore/index')).default;
const { RestoreQrView } = await import('@/components/account/restore/RestoreQrView');
const { RestoreScanComputerQrView } = await import('@/components/account/restore/RestoreScanComputerQrView');

let localStorage: ReturnType<typeof installLocalStorageMock> | undefined;
afterEach(async () => {
    await standardCleanup();
    resetServerProfilesRuntimeForTests();
    localStorage?.restore();
    vi.unstubAllGlobals();
});

describe('/restore (web desktop)', () => {
    it('keeps the QR-first restore flow for its one established Home even when desktop camera APIs are available', async () => {
        localStorage = installLocalStorageMock();
        resetServerProfilesRuntimeForTests();
        // Camera/browser capabilities are environment facts, not a mocked scanner decision.
        vi.stubGlobal('navigator', {
            ...globalThis.navigator,
            locks: globalThis.navigator.locks,
            maxTouchPoints: 0,
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.0.0 Safari/537.36',
            mediaDevices: { getUserMedia: vi.fn(async () => ({})) },
        });
        const fixture = createDirectoryHttpFixture();
        const home = await adoptHomeProfile({
            descriptor: fixture.home.connectionDescriptor,
            source: 'account-directory', descriptorAuthority: 'current_connection_observation',
        });
        // This case proves presentation selection, not a completed pairing. An
        // unavailable enrollment HTTP boundary still leaves the selected QR surface mounted.
        setRuntimeFetch(async () => new Response('{}', { status: 404 }));
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><Screen /></InjectedAuthProvider>);
        expect(screen.findAllByType(RestoreQrView)).toHaveLength(1);
        expect(screen.findByType(RestoreQrView).props.targetProfileId).toBe(home.id);
        expect(screen.findAllByType(RestoreScanComputerQrView)).toHaveLength(0);
    });
});
