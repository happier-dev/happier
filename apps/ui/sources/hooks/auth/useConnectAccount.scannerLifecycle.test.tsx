import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installAuthHookCommonModuleMocks } from './authHookTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { modalAlertSpy, routerPushSpy, screenState } = vi.hoisted(() => ({
    modalAlertSpy: vi.fn(),
    routerPushSpy: vi.fn(),
    screenState: {
        platformOS: 'ios' as 'ios' | 'web',
        windowDimensions: { width: 390, height: 844 },
    },
}));

installAuthHookCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: modalAlertSpy,
                alertAsync: modalAlertSpy,
            },
        }).module;
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return screenState.platformOS;
                },
                select: (options: any) => options?.[screenState.platformOS] ?? options?.default ?? options?.ios ?? options?.android,
            },
            Dimensions: {
                get: () => ({ width: screenState.windowDimensions.width, height: screenState.windowDimensions.height, scale: 2, fontScale: 1 }),
            },
            useWindowDimensions: () => ({ width: screenState.windowDimensions.width, height: screenState.windowDimensions.height, scale: 2, fontScale: 1 }),
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { push: routerPushSpy },
        }).module;
    },
});

vi.mock('expo-camera', () => ({
  CameraView: {},
  useCameraPermissions: () => [{ granted: true }, vi.fn(async () => ({ granted: true }))],
}));

vi.mock('@/utils/platform/platform', () => ({
  isRunningOnMac: () => false,
}));

vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({
    credentials: { token: 't', secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', encryption: { type: 'legacy' } },
  }),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
  isLegacyAuthCredentials: () => true,
}));

vi.mock('@/encryption/base64', () => ({
  decodeBase64: vi.fn(() => new Uint8Array([1, 2, 3])),
}));

vi.mock('@/encryption/libsodium', () => ({
  encryptBox: vi.fn(() => new Uint8Array([9, 9, 9])),
}));

vi.mock('@/auth/flows/buildAccountLinkResponse', () => ({
  buildAccountLinkResponse: vi.fn(() => ({ t: 'stub' })),
}));

vi.mock('@/auth/flows/accountApprove', () => ({
  authAccountApprove: vi.fn(async () => {}),
}));

describe('useConnectAccount (scanner lifecycle)', () => {
  beforeEach(() => {
    vi.resetModules();
    screenState.platformOS = 'ios';
    screenState.windowDimensions = { width: 390, height: 844 };
    routerPushSpy.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('navigates to the in-app QR scanner when starting account link', async () => {
    const { useConnectAccount } = await import('./useConnectAccount');

    let hookApi: ReturnType<typeof useConnectAccount> | null = null;
    function Probe() {
      hookApi = useConnectAccount();
      return null;
    }

    await renderScreen(<Probe />);

    await act(async () => {
      await hookApi!.connectAccount();
    });

    expect(routerPushSpy).toHaveBeenCalledWith('/scan/account');
  });

  it('navigates to the in-app QR scanner on phone-sized web', async () => {
    screenState.platformOS = 'web';
    screenState.windowDimensions = { width: 360, height: 800 };
    vi.stubGlobal('navigator', { maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)' } as any);

    const { useConnectAccount } = await import('./useConnectAccount');

    let hookApi: ReturnType<typeof useConnectAccount> | null = null;
    function Probe() {
      hookApi = useConnectAccount();
      return null;
    }

    await renderScreen(<Probe />);

    await act(async () => {
      await hookApi!.connectAccount();
    });

    expect(routerPushSpy).toHaveBeenCalledWith('/scan/account');
  });

  it('does not open the scanner on desktop web even when the viewport is narrow', async () => {
    screenState.platformOS = 'web';
    screenState.windowDimensions = { width: 480, height: 700 };
    vi.stubGlobal('navigator', { maxTouchPoints: 0, userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' } as any);
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) } as any);

    const { useConnectAccount } = await import('./useConnectAccount');

    let hookApi: ReturnType<typeof useConnectAccount> | null = null;
    function Probe() {
      hookApi = useConnectAccount();
      return null;
    }

    await renderScreen(<Probe />);

    modalAlertSpy.mockClear();

    await act(async () => {
      await hookApi!.connectAccount();
    });

    expect(routerPushSpy).not.toHaveBeenCalled();
    expect(modalAlertSpy).toHaveBeenCalled();
  });

  it('accepts account URLs that match the configured app scheme', async () => {
    vi.doMock('expo-constants', () => ({
      default: {
        expoConfig: {
          scheme: 'happier-dev',
        },
      },
    }));

    const { useConnectAccount } = await import('./useConnectAccount');

    let hookApi: ReturnType<typeof useConnectAccount> | null = null;
    function Probe() {
      hookApi = useConnectAccount();
      return null;
    }

    await renderScreen(<Probe />);

    modalAlertSpy.mockClear();

    let ok = false;
    await act(async () => {
      ok = await hookApi!.processAuthUrl('happier-dev:///account?abc123');
    });
    expect(ok).toBe(true);
    expect(modalAlertSpy).not.toHaveBeenCalledWith('common.error', 'modals.invalidAuthUrl', expect.anything());
  });
});
