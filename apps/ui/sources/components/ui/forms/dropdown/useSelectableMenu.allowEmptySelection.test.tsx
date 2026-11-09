import { useLayoutEffect } from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import type { SelectableMenuItem } from '@/components/ui/forms/dropdown/selectableMenuTypes';
import { installDropdownCommonModuleMocks } from './dropdownTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installDropdownCommonModuleMocks();

describe('useSelectableMenu (allowEmptySelection)', () => {
  it('keeps keyboard selection work local in a 54,935-item source and admits a real replacement', async () => {
    const { useSelectableMenu } = await import('./useSelectableMenu');
    let identityReads = 0;
    const makeItem = (id: string, title: string): SelectableMenuItem => ({
      get id() { identityReads += 1; return id; }, title,
    });
    const items = Array.from({ length: 54_935 }, (_, index) => makeItem(`file-${index}`, `File ${index}`));
    const makeSource = (rows: readonly SelectableMenuItem[]) => ({
      items: rows,
      indexById: new Map(rows.map((item, index) => [item.id, index])),
      getItem: (index: number) => rows[index],
    });
    let itemSource = makeSource(items);
    const hook = await renderHook(() => useSelectableMenu({
      items: itemSource.items, itemSource, initialSelectedId: 'file-54934', open: true, onRequestClose: () => {},
    }));
    try {
      expect(hook.getCurrent().selectedIndex).toBe(54_934);
      identityReads = 0;
      await act(async () => { hook.getCurrent().handleKeyPress('ArrowUp', () => {}); });
      expect(hook.getCurrent().selectedIndex).toBe(54_933);
      expect(identityReads).toBeLessThanOrEqual(8);
      const changed = [...items];
      changed[54_933] = makeItem('file-54933', 'Freshly renamed file');
      itemSource = makeSource(changed);
      await hook.rerender();
      let activated: SelectableMenuItem | undefined;
      await act(async () => { hook.getCurrent().handleKeyPress('Enter', item => { activated = item; }); });
      expect(activated?.title).toBe('Freshly renamed file');
      expect(hook.getCurrent().filteredCategories[0]?.items).toHaveLength(54_935);
    } finally { await hook.unmount(); }
  });

  it('starts with no highlighted item when enabled and no preferred id exists', async () => {
    const { useSelectableMenu } = await import('./useSelectableMenu');
    const items: SelectableMenuItem[] = [
      { id: 'a', title: 'A', left: null, right: null },
    ];

    const hook = await renderHook(() =>
      useSelectableMenu({
        items,
        onRequestClose: () => {},
        allowEmptySelection: true,
      }),
    );

    expect(hook.getCurrent().selectedIndex).toBe(-1);

    await hook.unmount();
  });

  it('keeps sections whose titles differ only by case or spacing distinct, so no two share a key', async () => {
    const { useSelectableMenu } = await import('./useSelectableMenu');
    const items: SelectableMenuItem[] = [
      { id: 'a', title: 'Find more models', category: 'Goose', left: null, right: null },
      { id: 'b', title: 'Find more models', category: 'goose', left: null, right: null },
      { id: 'c', title: 'Find more models', category: 'QA A', left: null, right: null },
      { id: 'd', title: 'Find more models', category: 'QA-A', left: null, right: null },
    ];
    const hook = await renderHook(() => useSelectableMenu({ items, onRequestClose: () => {} }));
    const ids = hook.getCurrent().filteredCategories.map((category) => category.id);
    expect(new Set(ids).size).toBe(4);
    await hook.unmount();
  });

  it('never invents a group title for items that name no category, browsing or searching', async () => {
    const { useSelectableMenu } = await import('./useSelectableMenu');
    const items: SelectableMenuItem[] = [
      {
        id: 'conversation',
        title: 'New agent conversation',
        left: null,
        right: null,
      },
      {
        id: 'review',
        title: 'Review',
        category: 'Ask an agent to',
        left: null,
        right: null,
      },
    ];

    const hook = await renderHook(() =>
      useSelectableMenu({ items, onRequestClose: () => {} }),
    );
    expect(
      hook.getCurrent().filteredCategories.map((category) => category.title),
    ).toEqual(['', 'Ask an agent to']);

    await act(async () => {
      hook.getCurrent().handleSearchChange('new');
    });
    expect(
      hook.getCurrent().filteredCategories.map((category) => category.title),
    ).toEqual(['']);

    await hook.unmount();
  });

  it('uses the shared edge, typeahead, activation, and Escape semantics', async () => {
    const { useSelectableMenu } = await import('./useSelectableMenu');
    const onRequestClose = vi.fn();
    const onActivate = vi.fn();
    const items: SelectableMenuItem[] = [
      { id: 'alpha', title: 'Alpha', left: null, right: null },
      {
        id: 'disabled',
        title: 'Archive',
        disabled: true,
        left: null,
        right: null,
      },
      { id: 'beta', title: 'Beta', left: null, right: null },
      { id: 'gamma', title: 'Gamma', left: null, right: null },
    ];

    const hook = await renderHook(() =>
      useSelectableMenu({
        items,
        onRequestClose,
      }),
    );

    await act(async () => {
      hook.getCurrent().handleKeyPress('End', onActivate);
    });
    expect(hook.getCurrent().selectedIndex).toBe(3);

    await act(async () => {
      hook.getCurrent().handleKeyPress('ArrowDown', onActivate);
    });
    expect(hook.getCurrent().selectedIndex).toBe(3);

    await act(async () => {
      hook.getCurrent().handleKeyPress('Home', onActivate);
    });
    expect(hook.getCurrent().selectedIndex).toBe(0);

    await act(async () => {
      hook.getCurrent().handleKeyPress('g', onActivate);
    });
    expect(hook.getCurrent().selectedIndex).toBe(3);

    await act(async () => {
      hook.getCurrent().handleKeyPress('Enter', onActivate);
      hook.getCurrent().handleKeyPress('Escape', onActivate);
    });
    expect(onActivate).toHaveBeenCalledWith(items[3]);
    expect(onRequestClose).toHaveBeenCalledOnce();

    await hook.unmount();
  });

  it('honors and preserves an empty-string selected id used by default options', async () => {
    const { useSelectableMenu } = await import('./useSelectableMenu');
    const row = (id: string): SelectableMenuItem => ({ id, title: id || 'Default', left: null, right: null });
    const hook = await renderHook(
      ({ items }: { items: SelectableMenuItem[] }) =>
        useSelectableMenu({ items, initialSelectedId: '', onRequestClose: () => {}, open: true }),
      { initialProps: { items: [row('custom'), row('')] } },
    );
    expect(hook.getCurrent().selectedIndex).toBe(1);
    await hook.rerender({ items: [row('arriving'), row('custom'), row('')] });
    expect(hook.getCurrent().selectedIndex).toBe(2);
    await hook.rerender({ items: [row(''), row('custom')] });
    expect(hook.getCurrent().selectedIndex).toBe(0);
    await hook.unmount();
  });

  it('keeps the highlighted row when rows arrive while open, and resets it only for a new query', async () => {
    const { useSelectableMenu } = await import('./useSelectableMenu');
    const row = (id: string): SelectableMenuItem => ({ id, title: id, left: null, right: null });
    const hook = await renderHook(
      ({ items }: { items: SelectableMenuItem[] }) =>
        useSelectableMenu({ items, onRequestClose: () => {}, open: true, initialSelectedId: 'alpha' }),
      { initialProps: { items: [row('alpha'), row('find-more')] } },
    );
    await act(async () => {
      hook.getCurrent().setSelectedIndex(1);
    });
    // Discovery adds models above the operation the pointer is on; the highlight stays on that operation.
    await hook.rerender({ items: [row('alpha'), row('beta'), row('gamma'), row('find-more')] });
    expect(hook.getCurrent().selectedIndex).toBe(3);
    // Discovery can also insert above the initial selection; its index is not a new selection intent.
    await hook.rerender({ items: [row('aardvark'), row('alpha'), row('beta'), row('gamma'), row('find-more')] });
    expect(hook.getCurrent().selectedIndex).toBe(4);
    await hook.rerender({ items: [row('find-more'), row('gamma'), row('alpha'), row('beta')] });
    expect(hook.getCurrent().selectedIndex).toBe(0);
    await act(async () => {
      hook.getCurrent().handleSearchChange('a');
    });
    expect(hook.getCurrent().selectedIndex).toBe(1);
    await hook.unmount();
  });

  it('falls back when the highlighted row disappears or becomes disabled, and honors a new initial selection', async () => {
    const { useSelectableMenu } = await import('./useSelectableMenu');
    const row = (id: string, disabled = false): SelectableMenuItem => ({ id, title: id, disabled, left: null, right: null });
    const hook = await renderHook(
      ({ items, initialSelectedId }: { items: SelectableMenuItem[]; initialSelectedId: string }) =>
        useSelectableMenu({ items, initialSelectedId, onRequestClose: () => {}, open: true }),
      { initialProps: { items: [row('alpha'), row('beta'), row('find-more')], initialSelectedId: 'alpha' } },
    );
    await act(async () => hook.getCurrent().setSelectedIndex(2));
    await hook.rerender({ items: [row('beta'), row('alpha')], initialSelectedId: 'alpha' });
    expect(hook.getCurrent().selectedIndex).toBe(1);
    await act(async () => hook.getCurrent().setSelectedIndex(0));
    await hook.rerender({ items: [row('beta', true), row('alpha')], initialSelectedId: 'alpha' });
    expect(hook.getCurrent().selectedIndex).toBe(1);
    await hook.rerender({ items: [row('beta'), row('alpha')], initialSelectedId: 'beta' });
    expect(hook.getCurrent().selectedIndex).toBe(0);
    await hook.unmount();
  });

  it.each([false, true])('admits arriving rows according to empty-selection policy (allowEmptySelection=%s)', async (allowEmptySelection) => {
    const { useSelectableMenu } = await import('./useSelectableMenu');
    const emptyItems: SelectableMenuItem[] = [];
    const hook = await renderHook(
      ({ items }: { items: SelectableMenuItem[] }) =>
        useSelectableMenu({ items, allowEmptySelection, onRequestClose: () => {}, open: true }),
      { initialProps: { items: emptyItems } },
    );
    expect(hook.getCurrent().selectedIndex).toBe(-1);
    await hook.rerender({ items: [{ id: 'arriving', title: 'Arriving', left: null, right: null }] });
    expect(hook.getCurrent().selectedIndex).toBe(allowEmptySelection ? -1 : 0);
    await hook.unmount();
  });

  it('keeps an already visible discovery operation in view when rows arrive above the initial selection', async () => {
    const { useSelectableMenu } = await import('./useSelectableMenu');
    const { useScrollRectIntoViewRegistry } = await import('@/components/ui/scroll/useScrollRectIntoView');
    const row = (id: string): SelectableMenuItem => ({ id, title: id, left: null, right: null });
    const layout = (y: number) => ({ nativeEvent: { layout: { y, height: 40 } } });
    const hook = await renderHook(
      ({ items }: { items: SelectableMenuItem[] }) => {
        const menu = useSelectableMenu({ items, initialSelectedId: 'alpha', onRequestClose: () => {}, open: true });
        const scroll = useScrollRectIntoViewRegistry({ activeKey: items[menu.selectedIndex]?.id ?? null });
        // Web row frames report geometry during layout, before passive selection effects settle.
        useLayoutEffect(() => {
          scroll.onViewportLayout({ nativeEvent: { layout: { height: 100 } } });
          scroll.onContentSizeChange(200, 1000);
          items.forEach((item, index) => scroll.registerItemLayout(item.id)(layout(item.id === 'find-more' ? 500 : index * 100)));
        }, [items]);
        return { menu, scroll };
      },
      { initialProps: { items: [row('alpha'), row('find-more')] } },
    );
    const scrollTo = vi.fn();
    // The ScrollView and its geometry are the native/browser boundary; both interaction and scroll policy run real.
    hook.getCurrent().scroll.scrollRef.current = { scrollTo } as unknown as import('react-native').ScrollView;
    await act(async () => {
      hook.getCurrent().menu.setSelectedIndex(1);
    });
    await act(async () => hook.getCurrent().scroll.onScroll({ nativeEvent: { contentOffset: { y: 450 } } }));
    scrollTo.mockClear();
    await hook.rerender({ items: [row('arriving'), row('alpha'), row('find-more')] });
    expect(hook.getCurrent().menu.selectedIndex).toBe(2);
    expect(scrollTo).not.toHaveBeenCalled();
    await hook.unmount();
  });

  it('clears typeahead when a controlled menu closes before reopening', async () => {
    const { useSelectableMenu } = await import('./useSelectableMenu');
    const items: SelectableMenuItem[] = [
      { id: 'alpha', title: 'Alpha', left: null, right: null },
      {
        id: 'disabled',
        title: 'Archive',
        disabled: true,
        left: null,
        right: null,
      },
      { id: 'beta', title: 'Beta', left: null, right: null },
      { id: 'gamma', title: 'Gamma', left: null, right: null },
    ];
    const hook = await renderHook(
      ({ open }: { open: boolean }) =>
        useSelectableMenu({
          items,
          onRequestClose: () => {},
          open,
        }),
      { initialProps: { open: true } },
    );

    await act(async () => {
      hook.getCurrent().handleKeyPress('g', () => {});
    });
    expect(hook.getCurrent().selectedIndex).toBe(3);

    await hook.rerender({ open: false });
    await hook.rerender({ open: true });
    await act(async () => {
      hook.getCurrent().handleKeyPress('a', () => {});
    });
    expect(hook.getCurrent().selectedIndex).toBe(0);

    await hook.unmount();
  });
});
