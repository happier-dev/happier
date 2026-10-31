import { act, type ReactNode } from 'react';
import { View } from 'react-native';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { HappierUiPalette } from '../environment/types.js';
import type { PluginUiPresentationHost } from '../presentationHost/context.js';
import { COLLECTION_RAIL_MIN_WIDTH_PX, HAPPIER_COLLECTION_LIST_METRICS, HAPPIER_COLLECTION_LIST_TEXT, resolveHappierCollectionListRowPadding } from '../presentation/collection/CollectionList.js';
import { HAPPIER_COLLECTION_RAIL_WIDTH_PX } from '../presentation/layout/pageMetrics.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { NavigationList } from './NavigationList.js';
import { PluginUiProviderInternal } from './PluginUiProvider.js';

/**
 * Shell extensibility O4: a plugin column is the shell's own navigation anatomy. A plugin-mounted
 * `NavigationList` lies on the host's plane (it paints no ground of its own), draws flat rows on the
 * shared gutter and content inset, and marks the open row with the plane's selected chip and a
 * heavier title — the same owner the core Settings/Plugins columns read.
 */
const PALETTE = {
  page: '#fafafa',
  sheet: '#f1f2f3',
  sheetBorder: '#0a0b0c',
  rowDivider: '#070809',
  groupDivider: '#0d0e0f',
  controlBorder: '#d6d6d6',
  fieldBackground: '#ffffff',
  placeholder: '#999999',
  selection: '#111111',
  switchTrackOn: '#1976d2',
  switchTrackOff: '#dddddd',
  switchThumb: '#ffffff',
  segmentTrack: '#eeeeee',
  segmentThumb: '#ffffff',
  navigationSelected: '#123456',
  navigationHover: '#654321',
} satisfies HappierUiPalette;

function mount(children: ReactNode) {
  const context = createSurfaceContext();
  const presentationHost = {
    palette: PALETTE,
    renderMarkdown: () => null,
    renderPopover: () => null,
    renderIcon: () => null,
  } as unknown as PluginUiPresentationHost;
  return mountThroughReactNativeWeb(
    <PluginUiProviderInternal hostApi={createHostApiStub(context)} context={context} presentationHost={presentationHost}>
      {children}
    </PluginUiProviderInternal>,
  );
}

function byTestId(container: HTMLElement, testID: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
  if (!element) throw new Error(`missing ${testID}`);
  return element;
}

function rgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
}

function textWeight(row: HTMLElement, text: string): string {
  const node = [...row.querySelectorAll<HTMLElement>('div, span')].find((element) => element.textContent === text
    && element.children.length === 0);
  if (!node) throw new Error(`missing text ${text}`);
  return node.style.fontWeight;
}

describe('NavigationList (public plugin column anatomy)', () => {
  it('fits a mark, readable title and trailing glyph below the standard rail default', () => {
    const titleWidth = 16 * HAPPIER_COLLECTION_LIST_TEXT.rowTitle.fontSize * 0.5;
    const rowDemand = 2 * HAPPIER_COLLECTION_LIST_METRICS.contentInset
      + Math.max(HAPPIER_COLLECTION_LIST_METRICS.markSize, HAPPIER_COLLECTION_LIST_METRICS.rowGlyphBox)
      + HAPPIER_COLLECTION_LIST_METRICS.rowGlyphGap + titleWidth + HAPPIER_COLLECTION_LIST_METRICS.rowGlyphBox;
    expect(COLLECTION_RAIL_MIN_WIDTH_PX).toBeGreaterThanOrEqual(rowDemand);
    const headerDemand = 2 * HAPPIER_COLLECTION_LIST_METRICS.contentInset
      + HAPPIER_COLLECTION_LIST_METRICS.titleRowHeight + HAPPIER_COLLECTION_LIST_METRICS.headerGap
      + 16 * HAPPIER_COLLECTION_LIST_TEXT.title.fontSize * 0.5;
    expect(COLLECTION_RAIL_MIN_WIDTH_PX).toBeGreaterThanOrEqual(headerDemand);
    expect(COLLECTION_RAIL_MIN_WIDTH_PX).toBeLessThan(HAPPIER_COLLECTION_RAIL_WIDTH_PX.standard);
  });
  it('presents an explicit qualified row destination through the host without replacing ordinary activation', () => {
    const context = createSurfaceContext();
    const onOpen = vi.fn();
    // The app presentation bridge is the boundary: it owns route generation and browser gestures.
    const presentationHost = {
      renderMarkdown: () => null, renderPopover: () => null, renderIcon: () => null,
      renderDestinationRow: (input: Readonly<{ destination: Readonly<{ pluginId: string; localId: string }>; subPath?: string; children: ReactNode }>) => (
        <View testID={`destination:${input.destination.pluginId}:${input.destination.localId}:${input.subPath ?? ''}`}>{input.children}</View>
      ),
    } as unknown as PluginUiPresentationHost;
    const view = mountThroughReactNativeWeb(
      <PluginUiProviderInternal hostApi={createHostApiStub(context)} context={context} presentationHost={presentationHost}>
        <NavigationList.Row title="Needs review" testID="destination-row" onPress={onOpen}
          destination={{ destination: { pluginId: 'triage', localId: 'triage' }, subPath: 'e,source,pulls,42' }} />
      </PluginUiProviderInternal>,
    );
    expect(view.container.querySelector('[data-testid="destination:triage:triage:e,source,pulls,42"]')).not.toBeNull();
    act(() => byTestId(view.container, 'destination-row').click());
    expect(onOpen).toHaveBeenCalledTimes(1);
    view.unmount();
  });
  it('focuses its only search input when the surrounding field is tapped', () => {
    const view = mount(<NavigationList search={{ value: '', onValueChange: () => undefined, label: 'Search channels', testID: 'search' }} />);
    const input = byTestId(view.container, 'search');
    const frame = input.parentElement!;
    act(() => frame.click());
    expect(document.activeElement).toBe(input);
    expect(frame.getAttribute('tabindex')).toBe('-1');
    view.unmount();
  });
  it('lies on the host plane and draws the header, a quiet group label and flat rows with the selected chip', () => {
    const onOpen = vi.fn();
    const view = mount(
      <NavigationList testID="views" title="Views" count={2} headerAction={<View testID="new-view" />}>
        <NavigationList.Group title="Saved" count={2}>
          <NavigationList.Row testID="row-open" title="Needs review" selected onPress={() => onOpen('open')} />
          <NavigationList.Row testID="row-other" title="Mine" onPress={() => onOpen('other')} />
        </NavigationList.Group>
      </NavigationList>,
    );

    const root = byTestId(view.container, 'views');
    // The plane belongs to the host column: the list paints nothing behind itself.
    expect(['', 'rgba(0, 0, 0, 0)', 'transparent']).toContain(getComputedStyle(root).backgroundColor);
    expect(root.textContent).toContain('Views');
    expect(root.textContent).toContain('Saved');
    expect(view.container.querySelector('[data-testid="new-view"]')).not.toBeNull();
    expect(view.container.querySelector('[role="heading"]')?.textContent).toBe('Views');

    const open = byTestId(view.container, 'row-open');
    const other = byTestId(view.container, 'row-other');
    // The selected chip is the plane's (host) selection colour; the other row stays flat.
    expect(getComputedStyle(open).backgroundColor).toBe(rgb(PALETTE.navigationSelected));
    expect(['', 'rgba(0, 0, 0, 0)', 'transparent']).toContain(getComputedStyle(other).backgroundColor);
    // The chip's contrast against the plane is low, so the title's weight carries the state too.
    expect(Number(textWeight(open, 'Needs review'))).toBeGreaterThan(Number(textWeight(other, 'Mine')));
    // One geometry owner for core and plugin navigation rows: the gutter and the content inset.
    expect(getComputedStyle(open).marginLeft).toBe(`${HAPPIER_COLLECTION_LIST_METRICS.rowInset}px`);
    expect(getComputedStyle(open).marginRight).toBe(`${HAPPIER_COLLECTION_LIST_METRICS.rowInset}px`);
    // The glyph column starts on the list's text edge (gutter + ring + the row's own padding).
    const content = open.firstElementChild as HTMLElement;
    const px = (value: string) => Number.parseFloat(value || '0');
    expect(px(getComputedStyle(open).marginLeft) + px(getComputedStyle(open).borderLeftWidth)
      + px(getComputedStyle(content).paddingLeft)).toBe(HAPPIER_COLLECTION_LIST_METRICS.contentInset);
    expect(resolveHappierCollectionListRowPadding(0).paddingLeft)
      .toBe(HAPPIER_COLLECTION_LIST_METRICS.contentInset - HAPPIER_COLLECTION_LIST_METRICS.rowInset);
    // Selection is announced, not only drawn.
    expect(open.getAttribute('aria-current')).toBe('page');
    expect(other.getAttribute('aria-current')).toBeNull();

    act(() => other.click());
    expect(onOpen).toHaveBeenCalledWith('other');
    view.unmount();
  });

  it('lets a row, a group and the column foot speak for a state without restyling the anatomy', () => {
    const onFoot = vi.fn();
    const renderIcon = vi.fn((input: Readonly<{ name: string }>) => <View testID={`icon-${input.name}`} />);
    const context = createSurfaceContext();
    const presentationHost = {
      palette: PALETTE,
      renderMarkdown: () => null,
      renderPopover: () => null,
      renderIcon,
    } as unknown as PluginUiPresentationHost;
    const view = mountThroughReactNativeWeb(
      <PluginUiProviderInternal hostApi={createHostApiStub(context)} context={context} presentationHost={presentationHost}>
        <NavigationList
          testID="channels"
          title="Channels"
          footer={{ title: 'Bots & connections', icon: 'settings', onPress: onFoot, testID: 'foot' }}
        >
          <NavigationList.Group
            title="Telegram"
            mark={<View testID="telegram-mark" />}
            status={{ kind: 'attention', label: 'Bot needs you' }}
          >
            <NavigationList.Row testID="row-quiet" title="Ops on-call" onPress={() => undefined} />
          </NavigationList.Group>
          <NavigationList.Group title="Discord">
            <NavigationList.Row testID="row-paused" title="support" status={{ kind: 'paused', label: 'Paused' }} onPress={() => undefined} />
            <NavigationList.Row testID="row-attention" title="#2493" status={{ kind: 'attention', label: 'Needs a new transcript start' }} onPress={() => undefined} />
          </NavigationList.Group>
        </NavigationList>
      </PluginUiProviderInternal>,
    );

    // A group carries its identity mark and one worded status; its rows stay unmarked.
    const header = [...view.container.querySelectorAll<HTMLElement>('[role="heading"]')]
      .find((element) => element.textContent?.includes('Telegram'));
    expect(header?.querySelector('[data-testid="telegram-mark"]')).not.toBeNull();
    expect(header?.textContent).toContain('Bot needs you');
    expect(byTestId(view.container, 'row-quiet').querySelector('[data-testid^="icon-"]')).toBeNull();

    // A row's end speaks only for a state, as a glyph, and its name says it too.
    expect(byTestId(view.container, 'row-paused').querySelector('[data-testid="icon-pause"]')).not.toBeNull();
    expect(byTestId(view.container, 'row-attention').querySelector('[data-testid="icon-warning"]')).not.toBeNull();
    expect(byTestId(view.container, 'row-paused').getAttribute('aria-label')).toBe('support, Paused');
    expect(byTestId(view.container, 'row-attention').getAttribute('aria-label')).toBe('#2493, Needs a new transcript start');

    // The foot row sits outside the scroller, under the rows, and navigates.
    const foot = byTestId(view.container, 'foot');
    expect(foot.textContent).toContain('Bots & connections');
    expect(byTestId(view.container, 'channels').lastElementChild?.contains(foot)).toBe(true);
    act(() => foot.click());
    expect(onFoot).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('offers search only when the author passes it, and filters nothing itself', async () => {
    const onChange = vi.fn();
    const view = mount(
      <NavigationList testID="views" title="Views">
        <NavigationList.Row testID="row" title="All" onPress={() => undefined} />
      </NavigationList>,
    );
    onTestFinished(() => view.unmount());
    expect(view.container.querySelector('input')).toBeNull();
    await view.render(
      <PluginUiProviderInternal
        hostApi={createHostApiStub(createSurfaceContext())}
        context={createSurfaceContext()}
        presentationHost={{ palette: PALETTE, renderMarkdown: () => null, renderPopover: () => null, renderIcon: () => null } as unknown as PluginUiPresentationHost}
      >
        <NavigationList
          testID="views"
          title="Views"
          search={{ value: 'no matching view', onValueChange: onChange, label: 'Search views', testID: 'views-search' }}
        >
          <NavigationList.Row testID="row" title="All" onPress={() => undefined} />
        </NavigationList>
      </PluginUiProviderInternal>,
    );
    const input = view.container.querySelector<HTMLInputElement>('input');
    expect(input).not.toBeNull();
    expect(input?.getAttribute('placeholder')).toBe('Search views');
    expect(input?.value).toBe('no matching view');
    expect(byTestId(view.container, 'row').textContent).toContain('All');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'another missing view');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledExactlyOnceWith('another missing view');
    expect(byTestId(view.container, 'row').textContent).toContain('All');
  });
});
