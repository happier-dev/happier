import * as React from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativePlatform = vi.hoisted(() => ({
  OS: 'android',
  select: <T,>(options: Readonly<{ ios?: T; android?: T; native?: T; default?: T }>) => (
    options.android ?? options.native ?? options.default
  ),
}));

/**
 * React Native is the platform boundary; the List owner and its shared row path
 * stay real. The virtualizer is mounted whole so the collection frame and every
 * row frame are observable in one tree — this suite measures what Android's
 * accessibility service can read, never scroll timing.
 */
vi.mock('react-native', () => ({
  Platform: nativePlatform,
  I18nManager: { isRTL: false },
  FlatList: function MountedFlatList(props: Readonly<{
    data: readonly unknown[];
    keyExtractor(item: unknown, index: number): string;
    renderItem(input: Readonly<{ item: unknown; index: number }>): React.ReactNode;
    ref?: React.Ref<unknown>;
  }> & Record<string, unknown>) {
    const { data, keyExtractor, renderItem, ref, ...frame } = props;
    React.useImperativeHandle(ref, () => ({
      scrollToIndex() { /* every row is already mounted */ },
      scrollToOffset() { /* every row is already mounted */ },
      scrollToEnd() { /* every row is already mounted */ },
    }), []);
    return React.createElement(
      'FlatList',
      frame,
      data.map((item, index) => React.createElement(
        React.Fragment,
        { key: keyExtractor(item, index) },
        renderItem({ item, index }),
      )),
    );
  },
  SectionList: function MountedSectionList(props: Readonly<{
    sections: readonly Readonly<{ key: string; title: string; data: readonly unknown[] }>[];
    keyExtractor(item: unknown, index: number): string;
    renderItem(input: Readonly<{ item: unknown; index: number; section: unknown }>): React.ReactNode;
    renderSectionHeader(input: Readonly<{ section: unknown }>): React.ReactNode;
    ref?: React.Ref<unknown>;
  }> & Record<string, unknown>) {
    const { sections, keyExtractor, renderItem, renderSectionHeader, ref, ...frame } = props;
    React.useImperativeHandle(ref, () => ({
      getScrollResponder() { return { scrollTo() { /* every row is already mounted */ } }; },
      scrollToLocation() { /* every row is already mounted */ },
    }), []);
    return React.createElement(
      'SectionList',
      frame,
      sections.map((section) => React.createElement(
        React.Fragment,
        { key: section.key },
        renderSectionHeader({ section }),
        section.data.map((item, index) => React.createElement(
          React.Fragment,
          { key: keyExtractor(item, index) },
          renderItem({ item, index, section }),
        )),
      )),
    );
  },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
}));

import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { List } from './List.js';
import { PluginUiProvider } from './PluginUiProvider.js';

type Entry = Readonly<{ id: string; label: string }>;

const entries: readonly Entry[] = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Bravo' },
  { id: 'c', label: 'Charlie' },
];

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = null;
});

function renderSelectableList(): ReactTestRenderer {
  const context = createSurfaceContext();
  act(() => {
    renderer = create(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <List
          accessibilityLabel="Repositories"
          testID="repositories"
          items={entries}
          keyForItem={(item) => item.id}
          selection={{ selectedKey: null, onSelectedKeyChange: () => undefined }}
          renderItem={(item) => (
            <List.Item testID={`row-${item.id}`} title={item.label} />
          )}
        />
      </PluginUiProvider>,
    );
  });
  return renderer!;
}

function renderSelectableSectionedList(): ReactTestRenderer {
  const context = createSurfaceContext();
  act(() => {
    renderer = create(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <List
          accessibilityLabel="Repositories"
          testID="repositories"
          sections={[
            { key: 'open', title: 'Open', data: [entries[0]!, entries[1]!] },
            { key: 'closed', title: 'Closed', data: [entries[2]!] },
          ]}
          keyForItem={(item) => item.id}
          selection={{ selectedKey: null, onSelectedKeyChange: () => undefined }}
          renderItem={(item) => (
            <List.Item testID={`row-${item.id}`} title={item.label} />
          )}
        />
      </PluginUiProvider>,
    );
  });
  return renderer!;
}

function frame(host: string, testID: string): Record<string, unknown> {
  return renderer!.root.find((node) => node.type === host && node.props.testID === testID)
    .props as Record<string, unknown>;
}

describe('plugin-ui selectable List collection semantics on native', () => {
  it('gives the collection its native row count', () => {
    renderSelectableList();

    // `role="listbox"` is a React Native Web alias; Android reads
    // `accessibilityCollection`. Without it TalkBack has no collection at all
    // for a selectable list, because the selectable arm deliberately withholds
    // the native `list` role that would contradict `option` rows.
    expect(frame('FlatList', 'repositories').accessibilityCollection).toEqual({
      rowCount: entries.length,
      columnCount: 1,
    });
  });

  it('gives every row its native position without dropping the web aliases', () => {
    renderSelectableList();

    const second = frame('Pressable', 'row-b');
    // Android announces "item 2 of 3" only from the collection-item fact.
    expect(second.accessibilityCollectionItem).toEqual({
      rowIndex: 1,
      columnIndex: 0,
      rowSpan: 1,
      columnSpan: 1,
      heading: false,
    });
    // The web channel keeps carrying the same position, from the same values.
    expect(second['aria-posinset']).toBe(2);
    expect(second['aria-setsize']).toBe(3);

    expect(frame('Pressable', 'row-c').accessibilityCollectionItem).toEqual({
      rowIndex: 2,
      columnIndex: 0,
      rowSpan: 1,
      columnSpan: 1,
      heading: false,
    });
  });

  it('withholds the whole-list extent from a sectioned collection whose rows index inside their section', () => {
    renderSelectableSectionedList();

    // A row's collection-item position is SECTION-local by design (`Bravo` is
    // "2 of 2" in Open, `Charlie` is "1 of 1" in Closed). A whole-list extent
    // beside those indices is a contradiction Android cannot resolve: two rows
    // claim row 0 and no row ever reaches `rowCount - 1`, so TalkBack announces
    // a position that is simply false. The extent is published only where it is
    // derived from the same traversal the rows index within.
    expect(frame('SectionList', 'repositories').accessibilityCollection).toBeUndefined();

    // Positive twin: the rows are really mounted inside the sectioned arm and
    // still carry their section-local position, so this case reaches the branch
    // instead of passing because nothing rendered.
    const bravo = frame('Pressable', 'row-b');
    expect(bravo['aria-posinset']).toBe(2);
    expect(bravo['aria-setsize']).toBe(2);
    const charlie = frame('Pressable', 'row-c');
    expect(charlie['aria-posinset']).toBe(1);
    expect(charlie['aria-setsize']).toBe(1);
  });
});
