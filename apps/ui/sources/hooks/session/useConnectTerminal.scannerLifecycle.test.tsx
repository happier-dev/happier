import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionHooksCommonModuleMocks } from './sessionHooksTestHelpers';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const modalAlertSpy = vi.fn();
const screenState = vi.hoisted(() => ({
    platformOS: 'ios' as 'ios' | 'web',
    windowDimensions: { width: 390, height: 844 },
}));

installSessionHooksCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: modalAlertSpy,
                alertAsync: modalAlertSpy,
            },
        }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
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
                get: () => ({
                    width: screenState.windowDimensions.width,
                    height: screenState.windowDimensions.height,
                    scale: 2,
                    fontScale: 1,
                }),
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const expoRouterMock = createExpoRouterMock({
            router: { replace: vi.fn(), push: routerPushSpy },
        });
        return expoRouterMock.module;
    },
});

vi.mock('expo-camera', () => ({
  CameraView: {},
  useCameraPermissions: () => [{ granted: true }, vi.fn(async () => ({ granted: true }))],
}));

vi.mock('expo-device', () => ({
  isDevice: true,
}));

vi.mock('@/utils/platform/platform', () => ({
  isRunningOnMac: () => false,
}));

const routerPushSpy = vi.fn();

await initializeRealAppRuntimeForTests();
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { useConnectTerminal } = await import('./useConnectTerminal');

describe('useConnectTerminal (scanner lifecycle)', () => {
  beforeEach(() => {
    screenState.platformOS = 'ios';
    screenState.windowDimensions = { width: 390, height: 844 };
    routerPushSpy.mockClear();
  });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

  it('navigates to the in-app QR scanner when starting terminal connect', async () => {
    let hookApi: ReturnType<typeof useConnectTerminal> | null = null;
    function Probe() {
      hookApi = useConnectTerminal();
      return null;
    }

    await renderScreen(<InjectedAuthProvider credentials={null}><Probe /></InjectedAuthProvider>);

    await act(async () => {
      await hookApi!.connectTerminal();
    });

    expect(routerPushSpy).toHaveBeenCalledWith('/scan/terminal');
  });

  it('navigates to the in-app QR scanner on phone-sized web', async () => {
    screenState.platformOS = 'web';
    screenState.windowDimensions = { width: 360, height: 800 };
    vi.stubGlobal('navigator', {
      maxTouchPoints: 5,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)',
      mediaDevices: { getUserMedia: async () => ({}) },
    } as any);

    let hookApi: ReturnType<typeof useConnectTerminal> | null = null;
    function Probe() {
      hookApi = useConnectTerminal();
      return null;
    }

    await renderScreen(<InjectedAuthProvider credentials={null}><Probe /></InjectedAuthProvider>);

    await act(async () => {
      await hookApi!.connectTerminal();
    });

    expect(routerPushSpy).toHaveBeenCalledWith('/scan/terminal');
  });

  it('navigates to the in-app QR scanner on desktop web when camera APIs exist', async () => {
    screenState.platformOS = 'web';
    screenState.windowDimensions = { width: 480, height: 700 };
    vi.stubGlobal('navigator', {
      maxTouchPoints: 0,
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
      mediaDevices: { getUserMedia: async () => ({}) },
    } as any);

    let hookApi: ReturnType<typeof useConnectTerminal> | null = null;
    function Probe() {
      hookApi = useConnectTerminal();
      return null;
    }

    await renderScreen(<InjectedAuthProvider credentials={null}><Probe /></InjectedAuthProvider>);

    modalAlertSpy.mockClear();

    await act(async () => {
      await hookApi!.connectTerminal();
    });

    expect(routerPushSpy).toHaveBeenCalledWith('/scan/terminal');
    expect(modalAlertSpy).not.toHaveBeenCalled();
  });

  it('does not open the scanner when web camera APIs are unavailable', async () => {
    screenState.platformOS = 'web';
    screenState.windowDimensions = { width: 480, height: 700 };
    vi.stubGlobal('navigator', { maxTouchPoints: 0, userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' } as any);

    let hookApi: ReturnType<typeof useConnectTerminal> | null = null;
    function Probe() {
      hookApi = useConnectTerminal();
      return null;
    }

    await renderScreen(<InjectedAuthProvider credentials={null}><Probe /></InjectedAuthProvider>);

    modalAlertSpy.mockClear();
    routerPushSpy.mockClear();

    await act(async () => {
      await hookApi!.connectTerminal();
    });

    expect(routerPushSpy).not.toHaveBeenCalled();
    expect(modalAlertSpy).toHaveBeenCalled();
  });
});
