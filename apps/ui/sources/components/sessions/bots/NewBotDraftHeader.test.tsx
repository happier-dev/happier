import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderHook, renderScreen } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const keyboardBoundary = vi.hoisted(() => ({
  onEnd: undefined as undefined | ((event: { height: number; progress: number }) => void),
  listeners: new Map<string, () => void>(),
}));

installSettingsViewCommonModuleMocks({
  reactNative: async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' }, {
      Keyboard: { addListener: (name: string, listener: () => void) => {
        keyboardBoundary.listeners.set(name, listener);
        return { remove: () => keyboardBoundary.listeners.delete(name) };
      } },
      useWindowDimensions: () => ({ width: 390, height: 800, scale: 1, fontScale: 1 }),
    });
  },
});

vi.mock('react-native-keyboard-controller', () => ({
  useKeyboardHandler: (handlers: { onEnd: typeof keyboardBoundary.onEnd }) => { keyboardBoundary.onEnd = handlers.onEnd; },
  useReanimatedKeyboardAnimation: () => ({ height: { value: 0 }, progress: { value: 0 } }),
}));

vi.mock('react-native-reanimated', async () => {
  const React = await import('react');
  const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
  return { ...createReanimatedModuleMock(), useSharedValue: <T,>(value: T) => React.useRef({ value }).current };
});

const { NewBotDraftHeader } = await import('./NewBotDraftHeader');
const { createComposerTextStore } =
  await import('@/components/sessions/agentInput/composerTextStore');
const { t } = await import('@/text');

function texts(root: ReactTestInstance): string[] {
  return root
    .findAll(
      (node) =>
        typeof node.type === 'string' &&
        typeof node.props.children === 'string',
    )
    .map((node) => node.props.children as string);
}

describe('NewBotDraftHeader (b-new, D30)', () => {
  it('raises the card when its name opens the iOS keyboard after a dismissal, and releases focus on blur', async () => {
    const { useComposerKeyboardLayout } = await import('@/components/sessions/keyboardAvoidance/useComposerKeyboardLayout.native');
    const { ComposerKeyboardProvider } = await import('@/components/sessions/keyboardAvoidance/ComposerKeyboardContext');
    const layout = await renderHook(() => useComposerKeyboardLayout({ layoutBottomInset: 80 }));
    const nameStore = createComposerTextStore('');
    const screen = await renderScreen(<ComposerKeyboardProvider layout={layout.getCurrent()}>
      <NewBotDraftHeader botCreation={{ nameStore, onSessionNameChange: nameStore.setPrompt }} />
    </ComposerKeyboardProvider>);
    const field = screen.root.find(node => node.props.testID === 'new-bot-name' && typeof node.props.onChangeText === 'function');
    act(() => keyboardBoundary.listeners.get('keyboardDidHide')?.());
    act(() => field.props.onFocus());
    act(() => keyboardBoundary.onEnd?.({ height: 300, progress: 1 }));
    expect(layout.getCurrent().bottomInset.value).toBe(220);

    act(() => field.props.onBlur());
    act(() => keyboardBoundary.listeners.get('keyboardDidHide')?.());
    act(() => keyboardBoundary.onEnd?.({ height: 300, progress: 1 }));
    expect(layout.getCurrent().bottomInset.value).toBe(0);
  });

  // Owner 2026-11-11 (New bot 02): "Surprise me" read as unclear; the face itself carries a quiet shuffle glyph.
  it('shuffles the face from a labelled glyph on the face, with no Surprise me button', async () => {
    const nameStore = createComposerTextStore('');
    const onFaceChange = vi.fn();
    const screen = await renderScreen(
      <NewBotDraftHeader botCreation={{ nameStore, onSessionNameChange: nameStore.setPrompt, face: { seed: 'draft-1' }, onFaceChange }} />,
    );
    expect(texts(screen.root)).not.toContain(t('bots.face.surprise'));
    const shuffle = screen.root.find(node => node.props.accessibilityLabel === t('bots.face.shuffle') && typeof node.props.onPress === 'function');
    await act(async () => { shuffle.props.onPress(); });
    expect(onFaceChange).toHaveBeenCalledTimes(1);
    expect(onFaceChange.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ seed: 'draft-1' }));
  });

  it('keeps an empty name empty, shows the naming hint while naming, and writes typed names through the draft owner', async () => {
    const nameStore = createComposerTextStore('');
    const written: string[] = [];
    const onSessionNameChange = vi.fn((value: string) => {
      written.push(value);
      nameStore.setPrompt(value);
    });
    const screen = await renderScreen(
      <NewBotDraftHeader botCreation={{ nameStore, onSessionNameChange }} />,
    );
    const field = screen.root.find(
      (node) =>
        node.props.testID === 'new-bot-name' &&
        typeof node.props.onChangeText === 'function',
    );
    // Empty means automatic naming: the placeholder is never the value.
    expect(field.props.value).toBe('');
    expect(field.props.placeholder).toBe(t('bots.name.placeholder'));
    expect(texts(screen.root)).toContain(t('bots.create.description'));

    await act(async () => {
      field.props.onFocus();
    });
    expect(texts(screen.root)).toContain(t('bots.name.hint'));
    expect(texts(screen.root)).not.toContain(t('bots.create.description'));

    await act(async () => {
      field.props.onChangeText('Release captain');
    });
    expect(written).toEqual(['Release captain']);
    await act(async () => {
      field.props.onBlur();
    });
    expect(texts(screen.root)).toContain(t('bots.create.description'));
    const settled = screen.root.find(
      (node) =>
        node.props.testID === 'new-bot-name' &&
        typeof node.props.onChangeText === 'function',
    );
    expect(settled.props.value).toBe('Release captain');
  });
});
