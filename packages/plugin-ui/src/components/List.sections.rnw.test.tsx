import * as React from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

const SECTIONED_WINDOW_SIZE = vi.hoisted(() => 10);

type CapturedSection = Readonly<{ key: string; title: string; data: readonly unknown[] }>;

const sectionListCapture = vi.hoisted(() => ({
  sections: [] as Array<readonly CapturedSection[]>,
  role: [] as unknown[],
  stickySectionHeadersEnabled: [] as unknown[],
  mountedRowKeys: [] as Array<readonly string[]>,
  reveals: [] as Array<Readonly<{ sectionIndex: number; itemIndex: number }>>,
  /** Window moves the test settles explicitly, the way a later native frame would. */
  settleReveals: [] as Array<() => void>,
}));

/**
 * The platform SECTION virtualizer boundary.
 *
 * React Native's `VirtualizedSectionList` flattens each section into a header
 * cell followed by its rows, hands `renderItem` a SECTION-LOCAL index, and
 * reveals a row through `scrollToLocation({ sectionIndex, itemIndex })` — there
 * is no `scrollToIndex` on this surface. The mock reproduces exactly those
 * facts, and defers the revealed window move so an owner that drops its pending
 * focus at the next commit cannot pass.
 */
vi.mock('react-native', async () => {
  const native = await vi.importActual<typeof import('react-native')>('react-native');
  return {
    ...native,
    SectionList: function CapturingSectionList(props: Readonly<{
      sections: readonly CapturedSection[];
      keyExtractor(item: unknown, index: number): string;
      renderItem(input: Readonly<{ item: unknown; index: number; section: CapturedSection }>): React.ReactNode;
      renderSectionHeader?(input: Readonly<{ section: CapturedSection }>): React.ReactNode;
      ListHeaderComponent?: React.ReactNode;
      ListEmptyComponent?: React.ReactNode;
      ListFooterComponent?: React.ReactNode;
      stickySectionHeadersEnabled?: boolean;
      role?: 'list' | 'listbox';
      ref?: React.Ref<unknown>;
    }>) {
      type Cell =
        | Readonly<{ kind: 'header'; sectionIndex: number }>
        | Readonly<{ kind: 'row'; sectionIndex: number; itemIndex: number }>;
      const cells: Cell[] = [];
      props.sections.forEach((section, sectionIndex) => {
        cells.push({ kind: 'header', sectionIndex });
        section.data.forEach((_item, itemIndex) => {
          cells.push({ kind: 'row', sectionIndex, itemIndex });
        });
      });
      const [windowStart, setWindowStart] = React.useState(0);
      const maximumWindowStart = Math.max(0, cells.length - SECTIONED_WINDOW_SIZE);
      const boundedWindowStart = Math.min(windowStart, maximumWindowStart);
      const cellIndexOf = (sectionIndex: number, itemIndex: number): number => (
        cells.findIndex((cell) => (
          cell.kind === 'row' && cell.sectionIndex === sectionIndex && cell.itemIndex === itemIndex
        ))
      );
      React.useImperativeHandle(props.ref, () => ({
        scrollToLocation(input: Readonly<{ sectionIndex: number; itemIndex: number }>) {
          sectionListCapture.reveals.push({ sectionIndex: input.sectionIndex, itemIndex: input.itemIndex });
          const target = cellIndexOf(input.sectionIndex, input.itemIndex);
          sectionListCapture.settleReveals.push(() => {
            setWindowStart((current) => {
              const maximum = Math.max(0, cells.length - SECTIONED_WINDOW_SIZE);
              const start = Math.min(current, maximum);
              if (target >= start && target < start + SECTIONED_WINDOW_SIZE) return current;
              // Reveal the section header with its row, as the platform does.
              return Math.max(0, Math.min(target - 1, maximum));
            });
          });
        },
      }), [cells.length, props.sections]);

      const windowCells = cells.slice(boundedWindowStart, boundedWindowStart + SECTIONED_WINDOW_SIZE);
      sectionListCapture.sections.push(props.sections);
      sectionListCapture.role.push(props.role);
      sectionListCapture.stickySectionHeadersEnabled.push(props.stickySectionHeadersEnabled);
      sectionListCapture.mountedRowKeys.push(windowCells.flatMap((cell) => {
        if (cell.kind !== 'row') return [];
        const section = props.sections[cell.sectionIndex];
        if (!section) return [];
        const item = section.data[cell.itemIndex];
        return [`${section.key}:${props.keyExtractor(item, cell.itemIndex)}`];
      }));

      return (
        <div role={props.role}>
          {props.ListHeaderComponent}
          {cells.length === 0
            ? props.ListEmptyComponent
            : windowCells.map((cell) => {
                const section = props.sections[cell.sectionIndex];
                if (!section) return null;
                if (cell.kind === 'header') {
                  return (
                    <React.Fragment key={`${section.key}:header`}>
                      {props.renderSectionHeader?.({ section })}
                    </React.Fragment>
                  );
                }
                const item = section.data[cell.itemIndex];
                return (
                  <React.Fragment key={`${section.key}:${props.keyExtractor(item, cell.itemIndex)}`}>
                    {props.renderItem({ item, index: cell.itemIndex, section })}
                  </React.Fragment>
                );
              })}
          {props.ListFooterComponent}
        </div>
      );
    },
  };
});

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { List } from './List.js';
import { PluginUiProvider } from './PluginUiProvider.js';

type Entry = Readonly<{ id: string; label: string; blocked: boolean }>;

/** Stable identity, so the derived-section memo is what the test measures. */
const matchesQuery = (item: Entry, query: string): boolean => item.label.includes(query);

const SECTION_TITLES = ['Blocked', 'Waiting', 'Mine', 'Review', 'Merged', 'Closed'] as const;
const ROWS_PER_SECTION = 400;

const sections = SECTION_TITLES.map((title, sectionIndex) => ({
  key: `section-${sectionIndex}`,
  title,
  data: Array.from({ length: ROWS_PER_SECTION }, (_row, rowIndex): Entry => ({
    id: `s${sectionIndex}-r${String(rowIndex).padStart(3, '0')}`,
    label: `${title} ${String(rowIndex).padStart(3, '0')}`,
    blocked: sectionIndex === 0 && rowIndex === 1,
  })),
}));

function mountSectionedList(
  node: React.ReactNode,
): ReturnType<typeof mountThroughReactNativeWeb> {
  const context = createSurfaceContext();
  return mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      {node}
    </PluginUiProvider>,
  );
}

const optionsIn = (mount: Readonly<{ container: HTMLElement }>) => (
  Array.from(mount.container.querySelectorAll<HTMLElement>('[role="option"]'))
);
const optionNamed = (mount: Readonly<{ container: HTMLElement }>, label: string) => (
  optionsIn(mount).find((option) => option.textContent?.includes(label))
);
const tabStopIn = (mount: Readonly<{ container: HTMLElement }>) => (
  optionsIn(mount).find((option) => option.getAttribute('tabindex') === '0')
);

async function pressKey(target: HTMLElement | undefined, key: string): Promise<void> {
  await act(async () => {
    target?.focus();
    target?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

async function settleReveals(): Promise<void> {
  const pending = sectionListCapture.settleReveals.splice(0, sectionListCapture.settleReveals.length);
  await act(async () => {
    for (const settle of pending) settle();
  });
}

function resetCapture(): void {
  sectionListCapture.sections.length = 0;
  sectionListCapture.role.length = 0;
  sectionListCapture.stickySectionHeadersEnabled.length = 0;
  sectionListCapture.mountedRowKeys.length = 0;
  sectionListCapture.reveals.length = 0;
  sectionListCapture.settleReveals.length = 0;
}

type SectionedListProps = Readonly<{
  sections: readonly Readonly<{ key: string; title: string; data: readonly Entry[] }>[];
  onSelectedKeyChange: (key: string) => void;
  search?: Readonly<{ label: string; value: string; onValueChange: (value: string) => void }>;
  renderedSectionKeys?: string[];
}>;

function SectionedReviewList(props: SectionedListProps): React.ReactElement {
  return (
    <List
      accessibilityLabel="Reviews"
      sections={props.sections}
      keyForItem={(item: Entry) => item.id}
      renderItem={(item: Entry, _index: number, sectionKey: string | null) => {
        props.renderedSectionKeys?.push(sectionKey ?? 'null');
        return <List.Item title={item.label} />;
      }}
      search={props.search === undefined
        ? undefined
        : {
            label: props.search.label,
            value: props.search.value,
            onValueChange: props.search.onValueChange,
            filter: matchesQuery,
          }}
      selection={{
        defaultSelectedKey: 's0-r000',
        isItemDisabled: (item: Entry) => item.blocked,
        onSelectedKeyChange: props.onSelectedKeyChange,
      }}
    />
  );
}

describe('sectioned virtualized List', () => {
  it('renders section headers and rows through the platform section virtualizer with a bounded mounted window', async () => {
    resetCapture();
    const mount = mountSectionedList(<SectionedReviewList sections={sections} onSelectedKeyChange={() => {}} />);

    const capturedSections = sectionListCapture.sections.at(-1);
    expect(capturedSections?.map((section) => section.title)).toEqual([...SECTION_TITLES]);
    expect(sectionListCapture.role.at(-1)).toBe('listbox');
    expect(sectionListCapture.stickySectionHeadersEnabled.at(-1)).toBe(true);

    // 2,400 authored rows; the platform virtualizer decides the mounted window.
    expect(sections.reduce((total, section) => total + section.data.length, 0)).toBe(2400);
    expect(optionsIn(mount).length).toBeLessThanOrEqual(SECTIONED_WINDOW_SIZE);
    expect(optionsIn(mount).length).toBeGreaterThan(0);

    // The first section's header is announced by name beside its rows.
    expect(mount.container.textContent).toContain('Blocked');
    expect(optionNamed(mount, 'Blocked 000')).toBeDefined();
    mount.unmount();
  });

  it('gives each row its section-local screen-reader position and its section key', async () => {
    resetCapture();
    const renderedSectionKeys: string[] = [];
    const mount = mountSectionedList(
      <SectionedReviewList
        sections={sections}
        onSelectedKeyChange={() => {}}
        renderedSectionKeys={renderedSectionKeys}
      />,
    );

    const secondRow = optionNamed(mount, 'Blocked 001');
    expect(secondRow?.getAttribute('aria-posinset')).toBe('2');
    // Section-local, not 2,400: a reader hears "row 2 of 400" inside "Blocked".
    expect(secondRow?.getAttribute('aria-setsize')).toBe(String(ROWS_PER_SECTION));
    expect(new Set(renderedSectionKeys)).toEqual(new Set(['section-0']));
    mount.unmount();
  });

  it('moves logical focus across a section boundary without changing the selected row', async () => {
    resetCapture();
    const selectedKeys: string[] = [];
    const lastOfFirstSection = sections[0]!.data.at(-1)!;
    const firstOfSecondSection = sections[1]!.data[0]!;
    const twoSections = [
      { ...sections[0]!, data: sections[0]!.data.slice(-2) },
      { ...sections[1]!, data: sections[1]!.data.slice(0, 2) },
    ];
    const mount = mountSectionedList(
      <SectionedReviewList
        sections={twoSections}
        onSelectedKeyChange={(key) => selectedKeys.push(key)}
      />,
    );

    await pressKey(optionNamed(mount, lastOfFirstSection.label), 'ArrowDown');
    await settleReveals();

    expect(document.activeElement).toBe(optionNamed(mount, firstOfSecondSection.label));
    expect(tabStopIn(mount)).toBe(optionNamed(mount, firstOfSecondSection.label));
    expect(selectedKeys).toEqual([]);
    expect(optionNamed(mount, firstOfSecondSection.label)?.getAttribute('aria-selected')).toBe('false');
    mount.unmount();
  });

  it('reveals an unmounted row by section location and keeps the pending focus until it registers', async () => {
    resetCapture();
    const selectedKeys: string[] = [];
    const lastEntry = sections.at(-1)!.data.at(-1)!;
    const mount = mountSectionedList(
      <SectionedReviewList sections={sections} onSelectedKeyChange={(key) => selectedKeys.push(key)} />,
    );

    await pressKey(optionNamed(mount, 'Blocked 000'), 'End');

    // The platform surface has no `scrollToIndex`; the location is section-local.
    expect(sectionListCapture.reveals.at(-1)).toEqual({
      sectionIndex: SECTION_TITLES.length - 1,
      itemIndex: ROWS_PER_SECTION - 1,
    });
    expect(optionNamed(mount, lastEntry.label)).toBeUndefined();

    await settleReveals();

    expect(document.activeElement).toBe(optionNamed(mount, lastEntry.label));
    expect(selectedKeys).toEqual([]);
    mount.unmount();
  });

  it('composes the sectioned listbox out of nothing but groups and options', () => {
    resetCapture();
    const mount = mountSectionedList(
      <SectionedReviewList
        sections={sections}
        onSelectedKeyChange={() => {}}
        search={{ label: 'Search reviews', value: '', onValueChange: () => {} }}
      />,
    );

    const listbox = mount.container.querySelector<HTMLElement>('[role="listbox"]');
    expect(listbox).not.toBeNull();
    const composedRoles = new Set(
      Array.from(listbox?.querySelectorAll<HTMLElement>('[role]') ?? [])
        .map((element) => element.getAttribute('role')),
    );
    // A listbox owns options and groups. A heading or a textbox inside it makes
    // the whole control invalid, and a reader then announces a coherent
    // sounding but wrong structure.
    expect(composedRoles).toEqual(new Set(['group', 'option']));
    expect(listbox?.querySelector('input')).toBeNull();

    // The section names its own group, and each row keeps its section-local set.
    expect(listbox?.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Blocked');
    expect(optionNamed(mount, 'Blocked 001')?.getAttribute('aria-setsize')).toBe(String(ROWS_PER_SECTION));

    // The search field is still part of the List, as the collection's sibling.
    expect(mount.container.querySelector('input')).not.toBeNull();
    mount.unmount();
  });

  it('composes a sectioned list with no selection out of nothing but list items', () => {
    resetCapture();
    const context = createSurfaceContext();
    const blocked = sections[0]!;
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <List
          accessibilityLabel="Reviews"
          sections={[{ key: blocked.key, title: blocked.title, data: blocked.data.slice(0, 2) }]}
          keyForItem={(item: Entry) => item.id}
          renderItem={(item: Entry) => <List.Item title={item.label} />}
        />
      </PluginUiProvider>,
    );

    const list = mount.container.querySelector<HTMLElement>('[role="list"]');
    expect(list).not.toBeNull();
    const composedRoles = new Set(
      Array.from(list?.querySelectorAll<HTMLElement>('[role]') ?? [])
        .map((element) => element.getAttribute('role')),
    );
    // A `list` admits list items, not groups. The section header is the one
    // permitted child that can name the section here, so borrowing the
    // listbox's `group` would make this control's structure invalid.
    expect(composedRoles).toEqual(new Set(['listitem']));
    expect(list?.querySelector('[role="listitem"]')?.getAttribute('aria-label')).toBe('Blocked');
    mount.unmount();
  });

  it('renders the empty slot instead of bare headings when every section is empty', () => {
    resetCapture();
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <List
          accessibilityLabel="Reviews"
          sections={[
            { key: 'section-0', title: 'Blocked', data: [] as readonly Entry[] },
            { key: 'section-1', title: 'Waiting', data: [] as readonly Entry[] },
          ]}
          keyForItem={(item: Entry) => item.id}
          renderItem={(item: Entry) => <List.Item title={item.label} />}
          empty={<List.Item title="No reviews yet" />}
          selection={{ onSelectedKeyChange: () => {} }}
        />
      </PluginUiProvider>,
    );

    expect(mount.container.textContent).toContain('No reviews yet');
    // A heading floating over nothing announces a group a reader cannot enter.
    expect(mount.container.textContent).not.toContain('Blocked');
    expect(mount.container.textContent).not.toContain('Waiting');
    mount.unmount();
  });

  it('drops an individually empty section instead of announcing a group with no rows', () => {
    resetCapture();
    const context = createSurfaceContext();
    const populated = sections[1]!;
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <List
          accessibilityLabel="Reviews"
          sections={[
            { key: 'section-0', title: 'Blocked', data: [] as readonly Entry[] },
            { key: populated.key, title: populated.title, data: populated.data.slice(0, 3) },
          ]}
          keyForItem={(item: Entry) => item.id}
          renderItem={(item: Entry) => <List.Item title={item.label} />}
          selection={{ onSelectedKeyChange: () => {} }}
        />
      </PluginUiProvider>,
    );

    expect(sectionListCapture.sections.at(-1)?.map((section) => section.title)).toEqual(['Waiting']);
    expect(mount.container.textContent).not.toContain('Blocked');
    expect(optionNamed(mount, 'Waiting 000')?.getAttribute('aria-setsize')).toBe('3');
    mount.unmount();
  });

  it('drops a section whose rows are all filtered out and keeps the derived section array stable', async () => {
    resetCapture();
    const context = createSurfaceContext();
    const hostApi = createHostApiStub(context);
    const tree = (revision: number) => (
      <PluginUiProvider hostApi={hostApi} context={context}>
        <SectionedReviewList
          sections={sections}
          onSelectedKeyChange={() => {}}
          search={{ label: `Filter ${revision}`, value: 'Waiting 0', onValueChange: () => {} }}
        />
      </PluginUiProvider>
    );
    const mount = mountThroughReactNativeWeb(tree(0));

    const filtered = sectionListCapture.sections.at(-1);
    expect(filtered?.map((section) => section.title)).toEqual(['Waiting']);
    expect(filtered?.[0]?.data.length).toBe(100);

    // Re-rendering with the same authored sections must not rebuild the derived
    // section array the virtualizer keys its cells from.
    const before = sectionListCapture.sections.at(-1);
    await mount.render(tree(1));
    expect(sectionListCapture.sections.at(-1)).toBe(before);
    mount.unmount();
  });
});
