import { Pressable, Text, View } from 'react-native';
import { act, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { PageHeader } from './PageHeader.js';
import type { HappierLayoutChangeEvent } from '../presentation/portableTypes.js';
import { HAPPIER_PAGE_METRICS } from '../presentation/layout/pageMetrics.js';
import { HAPPIER_PAGE_TEXT } from '../presentation/layout/pageText.js';

describe('public PageHeader composition', () => {
  it.each([[undefined, false], ['hang', true]] as const)('with actionsLayout %s the mark hangs from the title line: %s', (actionsLayout, hanging) => {
    const context = createSurfaceContext();
    const view = mountThroughReactNativeWeb(<PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <PageHeader testID="header" title="Machine" actionsLayout={actionsLayout} description="One purpose line."
        leading={<View testID="mark" />} actions={<Text>Act</Text>} />
    </PluginUiProvider>);
    try {
      const header = view.container.querySelector('[data-testid="header"]')!;
      const heights: string[] = [];
      for (let node = view.container.querySelector('[data-testid="mark"]')!.parentElement!; node !== header; node = node.parentElement!) {
        heights.push(getComputedStyle(node).height);
      }
      expect(heights.includes(`${HAPPIER_PAGE_TEXT.pageTitle.lineHeight}px`)).toBe(hanging);
    } finally { view.unmount(); }
  });

  it('copies a mono fact whole on tap, says Copied in its place, and keeps the full value named', async () => {
    const context = createSurfaceContext();
    const written: string[] = [];
    const value = '/home/person/projects/happier/apps/ui/sources/components/ui/layout';
    const view = mountThroughReactNativeWeb(<PluginUiProvider
      hostApi={createHostApiStub(context, { writeClipboard: async (text: string) => { written.push(text); } })} context={context}>
      <PageHeader title="Machine" leading={<View />} meta={[{ key: 'path', text: value, mono: true }]} />
    </PluginUiProvider>);
    try {
      const fact = view.container.querySelector<HTMLElement>(`[aria-label="${value}"]`)!;
      expect(fact).not.toBeNull();
      await act(async () => { fact.click(); });
      expect(written).toEqual([value]);
      expect(view.container.textContent).toContain('Copied');
    } finally { view.unmount(); }
  });

  it.each([undefined, 'centered'] as const)('retains an open, focused action across measured wrapping (%s compact presentation)', compactPresentation => {
    function Menu() {
      const [open, setOpen] = useState(false);
      return <Pressable testID="menu" accessibilityRole="button" aria-expanded={open} onPress={() => setOpen(current => !current)}>
        <Text>{open ? 'Open menu' : 'Closed menu'}</Text>
      </Pressable>;
    }
    const context = createSurfaceContext();
    const view = mountThroughReactNativeWeb(<PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <PageHeader testID="header" title="Prepare the release" compactPresentation={compactPresentation}
        description="Review before publishing." leading={<View />} meta={[{ key: 'machine', text: 'Development machine' }]}
        actions={<Menu />} />
    </PluginUiProvider>);
    // Like the neighboring layout-owner tests, deliver platform measurement to RNW's real handler;
    // jsdom supplies no ResizeObserver. No header decisions or React state are substituted.
    const handler = (node: Element) => Reflect.get(node, '__reactLayoutHandler') as ((event: HappierLayoutChangeEvent) => void) | undefined;
    const header = view.container.querySelector<HTMLElement>('[data-testid="header"]')!;
    const layout = (node: Element, width: number, height: number) => act(() => handler(node)!({ nativeEvent: { layout: { x: 0, y: 0, width, height } } }));
    const measuredAncestors = (node: Element) => {
      const boxes: Element[] = [];
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        if (handler(parent)) boxes.push(parent);
        if (parent === header) break;
      }
      return boxes;
    };
    const titleBoxes = () => measuredAncestors(header.querySelector('[role="heading"]')!);
    const menu = view.container.querySelector<HTMLElement>('[data-testid="menu"]')!;
    try {
      layout(header, 800, 100);
      layout(titleBoxes()[0]!, 300, 30);
      layout(measuredAncestors(menu)[0]!, 300, 34);
      layout(titleBoxes().at(-2)!, 800, 60);
      act(() => { menu.click(); menu.focus(); });
      expect(menu.getAttribute('aria-expanded')).toBe('true');
      expect(document.activeElement).toBe(menu);
      for (const width of [400, 800]) {
        layout(header, width, 100);
        const identity = titleBoxes().at(-2);
        if (identity) layout(identity, width, 60);
        expect(view.container.querySelector('[data-testid="menu"]')).toBe(menu);
        expect(document.activeElement).toBe(menu);
        expect(menu.getAttribute('aria-expanded')).toBe('true');
      }
      act(() => menu.click());
      expect(menu.getAttribute('aria-expanded')).toBe('false');
    } finally {
      view.unmount();
    }
  });

  it('shows a column summary after the identity row and retains an actionable control', () => {
    const context = createSurfaceContext();
    let refreshed = false;
    const view = mountThroughReactNativeWeb(<PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <PageHeader testID="header" title="Personal" compactPresentation="centered" detailsPlacement="column" details={<Text testID="summary">2 accounts need attention</Text>} actions={<Pressable accessibilityRole="button" testID="refresh" onPress={() => { refreshed = true; }}><Text>Refresh</Text></Pressable>} />
    </PluginUiProvider>);
    try {
      expect(view.container.querySelector('[data-testid="summary"]')?.textContent).toBe('2 accounts need attention');
      expect(view.container.querySelector('[data-testid="header-title-row"] [data-testid="summary"]')).toBeNull();
      act(() => view.container.querySelector<HTMLElement>('[data-testid="refresh"]')?.click());
      expect(refreshed).toBe(true);
    } finally {
      view.unmount();
    }
  });
  it('draws the leading mark in the page header mark slot and keeps a control line before controls arrive', () => {
    const context = createSurfaceContext();
    const view = mountThroughReactNativeWeb(<PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <PageHeader testID="header" title="Plugin Inspector" description="Inspect plugins." leading={<View testID="mark" />} />
    </PluginUiProvider>);
    try {
      const slot = view.container.querySelector<HTMLElement>('[data-testid="mark"]')!.parentElement!;
      expect(getComputedStyle(slot).width).toBe(`${HAPPIER_PAGE_METRICS.pageHeaderMarkSlotPx}px`);
      expect(getComputedStyle(slot).height).toBe(`${HAPPIER_PAGE_METRICS.pageHeaderMarkSlotPx}px`);
      // No controls yet, yet the title line already holds a control's height (the chip arrives later).
      const titleRow = view.container.querySelector<HTMLElement>('[data-testid="header-title-row"]')!;
      const heights = Array.from(titleRow.querySelectorAll<HTMLElement>('div')).map(node => getComputedStyle(node).minHeight);
      expect(heights).toContain(`${HAPPIER_PAGE_METRICS.controlHeightPx}px`);
    } finally {
      view.unmount();
    }
  });
});
