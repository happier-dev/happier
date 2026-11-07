import { act, Fragment, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import {
  HappierCollectionListGroupLabel,
  type HappierCollectionListHost,
  type HappierCollectionListTextRole,
} from '../collection/CollectionList.js';
import { HappierPageSectionHeader, HappierPageSheet, HappierPageSheetGroup, useHappierPageSection } from './PageSection.js';
import { HAPPIER_PAGE_METRICS } from './pageMetrics.js';

/**
 * The page-section sheet's structure inputs (unified-work lab W8/W9): the flat surface's row inset,
 * the section-level "no row dividers" switch, and the group boundary that draws one lighter,
 * content-width separator between groups — never above the first, never inside a group.
 */
const COLORS = {
  sheet: '#f1f2f3',
  sheetBorder: '#0a0b0c',
  rowDivider: '#070809',
  groupDivider: '#0b0c0d',
} as const;

function Row(props: Readonly<{ id: string; showDivider?: boolean }>) {
  // A probe row: it takes the sheet's row inset like a page row does, and says whether it was asked
  // to draw the hairline under it.
  const section = useHappierPageSection();
  return (
    <View testID={props.id} style={{ paddingLeft: section?.rowInsetPx, paddingRight: section?.rowInsetPx }}>
      <Text>{props.showDivider === true ? 'yes' : 'no'}</Text>
    </View>
  );
}

function DraftRow(props: Readonly<{ id: string }>) {
  const [edits, setEdits] = useState(0);
  return <Pressable testID={props.id} onPress={() => setEdits((current) => current + 1)}><Text>{edits}</Text></Pressable>;
}

function separatorsIn(root: Element): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[role="separator"]'));
}

function dividerFlags(root: Element, ids: readonly string[]): string[] {
  return ids.map((id) => root.querySelector(`[data-testid="${id}"]`)?.textContent ?? 'missing');
}

function mount(children: ReactNode) {
  return mountThroughReactNativeWeb(<View testID="root">{children}</View>);
}

describe('HappierPageSheet groups, row inset and row dividers', () => {
  it.each([false, true])('retains a mounted row when the last peer group disappears and returns (rowDividers=%s)', async (rowDividers) => {
    const sheet = (grouped: boolean) => (
      <HappierPageSheet surface="none" colors={COLORS} rowDividers={rowDividers}>
        {grouped ? <HappierPageSheetGroup key="starts"><Row id="starts" /></HappierPageSheetGroup> : null}
        <DraftRow key="destination" id="destination" />
      </HappierPageSheet>
    );
    const view = mount(sheet(true));
    const draft = () => view.container.querySelector<HTMLElement>('[data-testid="destination"]')!;
    const original = draft();
    act(() => original.click());
    expect(original.textContent).toBe('1');
    await view.render(<View testID="root">{sheet(false)}</View>);
    expect(draft().textContent).toBe('1');
    expect(draft() === original).toBe(true);
    await view.render(<View testID="root">{sheet(true)}</View>);
    expect(draft().textContent).toBe('1');
    expect(draft() === original).toBe(true);
    view.unmount();
  });

  it.each([false, true])('retains a mounted row draft when a conditional status line appears (rowDividers=%s)', async (rowDividers) => {
    const sheet = (pending: boolean) => (
      <HappierPageSheet surface="none" colors={COLORS} rowDividers={rowDividers}>
        {pending ? <Text testID="pending">Saving</Text> : null}
        <><DraftRow id="draft" /></>
      </HappierPageSheet>
    );
    const view = mount(sheet(false));
    const draft = () => view.container.querySelector<HTMLElement>('[data-testid="draft"]')!;
    act(() => draft().click());
    expect(draft().textContent).toBe('1');
    await view.render(<View testID="root">{sheet(true)}</View>);
    expect(draft().textContent).toBe('1');
    await view.render(<View testID="root">{sheet(false)}</View>);
    expect(draft().textContent).toBe('1');
    view.unmount();
  });

  it('keeps nested fragment keys scoped while grouped rows reorder', async () => {
    const sheet = (ids: readonly string[]) => (
      <HappierPageSheet colors={COLORS}>
        <HappierPageSheetGroup>
          {ids.map((id) => <Fragment key={id}><><DraftRow key="draft" id={id} /></></Fragment>)}
        </HappierPageSheetGroup>
        <HappierPageSheetGroup><Row id="neighbor" /></HappierPageSheetGroup>
      </HappierPageSheet>
    );
    const view = mount(sheet(['draft-a', 'draft-b']));
    const draft = (id: string) => view.container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
    act(() => draft('draft-a').click());
    act(() => { draft('draft-b').click(); draft('draft-b').click(); });
    await view.render(<View testID="root">{sheet(['draft-b', 'draft-a'])}</View>);
    expect(draft('draft-a').textContent).toBe('1');
    expect(draft('draft-b').textContent).toBe('2');
    expect(dividerFlags(view.container, ['neighbor'])).toEqual(['no']);
    expect(separatorsIn(view.container)).toHaveLength(1);
    view.unmount();
  });

  it('lays a flat sheet out with its own row inset, no row hairlines, and one inset separator between groups', () => {
    const view = mount(
      <HappierPageSheet surface="none" colors={COLORS} rowInsetPx={9} rowDividers={false}>
        <HappierPageSheetGroup testID="group-a" header={<Text>When a turn ends</Text>}>
          <Row id="a1" />
          <Row id="a2" />
        </HappierPageSheetGroup>
        <HappierPageSheetGroup testID="group-b" header={<Text>When the session starts</Text>}>
          <Row id="b1" />
        </HappierPageSheetGroup>
        <HappierPageSheetGroup testID="group-c">
          <Row id="c1" />
        </HappierPageSheetGroup>
      </HappierPageSheet>,
    );
    const root = view.container.querySelector('[data-testid="root"]')!;

    expect(dividerFlags(root, ['a1', 'a2', 'b1', 'c1'])).toEqual(['no', 'no', 'no', 'no']);
    const separators = separatorsIn(root);
    // Above every group but the first: two for three groups.
    expect(separators).toHaveLength(2);
    for (const separator of separators) {
      expect(separator.style.backgroundColor).toBe('rgb(11, 12, 13)');
      // Content width: from the rows' text edge to their trailing edge, not the sheet's.
      expect(separator.style.marginLeft).toBe('9px');
      expect(separator.style.marginRight).toBe('9px');
    }
    // Each separator sits between two groups, never inside one.
    const groupB = root.querySelector('[data-testid="group-b"]')!;
    expect(groupB.contains(separators[0]!)).toBe(false);
    expect(separators[0]!.compareDocumentPosition(groupB) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The header reads before its rows.
    expect(groupB.textContent?.indexOf('When the session starts')).toBe(0);
    // Rows take the sheet's inset instead of the page's.
    expect(root.querySelector<HTMLElement>('[data-testid="a1"]')!.style.paddingLeft).toBe('9px');
    // No sheet chrome on the flat surface.
    expect(Array.from(root.querySelectorAll<HTMLElement>('div')).some((element) => element.style.borderTopLeftRadius === '14px'))
      .toBe(false);
    view.unmount();
  });

  it('keeps row hairlines inside each group on the carded sheet and starts every later group with the separator', () => {
    const view = mount(
      <HappierPageSheet colors={COLORS}>
        <HappierPageSheetGroup>
          <Row id="a1" />
          <Row id="a2" />
        </HappierPageSheetGroup>
        <HappierPageSheetGroup>
          <Row id="b1" />
          <Row id="b2" />
        </HappierPageSheetGroup>
      </HappierPageSheet>,
    );
    const root = view.container.querySelector('[data-testid="root"]')!;

    // A group's last row draws no hairline: the group separator replaces it.
    expect(dividerFlags(root, ['a1', 'a2', 'b1', 'b2'])).toEqual(['yes', 'no', 'yes', 'no']);
    const separators = separatorsIn(root);
    expect(separators).toHaveLength(1);
    expect(separators[0]!.style.marginLeft).toBe(`${HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx}px`);
    expect(root.querySelector<HTMLElement>('[data-testid="a1"]')!.style.paddingLeft)
      .toBe(`${HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx}px`);
    view.unmount();
  });

  it('keeps an ungrouped sheet exactly as before: hairlines between rows, none after the last, no group separator', () => {
    const view = mount(
      <HappierPageSheet colors={COLORS}>
        <Row id="r1" />
        <Row id="r2" />
        <Row id="r3" showDivider={false} />
      </HappierPageSheet>,
    );
    const root = view.container.querySelector('[data-testid="root"]')!;
    expect(dividerFlags(root, ['r1', 'r2', 'r3'])).toEqual(['yes', 'yes', 'no']);
    expect(separatorsIn(root)).toHaveLength(0);
    view.unmount();
  });

  it('stands a framed sheet on the host card edge — lip and grounding — and keeps a flat sheet bare', () => {
    const colors = {
      ...COLORS,
      sheetEdge: { side: 'bottom' as const, color: '#123456', lift: { boxShadow: '0px 1px 2px rgba(0, 0, 0, 0.02)' } },
    };
    const view = mount(
      <>
        <HappierPageSheet testID="framed" colors={colors}><Row id="f1" /></HappierPageSheet>
        <HappierPageSheet testID="flat" surface="none" colors={colors}><Row id="n1" /></HappierPageSheet>
        <HappierPageSheet testID="hostless" colors={COLORS}><Row id="h1" /></HappierPageSheet>
      </>,
    );
    const style = (id: string) => getComputedStyle(view.container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!);
    expect(style('framed').borderBottomColor).toBe('rgb(18, 52, 86)');
    expect(style('framed').borderTopColor).toBe('rgb(10, 11, 12)');
    expect(style('framed').boxShadow).toContain('rgba(0, 0, 0, 0.02)');
    expect(style('flat').boxShadow).toBe('');
    expect(style('flat').borderBottomWidth).not.toBe('1px');
    expect(style('hostless').borderBottomColor).toBe('rgb(10, 11, 12)');
    expect(style('hostless').boxShadow).toBe('');
    view.unmount();
  });

  it('draws a group label inside a sheet as the group sub-heading, on the rows’ inset', () => {
    const roles: HappierCollectionListTextRole[] = [];
    const host: HappierCollectionListHost = {
      Text: (props) => {
        roles.push(props.role);
        return <Text>{props.children}</Text>;
      },
      Scroller: (props) => <View>{props.children}</View>,
      SearchField: () => null,
      surfaceStyle: null,
    };
    const view = mount(
      <>
        <HappierCollectionListGroupLabel host={host} title="Built-in" />
        <HappierPageSheet surface="none" colors={COLORS} rowInsetPx={9} rowDividers={false}>
          <HappierPageSheetGroup header={<HappierCollectionListGroupLabel host={host} title="When a turn ends" count={2} />}>
            <Row id="a1" />
          </HappierPageSheetGroup>
        </HappierPageSheet>
      </>,
    );
    const root = view.container.querySelector('[data-testid="root"]')!;

    // In a navigation column the label stays the quiet group title; in a sheet it is a heading.
    expect(roles).toEqual(['groupTitle', 'groupHeading', 'groupCount']);
    const labels = Array.from(root.querySelectorAll<HTMLElement>('[role="heading"]'));
    expect(labels).toHaveLength(2);
    expect(labels[1]!.style.paddingLeft).toBe('9px');
    expect(labels[1]!.style.paddingRight).toBe('9px');
    view.unmount();
  });
});

describe('HappierPageSectionHeader action placement', () => {
  const header = (action: ReactNode) => (
    <HappierPageSectionHeader
      testID="section-header"
      title="Directory"
      description="Directory sources keep Team membership and Groups aligned with an external organization."
      action={action}
      actionLayout="inline"
      insetPx={0}
    />
  );

  it('observes the header even when its action arrives after the first paint', async () => {
    // A directory's "+ Add source" is offered once the sources have loaded, so the header mounts
    // without it. React Native Web decides whether to observe a view's size only at mount, so a
    // header that attached its layout handler with the action would never learn its width and
    // would keep the action beside a wrapped description on a phone.
    const observed = new Set<Element>();
    class RecordingResizeObserver {
      observe(node: Element) { observed.add(node); }
      unobserve(node: Element) { observed.delete(node); }
      disconnect() { observed.clear(); }
    }
    const windowWithObserver = window as unknown as { ResizeObserver?: unknown };
    const previous = windowWithObserver.ResizeObserver;
    windowWithObserver.ResizeObserver = RecordingResizeObserver;
    try {
      const view = mountThroughReactNativeWeb(header(null));
      await view.render(header(<Text testID="late-action">Add source</Text>));
      const root = view.container.querySelector<HTMLElement>('[data-testid="section-header"]')!;
      expect(observed.has(root)).toBe(true);
      view.unmount();
    } finally {
      windowWithObserver.ResizeObserver = previous;
    }
  });
});
