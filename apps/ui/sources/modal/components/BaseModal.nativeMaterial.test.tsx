import React from 'react';
import { StyleSheet as ReactNativeStyleSheet } from 'react-native';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installExpoBlurRequireStub } from '@/dev/testkit/mocks/expoBlur';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// iOS's platform renderer, safe-area SDK and keyboard controller are the system boundary; modal policy stays real.
vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  initialWindowMetrics: {
    insets: { top: 47, bottom: 34, left: 0, right: 0 },
    frame: { x: 0, y: 0, width: 402, height: 874 },
  },
}));
vi.mock('react-native-keyboard-controller', () => ({
  KeyboardAvoidingView: (
    props: React.PropsWithChildren<Record<string, unknown>>,
  ) => React.createElement('NativeKeyboardAvoidingView', props, props.children),
}));
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

const restoreExpoBlur = installExpoBlurRequireStub();
afterAll(restoreExpoBlur);

const { BaseModal } = await import('./BaseModal');

function fadedAncestors(
  screen: Awaited<ReturnType<typeof renderScreen>>,
): unknown[] {
  const faded: unknown[] = [];
  for (
    let node = screen.findByType('CardChild' as never)?.parent ?? null;
    node;
    node = node.parent
  ) {
    const flat = ReactNativeStyleSheet.flatten(node.props?.style as never) as
      | Record<string, unknown>
      | undefined;
    if (flat && 'opacity' in flat && flat.opacity !== 1)
      faded.push(flat.opacity);
  }
  return faded;
}

// NATIVE-SWEEP-1110 M2: UIKit renders no glass created under an ancestor with alpha below 1, so a card that
// faded in stood clear over the Welcome hero. A native card moves in by transform; only its scrim fades.
describe('BaseModal material on iOS', () => {
  it.each(['center', 'bottom'] as const)(
    'never fades a %s card through opacity on its ancestors',
    async (placement) => {
      const screen = await renderScreen(
        <BaseModal visible placement={placement}>
          {React.createElement('CardChild')}
        </BaseModal>,
      );
      expect(fadedAncestors(screen)).toEqual([]);
    },
  );
});

// Owner 2026-11-10 (follow 0.2): the scrim behind a sheet or dialog is a light frost of the page under a very light
// dim, the popovers' scrim, never the flat dark veil (dark scrimWizard at 0.78 × 0.5).
describe('BaseModal scrim on iOS', () => {
  it('frosts the page under a very light dim', async () => {
    const screen = await renderScreen(
      <BaseModal visible placement="bottom">
        {React.createElement('CardChild')}
      </BaseModal>,
    );
    const scrim = screen.findByTestId('modal-scrim');
    expect(scrim).toBeTruthy();
    expect(scrim!.findAllByType('BlurView' as never)).toHaveLength(1);
    const alphas = scrim!.findAll((node) => typeof node.type === 'string')
      .map((node) => (ReactNativeStyleSheet.flatten(node.props?.style as never) as { backgroundColor?: unknown } | undefined)?.backgroundColor)
      .filter((fill): fill is string => typeof fill === 'string' && fill !== 'transparent')
      .map((fill) => Number(/rgba?\([^)]*?,\s*([\d.]+)\)$/.exec(fill)?.[1] ?? 1));
    expect(alphas.length).toBeGreaterThan(0);
    expect(Math.max(...alphas)).toBeLessThanOrEqual(0.1);
  });
});
