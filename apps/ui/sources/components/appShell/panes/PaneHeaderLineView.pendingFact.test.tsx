import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flattenTestStyle, renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

afterEach(() => standardCleanup());

const { PaneHeaderLineView } = await import('./PaneHeader');

/** Every host text node that draws `text`, with its own and its ancestors' opacity. */
function drawnOpacity(
  screen: Awaited<ReturnType<typeof renderScreen>>,
  text: string,
): number | null {
  const node = screen.root.findAll(
    (candidate) =>
      typeof candidate.type === 'string' &&
      (candidate.children ?? []).some(
        (child) => typeof child === 'string' && child.includes(text),
      ),
  )[0];
  if (!node) return null;
  let opacity = 1;
  for (
    let current: typeof node | null = node;
    current;
    current = current.parent
  ) {
    const value = flattenTestStyle(current.props?.style)?.opacity;
    if (typeof value === 'number') opacity *= value;
  }
  return opacity;
}

describe('PaneHeaderLineView pending fact', () => {
  it.each([false, true])(
    'keeps a fact that has not arrived in its room, unseen and unannounced (large=%s)',
    async (large) => {
      const screen = await renderScreen(
        <PaneHeaderLineView
          line={{
            segments: ['repo on Mac', { text: '0 changed', pending: true }],
          }}
          large={large}
          testID="header"
        />,
      );
      // The words hold the line's room (wrapping as the real fact will) without being seen.
      expect(drawnOpacity(screen, '0 changed')).toBe(0);
      expect(drawnOpacity(screen, 'repo on Mac')).toBe(1);
      // Nothing of the pending fact is reachable by VoiceOver, its separator included (native reads each text node).
    const pendingText = screen.root.findAll((candidate) => typeof candidate.type === 'string'
      && (candidate.children ?? []).some((child) => typeof child === 'string' && child.includes('0 changed')))[0]!;
    let hidden = false;
    for (let current: typeof pendingText | null = pendingText; current; current = current.parent) {
      if (current.props?.accessibilityElementsHidden === true) { hidden = true; break; }
    }
    expect(hidden).toBe(true);
    if (large) {
      // In the wrapping layout each separator trails its fact: the seen fact before a pending one draws none,
      // so no separator joins the pending fact where it can be seen or read.
      const separators = screen.root.findAll((node) => typeof node.type === 'string'
        && (node.children ?? []).some((child) => child === '·'));
      const seenSeparators = separators.filter((node) => {
        for (let current: typeof node | null = node; current; current = current.parent) {
          if (current.props?.accessibilityElementsHidden === true) return false;
        }
        return true;
      });
      expect(seenSeparators).toEqual([]);
    }
    const subtitle = screen.findByTestId('header.subtitle');
      expect(String(subtitle?.props.accessibilityLabel ?? '')).not.toContain(
        '0 changed',
      );
      await screen.unmount?.();
    },
  );
});
