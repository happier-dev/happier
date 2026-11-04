import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { Button, Dropdown, useCollectionSavedViewsControl, useCollectionSavedViewsSelection } from '@happier-dev/plugin-ui/components';
import { defineUiSurface } from '@happier-dev/plugin-ui';

const mounted: PluginUiTestkit[] = [];
afterEach(async () => { for (const fixture of mounted.splice(0)) await fixture.dispose(); });

const labels = {
  title: 'Spaces', unselected: 'No space', actions: 'Space actions', create: 'New space',
  rename: 'Rename', update: 'Update', delete: 'Delete', modified: 'Filtered',
  name: 'Space name', confirm: 'Save space', cancel: 'Cancel',
};

async function press(fixture: PluginUiTestkit, role: 'button' | 'menuitem' | 'menuitemradio', name: string) {
  await act(async () => { await fixture.press(await fixture.getByRole(role, { name })); });
}

async function typeName(value: string) {
  // Text input is a DOM boundary; the semantic testkit currently supports presses only.
  const field = document.querySelector('input');
  expect(field).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the public controlled collection saved-view presentation', () => {
  it('opens an empty read-only catalog without requiring an unselected item or writer', async () => {
    function Surface() {
      const selection = useCollectionSavedViewsSelection({
        scope: 'account-a', items: [], selectedId: null, labels: { title: 'Spaces' }, onSelect: () => undefined,
      });
      return <Dropdown open={selection.open} onOpenChange={selection.onOpenChange}
        trigger="Choose lens" items={selection.items} radioGroups={selection.radioGroups} onSelect={selection.selectItem} />;
    }
    let fixture!: PluginUiTestkit;
    await act(async () => { fixture = await createPluginUiTestkit({
      identity: { instanceId: 'empty-views', mountNonce: 'empty-views' },
      authorPlugin: { id: 'happier.example', version: '0.0.0' },
      surface: defineUiSurface(() => <Surface />), surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
    }); });
    mounted.push(fixture);
    await press(fixture, 'button', 'Choose lens');
    await expect(fixture.getByRole('menu')).resolves.toBeDefined();
  });

  it('composes a read-only domain catalog and retires its unavailable selection on Account change', async () => {
    const selections: string[] = [];
    function Surface() {
      const [scope, setScope] = React.useState('account-a');
      const [selectedId, setSelectedId] = React.useState<string | null>(null);
      const items = React.useMemo(() => [{ id: scope, label: scope, filter: { status: 'open' } }], [scope]);
      const selection = useCollectionSavedViewsSelection({
        scope, items, selectedId, labels,
        onSelect: (id) => { selections.push(`${scope}:${id}`); setSelectedId(id); },
      });
      return <>
        <Dropdown open={selection.open} onOpenChange={selection.onOpenChange}
          trigger={selection.selected?.label ?? 'Choose lens'} items={selection.items}
          radioGroups={selection.radioGroups} onSelect={selection.selectItem} />
        <Button title="Switch Account" onPress={() => setScope('account-b')} />
      </>;
    }
    let fixture!: PluginUiTestkit;
    await act(async () => { fixture = await createPluginUiTestkit({
      identity: { instanceId: 'read-only-views', mountNonce: 'read-only-views' },
      authorPlugin: { id: 'happier.example', version: '0.0.0' },
      surface: defineUiSurface(() => <Surface />), surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
    }); });
    mounted.push(fixture);
    await press(fixture, 'button', 'Choose lens');
    await press(fixture, 'menuitemradio', 'account-a');
    await press(fixture, 'button', 'account-a');
    await press(fixture, 'button', 'Switch Account');
    expect(await fixture.queryByRole('menuitemradio', { name: 'account-b' })).toBeUndefined();
    await press(fixture, 'button', 'Choose lens');
    await press(fixture, 'menuitemradio', 'account-b');
    expect(selections).toEqual(['account-a:account-a', 'account-b:account-b']);
  });

  it('selects typed items and preserves a refused name until acceptance, without writing on edit or cancel', async () => {
    const writes: string[] = [];
    let accept = false;
    function Surface() {
      const [items, setItems] = React.useState([{ id: 'review', label: 'Review', filter: 'open' }]);
      const [selectedId, setSelectedId] = React.useState<string | null>(null);
      const { control, details } = useCollectionSavedViewsControl({
        scope: 'account-a',
        items, selectedId, modified: false, labels,
        onSelect: setSelectedId,
        onCreate: async (label) => {
          writes.push(label);
          if (!accept) return false;
          setItems((current) => [...current, { id: 'new', label, filter: 'new' }]);
          setSelectedId('new');
          return true;
        },
        onRename: async (item, label) => {
          writes.push(item.filter);
          setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, label } : entry));
          return true;
        },
        onUpdate: () => undefined,
        onDelete: () => undefined,
      });
      return <>{control}{details}</>;
    }
    let fixture!: PluginUiTestkit;
    await act(async () => { fixture = await createPluginUiTestkit({
      identity: { instanceId: 'saved-views', mountNonce: 'saved-views' },
      authorPlugin: { id: 'happier.example', version: '0.0.0' },
      surface: defineUiSurface(() => <Surface />),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
    }); });
    mounted.push(fixture);
    await press(fixture, 'button', 'Spaces: No space');
    await press(fixture, 'menuitemradio', 'Review');
    await press(fixture, 'button', 'Spaces: Review');
    await press(fixture, 'menuitem', 'Rename');
    await typeName('Renamed');
    expect(writes).toEqual([]);
    await press(fixture, 'button', 'Save space');
    expect(writes).toEqual(['open']);
    await press(fixture, 'button', 'Spaces: Renamed');
    await press(fixture, 'menuitem', 'New space');
    await typeName('Mine');
    await press(fixture, 'button', 'Save space');
    await expect(fixture.getByRole('textbox', { name: 'Space name' })).resolves.toBeDefined();
    accept = true;
    await press(fixture, 'button', 'Save space');
    await expect(fixture.getByRole('button', { name: 'Spaces: Mine' })).resolves.toBeDefined();
    await press(fixture, 'button', 'Spaces: Mine');
    await press(fixture, 'menuitem', 'New space');
    await press(fixture, 'button', 'Cancel');
    expect(writes).toEqual(['open', 'Mine', 'Mine']);
  });

  it('retires a private name with its Account scope and ignores the retired submission settling later', async () => {
    let settle: ((accepted: boolean) => void) | undefined;
    const submissions: string[] = [];
    function Surface() {
      const [scope, setScope] = React.useState('account-a');
      const { control, details } = useCollectionSavedViewsControl({
        scope, items: [], selectedId: null, modified: false, labels,
        onSelect: () => undefined,
        onCreate: (name) => {
          submissions.push(`${scope}:${name}`);
          return new Promise<boolean>((resolve) => { settle = resolve; });
        },
        onRename: async () => false,
        onUpdate: () => undefined,
        onDelete: () => undefined,
      });
      return <>{control}{details}<Button title="Switch Account" onPress={() => setScope('account-b')} /></>;
    }
    let fixture!: PluginUiTestkit;
    await act(async () => { fixture = await createPluginUiTestkit({
      identity: { instanceId: 'saved-views-scope', mountNonce: 'saved-views-scope' },
      authorPlugin: { id: 'happier.example', version: '0.0.0' },
      surface: defineUiSurface(() => <Surface />),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
    }); });
    mounted.push(fixture);
    await press(fixture, 'button', 'Spaces: No space');
    await press(fixture, 'menuitem', 'New space');
    await typeName('Private A');
    // The button starts the write without waiting for its external acceptance.
    await press(fixture, 'button', 'Save space');
    await press(fixture, 'button', 'Switch Account');
    expect(await fixture.queryByRole('textbox', { name: 'Space name' })).toBeUndefined();
    await press(fixture, 'button', 'Spaces: No space');
    await press(fixture, 'menuitem', 'New space');
    await typeName('Private B');
    await act(async () => { settle?.(true); });
    expect(document.querySelector('input')?.value).toBe('Private B');
    expect(submissions).toEqual(['account-a:Private A']);
  });
});
