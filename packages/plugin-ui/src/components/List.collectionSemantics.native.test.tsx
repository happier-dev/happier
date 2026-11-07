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
  // Native rows use the static reveal slot; the web easing is only initialized.
  Easing: { bezier: () => (t: number) => t },
  StyleSheet: { hairlineWidth: 0.5 },
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
import { createListMultiSelectionStore, type ListMultiSelectionStore } from './ListMultiSelection.js';
import { ContextMenu } from './Overlay.js';
import { Text } from 'react-native';

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

function renderSelectableList(store?: ListMultiSelectionStore): ReactTestRenderer {
  const context = createSurfaceContext();
  act(() => {
    renderer = create(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <List
          accessibilityLabel="Repositories"
          testID="repositories"
          items={entries}
          keyForItem={(item) => item.id}
          selection={{ selectedKey: null, onSelectedKeyChange: () => undefined,
            ...(store ? { multiple: { store } } : {}) }}
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

function gridRowFrames(): readonly Record<string, unknown>[] {
  return renderer!.root.findAll((node) => node.type === 'View' && node.props.role === 'row')
    .map((node) => node.props as Record<string, unknown>);
}

describe('plugin-ui selectable List collection semantics on native', () => {
  it('retains mounted grid row bodies when independent accessories arrive and leave', () => {
    const context = createSurfaceContext();
    let mounts = 0;
    let unmounts = 0;
    function Body(props: Readonly<{ label: string }>) {
      React.useEffect(() => { mounts += 1; return () => { unmounts += 1; }; }, []);
      return <Text>{props.label}</Text>;
    }
    const tree = (withAccessory: boolean, label: string) => (
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <List accessibilityLabel="Repositories" accessibilityPattern="grid" items={entries}
          keyForItem={item => item.id} selection={{ selectedKey: 'a', onSelectedKeyChange: () => undefined }}
          renderItem={item => <List.Item title={item.label}
            accessory={withAccessory ? <Text>Review</Text> : undefined}>
            <Body label={label} />
          </List.Item>} />
      </PluginUiProvider>
    );
    act(() => { renderer = create(tree(false, 'Retained draft')); });
    expect(mounts).toBe(entries.length);
    act(() => { renderer!.update(tree(true, 'Updated draft')); });
    act(() => { renderer!.update(tree(false, 'Updated draft')); });
    expect(mounts).toBe(entries.length);
    expect(unmounts).toBe(0);
    expect(renderer!.root.findAllByType(Body).map(node => node.props.label)).toEqual(entries.map(() => 'Updated draft'));
  });

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

  it('opens the native row menu on long-press without selecting until Select is chosen', () => {
    const store = createListMultiSelectionStore({ scopeKey: 'native-menu', visibleOrderedKeys: [] });
    renderSelectableList(store);
    const row = renderer!.root.find((node) => node.type === 'Pressable' && node.props.testID === 'row-b');
    act(() => { row.props.onLongPress?.({}); });
    const menu = renderer!.root.findAllByType(ContextMenu).find((node) => node.props.open);
    expect(menu).toBeDefined();
    expect(store.getSnapshot().count).toBe(0);
    act(() => { menu?.props.onSelect('selection.select'); });
    expect(Array.from(store.getSnapshot().selectedKeys)).toEqual(['b']);
  });

  it('adds to a live selection from the row menu, and offers Deselect for a chosen row', () => {
    // The row menu is the only way a finger builds a set. Once a set exists, its Select must add the row rather
    // than replace everything chosen so far, and a chosen row offers the way back out.
    const store = createListMultiSelectionStore({ scopeKey: 'native-menu-add', visibleOrderedKeys: [] });
    renderSelectableList(store);
    act(() => { store.replaceWith('a'); });
    const openMenu = (testID: string) => {
      const row = renderer!.root.find((node) => node.type === 'Pressable' && node.props.testID === testID);
      act(() => { row.props.onLongPress?.({}); });
      return renderer!.root.findAllByType(ContextMenu).find((node) => node.props.open);
    };
    const menu = openMenu('row-b');
    const select = (menu?.props.items as readonly { id: string; label: string }[]).find((item) => item.id === 'selection.select');
    expect(select?.label).toBe('Select');
    act(() => { menu?.props.onSelect('selection.select'); });
    expect(Array.from(store.getSnapshot().selectedKeys).sort()).toEqual(['a', 'b']);
    act(() => { menu?.props.onOpenChange?.(false); });

    const again = openMenu('row-b');
    const deselect = (again?.props.items as readonly { id: string; label: string }[]).find((item) => item.id === 'selection.select');
    expect(deselect?.label).toBe('Deselect');
    act(() => { again?.props.onSelect('selection.select'); });
    expect(Array.from(store.getSnapshot().selectedKeys)).toEqual(['a']);
  });

  it('projects grid rows as selected row/cell structure with native positions', () => {
    const context = createSurfaceContext();
    act(() => {
      renderer = create(
        <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
          <List
            accessibilityLabel="Repositories"
            testID="repositories"
            accessibilityPattern="grid"
            items={entries}
            keyForItem={(item) => item.id}
            selection={{ selectedKey: 'b', onSelectedKeyChange: () => undefined }}
            renderItem={(item) => <List.Item testID={`row-${item.id}`} title={item.label} />}
          />
        </PluginUiProvider>,
      );
    });

    const collection = frame('FlatList', 'repositories');
    expect(collection.role).toBe('grid');
    expect(collection['aria-rowcount']).toBe(entries.length);
    const rows = gridRowFrames();
    expect(rows).toHaveLength(entries.length);
    expect(rows.map((row) => row['aria-rowindex'])).toEqual([1, 2, 3]);
    expect(rows.map((row) => row['aria-selected'])).toEqual([false, true, false]);
    expect(rows.map((row) => row.accessibilityState)).toEqual([
      { selected: false },
      { selected: true },
      { selected: false },
    ]);
    expect(rows[1]?.accessibilityCollectionItem).toEqual({
      rowIndex: 1,
      columnIndex: 0,
      rowSpan: 1,
      columnSpan: 1,
      heading: false,
    });
  });
});
