import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const keyboard = vi.hoisted(() => ({
  // React Native's own dismissal only blurs a registered `TextInput`; the composer's native editor is not one.
  rnDismiss: vi.fn(),
  native: null as { KeyboardController: { dismiss: { mock: { calls: unknown[] }; mockClear: () => void } } } | null,
}));

// iOS and its keyboard are the system boundary; the composer popover layout policy stays real.
vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeNativeMock(
    { platformOS: 'ios' },
    {
      Keyboard: {
        dismiss: keyboard.rnDismiss,
        addListener: () => ({ remove: () => {} }),
        removeAllListeners: () => {},
      },
      useWindowDimensions: () => ({
        width: 402,
        height: 874,
        scale: 3,
        fontScale: 1,
      }),
    },
  );
});

// The keyboard controller resigns the platform's focused input, the composer's native editor included.
vi.mock('react-native-keyboard-controller', async () => {
  const { createKeyboardControllerModuleMock } = await import('@/dev/testkit/mocks/keyboardController');
  const mock = await createKeyboardControllerModuleMock();
  keyboard.native = mock as never;
  return mock;
});

const nativeDismissCalls = () => keyboard.native?.KeyboardController.dismiss.mock.calls.length ?? 0;

const { useAgentInputPopoverLayout } =
  await import('./useAgentInputPopoverLayout');
const { ComposerKeyboardProvider } =
  await import('@/components/sessions/keyboardAvoidance/ComposerKeyboardContext');
type Layout = ReturnType<typeof useAgentInputPopoverLayout>;
type ComposerLayout = React.ComponentProps<
  typeof ComposerKeyboardProvider
>['layout'];

/** The composer's keyboard as its owner publishes it: a height, its subscribers and the lifts held on it. */
function composerKeyboard(initialHeight: number) {
  const height = initialHeight;
  const listeners = new Set<(height: number) => void>();
  const shared = { value: 0 } as never;
  const state = { lifts: 0 };
  const layout: ComposerLayout = {
    availablePanelHeight: shared,
    bottomInset: shared,
    composerHeight: shared,
    isKeyboardLiftSuppressed: shared,
    keyboardHeightForInset: shared,
    keyboardHeightLive: shared,
    keyboardProgress: shared,
    listBottomInset: shared,
    setComposerMeasuredHeight: () => {},
    getKeyboardHeight: () => height,
    subscribeKeyboardHeight: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retainKeyboardLift: () => {
      state.lifts += 1;
      return () => {
        state.lifts -= 1;
      };
    },
  };
  return { layout, state };
}

async function openPicker(anchor: 'chip' | 'caret') {
  keyboard.rnDismiss.mockClear();
  keyboard.native?.KeyboardController.dismiss.mockClear();
  const composer = composerKeyboard(336);
  const latest: { layout: Layout | null; setOpen: (open: boolean) => void } = {
    layout: null,
    setOpen: () => {},
  };
  function Picker() {
    const [open, setOpen] = React.useState(false);
    latest.setOpen = setOpen;
    latest.layout = useAgentInputPopoverLayout({ open, anchor });
    return null;
  }
  await renderScreen(
    <ComposerKeyboardProvider layout={composer.layout}>
      <Picker />
    </ComposerKeyboardProvider>,
  );
  act(() => latest.setOpen(true));
  return { composer, latest };
}

// Owner 2026-11-11 (phone 05–07), reversing the 2026-11-10 dismissal ruling: tapping a chip while writing closed the
// keyboard and the whole composer jumped down. A chip picker opens above the keyboard; the field keeps it.
describe('composer popover layout and the keyboard on iOS', () => {
  it.each(['chip', 'caret'] as const)('keeps the keyboard, and the composer lifted, when a %s popover opens', async (anchor) => {
    const { composer, latest } = await openPicker(anchor);
    expect(nativeDismissCalls()).toBe(0);
    expect(keyboard.rnDismiss).not.toHaveBeenCalled();
    expect(composer.state.lifts).toBe(1);
    expect(latest.layout?.keyboardBottomInset).toBe(336);
  });
});

// Owner 2026-11-10 (PHONE-POPOVERS): on a phone the engine popover stopped at its desktop height cap, far below
// the status bar. A chip picker may grow up to the top safe area, and never under the status bar.
describe('composer chip picker height on a phone', () => {
  it('lets a chip picker grow to the top safe area instead of stopping at its caller cap', async () => {
    const { SafeAreaProvider } = await import('react-native-safe-area-context');
    const statusBar = 62;
    const latest: { layout: Layout | null } = { layout: null };
    function Picker() {
      latest.layout = useAgentInputPopoverLayout({ open: true, maxHeightCap: 640 });
      return null;
    }
    await renderScreen(
      <SafeAreaProvider initialMetrics={{
        frame: { x: 0, y: 0, width: 402, height: 874 },
        insets: { top: statusBar, bottom: 34, left: 0, right: 0 },
      }}>
        <ComposerKeyboardProvider layout={composerKeyboard(0).layout}>
          <Picker />
        </ComposerKeyboardProvider>
      </SafeAreaProvider>,
    );
    expect(latest.layout?.maxHeightCap).toBeUndefined();
    expect(latest.layout?.edgePadding.top).toBe(statusBar);
  });
});
