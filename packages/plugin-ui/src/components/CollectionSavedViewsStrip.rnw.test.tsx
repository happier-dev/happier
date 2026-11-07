import { act, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { PluginUiPresentationHostProviderInternal, type PluginUiPresentationHost } from '../presentationHost/context.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { CollectionSavedViewsStrip, type CollectionSavedViewStripItem } from './CollectionSavedViewsStrip.js';
import { PluginUiProvider } from './PluginUiProvider.js';

const VIEWS: readonly CollectionSavedViewStripItem[] = [
  { id: 'mine', label: 'Mine', icon: 'issue' },
  { id: 'team', label: 'Team', icon: 'pin' },
  { id: 'open', label: 'Open', icon: 'search' },
];
const LABELS = { title: 'Views', add: 'New view' };

function mount(element: ReactElement, host?: Partial<NonNullable<PluginUiPresentationHost['collectionSpacesStrip']>>) {
  const context = createSurfaceContext();
  const presentation: PluginUiPresentationHost = {
    renderMarkdown: () => null, renderCodeBlock: () => null, renderPopover: () => null,
    renderIcon: (input) => <span data-glyph={input.name} />,
    ...(host === undefined ? {} : { collectionSpacesStrip: {
      renderTabs: (tabs) => <div data-testid="host-tabs">{tabs.items.map((item) => {
        const tab = <button key={item.id} data-testid={item.id} aria-label={item.label} onClick={() => tabs.onSelect(item.id)}>{item.icon}</button>;
        return tabs.wrapTab ? tabs.wrapTab(item.id, tab) : tab;
      })}</div>,
      useEdgeMask: () => ({ wrapScroller: (scroller) => scroller, onScroll() {}, onViewportLayout() {}, onContentSizeChange() {} }),
      ...host,
    } }),
  };
  return mountThroughReactNativeWeb(<PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
    <PluginUiPresentationHostProviderInternal host={presentation}>{element}</PluginUiPresentationHostProviderInternal>
  </PluginUiProvider>);
}

describe('public CollectionSavedViewsStrip', () => {
  it('draws a named glyph tab per view on the hosted-web page strip, selects one and offers add', () => {
    const onSelect = vi.fn();
    const onAdd = vi.fn();
    const view = mount(<CollectionSavedViewsStrip scope="account-a" testID="strip" items={VIEWS} selectedId="team" labels={LABELS} onSelect={onSelect} onAdd={onAdd} />);
    try {
      const tabs = [...view.container.querySelectorAll('[role="tab"]')];
      expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual(['Mine', 'Team', 'Open']);
      expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
      // The strip carries no words beside its glyphs: the title names the selected view.
      expect(view.container.textContent).not.toContain('Mine');
      act(() => { (tabs[2] as HTMLElement).click(); });
      expect(onSelect).toHaveBeenCalledExactlyOnceWith('open');
      act(() => { view.container.querySelector<HTMLElement>('[aria-label="New view"]')!.click(); });
      expect(onAdd).toHaveBeenCalledTimes(1);
    } finally { view.unmount(); }
  });

  it('shows words on every tab when any view has no glyph, and offers the unselected choice first', () => {
    const onSelect = vi.fn();
    const items = [{ id: 'mine', label: 'Mine' }, { id: 'team', label: 'Team', icon: 'pin' as const }];
    const view = mount(<CollectionSavedViewsStrip scope="account-a" items={items} selectedId={null}
      labels={{ title: 'Views', unselected: 'All' }} onSelect={onSelect} />);
    try {
      const tabs = [...view.container.querySelectorAll<HTMLElement>('[role="tab"]')];
      expect(tabs.map((tab) => tab.textContent)).toEqual(['All', 'Mine', 'Team']);
      expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
      act(() => { tabs[1]!.click(); });
      expect(onSelect).toHaveBeenCalledExactlyOnceWith('mine');
    } finally { view.unmount(); }
  });

  it('reaches the host for its bar, shortcuts, labels, swipe and drag', () => {
    const onSelect = vi.fn();
    const onReorder = vi.fn(async () => true);
    const commands: { enabled: boolean; selectOrdinal: (ordinal: number) => boolean }[] = [];
    const reorderInputs: unknown[] = [];
    const swipes: { canPrevious: boolean; canNext: boolean; onCommit: (direction: -1 | 1) => void }[] = [];
    const view = mount(<CollectionSavedViewsStrip scope="account-a" items={VIEWS} selectedId="team" labels={LABELS} onSelect={onSelect} onReorder={onReorder} shortcuts />, {
      useOrdinalLabel: () => (ordinal) => `⌃${ordinal}`,
      useOrdinalCommands: (input) => { commands.push(input); },
      useReorder: (input) => { reorderInputs.push(input); return {
        wrapList: (tabs: ReactNode) => <div data-testid="reorder-list">{tabs}</div>,
        wrapTab: (id: string, tab: ReactElement) => <div key={id} data-reorder-row={id}>{tab}</div>,
      }; },
      SwipeZone: (props) => { swipes.push(props); return <>{props.children}</>; },
    });
    try {
      expect(view.container.querySelector('[data-testid="host-tabs"]')).not.toBeNull();
      expect(view.container.querySelector('[aria-label="Team · ⌃2"]')).not.toBeNull();
      // Drag speaks the caller's own view ids, around every tab.
      expect(reorderInputs.at(-1)).toMatchObject({ items: [{ id: 'mine', name: 'Mine' }, { id: 'team', name: 'Team' }, { id: 'open', name: 'Open' }], onReorder });
      expect([...view.container.querySelectorAll('[data-reorder-row]')].map((row) => row.getAttribute('data-reorder-row'))).toEqual(['mine', 'team', 'open']);
      expect(commands.at(-1)?.enabled).toBe(true);
      expect(commands.at(-1)?.selectOrdinal(3)).toBe(true);
      expect(onSelect).toHaveBeenLastCalledWith('open');
      expect(commands.at(-1)?.selectOrdinal(9)).toBe(false);
      expect(swipes.at(-1)).toMatchObject({ canPrevious: true, canNext: true });
      act(() => { swipes.at(-1)!.onCommit(-1); });
      expect(onSelect).toHaveBeenLastCalledWith('mine');
    } finally { view.unmount(); }
  });
});
