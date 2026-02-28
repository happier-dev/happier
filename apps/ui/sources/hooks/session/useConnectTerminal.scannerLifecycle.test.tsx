import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const modalAlertSpy = vi.fn();
vi.mock('@/modal', () => ({
  Modal: {
    alert: modalAlertSpy,
    alertAsync: modalAlertSpy,
  },
}));

vi.mock('@/text', () => ({
  t: (key: string) => key,
}));

let platformOS: 'ios' | 'web' = 'ios';
let windowDimensions: { width: number; height: number } = { width: 390, height: 844 };

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return platformOS;
    },
    select: (options: any) => options?.[platformOS] ?? options?.default ?? options?.ios ?? options?.android,
  },
  Dimensions: {
    get: () => ({ width: windowDimensions.width, height: windowDimensions.height, scale: 2, fontScale: 1 }),
  },
  useWindowDimensions: () => ({ width: windowDimensions.width, height: windowDimensions.height, scale: 2, fontScale: 1 }),
}));

vi.mock('expo-camera', () => ({
  CameraView: {},
  useCameraPermissions: () => [{ granted: true }, vi.fn(async () => ({ granted: true }))],
}));

vi.mock('@/utils/platform/platform', () => ({
  isRunningOnMac: () => false,
}));

const routerPushSpy = vi.fn();
vi.mock('expo-router', () => ({
  router: { replace: vi.fn(), push: routerPushSpy },
}));

vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: { token: 't', encryption: { type: 'dataKey' } }, refreshFromActiveServer: vi.fn(async () => {}) }),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
  TokenStorage: { getCredentials: vi.fn(async () => null) },
  isLegacyAuthCredentials: () => false,
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
  getActiveServerUrl: () => 'https://api.happier.dev',
}));

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
  normalizeServerUrl: (value: string) => String(value ?? '').trim().replace(/\/+$/, ''),
  upsertActivateAndSwitchServer: vi.fn(async () => true),
}));

vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
  setPendingTerminalConnect: vi.fn(),
  clearPendingTerminalConnect: vi.fn(),
}));

vi.mock('@/utils/path/terminalConnectUrl', () => ({
  parseTerminalConnectUrl: () => ({ publicKeyB64Url: 'abc123', serverUrl: null }),
}));

vi.mock('@/encryption/base64', () => ({
  decodeBase64: vi.fn(() => new Uint8Array(32).fill(5)),
}));

vi.mock('@/sync/sync', () => ({
  sync: { encryption: { getContentPrivateKey: () => new Uint8Array(32).fill(7) } },
}));

vi.mock('@/auth/terminal/terminalProvisioning', () => ({
  buildTerminalResponseV1: vi.fn(() => new Uint8Array()),
  buildTerminalResponseV2: vi.fn(() => new Uint8Array([1, 2, 3])),
}));

vi.mock('@/sync/domains/state/storageStore', () => {
  const storage = {
    getState: () => ({ settings: { terminalConnectLegacySecretExportEnabled: false } }),
  };
  return { storage, getStorage: () => storage };
});

describe('useConnectTerminal (scanner lifecycle)', () => {
  beforeEach(() => {
    vi.resetModules();
    platformOS = 'ios';
    windowDimensions = { width: 390, height: 844 };
    routerPushSpy.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('navigates to the in-app QR scanner when starting terminal connect', async () => {
    const { useConnectTerminal } = await import('./useConnectTerminal');

    let hookApi: ReturnType<typeof useConnectTerminal> | null = null;
    function Probe() {
      hookApi = useConnectTerminal();
      return null;
    }

    await act(async () => {
      renderer.create(<Probe />);
    });

    await act(async () => {
      await hookApi!.connectTerminal();
    });

    expect(routerPushSpy).toHaveBeenCalledWith('/scan/terminal');
  });

  it('navigates to the in-app QR scanner on phone-sized web', async () => {
    platformOS = 'web';
    windowDimensions = { width: 360, height: 800 };
    vi.stubGlobal('navigator', { maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)' } as any);

    const { useConnectTerminal } = await import('./useConnectTerminal');

    let hookApi: ReturnType<typeof useConnectTerminal> | null = null;
    function Probe() {
      hookApi = useConnectTerminal();
      return null;
    }

    await act(async () => {
      renderer.create(<Probe />);
    });

    await act(async () => {
      await hookApi!.connectTerminal();
    });

    expect(routerPushSpy).toHaveBeenCalledWith('/scan/terminal');
  });

  it('does not open the scanner on desktop web even when the viewport is narrow', async () => {
    platformOS = 'web';
    windowDimensions = { width: 480, height: 700 };
    vi.stubGlobal('navigator', { maxTouchPoints: 0, userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' } as any);
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) } as any);

    const { useConnectTerminal } = await import('./useConnectTerminal');

    let hookApi: ReturnType<typeof useConnectTerminal> | null = null;
    function Probe() {
      hookApi = useConnectTerminal();
      return null;
    }

    await act(async () => {
      renderer.create(<Probe />);
    });

    modalAlertSpy.mockClear();

    await act(async () => {
      await hookApi!.connectTerminal();
    });

    expect(routerPushSpy).not.toHaveBeenCalled();
    expect(modalAlertSpy).toHaveBeenCalled();
  });
});
