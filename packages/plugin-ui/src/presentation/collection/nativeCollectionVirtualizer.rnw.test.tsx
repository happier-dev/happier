import * as React from 'react';
import { act } from 'react';
import { FlatList, SectionList, Text, View } from 'react-native';
import { afterEach, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { NATIVE_COLLECTION_VIRTUALIZER } from './nativeCollectionVirtualizer.js';
import type { CollectionVirtualizerHandle } from './collectionVirtualizer.js';
import { PluginUiPresentationHostProviderInternal, type PluginUiPresentationHost } from '../../presentationHost/context.js';

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

it.each(['flat', 'sections'] as const)('drops a removed unmeasured reveal in a shrinking %s window', async kind => {
  const items = Array.from({ length: 200 }, (_, index) => ({ index }));
  let handle: CollectionVirtualizerHandle | null = null;
  const render = (rows: typeof items) => NATIVE_COLLECTION_VIRTUALIZER.render({
    ...(kind === 'flat' ? { kind, items: rows } : {
      kind, sections: [{ key: 'rows', data: rows }], renderSectionHeader: () => null,
    }),
    keyForItem: (item: typeof items[number]) => String(item.index),
    renderItem: (item: typeof items[number]) => <Text>{item.index}</Text>,
    role: 'list', testID: 'shrinking-window', onHandle: next => { handle = next; },
  });
  const view = mountThroughReactNativeWeb(render(items));
  try {
    act(() => { handle!.reveal({ index: 199, ...(kind === 'sections' ? { sectionIndex: 0 } : {}) }); });
    await view.render(render(items.slice(0, 1)));
    const scroll = view.container.querySelector<LayoutNode>('[data-testid="shrinking-window"]')!;
    // RNW reports content measurement after filtering; this retries an unmeasured reveal.
    expect(() => act(() => {
      (scroll.firstElementChild as LayoutNode).__reactLayoutHandler?.({
        nativeEvent: { layout: { x: 0, y: 0, width: 800, height: rowHeight } },
      });
    })).not.toThrow();
  } finally { view.unmount(); }
});

it.each(['flat', 'sections'] as const)('re-resolves a retained unmeasured reveal in a shrinking %s window', async kind => {
  const items = Array.from({ length: 200 }, (_, index) => ({ index }));
  // Observe the real RNW positioning boundary; its unmeasured failure stays real.
  const flatReveal = vi.spyOn(FlatList.prototype, 'scrollToIndex');
  const sectionReveal = vi.spyOn(SectionList.prototype, 'scrollToLocation');
  let handle: CollectionVirtualizerHandle | null = null;
  const render = (rows: typeof items) => NATIVE_COLLECTION_VIRTUALIZER.render({
    ...(kind === 'flat' ? { kind, items: rows } : {
      kind, sections: [{ key: 'rows', data: rows }], renderSectionHeader: () => null,
    }),
    keyForItem: (item: typeof items[number]) => String(item.index),
    renderItem: (item: typeof items[number]) => <Text>{item.index}</Text>,
    role: 'list', testID: 'retained-window', onHandle: next => { handle = next; },
  });
  const view = mountThroughReactNativeWeb(render(items));
  try {
    act(() => { handle!.reveal({ index: 199, ...(kind === 'sections' ? { sectionIndex: 0 } : {}) }); });
    await view.render(render(items.slice(190)));
    const scroll = view.container.querySelector<LayoutNode>('[data-testid="retained-window"]')!;
    act(() => {
      (scroll.firstElementChild as LayoutNode).__reactLayoutHandler?.({
        nativeEvent: { layout: { x: 0, y: 0, width: 800, height: rowHeight * 10 } },
      });
    });
    if (kind === 'flat') expect(flatReveal).toHaveBeenLastCalledWith(expect.objectContaining({ index: 9 }));
    else expect(sectionReveal).toHaveBeenLastCalledWith(expect.objectContaining({ sectionIndex: 0, itemIndex: 9 }));
  } finally { view.unmount(); flatReveal.mockRestore(); sectionReveal.mockRestore(); }
});

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

it.each(['flat', 'sections'] as const)('offers its %s scroller to what its rows disclose, so a disclosed diff nests no scroller of its own', async kind => {
  // QB-81: the host binds a disclosed diff's line windowing to the node this list hands over.
  let getScrollNode: (() => unknown) | undefined;
  const host: PluginUiPresentationHost = {
    renderMarkdown: () => null, renderCodeBlock: () => null, renderPopover: () => null, renderIcon: () => null,
    renderCollectionScrollRoot: input => { getScrollNode = input.getScrollNode; return input.children; },
  };
  const items = Array.from({ length: 20 }, (_, index) => ({ index }));
  const view = mountThroughReactNativeWeb(<PluginUiPresentationHostProviderInternal host={host}>
    {NATIVE_COLLECTION_VIRTUALIZER.render({
      ...(kind === 'flat' ? { kind, items } : { kind, sections: [{ key: 'rows', data: items }], renderSectionHeader: () => null }),
      keyForItem: (item: typeof items[number]) => String(item.index),
      renderItem: (item: typeof items[number]) => <Text>{item.index}</Text>,
      role: 'list', testID: 'offered-scroller', onHandle: () => {},
    })}
  </PluginUiPresentationHostProviderInternal>);
  try {
    const scroller = view.container.querySelector('[data-testid="offered-scroller"]');
    expect(scroller).not.toBeNull();
    expect(getScrollNode?.()).toBe(scroller);
  } finally { view.unmount(); }
});
