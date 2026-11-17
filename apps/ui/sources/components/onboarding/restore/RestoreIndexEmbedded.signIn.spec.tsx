import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { RestoreIndexEmbedded } from './RestoreIndexEmbedded';

type ReactActEnvironmentGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const viewport = vi.hoisted(() => ({
  current: { width: 1400, height: 900, scale: 1, fontScale: 1 },
}));
const DESKTOP = { width: 1400, height: 900, scale: 1, fontScale: 1 };
const PHONE = { width: 390, height: 844, scale: 1, fontScale: 1 };

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    Platform: {
      OS: 'web',
      select: (spec: Record<string, unknown>) => spec.web ?? spec.default,
    },
    // The window is a platform boundary; each case sets the device it is on.
    useWindowDimensions: () => viewport.current,
  });
});

vi.mock('@/utils/platform/platform', () => ({
  isRunningOnMac: () => false,
}));

// The device camera is a platform boundary: each case says whether this computer has one.
const camera = vi.hoisted(() => ({ available: false }));
vi.mock('@/utils/platform/qrScannerSupport', () => ({
  isWebQrScannerSupported: () => camera.available,
  canUseCurrentDeviceQrScanner: () => camera.available,
}));

// The camera scanner, the QR display and the secret-key journey are their own owners, each with
// camera, pairing-transport or credential-custody boundaries beneath; this spec is about which of
// them the Login screen offers, so they render as markers.
vi.mock('@/components/account/restore/RestoreScanComputerQrView', () => ({
  RestoreScanComputerQrView: () => React.createElement('scan'),
}));
vi.mock('@/components/account/restore/RestoreQrView', () => ({
  RestoreQrView: () => React.createElement('qr'),
}));
vi.mock('@/components/account/restore/SecretKeyLoginForm', () => ({
  SecretKeyLoginForm: (props: { embedded?: boolean }) =>
    React.createElement('secret-key-form', props),
}));

async function renderLogin(
  props: Partial<React.ComponentProps<typeof RestoreIndexEmbedded>> = {},
) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      // How the Welcome's "Login — I already use Happier" opens this step on a device that cannot scan.
      <RestoreIndexEmbedded
        entryIntent="enter_home"
        initialView="paste"
        onBack={vi.fn()}
        onOpenSecretKeyLogin={vi.fn()}
        {...props}
      />,
    );
  });
  return tree;
}

function pressable(tree: renderer.ReactTestRenderer, testID: string) {
  return tree.root.findAll(
    (node) =>
      node.props.testID === testID && typeof node.props.onPress === 'function',
  )[0];
}

describe('RestoreIndexEmbedded — Login keeps its promise', () => {
  /** Which way comes first on the screen, in reading order. */
  function firstWay(tree: renderer.ReactTestRenderer) {
    const first = tree.root.findAll(
      (node) =>
        node.type === ('secret-key-form' as never) ||
        node.props.testID === 'restore-pairing-link-input',
    )[0];
    return first?.type === ('secret-key-form' as never) ? 'recovery-key' : 'pairing-link';
  }

  it('leads with the open recovery key on a computer, then the pairing link', async () => {
    camera.available = false;
    viewport.current = DESKTOP;
    const tree = await renderLogin();
    try {
      // Always open: no disclosure to press before the key field shows.
      expect(tree.root.findAllByType('secret-key-form' as never)).toHaveLength(1);
      expect(pressable(tree, 'restore-sign-in-secret-key')).toBeUndefined();
      expect(firstWay(tree)).toBe('recovery-key');
      expect(
        tree.root.findAllByProps({ testID: 'restore-pairing-link-input' })
          .length,
      ).toBeGreaterThan(0);
      expect(
        tree.root.findAllByProps({ testID: 'restore-sign-in-use-camera' }),
      ).toHaveLength(0);
    } finally {
      act(() => tree.unmount());
    }
  });

  it('leads with the pairing link and the camera on a phone, then the open recovery key', async () => {
    camera.available = true;
    viewport.current = PHONE;
    const tree = await renderLogin();
    try {
      expect(firstWay(tree)).toBe('pairing-link');
      expect(pressable(tree, 'restore-sign-in-use-camera')).toBeTruthy();
      expect(tree.root.findAllByType('secret-key-form' as never)).toHaveLength(1);
    } finally {
      viewport.current = DESKTOP;
      act(() => tree.unmount());
    }
  });

  it('scans a QR code with the camera from the same screen when there is one', async () => {
    camera.available = true;
    const tree = await renderLogin();
    try {
      const useCamera = pressable(tree, 'restore-sign-in-use-camera');
      expect(useCamera).toBeTruthy();
      await act(async () => {
        useCamera!.props.onPress();
      });
      expect(tree.root.findAllByType('scan' as never)).toHaveLength(1);
    } finally {
      act(() => tree.unmount());
    }
  });

  it('shows a QR code for a signed-in device to scan when this computer knows its Home', async () => {
    camera.available = false;
    const tree = await renderLogin({ reverseTargetProfileId: 'home-b' });
    try {
      const showQr = pressable(tree, 'restore-sign-in-show-qr');
      expect(showQr).toBeTruthy();
      await act(async () => {
        showQr!.props.onPress();
      });
      expect(tree.root.findAllByType('qr' as never)).toHaveLength(1);
    } finally {
      act(() => tree.unmount());
    }
  });

  it('keeps adding a Home free of an Account secret key', async () => {
    camera.available = false;
    const tree = await renderLogin({
      entryIntent: 'add_home',
      onOpenSecretKeyLogin: undefined,
    });
    try {
      expect(
        tree.root.findAllByProps({ testID: 'restore-pairing-link-input' })
          .length,
      ).toBeGreaterThan(0);
      expect(
        tree.root.findAllByProps({ testID: 'restore-sign-in-secret-key' }),
      ).toHaveLength(0);
      expect(tree.root.findAllByType('secret-key-form' as never)).toHaveLength(
        0,
      );
    } finally {
      act(() => tree.unmount());
    }
  });
});
