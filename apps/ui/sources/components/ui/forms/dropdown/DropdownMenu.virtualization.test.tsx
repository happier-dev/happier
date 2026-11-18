import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HAPPIER_MENU_ROW_METRICS, HAPPIER_MENU_ROW_TEXT } from '@happier-dev/plugin-ui/presentation';
import { renderScreen, standardCleanup } from '@/dev/testkit';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('react-native-reanimated', async () => {
  const { createReanimatedModuleMock } =
    await import('@/dev/testkit/mocks/reanimated');
  return createReanimatedModuleMock();
});
vi.mock('@/components/ui/popover', async (importOriginal) =>
  (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(
    importOriginal,
  ),
);

afterEach(() => standardCleanup());

// A Review-sized working tree: every changed file is one choice of the picker.
const LARGE = 50_000;
const VIEWPORT = 400;
const ROW = 36;
// A row with a subtitle (every file row here) before it is measured: label, gap and subtitle lines plus padding,
// from the menu row owner.
const SUBTITLED_ROW = 2 * HAPPIER_MENU_ROW_METRICS.paddingVerticalPx + HAPPIER_MENU_ROW_TEXT.label.lineHeight
  + HAPPIER_MENU_ROW_METRICS.subtitleGapPx + HAPPIER_MENU_ROW_TEXT.subtitle.lineHeight;

function files(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `file-${index}`,
    title: `file-${index}.ts`,
    subtitle: `src/module-${Math.floor(index / 100)}`,
  }));
}

type Screen = Awaited<ReturnType<typeof renderScreen>>;

function mountedRowIds(screen: Screen): string[] {
  return screen.root
    .findAll(
      (node) =>
        node.type === ('div' as never) &&
        typeof node.props.testID === 'string' &&
        node.props.testID.endsWith(':scroll-frame'),
    )
    .map((node) =>
      String(node.props.testID)
        .replace(/^dropdown-option-/, '')
        .replace(/:scroll-frame$/, ''),
    );
}

async function openMenu(
  params: Readonly<{
    count: number;
    selectedId?: string | null;
    search?: boolean;
    onSelect?: (id: string) => void;
  }>,
) {
  const scrollTo = vi.fn();
  const { DropdownMenu } = await import('./DropdownMenu');
  const items = files(params.count);
  const screen = await renderScreen(
    <DropdownMenu
      open
      onOpenChange={() => {}}
      items={items}
      selectedId={params.selectedId ?? null}
      onSelect={params.onSelect ?? (() => {})}
      search={params.search}
      trigger={null}
    />,
    {
      createNodeMock: (node) =>
        node.props && 'keyboardShouldPersistTaps' in node.props
          ? { scrollTo }
          : null,
    },
  );
  const scroller = screen.root.findAll(
    (node) =>
      node.props &&
      'keyboardShouldPersistTaps' in node.props &&
      typeof node.props.onLayout === 'function',
  )[0]!;
  await act(async () => {
    scroller.props.onLayout({
      nativeEvent: { layout: { x: 0, y: 0, width: 280, height: VIEWPORT } },
    });
    scroller.props.onContentSizeChange(280, params.count * ROW);
  });
  const scroll = async (offsetY: number) => {
    await act(async () => {
      scroller.props.onScroll({
        nativeEvent: {
          contentOffset: { y: offsetY },
          layoutMeasurement: { height: VIEWPORT },
          contentSize: { height: params.count * ROW },
        },
      });
    });
  };
  const press = async (key: string) => {
    const rowId = mountedRowIds(screen)[0]!;
    await act(async () => {
      screen
        .findByTestId(`dropdown-option-${rowId}:scroll-frame`)!
        .props.onKeyDown({
          nativeEvent: { key },
          preventDefault() {},
          stopPropagation() {},
        });
    });
  };
  return { screen, scrollTo, scroll, press };
}

describe('DropdownMenu with a very long list', () => {
  it('mounts rows for its viewport, not for every choice', async () => {
    const { screen } = await openMenu({ count: LARGE });
    const mounted = mountedRowIds(screen);
    // A viewport of rows on each side of the visible window, never the whole list.
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThanOrEqual(
      Math.ceil((VIEWPORT * 3) / ROW) + 4,
    );
    expect(mounted[0]).toBe('file-0');
  }, 120_000);

  it('mounts the rows the person scrolls to', async () => {
    const { screen, scroll } = await openMenu({ count: LARGE });
    await scroll(30_000 * SUBTITLED_ROW);
    const mounted = mountedRowIds(screen);
    expect(mounted).toContain('file-30000');
    expect(mounted).toContain('file-30005');
    // The highlighted first row stays mounted for the keyboard; the rest of the top is not.
    expect(mounted).toContain('file-0');
    expect(mounted).not.toContain('file-1');
    expect(mounted.length).toBeLessThanOrEqual(
      Math.ceil((VIEWPORT * 3) / ROW) + 4,
    );
  }, 120_000);

  it('keeps the row that holds keyboard focus mounted when the person scrolls away from it', async () => {
    const { screen, scroll } = await openMenu({ count: LARGE });
    // Focus sits on a row other than the highlighted one (the pointer moved the highlight).
    await act(async () => {
      screen.findByTestId('dropdown-option-file-3:scroll-frame')!.props.onFocus?.({});
    });
    await scroll(30_000 * SUBTITLED_ROW);
    const mounted = mountedRowIds(screen);
    expect(mounted).toContain('file-30000');
    expect(mounted).toContain('file-3');
  }, 120_000);

  it('reaches and selects the last choice from the keyboard', async () => {
    const onSelect = vi.fn();
    const { screen, scrollTo, press } = await openMenu({
      count: LARGE,
      onSelect,
    });
    await press('End');
    expect(mountedRowIds(screen)).toContain(`file-${LARGE - 1}`);
    // The last row reports where it sits; the registry then scrolls the menu to it.
    await act(async () => {
      screen
        .findByTestId(`dropdown-option-file-${LARGE - 1}:scroll-frame`)!
        .props.onLayout({
          nativeEvent: { layout: { y: (LARGE - 1) * ROW, height: ROW } },
        });
    });
    expect(scrollTo).toHaveBeenCalled();
    await act(async () => {
      screen
        .findByTestId(`dropdown-option-file-${LARGE - 1}:scroll-frame`)!
        .props.onKeyDown({
          nativeEvent: { key: 'Enter' },
          preventDefault() {},
          stopPropagation() {},
        });
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(onSelect).toHaveBeenCalledWith(`file-${LARGE - 1}`, { anchor: expect.objectContaining({ kind: 'view' }) });
  }, 120_000);

  it('opens on the current choice deep in the list and scrolls to it', async () => {
    const { screen, scrollTo } = await openMenu({
      count: LARGE,
      selectedId: 'file-40000',
    });
    expect(mountedRowIds(screen)).toContain('file-40000');
    // The row reports where it sits; the registry then scrolls the menu to it.
    await act(async () => {
      screen
        .findByTestId('dropdown-option-file-40000:scroll-frame')!
        .props.onLayout({
          nativeEvent: { layout: { y: 40000 * ROW, height: ROW } },
        });
    });
    expect(scrollTo).toHaveBeenCalled();
    expect(mountedRowIds(screen).length).toBeLessThanOrEqual(
      Math.ceil((VIEWPORT * 3) / ROW) * 2 + 4,
    );
  }, 120_000);

  it('places the rows it has not measured yet at the height their content gives them', async () => {
    // Every choice carries a subtitle (the file's folder), so an unmeasured row is a two-line menu row.
    const { screen } = await openMenu({ count: LARGE, selectedId: 'file-40000' });
    const spacers = screen.root.findAll((node) => node.props?.testID === 'selectable-menu-unmounted-rows' && typeof node.type === 'string');
    const above = spacers.map((node) => Number(node.props.style?.height ?? 0)).find((height) => height > ROW * 1000);
    expect(above).toBeDefined();
    const unmountedAbove = 40000 - mountedRowIds(screen).filter((id) => Number(id.replace('file-', '')) < 40000).length;
    // A two-line row: label and subtitle lines, the gap between them and the row's vertical padding.
    expect(above! / unmountedAbove).toBeCloseTo(SUBTITLED_ROW, 0);
  }, 120_000);

  it('lets the person scroll away from the current choice without pulling them back to it', async () => {
    const { screen, scrollTo, scroll } = await openMenu({ count: LARGE, selectedId: 'file-0' });
    // The current choice is the first row, already in view at the top.
    await act(async () => {
      screen.findByTestId('dropdown-option-file-0:scroll-frame')!.props.onLayout({ nativeEvent: { layout: { y: 4, height: SUBTITLED_ROW } } });
    });
    expect(scrollTo.mock.calls.every(([options]) => (options as { y: number }).y === 0)).toBe(true);
    scrollTo.mockClear();
    // The person drags the scrollbar far down; the rows there mount and lay out.
    await scroll(30_000 * SUBTITLED_ROW);
    await act(async () => {
      for (const id of mountedRowIds(screen).filter((rowId) => rowId !== 'file-0')) {
        const index = Number(id.replace('file-', ''));
        screen.findByTestId(`dropdown-option-${id}:scroll-frame`)!.props.onLayout({ nativeEvent: { layout: { y: index * SUBTITLED_ROW, height: SUBTITLED_ROW } } });
      }
    });
    expect(scrollTo).not.toHaveBeenCalled();
  }, 120_000);

  it('finds any choice by typing', async () => {
    const { screen } = await openMenu({ count: LARGE, search: true });
    const field = screen.root.findAll(
      (node) => typeof node.props.onChangeText === 'function',
    )[0]!;
    await act(async () => {
      field.props.onChangeText('file-49999.ts');
    });
    expect(mountedRowIds(screen)).toEqual(['file-49999']);
  }, 120_000);
});

describe('DropdownMenu with an ordinary list', () => {
  it('mounts every row, with no spacer', async () => {
    const { screen } = await openMenu({ count: 12 });
    expect(mountedRowIds(screen)).toEqual(files(12).map((file) => file.id));
    expect(
      screen.root.findAll(
        (node) => node.props?.testID === 'selectable-menu-unmounted-rows',
      ),
    ).toHaveLength(0);
  });
});

describe('SelectableMenuResults row measurement', () => {
  // The Review inventory the freeze was measured on.
  const REVIEW = 54_935;

  function countedInventory(count: number) {
    const reads = { count: 0 };
    const items = Array.from({ length: count }, (_, index) => {
      const item = {};
      for (const [key, value] of Object.entries({ id: `file-${index}`, title: `file-${index}.ts`, subtitle: 'src' })) {
        Object.defineProperty(item, key, { enumerable: true, get: () => { reads.count += 1; return value; } });
      }
      for (const key of ['checked', 'swatch', 'disabled']) {
        Object.defineProperty(item, key, { enumerable: true, get: () => { reads.count += 1; return undefined; } });
      }
      return item as { id: string; title: string; subtitle: string };
    });
    return { reads, items };
  }

  async function renderMeasured(count: number, offset: { y: number }) {
    const { SelectableMenuResults } = await import('./SelectableMenuResults');
    const { reads, items } = countedInventory(count);
    const listeners = new Set<() => void>();
    const viewport = {
      get: () => ({ offsetY: offset.y, viewportHeight: VIEWPORT }),
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
    const screen = await renderScreen(
      <SelectableMenuResults
        categories={[{ id: 'files', title: '', items }]}
        selectedIndex={0}
        onSelectionChange={() => {}}
        onPressItem={() => {}}
        rowVariant="slim"
        viewport={viewport}
        initialViewportHeight={VIEWPORT}
      />,
    );
    const measure = async (ids: readonly string[], height: (id: string) => number) => {
      await act(async () => {
        for (const id of ids) {
          screen.findByTestId(`dropdown-option-${id}:scroll-frame`)!.props.onLayout({ nativeEvent: { layout: { y: 0, height: height(id) } } });
        }
      });
    };
    const scroll = async (y: number) => {
      offset.y = y;
      await act(async () => { listeners.forEach((listener) => listener()); });
    };
    return { screen, reads, measure, scroll };
  }

  it('re-places rows for one new measurement without walking the inventory', async () => {
    const { screen, reads, measure } = await renderMeasured(REVIEW, { y: 0 });
    const opened = mountedRowIds(screen);
    // Opening measures the mounted rows once.
    await measure(opened.slice(0, -1), () => ROW);
    reads.count = 0;
    await measure(opened.slice(-1), () => ROW + 16);
    // Proportional to the mounted rows, never to the 54,935 choices.
    expect(reads.count).toBeLessThan(opened.length * 60);
  }, 120_000);

  it('places rows of different heights where they really are', async () => {
    const { screen, measure, scroll } = await renderMeasured(1_000, { y: 0 });
    // The first rows are taller (a subtitle) than the estimate.
    await measure(mountedRowIds(screen), () => 50);
    const measuredCount = mountedRowIds(screen).length;
    // Scroll so the first visible row is the 100th row after the measured ones.
    const target = measuredCount + 100;
    await scroll(measuredCount * 50 + 100 * SUBTITLED_ROW);
    const mounted = mountedRowIds(screen);
    expect(mounted).toContain(`file-${target}`);
    expect(mounted).toContain(`file-${target + 5}`);
    // The scroller's extent stays true: mounted rows plus spacers cover the whole list.
    const spacers = screen.root.findAll((node) => node.props?.testID === 'selectable-menu-unmounted-rows');
    expect(spacers.length).toBeGreaterThan(0);
  }, 120_000);
});
