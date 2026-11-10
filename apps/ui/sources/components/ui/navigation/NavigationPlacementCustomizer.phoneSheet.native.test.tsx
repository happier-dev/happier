import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';

// An iPhone: the OS, its window and its keyboard are the boundary; the modal, its card and the customizer stay real.
vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeNativeMock(
    { platformOS: 'ios' },
    {
      useWindowDimensions: () => ({
        width: 402,
        height: 874,
        scale: 3,
        fontScale: 1,
      }),
      Dimensions: {
        get: () => ({ width: 402, height: 874, scale: 3, fontScale: 1 }),
        addEventListener: () => ({ remove() {} }),
      },
    },
  );
});
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('react-native-reanimated', async () =>
  (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock({
    settleTimingCallbacks: true,
  }),
);
vi.mock('react-native-gesture-handler', async () =>
  (
    await import('@/dev/testkit/mocks/gestureHandler')
  ).createGestureHandlerMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('expo-glass-effect', () => ({ isLiquidGlassAvailable: () => false }));
vi.mock('expo-blur', () => ({ BlurView: 'BlurView' }));

const account = createProviderSettingsAccountHarness();
await (
  await import('@/dev/testkit/harness/syncSingletonLoader')
).loadSyncSingletonForTests();
const { CustomModal } = await import('@/modal/components/CustomModal');
const { NavigationPlacementCustomizer } =
  await import('./NavigationPlacementCustomizer');
const { ScrollView } = await import('react-native');

const items = [
  'home',
  'inbox',
  'projects',
  'boards',
  'automations',
  'files',
  'search',
  'settings',
].map((id) => ({ id, title: id, defaultPlacement: 'pinned' as const }));

/** The scrollers a row is reached through, innermost first: only one may scroll, and it must be bounded. */
function scrollersAbove(
  node: {
    parent: unknown;
    type: unknown;
    props: Record<string, unknown>;
  } | null,
) {
  const scrollers: Array<Readonly<{ testID: unknown; scrolls: boolean }>> = [];
  for (let current = node; current; current = current.parent as typeof node) {
    if (current.type === ScrollView)
      scrollers.push({
        testID: current.props.testID,
        scrolls: current.props.scrollEnabled !== false,
      });
  }
  return scrollers;
}

afterEach(async () => {
  standardCleanup();
  await account.reset();
});

// PHONE-POPOVERS-1109 (iOS 26): the Phone shortcuts sheet's own row list laid out at its content height (1041 pt on
// an 874 pt screen) under a still body, so it never scrolled and its last row (Settings) was out of reach. On a
// phone the sheet's body is the one scroller, bounded by the sheet, and the rows sit in it at their own height.
describe('navigation placement customizer as a phone sheet', () => {
  it('reaches its last row through the sheet body, the one scroller', async () => {
    await account.restore({ settings: {} });
    const screen = await renderScreen(
      <CustomModal
        visible
        onClose={() => {}}
        config={{
          id: 'customize',
          type: 'custom',
          component: NavigationPlacementCustomizer,
          props: {
            surfaceId: 'phoneLauncher',
            items,
            testID: 'phone-launcher-customizer',
          },
        }}
      />,
    );
    await act(async () => {});
    const lastRow =
      screen.tree.root.findAll(
        (node) =>
          node.props.testID === 'phone-launcher-customizer.move:settings',
      )[0] ?? null;
    expect(lastRow).not.toBeNull();
    const scrollers = scrollersAbove(lastRow as never);
    expect(scrollers.filter((scroller) => scroller.scrolls)).toEqual([
      { testID: 'modal-card-body-scroll', scrolls: true },
    ]);
    await act(async () => screen.unmount());
  });
});
