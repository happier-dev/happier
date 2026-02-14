import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const modalAlertSpy = vi.fn();
vi.mock('@/modal', () => ({
  Modal: {
    alert: modalAlertSpy,
  },
}));

vi.mock('@/text', () => ({
  t: (key: string) => key,
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

const cameraRemoveSpy = vi.fn();
const cameraDismissSpy = vi.fn(async () => {});
const cameraLaunchSpy = vi.fn();
let onBarcodeScannedHandler: ((event: { data: string }) => unknown | Promise<unknown>) | null = null;

vi.mock('expo-camera', () => ({
  CameraView: {
    isModernBarcodeScannerAvailable: true,
    launchScanner: cameraLaunchSpy,
    dismissScanner: cameraDismissSpy,
    onModernBarcodeScanned: vi.fn((handler: (event: { data: string }) => unknown) => {
      onBarcodeScannedHandler = handler;
      return { remove: cameraRemoveSpy };
    }),
  },
}));

vi.mock('@/hooks/ui/useCheckCameraPermissions', () => ({
  useCheckScannerPermissions: () => vi.fn(async () => true),
}));

vi.mock('expo-router', () => ({
  router: { replace: vi.fn() },
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

vi.mock('@/sync/domains/state/storageStore', () => ({
  storage: {
    getState: () => ({ settings: { terminalConnectLegacySecretExportEnabled: false } }),
  },
}));

describe('useConnectTerminal (scanner lifecycle)', () => {
  beforeEach(() => {
    vi.resetModules();
    onBarcodeScannedHandler = null;
  });

  it('dismisses the scanner on unmount on iOS', async () => {
    cameraDismissSpy.mockClear();
    cameraRemoveSpy.mockClear();

    const { useConnectTerminal } = await import('./useConnectTerminal');

    let tree: ReturnType<typeof renderer.create> | undefined;
    function Probe() {
      useConnectTerminal();
      return null;
    }

    await act(async () => {
      tree = renderer.create(<Probe />);
    });

    act(() => {
      tree?.unmount();
    });

    expect(cameraRemoveSpy).toHaveBeenCalledTimes(1);
    expect(cameraDismissSpy).toHaveBeenCalledTimes(1);
  });

  it('debounces duplicate barcode scans while processing', async () => {
    const deferred = createDeferred<void>();
    const authApproveSpy = vi.fn(async () => deferred.promise);
    vi.doMock('@/auth/flows/approve', () => ({
      authApprove: authApproveSpy,
    }));

    const { useConnectTerminal } = await import('./useConnectTerminal');

    function Probe() {
      useConnectTerminal();
      return null;
    }

    await act(async () => {
      renderer.create(<Probe />);
    });

    expect(typeof onBarcodeScannedHandler).toBe('function');
    authApproveSpy.mockClear();
    cameraDismissSpy.mockClear();

    const event = { data: 'happier://terminal?key=abc123&server=https%3A%2F%2Fapi.happier.dev' };
    void onBarcodeScannedHandler!(event);
    void onBarcodeScannedHandler!(event);

    await act(async () => {});

    expect(authApproveSpy).toHaveBeenCalledTimes(1);

    deferred.resolve(undefined);
  });
});
