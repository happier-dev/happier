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

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

vi.mock('@/utils/platform/platform', () => ({
  isRunningOnMac: () => false,
}));

// The device camera is a platform boundary: each case says whether this computer has one.
const camera = vi.hoisted(() => ({ available: false }));
vi.mock('@/utils/platform/qrScannerSupport', () => ({
  isWebQrScannerSupported: () => camera.available,
  canUseCurrentDeviceQrScanner: () => camera.available,
}));

// The camera scanner and the QR display are their own owners, each with camera or pairing-transport
// boundaries beneath; this spec is about which ways the pairing-link step offers, so they render as markers.
vi.mock('@/components/account/restore/RestoreScanComputerQrView', () => ({
  RestoreScanComputerQrView: () => React.createElement('scan'),
}));
vi.mock('@/components/account/restore/RestoreQrView', () => ({
  RestoreQrView: () => React.createElement('qr'),
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

describe('RestoreIndexEmbedded — the pairing-link step', () => {
  it('is one field and its primary, with the recovery key one way away on a computer', async () => {
    camera.available = false;
    viewport.current = DESKTOP;
    const openKey = vi.fn();
    const tree = await renderLogin({ onOpenSecretKeyLogin: openKey });
    try {
      const input = tree.root.findAllByProps({ testID: 'restore-pairing-link-input' });
      expect(input.length).toBeGreaterThan(0);
      expect(input.some((node) => node.props.autoFocus === true)).toBe(true);
      expect(pressable(tree, 'restore-pairing-link-submit')).toBeTruthy();
      // The key is its own step, reached from the ways row; no camera way on a computer without one.
      expect(pressable(tree, 'restore-sign-in-use-camera')).toBeUndefined();
      await act(async () => {
        pressable(tree, 'restore-open-manual')!.props.onPress();
      });
      expect(openKey).toHaveBeenCalledTimes(1);
    } finally {
      act(() => tree.unmount());
    }
  });

  it('offers the camera on a phone and focuses nothing, so the keyboard does not cover the ways', async () => {
    camera.available = true;
    viewport.current = PHONE;
    const tree = await renderLogin();
    try {
      expect(pressable(tree, 'restore-sign-in-use-camera')).toBeTruthy();
      expect(
        tree.root
          .findAllByProps({ testID: 'restore-pairing-link-input' })
          .some((node) => node.props.autoFocus === true),
      ).toBe(false);
    } finally {
      viewport.current = DESKTOP;
      act(() => tree.unmount());
    }
  });

  it('scans a QR code with the camera from the same step when there is one', async () => {
    camera.available = true;
    const tree = await renderLogin();
    try {
      await act(async () => {
        pressable(tree, 'restore-sign-in-use-camera')!.props.onPress();
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
      await act(async () => {
        pressable(tree, 'restore-sign-in-show-qr')!.props.onPress();
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
      expect(pressable(tree, 'restore-open-manual')).toBeUndefined();
    } finally {
      act(() => tree.unmount());
    }
  });
});
