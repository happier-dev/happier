import * as React from 'react';
import { act } from 'react';
import { afterAll, expect, it, vi } from 'vitest';
import { View } from 'react-native';
import { SURFACE_CONTEXT_THEME_FIXTURE } from '@happier-dev/plugin-sdk/testing';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { HappierCollectionTableRowContext } from './CollectionList.js';
import { HappierListItem, HappierRowActionsReveal } from './List.js';
import { NATIVE_COLLECTION_VIRTUALIZER } from './nativeCollectionVirtualizer.js';

// The browser and regression count the same accepted React work. Install before ReactDOM.
const probe = await vi.hoisted(async () => {
  const { readFile } = await import('node:fs/promises');
  Function(await readFile(`${process.cwd()}/../../apps/stack/scripts/perf/browser-probe.js`, 'utf8'))();
  return (globalThis as typeof globalThis & { __happierPerfProbe: {
    reset(): void;
    collect(): { components: Record<string, { renders: number }> };
    stop(): void;
  } }).__happierPerfProbe;
});
afterAll(() => probe.stop());

it.each([true, false])('keeps row content out of pointer scroll updates in a 2095-entry native collection (hairline: %s)', hairline => {
  const previousMatchMedia = globalThis.matchMedia;
  // Browser input capability is the boundary; the virtualizer and row owners remain real.
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: fine)' || query === '(hover: hover)' }));
  const items = Array.from({ length: 2095 }, (_, index) => ({ index }));
  const view = mountThroughReactNativeWeb(NATIVE_COLLECTION_VIRTUALIZER.render({
    kind: 'flat', items, keyForItem: item => String(item.index),
    role: 'list', onHandle: () => {},
    renderItem: item => <HappierCollectionTableRowContext.Provider value={{ hairline }}>
      <HappierListItem theme={SURFACE_CONTEXT_THEME_FIXTURE} title={`Entry ${item.index}`}
        testID={`entry-${item.index}`} onPress={() => {}} hasSecondaryActions
        accessoryOutsidePressable accessoryIsRowActions
        accessory={<HappierRowActionsReveal><View testID={`action-${item.index}`} /></HappierRowActionsReveal>} />
    </HappierCollectionTableRowContext.Provider>,
  }));
  try {
    const row = view.container.querySelector<HTMLElement>('[data-testid="entry-0"]')!;
    const action = view.container.querySelector<HTMLElement>('[data-testid="action-0"]')!;
    const opacity = () => {
      for (let node: HTMLElement | null = action; node && node !== view.container; node = node.parentElement)
        if (getComputedStyle(node).opacity === '0') return '0';
      return '1';
    };
    const mounted = view.container.querySelectorAll('[data-testid^="entry-"]').length;
    expect(mounted).toBeLessThan(items.length);
    expect(opacity()).toBe('0');
    probe.reset();
    act(() => row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(opacity()).toBe('1');
    act(() => row.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
    expect(opacity()).toBe('0');
    expect(view.container.querySelectorAll('[data-testid^="entry-"]')).toHaveLength(mounted);
    expect(probe.collect().components.HappierListItem?.renders ?? 0).toBe(0);
  } finally {
    view.unmount();
    vi.stubGlobal('matchMedia', previousMatchMedia);
  }
});
