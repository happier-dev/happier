import * as React from 'react';
import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import type { CollectionVirtualizer, CollectionVirtualizerRequest } from '../presentation/index.js';
import { useHappierCollection } from '../presentation/collection/useCollection.js';
import { Collection } from './Collection.js';
import { List } from './List.js';
import { PluginUiProviderInternal } from './PluginUiProvider.js';

// A supplied platform boundary with a one-row window. Revealing a row mounts it
// on the next React commit, so List must retain its own pending physical focus.
function Window<Item>({ request }: Readonly<{ request: CollectionVirtualizerRequest<Item> }>) {
  const [location, setLocation] = React.useState({ index: 0, sectionIndex: 0 });
  React.useLayoutEffect(() => {
    request.onHandle({
      reveal: (next) => setLocation({ index: next.index, sectionIndex: next.sectionIndex ?? 0 }),
      scrollToOffset: () => setLocation({ index: 0, sectionIndex: 0 }),
      scrollToEnd: () => setLocation({
        index: request.kind === 'flat' ? request.items.length - 1 : 0,
        sectionIndex: 0,
      }),
    });
    return () => request.onHandle(null);
  }, [request.onHandle, request.kind === 'flat' ? request.items.length : request.sections.length]);
  const section = request.kind === 'sections' ? request.sections[location.sectionIndex] : null;
  const items = request.kind === 'flat' ? request.items : section?.data ?? [];
  const item = items[location.index];
  return (
    <div data-testid="injected-virtualizer" role={request.role} aria-label={request.accessibilityLabel}>
      {section === null ? null : request.kind === 'sections' ? request.renderSectionHeader(location.sectionIndex) : null}
      {item === undefined ? null : request.renderItem(item, location.index, section === null ? null : location.sectionIndex)}
      {request.endContent}
    </div>
  );
}

const virtualizer: CollectionVirtualizer = {
  render: (request) => <Window request={request} />,
};

function mount(children: React.ReactNode, hostVirtualizer: CollectionVirtualizer | null = virtualizer) {
  const context = createSurfaceContext();
  const presentationHost = hostVirtualizer === null ? undefined : { collectionVirtualizer: hostVirtualizer };
  return mountThroughReactNativeWeb(
    <PluginUiProviderInternal hostApi={createHostApiStub(context)} context={context} presentationHost={presentationHost}>
      {children}
    </PluginUiProviderInternal>,
  );
}

const items = [{ id: 'a', title: 'Alpha' }, { id: 'b', title: 'Beta' }, { id: 'c', title: 'Gamma' }];

describe('host-injected Collection virtualizer', () => {
  it('chooses an unmounted radio row through the existing reveal and focus lifecycle', () => {
    const changes: string[] = [];
    function Example() {
      const [value, setValue] = React.useState<string | null>('a');
      return <List items={items} keyForItem={(item) => item.id} accessibilityLabel="Size"
        selection={{ single: { value, onValueChange: (key) => { changes.push(key); setValue(key); },
          isItemSelectable: (item) => item.id !== 'b' } }}
        renderItem={(item) => <List.Item title={item.title} />} />;
    }
    const view = mount(<Example />);
    try {
      const first = view.container.querySelector<HTMLElement>('[role="radio"]')!;
      expect(first?.getAttribute('aria-checked')).toBe('true');
      act(() => {
        first.focus();
        first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      });
      const chosen = view.container.querySelector<HTMLElement>('[role="radio"]')!;
      expect(changes).toEqual(['c']);
      expect(chosen.textContent).toContain('Gamma');
      expect(chosen.getAttribute('aria-checked')).toBe('true');
      expect(chosen.getAttribute('tabindex')).toBe('0');
      expect(document.activeElement).toBe(chosen);
    } finally { view.unmount(); }
  });
  it('uses the injected flat window while List retains reveal, focus and selection', () => {
    const selected: string[] = [];
    const view = mount(
      <List
        items={items}
        keyForItem={(item) => item.id}
        accessibilityLabel="Entries"
        selection={{ onSelectedKeyChange: (key) => selected.push(key) }}
        renderItem={(item) => <List.Item itemKey={item.id} title={item.title} />}
      />,
    );
    try {
      expect(view.container.querySelector('[data-testid="injected-virtualizer"]')).not.toBeNull();
      expect(view.container.textContent).toContain('Alpha');
      expect(view.container.textContent).not.toContain('Beta');
      const first = view.container.querySelector<HTMLElement>('[role="option"]')!;
      act(() => {
        first.focus();
        first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      });
      const next = view.container.querySelector<HTMLElement>('[role="option"]')!;
      expect(next.textContent).toContain('Beta');
      expect(document.activeElement).toBe(next);
      expect(selected).toEqual([]);
      act(() => next.click());
      expect(selected).toEqual(['b']);
    } finally { view.unmount(); }
  });

  it('uses the public Collection adapter for grouped rows and cross-group focus without a host binding', () => {
    function Example() {
      const model = useHappierCollection({
        items,
        keyOf: (item) => item.id,
        groups: {
          axis: [{ key: 'first', title: 'First' }, { key: 'rest', title: 'Rest' }],
          groupOf: (item) => item.id === 'a' ? 'first' : 'rest',
        },
      });
      return <Collection model={model} anatomy={{
        glyph: () => null,
        title: (item) => item.title,
        accessibilityLabel: (item) => item.title,
        columnTitles: { title: 'Entry' },
      }} virtualizer={virtualizer} accessibilityLabel="Entries" presentation="list" detail="none"
        minListWidth={300} minDetailWidth={300} preferredListRatio={0.5} />;
    }
    const view = mount(<Example />, null);
    try {
      expect(view.container.querySelector('[data-testid="injected-virtualizer"]')).not.toBeNull();
      expect(view.container.textContent).toContain('First');
      expect(view.container.textContent).not.toContain('Beta');
      const first = view.container.querySelector<HTMLElement>('[tabindex="0"]')!;
      act(() => {
        first.focus();
        first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      });
      expect(view.container.textContent).toContain('Rest');
      expect(view.container.textContent).toContain('Beta');
      expect(document.activeElement?.textContent).toContain('Beta');
    } finally { view.unmount(); }
  });
});
