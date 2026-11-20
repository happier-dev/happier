/**
 * Round 4 item 4: while Command or Control is held over the picker, each favourite with a live
 * shortcut binding shows its digit at the end of its name line. The slot comes from the favourite
 * owner's `shortcutSlotByKey`; the held state comes from SelectionList's own modifier report.
 */
import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

vi.mock('@legendapp/list/react-native', async (importOriginal) => {
  const { createCapturingLegendListMock } =
    await import('@/dev/testkit/mocks/legendList');
  return createCapturingLegendListMock({
    original: await importOriginal<Record<string, unknown>>(),
    renderItems: true,
    renderItemLimit: 4,
    memoizeItems: true,
  }).module;
});

const { OptionPickerOverlay } = await import('./OptionPickerOverlay');

const keyEvent = (type: string, init: Readonly<Record<string, unknown>>) =>
  Object.assign(new Event(type), init);

const OPTIONS = [
  { value: 'opus', label: 'Opus 5.5' },
  { value: 'sonnet', label: 'Sonnet 5.5' },
  { value: 'haiku', label: 'Haiku 5.5' },
];

describe('OptionPickerOverlay held-modifier slot hints', () => {
  it.each(['metaKey', 'ctrlKey'] as const)(
    'shows each bound favourite its digit while %s is held, and clears on keyup and blur',
    async (modifier) => {
      const activated: number[] = [];
      // The window is the platform boundary the list's modifier listener attaches to.
      const win = Object.assign(new EventTarget(), { matchMedia: () => ({ matches: true }) });
      vi.stubGlobal('window', win);
      const screen = await renderScreen(
        <OptionPickerOverlay
          title="Model"
          options={OPTIONS}
          selectedValue="haiku"
          emptyText="Empty"
          canEnterCustomValue={false}
          onSelect={() => {}}
          quickActionShortcuts={[
            { shortcut: 'cmd+1', onActivate: () => activated.push(1) },
            { shortcut: 'cmd+2', onActivate: () => activated.push(2) },
          ]}
          favoriteOptions={{
            // Haiku is a favourite without a live binding: it gets no digit.
            values: new Set(['opus', 'sonnet', 'haiku']),
            shortcutSlotByKey: new Map([
              ['opus', 1],
              ['sonnet', 2],
            ]),
            onToggle: () => {},
          }}
        />,
      );
      try {
        const hint = (key: string) =>
          screen.findHostByTestId(`model-picker-overlay-option-slot-hint:${key}`);
        const key = modifier === 'metaKey' ? 'Meta' : 'Control';
        const send = async (event: Event) => {
          await act(async () => {
            win.dispatchEvent(event);
          });
        };
        expect(hint('opus')).toBeNull();

        await send(keyEvent('keydown', { key, [modifier]: true }));
        expect(hint('opus')?.props.accessibilityLabel).toBe('1');
        expect(hint('sonnet')?.props.accessibilityLabel).toBe('2');
        expect(hint('haiku')).toBeNull();

        // The digit the hint names is the one the list dispatches.
        const list = screen.findHostByTestId('model-picker-overlay-selection-list');
        const digit = Object.assign(new Event('keydown', { cancelable: true }), { key: '2', [modifier]: true });
        await act(async () => {
          list!.props.onKeyDown(digit);
        });
        expect(activated).toEqual([2]);

        await send(keyEvent('keyup', { key }));
        expect(hint('opus')).toBeNull();

        await send(keyEvent('keydown', { key, [modifier]: true }));
        expect(hint('opus')).not.toBeNull();
        await send(new Event('blur'));
        expect(hint('opus')).toBeNull();
      } finally {
        await screen.unmount();
        vi.unstubAllGlobals();
      }
    },
  );
});
