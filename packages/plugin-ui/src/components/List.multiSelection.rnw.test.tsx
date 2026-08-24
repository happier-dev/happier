import * as React from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

/**
 * A FULLY MOUNTED flat virtualizer.
 *
 * The sibling focus/virtualization suites already prove this owner against a
 * windowing virtualizer. This suite measures the multi-selection capability's
 * RULES, so every row is mounted and no reveal timing is in play: a failure here
 * is a selection defect and never a scroll-timing one.
 */
vi.mock('react-native', async () => {
  const native = await vi.importActual<typeof import('react-native')>('react-native');
  return {
    ...native,
    FlatList: function MountedFlatList(props: Readonly<{
      data: readonly unknown[];
      keyExtractor(item: unknown, index: number): string;
      renderItem(input: Readonly<{ item: unknown; index: number }>): React.ReactNode;
      ListHeaderComponent?: React.ReactNode;
      ListEmptyComponent?: React.ReactNode;
      ListFooterComponent?: React.ReactNode;
      role?: 'list' | 'listbox';
      ref?: React.Ref<unknown>;
    }>) {
      React.useImperativeHandle(props.ref, () => ({
        scrollToIndex() { /* every row is already mounted */ },
        scrollToOffset() { /* every row is already mounted */ },
        scrollToEnd() { /* every row is already mounted */ },
      }), []);
      return (
        <div role={props.role} data-testid="collection">
          {props.ListHeaderComponent}
          {props.data.map((item, index) => (
            <React.Fragment key={props.keyExtractor(item, index)}>
              {props.renderItem({ item, index })}
            </React.Fragment>
          ))}
          {props.ListFooterComponent}
        </div>
      );
    },
  };
});

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { List } from './List.js';
import { useListMultiSelectionController, type ListMultiSelectionStore } from './ListMultiSelection.js';
import { PluginUiProvider } from './PluginUiProvider.js';

type Entry = Readonly<{ id: string; label: string; selectable: boolean }>;

const entries: readonly Entry[] = [
  { id: 'a', label: 'Alpha', selectable: true },
  { id: 'b', label: 'Bravo', selectable: true },
  { id: 'c', label: 'Charlie', selectable: false },
  { id: 'd', label: 'Delta', selectable: true },
  { id: 'e', label: 'Echo', selectable: true },
];

type Mounted = Readonly<{
  container: HTMLElement;
  /** Re-renders inside the SAME environment, which is what a real re-render is. */
  rerender: (node: React.ReactNode) => Promise<void>;
  unmount: () => void;
}>;

function mount(node: React.ReactNode): Mounted {
  const context = createSurfaceContext();
  const hostApi = createHostApiStub(context);
  const wrap = (child: React.ReactNode) => (
    <PluginUiProvider hostApi={hostApi} context={context}>
      {child}
    </PluginUiProvider>
  );
  const mounted = mountThroughReactNativeWeb(wrap(node));
  return {
    container: mounted.container,
    rerender: (next) => mounted.render(wrap(next)),
    unmount: mounted.unmount,
  };
}

type HarnessProps = Readonly<{
  scopeKey?: string;
  items?: readonly Entry[];
  onSelectedKeyChange?: (key: string) => void;
  onStore?: (store: ListMultiSelectionStore) => void;
  withActionBar?: boolean;
  onAction?: (actionId: string, keys: readonly string[]) => void;
  query?: string;
  retainedSelectionKeys?: readonly string[];
}>;

function Harness(props: HarnessProps): React.ReactElement {
  const store = useListMultiSelectionController({
    scopeKey: props.scopeKey ?? 'scope-a',
    rows: 'collection',
  });
  props.onStore?.(store);
  return (
    <List
      accessibilityLabel="Entries"
      items={props.items ?? entries}
      keyForItem={(item: Entry) => item.id}
      renderItem={(item: Entry) => <List.Item title={item.label} onPress={() => undefined} />}
      search={props.query === undefined ? undefined : {
        label: 'Search',
        value: props.query,
        onValueChange: () => undefined,
        filter: (item: Entry, query: string) => item.label.includes(query),
      }}
      selection={{
        onSelectedKeyChange: props.onSelectedKeyChange ?? (() => undefined),
        multiple: {
          store,
          isItemSelectable: (item: Entry) => item.selectable,
          ...(props.retainedSelectionKeys === undefined
            ? {}
            : { retainedSelectionKeys: props.retainedSelectionKeys }),
        },
      }}
      footer={props.withActionBar ? (
        <List.SelectionActionBar
          actions={[{ id: 'attach', label: 'Attach all' }]}
          onAction={props.onAction ?? (() => undefined)}
          testID="bulk-bar"
        />
      ) : undefined}
    />
  );
}

const optionsIn = (container: HTMLElement) => (
  Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'))
);
const optionNamed = (container: HTMLElement, label: string) => (
  optionsIn(container).find((option) => option.textContent?.includes(label))
);
const selectedLabels = (container: HTMLElement) => (
  optionsIn(container)
    .filter((option) => option.getAttribute('aria-selected') === 'true')
    .map((option) => option.textContent ?? '')
);

async function pressRow(
  container: HTMLElement,
  label: string,
  modifiers: Readonly<{ shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }> = {},
): Promise<void> {
  const option = optionNamed(container, label);
  await act(async () => {
    option?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...modifiers }));
  });
}

async function pressKey(
  container: HTMLElement,
  label: string,
  key: string,
  modifiers: Readonly<{ shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }> = {},
): Promise<void> {
  const option = optionNamed(container, label);
  await act(async () => {
    option?.focus();
    option?.dispatchEvent(new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...modifiers,
    }));
  });
}

describe('List multi-selection capability', () => {
  it('is absent until an author opts in', async () => {
    const mounted = mount(
      <List
        accessibilityLabel="Entries"
        items={entries}
        keyForItem={(item: Entry) => item.id}
        renderItem={(item: Entry) => <List.Item title={item.label} onPress={() => undefined} />}
        selection={{ onSelectedKeyChange: () => undefined }}
      />,
    );
    await pressRow(mounted.container, 'Bravo', { ctrlKey: true });
    // Without the capability a modified press is an ordinary activation, so the
    // single selected key moved and nothing became multi-selected.
    expect(selectedLabels(mounted.container)).toEqual(['Bravo']);
    mounted.unmount();
  });

  it('toggles with the platform command modifier without opening a detail', async () => {
    const opened: string[] = [];
    const mounted = mount(<Harness onSelectedKeyChange={(key) => opened.push(key)} />);

    await pressRow(mounted.container, 'Bravo', { ctrlKey: true });
    await pressRow(mounted.container, 'Delta', { ctrlKey: true });

    expect(selectedLabels(mounted.container)).toEqual(['Bravo', 'Delta']);
    // The two cursors stayed independent: building a set never opened a detail.
    expect(opened).toEqual([]);
    mounted.unmount();
  });

  it('enters selection mode from an ordinary touch-sized control and then toggles rows without opening them', async () => {
    const opened: string[] = [];
    const mounted = mount(
      <Harness withActionBar onSelectedKeyChange={(key) => opened.push(key)} />,
    );

    const enter = mounted.container.querySelector<HTMLElement>(
      '[data-testid="happier-list-selection-mode"]',
    );
    expect(enter).not.toBeNull();
    expect(enter?.textContent).toContain('Select');
    // The host button owner exposes the minimum interactive box directly;
    // hit slop alone would not make adjacent controls non-overlapping on touch.
    expect(Number.parseFloat(enter?.style.minHeight ?? '0')).toBeGreaterThanOrEqual(44);

    await act(async () => { enter?.click(); });
    expect(opened).toEqual([]);
    expect(mounted.container.querySelector('[data-testid="bulk-bar"]')).toBeNull();

    await pressRow(mounted.container, 'Bravo');
    await pressRow(mounted.container, 'Delta');

    expect(opened).toEqual([]);
    expect(selectedLabels(mounted.container)).toEqual(['Bravo', 'Delta']);
    expect(mounted.container.querySelector('[data-testid="bulk-bar"]')).not.toBeNull();
    mounted.unmount();
  });

  it('opens a detail on a plain press and toggles once a selection is live', async () => {
    const opened: string[] = [];
    const mounted = mount(<Harness onSelectedKeyChange={(key) => opened.push(key)} />);

    await pressRow(mounted.container, 'Alpha');
    expect(opened).toEqual(['a']);

    await pressRow(mounted.container, 'Bravo', { ctrlKey: true });
    await pressRow(mounted.container, 'Delta');

    expect(opened).toEqual(['a']);
    expect(selectedLabels(mounted.container)).toEqual(['Bravo', 'Delta']);
    mounted.unmount();
  });

  it('extends a shift range over the collection and skips unselectable rows', async () => {
    const mounted = mount(<Harness />);

    await pressRow(mounted.container, 'Bravo', { ctrlKey: true });
    await pressRow(mounted.container, 'Echo', { shiftKey: true });

    // Charlie is not selectable, so the span reaches over it rather than
    // stopping at it or quietly selecting it.
    expect(selectedLabels(mounted.container)).toEqual(['Bravo', 'Delta', 'Echo']);
    mounted.unmount();
  });

  it('toggles the focused row with Space and extends with Shift+Arrow', async () => {
    const mounted = mount(<Harness />);

    await pressKey(mounted.container, 'Alpha', ' ');
    expect(selectedLabels(mounted.container)).toEqual(['Alpha']);

    await pressKey(mounted.container, 'Alpha', 'ArrowDown', { shiftKey: true });
    expect(selectedLabels(mounted.container)).toEqual(['Alpha', 'Bravo']);

    // Charlie is disabled for selection, so the next extension must land on
    // Delta — a fact only the collection owner can see.
    await pressKey(mounted.container, 'Bravo', 'ArrowDown', { shiftKey: true });
    expect(selectedLabels(mounted.container)).toEqual(['Alpha', 'Bravo', 'Delta']);
    mounted.unmount();
  });

  it('selects every visible eligible row with the command modifier and clears with Escape', async () => {
    const mounted = mount(<Harness />);

    await pressKey(mounted.container, 'Alpha', 'a', { ctrlKey: true });
    expect(selectedLabels(mounted.container)).toEqual(['Alpha', 'Bravo', 'Delta', 'Echo']);

    await pressKey(mounted.container, 'Alpha', 'Escape');
    expect(selectedLabels(mounted.container)).toEqual([]);
    mounted.unmount();
  });

  it('keeps a selection through a search narrowing and restores it when the query clears', async () => {
    let store: ListMultiSelectionStore | null = null;
    const mounted = mount(<Harness query="" onStore={(next) => { store = next; }} />);

    await pressRow(mounted.container, 'Bravo', { ctrlKey: true });
    await pressRow(mounted.container, 'Echo', { ctrlKey: true });

    await mounted.rerender(<Harness query="Alpha" onStore={(next) => { store = next; }} />);

    // Neither row is on screen, yet both survive: eligibility is the author's
    // whole dataset, not the filtered window.
    expect(Array.from(store?.getSnapshot().selectedKeys ?? []).sort()).toEqual(['b', 'e']);

    await mounted.rerender(<Harness query="" onStore={(next) => { store = next; }} />);
    expect(selectedLabels(mounted.container)).toEqual(['Bravo', 'Echo']);
    mounted.unmount();
  });

  it('keeps a selection whose rows an OWNER OUTSIDE this List narrowed away', async () => {
    // Triage's case: the query narrows the corpus walk upstream, so the rows
    // never reach this List at all and its own author-dataset eligibility
    // cannot see them. Without a retained set the selection the reader built is
    // pruned by typing, which is the silent drop the eligible/visible split
    // exists to prevent.
    let store: ListMultiSelectionStore | null = null;
    const mounted = mount(<Harness onStore={(next) => { store = next; }} />);

    await pressRow(mounted.container, 'Bravo', { ctrlKey: true });
    await pressRow(mounted.container, 'Echo', { ctrlKey: true });
    expect(store?.getSnapshot().count).toBe(2);

    await mounted.rerender(
      <Harness
        items={[entries[0]!]}
        retainedSelectionKeys={['b', 'e']}
        onStore={(next) => { store = next; }}
      />,
    );

    expect(Array.from(store?.getSnapshot().selectedKeys ?? []).sort()).toEqual(['b', 'e']);

    await mounted.rerender(
      <Harness retainedSelectionKeys={['b', 'e']} onStore={(next) => { store = next; }} />,
    );
    expect(selectedLabels(mounted.container)).toEqual(['Bravo', 'Echo']);
    mounted.unmount();
  });

  it('never lets a retained key make an author-declared UNSELECTABLE row selectable', async () => {
    // Retention answers "this row is hidden", never "this row may be chosen".
    // `Charlie` is declared unselectable, so naming it retained must not admit
    // it — otherwise a continuation or placeholder row joins a bulk action.
    let store: ListMultiSelectionStore | null = null;
    const mounted = mount(
      <Harness retainedSelectionKeys={['c']} onStore={(next) => { store = next; }} />,
    );

    await pressRow(mounted.container, 'Charlie', { ctrlKey: true });

    expect(store?.getSnapshot().count).toBe(0);
    mounted.unmount();
  });

  it('clears the selection when the author moves the scope', async () => {
    let store: ListMultiSelectionStore | null = null;
    const mounted = mount(<Harness onStore={(next) => { store = next; }} />);

    await pressRow(mounted.container, 'Bravo', { ctrlKey: true });
    expect(store?.getSnapshot().count).toBe(1);

    await mounted.rerender(<Harness scopeKey="scope-b" onStore={(next) => { store = next; }} />);

    expect(store?.getSnapshot().count).toBe(0);
    expect(store?.getSnapshot().isSelectionMode).toBe(false);
    // The rows must survive the scope reset, or the next selection has nothing
    // to address and range extension silently stops working.
    expect(store?.getSnapshot().visibleOrderedKeys).toEqual(['a', 'b', 'c', 'd', 'e']);
    mounted.unmount();
  });

  it('shows the bulk action bar only while a selection is live and hands it the keys', async () => {
    const actions: Array<Readonly<{ id: string; keys: readonly string[] }>> = [];
    const mounted = mount(
      <Harness withActionBar onAction={(id, keys) => actions.push({ id, keys })} />,
    );

    expect(mounted.container.textContent).not.toContain('Attach all');

    await pressRow(mounted.container, 'Bravo', { ctrlKey: true });
    await pressRow(mounted.container, 'Delta', { ctrlKey: true });
    expect(mounted.container.textContent).toContain('2 selected');

    const attach = Array.from(mounted.container.querySelectorAll<HTMLElement>('[role="button"]'))
      .find((button) => button.textContent?.includes('Attach all'));
    await act(async () => {
      attach?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(actions).toEqual([{ id: 'attach', keys: ['b', 'd'] }]);

    const clear = Array.from(mounted.container.querySelectorAll<HTMLElement>('[role="button"]'))
      .find((button) => button.textContent?.includes('Clear selection'));
    await act(async () => {
      clear?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(mounted.container.textContent).not.toContain('Attach all');
    mounted.unmount();
  });

  it('keeps one tab stop while a multi-selection is live', async () => {
    const mounted = mount(<Harness />);

    await pressRow(mounted.container, 'Bravo', { ctrlKey: true });
    await pressRow(mounted.container, 'Delta', { ctrlKey: true });

    const tabStops = optionsIn(mounted.container).filter((option) => option.getAttribute('tabindex') === '0');
    expect(tabStops).toHaveLength(1);
    expect(tabStops[0]?.textContent).toContain('Delta');
    mounted.unmount();
  });
});
