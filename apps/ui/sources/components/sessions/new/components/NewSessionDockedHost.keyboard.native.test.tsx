import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { createNavigationPropMock } from '@/dev/testkit/mocks/reactNavigation';

const keyboard = vi.hoisted(() => ({
  /** The keyboard controller's frame worklets, as the device runs them. */
  handlers: [] as Array<Record<string, ((event: { height: number; progress: number; duration: number; target: number }) => void) | undefined>>,
  /** React Native's own settled-keyboard notifications. */
  rnListeners: new Map<string, Set<() => void>>(),
  module: null as null | Awaited<
    ReturnType<
      (typeof import('@/dev/testkit/mocks/keyboardController'))['createKeyboardControllerModuleMock']
    >
  >,
}));
vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeNativeMock(
    { platformOS: 'ios' },
    {
      useWindowDimensions: () => ({
        width: 390,
        height: 844,
        scale: 1,
        fontScale: 1,
      }),
      Keyboard: {
        dismiss: () => {},
        isVisible: () => false,
        addListener: (name: string, listener: () => void) => {
          const set = keyboard.rnListeners.get(name) ?? new Set<() => void>();
          set.add(listener);
          keyboard.rnListeners.set(name, set);
          return { remove: () => { set.delete(listener); } };
        },
      },
    },
  );
});
vi.mock('react-native-keyboard-controller', async () => {
  keyboard.module = await (
    await import('@/dev/testkit/mocks/keyboardController')
  ).createKeyboardControllerModuleMock({
    useKeyboardHandler: ((handler: (typeof keyboard.handlers)[number]) => {
      keyboard.handlers.push(handler);
    }) as never,
  });
  return keyboard.module;
});
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('react-native-reanimated', async () =>
  (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock({
    settleTimingCallbacks: true,
  }),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('@react-native-masked-view/masked-view', () => ({
  default: 'MaskedView',
}));
vi.mock('expo-glass-effect', () => ({ isLiquidGlassAvailable: () => false }));
vi.mock('expo-blur', () => ({ BlurView: 'BlurView' }));

const account = createProviderSettingsAccountHarness();
await (
  await import('@/dev/testkit/harness/syncSingletonLoader')
).loadSyncSingletonForTests();
const { NewSessionDockedHost } = await import('./NewSessionDockedHost');
const { NewSessionShellHostProvider, useOpenNewSession } =
  await import('../navigation/newSessionEntry');
const { SessionCockpitBottomChromeHeightContext } =
  await import('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry');
const { Pressable } = await import('react-native');
const { NavigationContext } = await import('@react-navigation/native');
const { HeaderHeightContext } = await import('@react-navigation/elements');

const TAB_BAR = 80;
const KEYBOARD = 300;

function Entry() {
  const open = useOpenNewSession();
  return <Pressable testID="open-dock" onPress={() => open()} />;
}

function readTranslateY(style: unknown): number | undefined {
  let translateY: number | undefined;
  for (const entry of [style].flat(Infinity)) {
    const transform =
      entry && typeof entry === 'object'
        ? (entry as { transform?: Array<{ translateY?: number }> }).transform
        : undefined;
    for (const step of transform ?? [])
      if (typeof step.translateY === 'number') translateY = step.translateY;
  }
  return translateY;
}

describe('native Docked composer keyboard seat', () => {
  beforeAll(async () => {
    await import('../NewSessionScreen');
  });
  afterEach(async () => {
    standardCleanup();
    await account.reset();
  });

  it.each([0, KEYBOARD])('keeps the card and its band clear of the bar at keyboard height %s', async keyboardHeight => {
    await account.restore({
      settings: {
        newSessionPresentationModeV1: 'docked',
        glassPreset: 'solid',
      },
    });
    const navigation = createNavigationPropMock();
    const tree = () => (
      <NavigationContext.Provider value={navigation}>
        <HeaderHeightContext.Provider value={0}>
          <SessionCockpitBottomChromeHeightContext.Provider value={TAB_BAR}>
            <NewSessionShellHostProvider>
              <Entry />
              <NewSessionDockedHost>{null}</NewSessionDockedHost>
            </NewSessionShellHostProvider>
          </SessionCockpitBottomChromeHeightContext.Provider>
        </HeaderHeightContext.Provider>
      </NavigationContext.Provider>
    );
    const screen = await renderScreen(tree());
    // The keyboard may already be up (another input owns it) when the dock mounts.
    act(() =>
      keyboard.module!.emitKeyboardEvent('keyboardDidShow', {
        height: keyboardHeight,
        duration: 0,
        timestamp: 0,
        target: 0,
        type: 'default',
        appearance: 'dark',
      }),
    );
    await screen.pressByTestIdAsync('open-dock');
    // The test Reanimated evaluates animated styles only while React renders; on device they follow
    // their shared values on the UI thread. Render once more so the seat reads the settled lift.
    await screen.update(tree());
    const host = screen.findAllHostsByTestId('new-session-docked-host')[0]!;
    const seatBottom = (host.props.style as unknown[])
      .flat(Infinity)
      .reduce<number>(
        (bottom, entry) =>
          typeof (entry as { marginBottom?: unknown })?.marginBottom ===
          'number'
            ? (entry as { marginBottom: number }).marginBottom
            : bottom,
        0,
      );
    let lift: number | undefined;
    for (let node = host.parent; node && lift === undefined; node = node.parent)
      lift = readTranslateY(node.props.style);
    // Card bottom above the window's foot: the seat's margin plus the scaffold's lift.
    const gap = seatBottom - TAB_BAR;
    expect(gap).toBeGreaterThan(0);
    const cardBottom = seatBottom - (lift ?? 0);
    expect(cardBottom).toBe(Math.max(TAB_BAR, keyboardHeight) + gap);
    const band = screen.findAllHostsByTestId('new-session-docked-band')[0]!;
    const bandBottom = Object.assign({}, ...[band.props.style].flat(Infinity)).bottom as number;
    // Read the actual paint footprint: the band ends at the visible bar, or at the keyboard
    // covering it. A card that clears the bar is insufficient if its frost paints across it.
    expect(cardBottom + bandBottom).toBe(Math.max(TAB_BAR, keyboardHeight));
    await act(async () => screen.unmount());
  });

  // PHONE-POPOVERS-1109 regression (iOS sim, 11-10 23:10): the docked composer opened from the bar's + stayed at the
  // bottom under the keyboard its own field raised. Driven the way the device does: the controller's frame worklets,
  // and React Native's settled hide between two focuses.
  it('lifts the card above the keyboard its own field raises, again after the keyboard went away', async () => {
    // The keyboard starts down: an earlier case left the controller's last frame up.
    act(() => keyboard.module!.emitKeyboardEvent('keyboardDidHide', { height: 0, duration: 0, timestamp: 0, target: 0, type: 'default', appearance: 'dark' }));
    keyboard.handlers.length = 0;
    await account.restore({ settings: { newSessionPresentationModeV1: 'docked', glassPreset: 'solid' } });
    const navigation = createNavigationPropMock();
    const tree = () => (
      <NavigationContext.Provider value={navigation}>
        <HeaderHeightContext.Provider value={0}>
          <SessionCockpitBottomChromeHeightContext.Provider value={TAB_BAR}>
            <NewSessionShellHostProvider>
              <Entry />
              <NewSessionDockedHost>{null}</NewSessionDockedHost>
            </NewSessionShellHostProvider>
          </SessionCockpitBottomChromeHeightContext.Provider>
        </HeaderHeightContext.Provider>
      </NavigationContext.Provider>
    );
    const screen = await renderScreen(tree(), { createNodeMock: () => ({ blur() {}, focus() {}, measureLayout() {}, measureInWindow() {} }) });
    await screen.pressByTestIdAsync('open-dock');
    const input = () => screen.tree.root.findAllByProps({ testID: 'new-session-composer-input' })
      .find(node => typeof node.props.onFocus === 'function' && typeof node.props.value === 'string');
    await vi.waitFor(async () => { await act(async () => {}); expect(input()).toBeDefined(); });
    const frame = (height: number) => act(() => {
      for (const handler of keyboard.handlers) {
        const event = { height, progress: height > 0 ? 1 : 0, duration: 0, target: 0 };
        handler.onStart?.(event);
        handler.onMove?.(event);
        handler.onEnd?.(event);
      }
    });
    const cardBottom = async () => {
      await screen.update(tree());
      const host = screen.findAllHostsByTestId('new-session-docked-host')[0]!;
      const seatBottom = (host.props.style as unknown[]).flat(Infinity).reduce<number>((bottom, entry) =>
        typeof (entry as { marginBottom?: unknown })?.marginBottom === 'number' ? (entry as { marginBottom: number }).marginBottom : bottom, 0);
      let lift: number | undefined;
      for (let node = host.parent; node && lift === undefined; node = node.parent) lift = readTranslateY(node.props.style);
      return { seatBottom, bottom: seatBottom - (lift ?? 0) };
    };
    const rest = await cardBottom();
    const gap = rest.seatBottom - TAB_BAR;
    for (let round = 0; round < 2; round += 1) {
      await act(async () => input()!.props.onFocus());
      frame(KEYBOARD);
      expect((await cardBottom()).bottom).toBe(KEYBOARD + gap);
      await act(async () => input()!.props.onBlur());
      frame(0);
      act(() => { for (const listener of keyboard.rnListeners.get('keyboardDidHide') ?? []) listener(); });
      expect((await cardBottom()).bottom).toBe(rest.bottom);
    }
    await act(async () => screen.unmount());
  });
});
