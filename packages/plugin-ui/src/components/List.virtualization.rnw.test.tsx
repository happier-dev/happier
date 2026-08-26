import * as React from 'react';
import { act } from 'react';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { describe, expect, it, vi } from 'vitest';

// This is a deterministic SYSTEM-BOUNDARY fixture used to exercise List's
// behavior with unmounted rows. It is not a measurement or an assertion about
// React Native's real retained window; that belongs to loaded native QA.
const VIRTUALIZED_WINDOW_SIZE = vi.hoisted(() => 12);

const flatListCapture = vi.hoisted(() => ({
  data: [] as Array<readonly unknown[]>,
  role: [] as Array<unknown>,
  contentContainerStyle: [] as unknown[],
  keyboardShouldPersistTaps: [] as Array<unknown>,
  keyExtractor: [] as Array<(item: unknown, index: number) => string>,
  emptyComponent: [] as React.ReactNode[],
  imperativeReveals: [] as Array<Readonly<{ method: string; index?: number; offset?: number }>>,
  renderItem: [] as Array<(input: Readonly<{ item: unknown; index: number }>) => React.ReactNode>,
  scrollToIndex: [] as Array<(index: number) => void>,
  windowStarts: [] as number[],
}));

// FlatList is the platform virtualizer boundary. Capturing its props lets this
// public-component test verify List's bounded-window contract without mocking
// any plugin-ui behavior beneath List.
vi.mock('react-native', async () => {
  // `importOriginal('react-native')` bypasses this test project's RNW alias and
  // loads React Native's Flow entrypoint. Import through the configured public
  // specifier so the virtualizer boundary retains RNW's real primitives while
  // only replacing FlatList itself.
  const native = await vi.importActual<typeof import('react-native')>('react-native');
  return {
    ...native,
    FlatList: function CapturingFlatList(props: Readonly<{
      data: readonly unknown[];
      keyExtractor(item: unknown, index: number): string;
      renderItem(input: Readonly<{ item: unknown; index: number }>): React.ReactNode;
      ListHeaderComponent?: React.ReactNode;
      ListEmptyComponent?: React.ReactNode;
      ListFooterComponent?: React.ReactNode;
      role?: 'list' | 'listbox';
      accessibilityLabel?: string;
      contentContainerStyle?: unknown;
      keyboardShouldPersistTaps?: unknown;
      // React 19 passes `ref` as an ordinary prop to a function component, so
      // the virtualizer boundary can expose its real imperative scroll surface
      // without evaluating `forwardRef` while this mock factory is still
      // resolving its own `react-native` import.
      ref?: React.Ref<unknown>;
    }>) {
      const [windowStart, setWindowStart] = React.useState(0);
      const maximumWindowStart = Math.max(0, props.data.length - VIRTUALIZED_WINDOW_SIZE);
      const boundedWindowStart = Math.min(windowStart, maximumWindowStart);
      // A real virtualizer only scrolls when the target sits outside the mounted
      // window; a mock that always re-anchors would hide whether the component
      // asks for reveals it does not need.
      const revealIndex = React.useCallback((index: number) => {
        setWindowStart((current) => {
          const maximum = Math.max(0, props.data.length - VIRTUALIZED_WINDOW_SIZE);
          const start = Math.min(current, maximum);
          if (index >= start && index < start + VIRTUALIZED_WINDOW_SIZE) return current;
          return Math.max(0, Math.min(index, maximum));
        });
      }, [props.data.length]);
      React.useImperativeHandle(props.ref, () => ({
        scrollToIndex(input: Readonly<{ index: number }>) {
          flatListCapture.imperativeReveals.push({ method: 'scrollToIndex', index: input.index });
          revealIndex(input.index);
        },
        scrollToOffset(input: Readonly<{ offset: number }>) {
          flatListCapture.imperativeReveals.push({ method: 'scrollToOffset', offset: input.offset });
          if (input.offset === 0) revealIndex(0);
        },
        scrollToEnd() {
          flatListCapture.imperativeReveals.push({ method: 'scrollToEnd' });
          revealIndex(props.data.length - 1);
        },
      }), [props.data.length, revealIndex]);
      const windowItems = props.data.slice(
        boundedWindowStart,
        boundedWindowStart + VIRTUALIZED_WINDOW_SIZE,
      );
      flatListCapture.data.push(props.data);
      flatListCapture.role.push(props.role);
      flatListCapture.contentContainerStyle.push(props.contentContainerStyle);
      flatListCapture.keyboardShouldPersistTaps.push(props.keyboardShouldPersistTaps);
      flatListCapture.keyExtractor.push(props.keyExtractor);
      flatListCapture.emptyComponent.push(props.ListEmptyComponent);
      flatListCapture.renderItem.push(props.renderItem);
      flatListCapture.scrollToIndex.push((index) => {
        setWindowStart(Math.max(0, Math.min(index, maximumWindowStart)));
      });
      flatListCapture.windowStarts.push(boundedWindowStart);
      return (
        <div aria-label={props.accessibilityLabel} role={props.role}>
          {props.ListHeaderComponent}
          {props.data.length === 0
            ? props.ListEmptyComponent
            : windowItems.map((item, offset) => {
                const index = boundedWindowStart + offset;
                return (
                  <React.Fragment key={props.keyExtractor(item, index)}>
                    {props.renderItem({ item, index })}
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
import { PluginUiPresentationHostProviderInternal } from '../presentationHost/context.js';
import { useLivePluginResource } from '../hostApi/index.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { Button } from './Button.js';
import { List } from './List.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { Text } from './Text.js';

function mountList(children: React.ReactNode, context = createSurfaceContext()) {
  return mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <PluginUiPresentationHostProviderInternal host={{
        focusTarget: (target: unknown) => {
          const focus = (target as Readonly<{ focus?: () => void }> | null)?.focus;
          if (typeof focus !== 'function') return false;
          focus.call(target);
          return true;
        },
        renderMarkdown: () => null,
        renderCodeBlock: () => null,
        renderPopover: () => null,
        renderIcon: () => null,
      }}>
        {children}
      </PluginUiPresentationHostProviderInternal>
    </PluginUiProvider>,
  );
}

function enterText(input: HTMLInputElement, value: string, isComposing = false): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('The RNW List search fixture did not expose an input value setter.');
  setter.call(input, value);
  input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing }));
}

describe('virtualized List data ownership', () => {
  it('owns exact search editing, IME settlement, Escape clearing, caret, and slash focus once', async () => {
    const composingValues: Array<string | null> = [];
    const settledValues: string[] = [];

    function SearchList() {
      const [value, setValue] = React.useState('hash-123');
      return (
        <List
          items={[{ id: 'one', label: 'hash-123' }]}
          keyForItem={(item) => item.id}
          renderItem={(item) => <List.Item title={item.label} />}
          search={{
            label: 'Search findings',
            value,
            testID: 'owned-search',
            filter: () => true,
            onValueChange: (next) => {
              settledValues.push(next);
              setValue(next);
            },
            onComposingValueChange: (next) => { composingValues.push(next); },
          }}
        />
      );
    }

    const mount = mountList(<SearchList />);
    const input = mount.container.querySelector<HTMLInputElement>('[data-testid="owned-search"]');
    expect(input).not.toBeNull();
    expect(input?.getAttribute('autocapitalize')).toBe('none');
    expect(input?.getAttribute('autocorrect')).toBe('off');

    input?.setSelectionRange(2, 5);
    await act(async () => {
      input?.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      enterText(input!, 'ハッシュ', true);
      input?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      input?.setSelectionRange(4, 4);
      input?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    expect(settledValues).toEqual([]);
    expect(composingValues).toContain('ハッシュ');

    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }));
    });
    expect(settledValues).toEqual([]);

    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }));
    });
    expect(settledValues).toEqual([]);

    await act(async () => {
      enterText(input!, 'ハッシュ', false);
      input?.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    });
    expect(settledValues).toEqual(['ハッシュ']);
    expect(composingValues.at(-1)).toBeNull();
    expect(input?.selectionStart).toBe(4);
    expect(input?.selectionEnd).toBe(4);

    input?.blur();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(input);

    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(settledValues.at(-1)).toBe('');
    expect(document.activeElement).toBe(input);

    const emptyEscape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await act(async () => { input?.dispatchEvent(emptyEscape); });
    expect(emptyEscape.defaultPrevented).toBe(false);
    mount.unmount();
  });

  it('passes the author-owned item array through unchanged to the native virtualizer', () => {
    const items = [
      { id: 'first', label: 'First finding' },
      { id: 'second', label: 'Second finding' },
    ] as const;
    flatListCapture.data.length = 0;

    const mount = mountList(
      <List
        items={items}
        keyForItem={(item) => item.id}
        renderItem={(item) => item.label}
      />,
    );

    expect(flatListCapture.data).toHaveLength(1);
    expect(flatListCapture.data[0]).toBe(items);
    mount.unmount();
  });

  it('keeps one semantic row per item and keeps surrounding content out of the collection element', () => {
    const items = [
      { id: 'first', label: 'First finding' },
      { id: 'second', label: 'Second finding' },
    ] as const;
    flatListCapture.data.length = 0;
    flatListCapture.keyboardShouldPersistTaps.length = 0;

    const mount = mountList(
      <List
        items={items}
        keyForItem={(item) => item.id}
        renderItem={(item) => <List.Item title={item.label} />}
        header={<Text value="Current findings" />}
        empty={<Text value="No findings" />}
        footer={<Text value="End of findings" />}
      />,
    );

    const list = mount.container.querySelector('[role="list"]');
    expect(list?.querySelectorAll('[role="listitem"]')).toHaveLength(2);
    // A `list` owns list items. Chrome inside it is not a permitted child, so
    // it is the collection's sibling and stays part of the same List.
    expect(list?.textContent).not.toContain('Current findings');
    expect(list?.textContent).not.toContain('End of findings');
    expect(mount.container.textContent).toContain('Current findings');
    expect(mount.container.textContent).toContain('End of findings');
    expect(flatListCapture.keyboardShouldPersistTaps).toEqual(['handled']);
    mount.unmount();
  });

  it('uses listbox and option semantics without nesting listitem inside selectable rows', () => {
    const items = [
      { id: 'first', label: 'First finding' },
      { id: 'second', label: 'Second finding' },
    ] as const;
    flatListCapture.role.length = 0;

    const mount = mountList(
      <List
        accessibilityLabel="Findings"
        items={items}
        keyForItem={(item) => item.id}
        selection={{ defaultSelectedKey: 'first' }}
        renderItem={(item) => <List.Item title={item.label} />}
      />,
    );

    const listbox = mount.container.querySelector<HTMLElement>('[role="listbox"]');
    expect(flatListCapture.role.at(-1)).toBe('listbox');
    expect(listbox).not.toBeNull();
    expect(listbox?.getAttribute('aria-label')).toBe('Findings');
    expect(listbox?.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(listbox?.querySelectorAll('[role="listitem"]')).toHaveLength(0);
    mount.unmount();
  });

  it('rejects blank selectable-list names supplied by an untyped bundle', () => {
    const items = [{ id: 'first', label: 'First finding' }] as const;
    const UntypedList = List as unknown as React.ComponentType<Readonly<{
      accessibilityLabel?: string;
      items: typeof items;
      keyForItem: (item: (typeof items)[number]) => string;
      selection: Readonly<{ defaultSelectedKey: string | null }>;
      renderItem: (item: (typeof items)[number]) => React.ReactNode;
    }>>;

    expect(() => mountList(
      <UntypedList
        accessibilityLabel="   "
        items={items}
        keyForItem={(item) => item.id}
        selection={{ defaultSelectedKey: 'first' }}
        renderItem={(item) => <List.Item title={item.label} />}
      />,
    )).toThrow('Selectable List requires a non-empty accessible name.');
  });

  it('resolves a selectable-list name from the plugin translation catalog', () => {
    const items = [{ id: 'first', label: 'First finding' }] as const;
    const mount = mountList(
      <List
        accessibilityLabelKey="acme.findings"
        items={items}
        keyForItem={(item) => item.id}
        selection={{ defaultSelectedKey: 'first' }}
        renderItem={(item) => <List.Item title={item.label} />}
      />,
      createSurfaceContext({ translations: { 'acme.findings': 'Constats' } }),
    );

    expect(mount.container.querySelector('[role="listbox"]')?.getAttribute('aria-label')).toBe('Constats');
    mount.unmount();
  });

  it('promotes primitive selectable rows into options at the virtualized row owner', () => {
    const items = [
      { id: 'first', label: 'First finding' },
      { id: 'second', label: 'Second finding' },
    ] as const;

    const mount = mountList(
      <List
        accessibilityLabel="Findings"
        items={items}
        keyForItem={(item) => item.id}
        selection={{ defaultSelectedKey: 'first' }}
        renderItem={(item) => item.label}
      />,
    );

    const listbox = mount.container.querySelector<HTMLElement>('[role="listbox"]');
    expect(listbox?.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(listbox?.querySelectorAll('[role="listitem"]')).toHaveLength(0);
    expect(listbox?.querySelector('[role="option"]')?.getAttribute('aria-selected')).toBe('true');
    mount.unmount();
  });

  it('keeps virtualized content spacing at the shared List owner while accepting a portable author inset', () => {
    const items = [{ id: 'first', label: 'First finding' }] as const;
    flatListCapture.contentContainerStyle.length = 0;

    const mount = mountList(
      <List
        items={items}
        keyForItem={(item) => item.id}
        renderItem={(item) => <List.Item title={item.label} />}
        contentContainerStyle={{ paddingBottom: 24 }}
      />,
    );

    expect(flatListCapture.contentContainerStyle).toEqual([[{ gap: 8 }, { paddingBottom: 24 }]]);
    mount.unmount();
  });

  it('gives the native virtualizer a bounded flex viewport through List own box', () => {
    const mount = mountList(
      <List
        items={[{ id: 'first', label: 'First finding' }]}
        keyForItem={(item) => item.id}
        renderItem={(item) => <List.Item title={item.label} />}
      />,
    );

    const collection = mount.container.querySelector<HTMLElement>('[role="list"]');
    const collectionBox = collection?.parentElement;
    expect(collectionBox).not.toBeNull();
    expect(collectionBox?.style.minHeight).toBe('0px');
    mount.unmount();
  });

  it('uses the public empty slot without replacing the virtualized list owner', () => {
    flatListCapture.data.length = 0;

    const mount = mountList(
      <List
        items={[]}
        keyForItem={() => 'unreachable'}
        renderItem={() => null}
        header={<Text value="Current findings" />}
        empty={<Text value="No findings" />}
      />,
    );

    expect(mount.container.textContent).toContain('Current findings');
    expect(mount.container.textContent).toContain('No findings');
    expect(mount.container.querySelectorAll('[role="listitem"]')).toHaveLength(0);
    mount.unmount();
  });

  it('keeps the empty slot beside the collection element rather than inside it', () => {
    flatListCapture.emptyComponent.length = 0;

    const mount = mountList(
      <List
        items={[]}
        keyForItem={() => 'unreachable'}
        renderItem={() => null}
        empty={<Text value="No findings" />}
      />,
    );

    // The platform empty slot is no longer used at all: a sectioned collection
    // never reaches it, so one owner decides emptiness for both arms.
    expect(flatListCapture.emptyComponent.at(-1)).toBeUndefined();
    const list = mount.container.querySelector('[role="list"]');
    expect(list).not.toBeNull();
    expect(list?.textContent).not.toContain('No findings');
    expect(mount.container.textContent).toContain('No findings');
    mount.unmount();
  });

  it('uses the public empty slot when its owned search leaves no matching rows', () => {
    const items = [{ id: 'first', label: 'First finding' }] as const;
    flatListCapture.data.length = 0;

    const mount = mountList(
      <List
        items={items}
        keyForItem={(item) => item.id}
        search={{
          label: 'Search findings',
          defaultValue: 'missing',
          filter: (item, query) => item.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
        }}
        renderItem={(item) => <List.Item title={item.label} />}
        empty={<Text value="No matching findings" />}
      />,
    );

    expect(flatListCapture.data.at(-1)).toEqual([]);
    expect(mount.container.textContent).toContain('No matching findings');
    expect(mount.container.querySelectorAll('[role="option"]')).toHaveLength(0);
    mount.unmount();
  });

  it('filters before the native virtualizer and preserves one uncontrolled option selection across a temporary query', async () => {
    const items = [
      { id: 'review-001', label: 'Review current changes' },
      { id: 'review-002', label: 'Review terminal output' },
      { id: 'review-003', label: 'Review release notes' },
    ] as const;
    const selectedKeys: string[] = [];
    flatListCapture.data.length = 0;

    const mount = mountList(
      <List
        accessibilityLabel="Review items"
        items={items}
        keyForItem={(item) => item.id}
        search={{
          label: 'Search review items',
          placeholder: 'Filter reviews',
          testID: 'review-search',
          filter: (item, query) => item.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
        }}
        selection={{
          defaultSelectedKey: 'review-001',
          onSelectedKeyChange: (key) => selectedKeys.push(key),
        }}
        header={({ selectedItem }) => (
          <Text value={selectedItem === null ? 'No selected review' : `Selected ${selectedItem.label}`} />
        )}
        renderItem={(item) => <List.Item title={item.label} />}
      />,
    );

    const initiallySelectedOption = mount.container.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
    expect(initiallySelectedOption).not.toBeNull();
    expect(initiallySelectedOption?.textContent).toContain('Review current changes');

    const search = mount.container.querySelector<HTMLInputElement>('[data-testid="review-search"]');
    expect(search, 'the public List must own its supplied search field').not.toBeNull();
    await act(async () => { enterText(search!, 'terminal'); });

    expect(flatListCapture.data.at(-1)).toEqual([items[1]]);
    expect(Array.from(mount.container.querySelectorAll<HTMLElement>('[role="option"]'))
      .some((option) => option.textContent?.includes('Review current changes'))).toBe(false);
    const filteredOption = mount.container.querySelector<HTMLElement>('[role="option"]');
    expect(filteredOption?.getAttribute('aria-selected')).toBe('false');
    expect(filteredOption?.getAttribute('aria-posinset')).toBe('1');
    expect(filteredOption?.getAttribute('aria-setsize')).toBe('1');
    expect(mount.container.textContent).toContain('No selected review');

    await act(async () => {
      filteredOption?.focus();
      filteredOption?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      filteredOption?.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(selectedKeys).toEqual(['review-002']);
    expect(filteredOption?.getAttribute('aria-selected')).toBe('true');
    expect(mount.container.textContent).toContain('Selected Review terminal output');
    expect(document.activeElement).toBe(filteredOption);

    await act(async () => { enterText(search!, ''); });
    const restoredTerminalOption = Array.from(mount.container.querySelectorAll<HTMLElement>('[role="option"]'))
      .find((option) => option.textContent?.includes('Review terminal output'));
    expect(restoredTerminalOption?.getAttribute('aria-selected')).toBe('true');
    mount.unmount();
  });

  it('keeps query and selection controlled by the author when both values change', async () => {
    const items = [
      { id: 'review-001', label: 'Review current changes' },
      { id: 'review-002', label: 'Review terminal output' },
      { id: 'review-003', label: 'Review release notes' },
    ] as const;
    flatListCapture.data.length = 0;

    function ControlledReviewList() {
      const [query, setQuery] = React.useState('terminal');
      const [selectedKey, setSelectedKey] = React.useState<string | null>('review-002');
      return (
        <List
          accessibilityLabel="Controlled review items"
          items={items}
          keyForItem={(item) => item.id}
          search={{
            label: 'Search controlled review items',
            value: query,
            onValueChange: setQuery,
            filter: (item, value) => item.label.toLocaleLowerCase().includes(value.toLocaleLowerCase()),
          }}
          selection={{ selectedKey, onSelectedKeyChange: setSelectedKey }}
          renderItem={(item) => <List.Item title={item.label} />}
        />
      );
    }

    const mount = mountList(<ControlledReviewList />);
    expect(flatListCapture.data.at(-1)).toEqual([items[1]]);
    expect(mount.container.querySelector('[role="option"]')?.getAttribute('aria-selected')).toBe('true');

    const search = mount.container.querySelector<HTMLInputElement>('[aria-label="Search controlled review items"]');
    expect(search).not.toBeNull();
    await act(async () => { enterText(search!, 'release'); });

    expect(flatListCapture.data.at(-1)).toEqual([items[2]]);
    const release = mount.container.querySelector<HTMLElement>('[role="option"]');
    expect(release?.getAttribute('aria-selected')).toBe('false');
    await act(async () => { release?.click(); });
    expect(release?.getAttribute('aria-selected')).toBe('true');
    mount.unmount();
  });

  it('keeps a bounded filtered data window referentially stable when an uncontrolled selection changes', async () => {
    const items = Array.from({ length: 240 }, (_, index) => ({
      id: `review-${String(index).padStart(3, '0')}`,
      label: `Review item ${index}`,
    }));
    const filter = vi.fn((item: (typeof items)[number], query: string) => item.label.includes(query));
    flatListCapture.data.length = 0;

    const mount = mountList(
      <List
        accessibilityLabel="Review items"
        items={items}
        keyForItem={(item) => item.id}
        search={{
          label: 'Search reviews',
          defaultValue: 'Review item 199',
          filter,
        }}
        selection={{ defaultSelectedKey: null }}
        renderItem={(item) => <List.Item title={item.label} />}
      />,
    );

    const filterCallsAfterMount = filter.mock.calls.length;
    const filteredWindow = flatListCapture.data.at(-1);
    expect(filterCallsAfterMount).toBe(items.length);
    expect((filteredWindow as readonly unknown[]).length).toBeGreaterThan(0);

    const option = mount.container.querySelector<HTMLElement>('[role="option"]');
    expect(option).not.toBeNull();
    await act(async () => { option?.click(); });

    expect(filter.mock.calls).toHaveLength(filterCallsAfterMount);
    expect(flatListCapture.data.at(-1)).toBe(filteredWindow);
    mount.unmount();
  });

  it('updates only selected rows while preserving the native virtualizer renderer across selection and header detail changes', async () => {
    const items = [
      { id: 'row-1', label: 'First review' },
      { id: 'row-2', label: 'Second review' },
      { id: 'row-3', label: 'Third review' },
    ] as const;
    const rowCommits: string[] = [];
    flatListCapture.renderItem.length = 0;

    function ControlledSelectionList() {
      const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
      const [detail, setDetail] = React.useState('Current detail');
      const keyForItem = React.useCallback((item: (typeof items)[number]) => item.id, []);
      const renderItem = React.useCallback((item: (typeof items)[number]) => (
        <React.Profiler id={item.id} onRender={(id) => { rowCommits.push(id); }}>
          <List.Item title={item.label} />
        </React.Profiler>
      ), []);

      return (
        <>
          <List
            accessibilityLabel="Review details"
            items={items}
            keyForItem={keyForItem}
            renderItem={renderItem}
            selection={{ selectedKey, onSelectedKeyChange: setSelectedKey }}
            header={({ selectedItem }) => (
              <Text value={`${detail}: ${selectedItem?.label ?? 'No selection'}`} />
            )}
          />
          <button type="button" data-testid="list-header-detail" onClick={() => setDetail('Updated detail')}>
            Update detail
          </button>
        </>
      );
    }

    const mount = mountList(<ControlledSelectionList />);
    const initialRenderItem = flatListCapture.renderItem.at(-1);
    expect(initialRenderItem).toBeDefined();
    rowCommits.length = 0;

    const options = () => Array.from(mount.container.querySelectorAll<HTMLElement>('[role="option"]'));
    await act(async () => { options()[0]?.click(); });

    expect(rowCommits).toEqual(['row-1']);
    expect(flatListCapture.renderItem.at(-1)).toBe(initialRenderItem);
    rowCommits.length = 0;

    await act(async () => { options()[1]?.click(); });

    expect(rowCommits).toEqual(['row-1', 'row-2']);
    expect(flatListCapture.renderItem.at(-1)).toBe(initialRenderItem);
    rowCommits.length = 0;

    const detailControl = mount.container.querySelector<HTMLButtonElement>('[data-testid="list-header-detail"]');
    expect(detailControl).not.toBeNull();
    await act(async () => { detailControl?.click(); });

    expect(mount.container.textContent).toContain('Updated detail: Second review');
    expect(rowCommits).toEqual([]);
    expect(flatListCapture.renderItem.at(-1)).toBe(initialRenderItem);
    mount.unmount();
  });

  it('keeps List behavior local when its virtualizer boundary leaves most of 2,000 rows unmounted', async () => {
    const items = Array.from({ length: 2_000 }, (_, index) => {
      const paddedIndex = String(index).padStart(4, '0');
      return {
        id: 'row-' + paddedIndex,
        label: 'Review ' + paddedIndex,
      };
    });
    type LargeItem = (typeof items)[number];

    const rowCommits: string[] = [];
    const filter = vi.fn((item: LargeItem, query: string) => item.label.includes(query));
    let activeResourceSubscriptions = 0;
    let openedResourceSubscriptions = 0;
    let resourceSubscriptionDisposals = 0;
    const watchResource: PluginUiHostApi['watchResource'] = vi.fn(async () => {
      activeResourceSubscriptions += 1;
      openedResourceSubscriptions += 1;
      let disposed = false;
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          activeResourceSubscriptions -= 1;
          resourceSubscriptionDisposals += 1;
        },
      };
    });

    function SelectedDetail({ selectedItem, revision }: Readonly<{
      selectedItem: LargeItem;
      revision: number;
    }>) {
      const { resource } = useLivePluginResource('detail-' + selectedItem.id);
      return (
        <Text
          value={
            'Detail ' + revision + ': ' + selectedItem.label + ' (' + resource.subscription + ')'
          }
        />
      );
    }

    function MasterDetailHeader({ selectedItem, revision, onDetailUpdate }: Readonly<{
      selectedItem: LargeItem | null;
      revision: number;
      onDetailUpdate: () => void;
    }>) {
      if (selectedItem === null) return <Text value="No selected review" />;
      return (
        <>
          <SelectedDetail selectedItem={selectedItem} revision={revision} />
          <Button
            title="Update detail"
            testID="large-list-detail"
            onPress={onDetailUpdate}
          />
        </>
      );
    }

    function LargeMasterDetailList() {
      const [detailRevision, setDetailRevision] = React.useState(0);
      const keyForItem = React.useCallback((item: LargeItem) => item.id, []);
      const renderItem = React.useCallback((item: LargeItem) => (
        <React.Profiler id={item.id} onRender={(id) => { rowCommits.push(id); }}>
          <List.Item title={item.label} />
        </React.Profiler>
      ), []);
      const updateDetail = React.useCallback(() => {
        setDetailRevision((revision) => revision + 1);
      }, []);
      const header = React.useCallback(
        ({ selectedItem }: Readonly<{ selectedItem: LargeItem | null }>) => (
          <MasterDetailHeader
            selectedItem={selectedItem}
            revision={detailRevision}
            onDetailUpdate={updateDetail}
          />
        ),
        [detailRevision, updateDetail],
      );

      return (
        <List
          accessibilityLabel="Large review items"
          items={items}
          keyForItem={keyForItem}
          renderItem={renderItem}
          search={{
            label: 'Search 2,000 reviews',
            testID: 'large-list-search',
            filter,
          }}
          selection={{ defaultSelectedKey: null }}
          header={header}
        />
      );
    }

    flatListCapture.data.length = 0;
    flatListCapture.keyExtractor.length = 0;
    flatListCapture.renderItem.length = 0;
    flatListCapture.scrollToIndex.length = 0;
    flatListCapture.windowStarts.length = 0;

    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider
        hostApi={createHostApiStub(context, {
          version: () => ({ apiVersion: '1.0.0', wireVersion: 1, methods: ['watchResource'] }),
          watchResource,
        })}
        context={context}
      >
        <LargeMasterDetailList />
      </PluginUiProvider>,
    );
    const options = () => Array.from(mount.container.querySelectorAll<HTMLElement>('[role="option"]'));
    expect(flatListCapture.data.at(-1)).toBe(items);
    expect(options()[0]?.getAttribute('aria-posinset')).toBe('1');
    expect(options()[0]?.getAttribute('aria-setsize')).toBe(String(items.length));
    const initialRenderItem = flatListCapture.renderItem.at(-1);
    const initialKeyExtractor = flatListCapture.keyExtractor.at(-1);
    expect(initialRenderItem).toBeDefined();
    expect(initialKeyExtractor).toBeDefined();

    let previousSelectedKey: string | null = null;
    for (const index of [0, 1, 2, 3, 4]) {
      const selectedKey = items[index]!.id;
      rowCommits.length = 0;
      await act(async () => { options()[index]?.click(); });

      expect(rowCommits).toEqual(
        previousSelectedKey === null ? [selectedKey] : [previousSelectedKey, selectedKey],
      );
      expect(flatListCapture.renderItem.at(-1)).toBe(initialRenderItem);
      expect(flatListCapture.keyExtractor.at(-1)).toBe(initialKeyExtractor);
      await vi.waitFor(() => {
        expect(activeResourceSubscriptions).toBe(1);
      });

      const openedBeforeDetailUpdate = openedResourceSubscriptions;
      const detailControl = mount.container.querySelector<HTMLButtonElement>('[data-testid="large-list-detail"]');
      expect(detailControl).not.toBeNull();
      rowCommits.length = 0;
      await act(async () => { detailControl?.click(); });

      expect(mount.container.textContent).toContain('Detail ' + (index + 1) + ': ' + items[index]!.label);
      expect(rowCommits).toEqual([]);
      expect(openedResourceSubscriptions).toBe(openedBeforeDetailUpdate);
      expect(flatListCapture.renderItem.at(-1)).toBe(initialRenderItem);
      expect(filter).toHaveBeenCalledTimes(0);
      previousSelectedKey = selectedKey;
    }

    const search = mount.container.querySelector<HTMLInputElement>('[data-testid="large-list-search"]');
    expect(search).not.toBeNull();
    await act(async () => { enterText(search!, 'Review 099'); });

    expect(filter).toHaveBeenCalledTimes(items.length);
    expect(flatListCapture.data.at(-1)).toEqual(items.slice(990, 1_000));
    expect(flatListCapture.data.at(-1)?.[0]).toBe(items[990]);
    expect(options()).toHaveLength(10);
    expect(options()[0]?.getAttribute('aria-setsize')).toBe('10');
    await vi.waitFor(() => {
      expect(activeResourceSubscriptions).toBe(0);
    });
    expect(resourceSubscriptionDisposals).toBe(openedResourceSubscriptions);

    await act(async () => { enterText(search!, ''); });
    expect(filter).toHaveBeenCalledTimes(items.length);
    expect(flatListCapture.data.at(-1)).toBe(items);
    await vi.waitFor(() => {
      expect(activeResourceSubscriptions).toBe(1);
    });

    const scrollToIndex = flatListCapture.scrollToIndex.at(-1);
    expect(scrollToIndex).toBeDefined();
    await act(async () => { scrollToIndex!(1_000); });

    expect(flatListCapture.windowStarts.at(-1)).toBe(1_000);
    expect(options()[0]?.getAttribute('aria-posinset')).toBe('1001');
    expect(options().at(-1)?.getAttribute('aria-posinset')).toBe('1012');
    expect(options()[0]?.getAttribute('aria-setsize')).toBe(String(items.length));
    const scrolledRenderItem = flatListCapture.renderItem.at(-1);
    expect(scrolledRenderItem).toBeDefined();
    expect(flatListCapture.keyExtractor.at(-1)).toBe(initialKeyExtractor);

    previousSelectedKey = items[4]!.id;
    for (const index of [0, 1, 2, 3, 4]) {
      const selectedKey = items[1_000 + index]!.id;
      rowCommits.length = 0;
      await act(async () => { options()[index]?.click(); });

      expect(rowCommits).toEqual(
        index === 0 ? [selectedKey] : [previousSelectedKey, selectedKey],
      );
      expect(flatListCapture.renderItem.at(-1)).toBe(scrolledRenderItem);
      expect(flatListCapture.keyExtractor.at(-1)).toBe(initialKeyExtractor);
      await vi.waitFor(() => {
        expect(activeResourceSubscriptions).toBe(1);
      });

      const openedBeforeDetailUpdate = openedResourceSubscriptions;
      const detailControl = mount.container.querySelector<HTMLButtonElement>('[data-testid="large-list-detail"]');
      expect(detailControl).not.toBeNull();
      rowCommits.length = 0;
      await act(async () => { detailControl?.click(); });

      expect(mount.container.textContent).toContain(
        'Detail ' + (index + 6) + ': ' + items[1_000 + index]!.label,
      );
      expect(rowCommits).toEqual([]);
      expect(openedResourceSubscriptions).toBe(openedBeforeDetailUpdate);
      expect(filter).toHaveBeenCalledTimes(items.length);
      previousSelectedKey = selectedKey;
    }

    expect(activeResourceSubscriptions).toBe(1);
    mount.unmount();
    await vi.waitFor(() => {
      expect(activeResourceSubscriptions).toBe(0);
    });
    expect(resourceSubscriptionDisposals).toBe(openedResourceSubscriptions);
  }, 15_000);
});

describe('virtualized List keyboard focus', () => {
  const reviews = Array.from({ length: 40 }, (_, index) => {
    const paddedIndex = String(index).padStart(2, '0');
    return { id: 'row-' + paddedIndex, label: 'Review ' + paddedIndex, blocked: index === 2 || index === 3 };
  });
  type Review = (typeof reviews)[number];

  const optionsIn = (mount: Readonly<{ container: HTMLElement }>) => (
    Array.from(mount.container.querySelectorAll<HTMLElement>('[role="option"]'))
  );
  const optionNamed = (mount: Readonly<{ container: HTMLElement }>, label: string) => (
    optionsIn(mount).find((option) => option.textContent?.includes(label))
  );

  async function pressKey(target: HTMLElement | undefined, key: string): Promise<void> {
    await act(async () => {
      target?.focus();
      target?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
  }

  it('gives a virtualized listbox one roving tab stop that follows focus, not selection', async () => {
    const selectedKeys: string[] = [];
    const mount = mountList(
      <List
        accessibilityLabel="Reviews"
        items={reviews}
        keyForItem={(item: Review) => item.id}
        renderItem={(item: Review) => <List.Item title={item.label} />}
        selection={{
          defaultSelectedKey: 'row-01',
          onSelectedKeyChange: (key) => selectedKeys.push(key),
        }}
      />,
    );

    // A listbox is one composite widget: exactly one option may be a tab stop,
    // otherwise a 40-row collection inserts 40 stops into the page tab order.
    // Before the reader moves focus, the selected row holds it.
    expect(optionsIn(mount).map((option) => option.getAttribute('tabindex')).slice(0, 4))
      .toEqual(['-1', '0', '-1', '-1']);

    await pressKey(optionNamed(mount, 'Review 01'), 'ArrowDown');

    expect(selectedKeys).toEqual([]);
    expect(optionNamed(mount, 'Review 01')?.getAttribute('aria-selected')).toBe('true');
    expect(optionNamed(mount, 'Review 02')?.getAttribute('aria-selected')).toBe('false');
    expect(optionsIn(mount).map((option) => option.getAttribute('tabindex')).slice(0, 4))
      .toEqual(['-1', '-1', '0', '-1']);
    expect(document.activeElement).toBe(optionNamed(mount, 'Review 02'));

    await pressKey(optionNamed(mount, 'Review 02'), 'ArrowUp');

    expect(selectedKeys).toEqual([]);
    expect(document.activeElement).toBe(optionNamed(mount, 'Review 01'));
    mount.unmount();
  });

  it('skips author-disabled rows and keeps Enter selection owned by the shared row pressable', async () => {
    const selectedKeys: string[] = [];
    const activated: string[] = [];
    const mount = mountList(
      <List
        accessibilityLabel="Reviews"
        items={reviews}
        keyForItem={(item: Review) => item.id}
        renderItem={(item: Review) => (
          <List.Item
            title={item.label}
            disabled={item.blocked}
            onPress={() => activated.push(item.id)}
          />
        )}
        selection={{
          defaultSelectedKey: 'row-01',
          isItemDisabled: (item: Review) => item.blocked,
          onSelectedKeyChange: (key) => selectedKeys.push(key),
        }}
      />,
    );

    // Rows 02 and 03 are disabled, so one ArrowDown must land on row 04.
    await pressKey(optionNamed(mount, 'Review 01'), 'ArrowDown');

    expect(selectedKeys).toEqual([]);
    expect(document.activeElement).toBe(optionNamed(mount, 'Review 04'));
    expect(optionNamed(mount, 'Review 02')?.getAttribute('tabindex')).toBe('-1');

    // Navigation is the only thing the collection owner claims; activation stays
    // with the shared pressable, so Enter both runs the author's row action and
    // commits the selection the reader navigated to.
    const current = optionNamed(mount, 'Review 04');
    await act(async () => {
      current?.focus();
      current?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      current?.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }));
    });

    expect(activated).toEqual(['row-04']);
    expect(selectedKeys).toEqual(['row-04']);
    mount.unmount();
  });

  it('reveals an off-window Home and End target through the real virtualizer before focusing it', async () => {
    const selectedKeys: string[] = [];
    flatListCapture.imperativeReveals.length = 0;
    const mount = mountList(
      <List
        accessibilityLabel="Reviews"
        items={reviews}
        keyForItem={(item: Review) => item.id}
        renderItem={(item: Review) => <List.Item title={item.label} />}
        selection={{
          defaultSelectedKey: 'row-01',
          onSelectedKeyChange: (key) => selectedKeys.push(key),
        }}
      />,
    );

    // The last row is far outside the mounted window; keyboard navigation is
    // only usable if the collection owner asks the virtualizer to reveal it.
    await pressKey(optionNamed(mount, 'Review 01'), 'End');

    expect(selectedKeys).toEqual([]);
    expect(flatListCapture.imperativeReveals.at(-1)?.method).toBe('scrollToEnd');
    expect(optionNamed(mount, 'Review 39')?.getAttribute('aria-selected')).toBe('false');
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(optionNamed(mount, 'Review 39'));
    });

    await pressKey(optionNamed(mount, 'Review 39'), 'Home');

    expect(selectedKeys).toEqual([]);
    expect(flatListCapture.imperativeReveals.at(-1)).toEqual({ method: 'scrollToOffset', offset: 0 });
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(optionNamed(mount, 'Review 00'));
    });
    mount.unmount();
  });
});
