import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StyleSheet } from 'react-native';
import { renderScreen } from '@/dev/testkit';
import { hitAreaOverlap, readHitArea } from '@/dev/testkit/harness/hitFrameReach';
import { HappierUiPlatformProvider } from '@happier-dev/plugin-ui/environment';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { EditorAccessoryBar, EditorAccessoryChip } from './EditorAccessoryBar';
import { CodeEditorAccessoryBar } from './CodeEditorAccessoryBar';
import type { CodeEditorInlineSuggestion, TextEditorHandle } from '../codeEditorTypes';
import { SessionCockpitBottomChromeHeightContext } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

describe('EditorAccessoryChip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('repeats a held arrow key like a hardware key and stops on release', async () => {
    const onPress = vi.fn();
    const screen = await renderScreen(
      <EditorAccessoryChip
        testID="key"
        icon="arrow-left"
        label="Left"
        repeat
        onPress={onPress}
      />,
    );
    const chip = screen.findByTestId('key')!;
    act(() => {
      chip.props.onPressIn?.({});
    });
    expect(onPress).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(
        motionTokens.gesture.keyRepeatDelayMs +
          motionTokens.gesture.keyRepeatIntervalMs * 3,
      );
    });
    expect(onPress).toHaveBeenCalledTimes(5);
    act(() => {
      chip.props.onPressOut?.({});
      chip.props.onPress?.({});
    });
    act(() => {
      vi.advanceTimersByTime(motionTokens.gesture.keyRepeatIntervalMs * 5);
    });
    // Releasing ends the repeat, and the release's own press is not a sixth step.
    expect(onPress).toHaveBeenCalledTimes(5);
  });

  it('still steps once for a press that arrives without a press-in (keyboard or assistive activation)', async () => {
    const onPress = vi.fn();
    const screen = await renderScreen(
      <EditorAccessoryChip
        testID="key"
        icon="arrow-left"
        label="Left"
        repeat
        onPress={onPress}
      />,
    );
    act(() => {
      screen.findByTestId('key')!.props.onPress?.({});
    });
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('EditorAccessoryBar', () => {
  it('accepts a visible suggestion through the editor command and retires its key with the engine snapshot', async () => {
    let suggestion: CodeEditorInlineSuggestion | null = { id: 'one', text: 'tail', line: 1, character: 1 };
    const listeners = new Set<() => void>();
    const runCommand = vi.fn();
    const editor: TextEditorHandle = { getValue: () => 'x', flushPendingChange: async () => {}, runCommand,
      inlineSuggestions: { getSuggestion: () => suggestion, getContext: () => null, set() {}, setAcceptGuard() {}, onEvent: () => () => {},
        subscribeContext: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } } };
    const screen = await renderScreen(<CodeEditorAccessoryBar editor={editor} save={{ visible: false, enabled: false, tone: 'default', onPress() {} }} />);
    const accept = screen.findByTestId('code-editor-accessory-inline-accept');
    expect(accept).not.toBeNull();
    act(() => { accept!.props.onPress(); });
    expect(runCommand).toHaveBeenLastCalledWith('inlineSuggestAccept');
    act(() => { suggestion = null; for (const listener of listeners) listener(); });
    expect(screen.findByTestId('code-editor-accessory-inline-accept')).toBeNull();
  });
  it('keeps the key row above the phone floating tab bar, so Save and the keys stay tappable', async () => {
    const { StyleSheet } = await import('react-native');
    const tabBarHeight = 84;
    const screen = await renderScreen(
      <SessionCockpitBottomChromeHeightContext.Provider value={tabBarHeight}>
        <EditorAccessoryBar testID="key-row"><EditorAccessoryChip text="Tab" label="Tab" onPress={() => {}} /></EditorAccessoryBar>
      </SessionCockpitBottomChromeHeightContext.Provider>,
    );
    const bottomReservation = () => {
      let node = screen.findHostByTestId('key-row');
      let bottom = 0;
      while (node) {
        if (typeof node.type === 'string') bottom += Number(StyleSheet.flatten(node.props.style)?.paddingBottom ?? 0);
        node = node.parent;
      }
      return bottom;
    };
    expect(bottomReservation()).toBe(tabBarHeight);
    // With no floating chrome over the page, the row keeps its own edge.
    await screen.update(<EditorAccessoryBar testID="key-row"><EditorAccessoryChip text="Tab" label="Tab" onPress={() => {}} /></EditorAccessoryBar>);
    expect(bottomReservation()).toBe(0);
  });
});

describe('EditorAccessoryBar key hit areas', () => {
  const keys = (variant: 'panel' | 'inline') => (
    <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
      <EditorAccessoryBar variant={variant} testID="row" leading={<EditorAccessoryChip testID="lead" text="Tab" label="Tab" onPress={() => {}} />}>
        <EditorAccessoryChip testID="first" icon="arrow-left" label="Left" onPress={() => {}} />
        <EditorAccessoryChip testID="second" icon="arrow-right" label="Right" onPress={() => {}} />
      </EditorAccessoryBar>
    </HappierUiPlatformProvider>
  );

  // 34 px keys sit 6 px apart: unbounded, each would reach 5 px sideways and the neighbours overlap by 4.
  it('splits the real key gap between neighbours so adjacent keys never overlap', async () => {
    const screen = await renderScreen(keys('panel'));
    const first = readHitArea(screen.findByTestId('first')!);
    const second = readHitArea(screen.findByTestId('second')!);
    expect(first.insets.right + second.insets.left).toBeLessThanOrEqual(6);
    expect(hitAreaOverlap(first, second, { axis: 'horizontal', gap: 6 })).toBe(0);
    expect(first.drawn).toEqual({ width: 34, height: 34 });
  });

  // The inline row's scroll viewport is one key tall and clips whatever reaches past it.
  it('keeps the inline row inside its scroll viewport and lets the panel row reach into its own padding', async () => {
    const inline = readHitArea((await renderScreen(keys('inline'))).findByTestId('first')!);
    expect(inline.insets.top + inline.insets.bottom).toBe(0);
    const panel = readHitArea((await renderScreen(keys('panel'))).findByTestId('first')!);
    expect(panel.height).toBe(44);
  });

  // iOS measured the inline viewport from its host's row (24 pt beside the Rich/Raw switch) and cut the
  // 34 pt keys to their side borders; the row holds exactly one key instead.
  it('holds the inline row exactly one key tall whatever its host row measures', async () => {
    const screen = await renderScreen(keys('inline'));
    const key = readHitArea(screen.findByTestId('first')!);
    const row = StyleSheet.flatten(screen.findHostByTestId('row')!.props.style);
    expect(row.height).toBe(key.drawn.height);
    expect(row.flexGrow ?? row.flex ?? 0).toBe(0);
  });
});
