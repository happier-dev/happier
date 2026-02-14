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

describe('useConnectAccount (scanner lifecycle)', () => {
  beforeEach(() => {
    vi.resetModules();
    onBarcodeScannedHandler = null;
  });

  it('dismisses the scanner on unmount on iOS', async () => {
    cameraDismissSpy.mockClear();
    cameraRemoveSpy.mockClear();

    const { useConnectAccount } = await import('./useConnectAccount');

    let tree: ReturnType<typeof renderer.create> | undefined;
    function Probe() {
      useConnectAccount();
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
    const authAccountApproveSpy = vi.fn(async () => deferred.promise);
    vi.doMock('@/auth/flows/accountApprove', () => ({
      authAccountApprove: authAccountApproveSpy,
    }));

    const { useConnectAccount } = await import('./useConnectAccount');

    function Probe() {
      useConnectAccount();
      return null;
    }

    await act(async () => {
      renderer.create(<Probe />);
    });

    expect(typeof onBarcodeScannedHandler).toBe('function');
    authAccountApproveSpy.mockClear();
    cameraDismissSpy.mockClear();

    const event = { data: 'happier:///account?abc123' };
    // Fire twice before the approval promise resolves.
    void onBarcodeScannedHandler!(event);
    void onBarcodeScannedHandler!(event);

    // Allow microtasks to run.
    await act(async () => {});

    expect(authAccountApproveSpy).toHaveBeenCalledTimes(1);

    deferred.resolve(undefined);
  });
});
