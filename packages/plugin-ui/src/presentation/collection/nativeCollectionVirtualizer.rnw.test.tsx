import * as React from 'react';
import { act } from 'react';
import { Text, View } from 'react-native';
import { afterEach, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { NATIVE_COLLECTION_VIRTUALIZER } from './nativeCollectionVirtualizer.js';

// Browser layout and scrolling are the boundary jsdom lacks. RNW's actual
// FlatList/SectionList, render mask, spacers and window updates remain real.
type LayoutNode = HTMLElement & {
  __reactLayoutHandler?: (event: Readonly<{ nativeEvent: Readonly<{
    layout: Readonly<{ x: number; y: number; width: number; height: number }>;
  }> }>) => void;
};
const viewportHeight = 613;
const rowHeight = 42;

afterEach(() => { vi.useRealTimers(); });

it.each(['flat', 'sections'] as const)('keeps the %s mounted window independent of total entry count', async kind => {
  vi.useFakeTimers();
  const profiles: Array<{ entries: number; initial: number; scrolled: number }> = [];
  // QB57's owner-approved gate compares collection sizes at identical geometry;
  // the platform's initial scroll-to-top batch is characterized, not forbidden.
  const characterize = async (count: number) => {
    const items = Array.from({ length: count }, (_, index) => ({ index }));
    const view = mountThroughReactNativeWeb(NATIVE_COLLECTION_VIRTUALIZER.render<(typeof items)[number]>({
      ...(kind === 'flat' ? { kind, items } : {
        kind,
        sections: [
          { key: 'needs-you', data: items.slice(0, 100) },
          { key: 'everything-else', data: items.slice(100) },
        ],
        renderSectionHeader: (index: number) => <View testID={`heading-${index}`} style={{ height: rowHeight }} />,
      }),
      keyForItem: item => String(item.index),
      renderItem: item => <View testID={`entry-${item.index}`} style={{ height: rowHeight }}><Text>{item.index}</Text></View>,
      role: 'list',
      testID: 'window',
      onHandle: () => {},
    }));
    try {
      const scroll = view.container.querySelector<LayoutNode>('[data-testid="window"]')!;
      const content = scroll.firstElementChild as LayoutNode;
      let contentHeight = 0;
      Object.defineProperties(scroll, {
        clientHeight: { configurable: true, get: () => viewportHeight },
        offsetHeight: { configurable: true, get: () => viewportHeight },
        clientWidth: { configurable: true, get: () => 1440 },
        offsetWidth: { configurable: true, get: () => 1440 },
        scrollHeight: { configurable: true, get: () => contentHeight },
      });
      const report = (node: LayoutNode, y: number, height: number) => node.__reactLayoutHandler?.({
        nativeEvent: { layout: { x: 0, y, width: 1440, height } },
      });
      const settle = async () => {
        for (let frame = 0; frame < 5; frame += 1) {
          await act(async () => {
            report(scroll, 0, viewportHeight);
            let y = 0;
            for (const child of Array.from(content.children) as LayoutNode[]) {
              const entry = child.querySelector('[data-testid^="entry-"]');
              const heading = child.querySelector('[data-testid^="heading-"]');
              const height = entry !== null || heading !== null ? rowHeight : Number.parseFloat(child.style.height) || 0;
              report(child, y, height);
              y += height;
            }
            contentHeight = y;
            report(content, 0, contentHeight);
            await vi.advanceTimersByTimeAsync(100);
          });
        }
      };
      await settle();
      expect(view.container.querySelector('[data-testid="entry-0"]')).not.toBeNull();
      const initial = view.container.querySelectorAll('[data-testid^="entry-"]').length;
      const targetOffset = viewportHeight * 4;
      for (let step = 0; step < 8; step += 1) {
        await act(async () => {
          scroll.scrollTop = Math.min(targetOffset, Math.max(0, contentHeight - viewportHeight));
          scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
          await vi.advanceTimersByTimeAsync(100);
        });
        await settle();
      }
      expect(scroll.scrollTop).toBe(targetOffset);
      const mounted = view.container.querySelectorAll('[data-testid^="entry-"]');
      // The midpoint of this physical viewport must remain useful after scrolling.
      const middleIndex = Math.floor((targetOffset + viewportHeight / 2) / rowHeight) - (kind === 'sections' ? 1 : 0);
      expect(view.container.querySelector(`[data-testid="entry-${middleIndex}"]`)).not.toBeNull();
      profiles.push({ entries: count, initial, scrolled: mounted.length });
    } finally {
      view.unmount();
    }
  };
  await characterize(200);
  await characterize(2000);
  expect(profiles[1]?.initial).toBe(profiles[0]?.initial);
  expect(profiles[1]?.scrolled).toBe(profiles[0]?.scrolled);
  console.info('RNW mounted-window characterization', { kind, viewportHeight, rowHeight, profiles });
});
