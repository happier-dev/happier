import { describe, expect, it } from 'vitest';
import * as React from 'react';
import { act } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';

import * as advancedEntry from './advanced/index.js';
import * as componentsEntry from './components/index.js';
import * as hostApiEntry from './hostApi/index.js';
import * as rootEntry from './index.js';
import * as testingEntry from './testing/index.js';
import { HappierDisclosure, HappierPressable, HAPPIER_INSTANT_DISCLOSURE_MOTION, useHappierCollection } from './presentation/index.js';

const publicItems = [{ id: 'entry', title: 'Public entry' }];
const publicKeyOf = (item: typeof publicItems[number]) => item.id;

function PublicCollection({ presentation }: { presentation: 'list' | 'board' | 'grid' }) {
  const model = useHappierCollection({ items: publicItems, keyOf: publicKeyOf, openKey: null, onOpenChange: () => {} });
  const anatomy = {
    glyph: () => <rootEntry.Icon name="document-text-outline" />,
    glyphBadge: () => ({ mark: (pixelSize: number) => <rootEntry.BrandMark pixelSize={pixelSize} externallyLabelled />, tone: 'success' } satisfies rootEntry.CollectionGlyphBadge),
    title: (item: typeof publicItems[number]) => item.title,
    accessibilityLabel: (item: typeof publicItems[number]) => item.title,
    description: () => 'Public card context',
  } satisfies rootEntry.CollectionAnatomy<typeof publicItems[number]>;
  return <rootEntry.Collection model={model} anatomy={anatomy} presentation={presentation} scroll="page"
    minListWidth={280} minDetailWidth={420} preferredListRatio={0.4} accessibilityLabel="Public collection" />;
}

function PublicControls({ store }: { store: rootEntry.ListMultiSelectionStore }) {
  const [expanded, setExpanded] = React.useState(false);
  const selection = rootEntry.useListMultiSelectionSnapshot();
  const row = rootEntry.useListMultiSelectionRow('entry');
  return <rootEntry.Tabs value="overview" onValueChange={() => {}} ariaLabel="Hosted detail" tabList="host">
    <rootEntry.Tabs.Item value="overview" title="Overview">
      <rootEntry.Step marker={{ kind: 'state', state: 'passed', label: 'Passed' }} title="Checks">
        <rootEntry.Button title="Select entry" onPress={row.toggle} />
        <rootEntry.Text value={`Selected: ${selection.count}`} />
        <rootEntry.ListSelectionActionBar actions={[{ id: 'inspect', label: 'Inspect selection' }]} onAction={() => store.clear()} />
      </rootEntry.Step>
      <HappierDisclosure expanded={expanded} onExpandedChange={setExpanded} reducedMotion motion={HAPPIER_INSTANT_DISCLOSURE_MOTION}
        header={({ headerProps }) => <HappierPressable {...headerProps}><rootEntry.Text value="Show context" /></HappierPressable>}>
        <rootEntry.Text value="Disclosed public context" />
      </HappierDisclosure>
    </rootEntry.Tabs.Item>
    <rootEntry.Tabs.Item value="activity" title="Activity"><rootEntry.Text value="Inactive public panel" /></rootEntry.Tabs.Item>
  </rootEntry.Tabs>;
}

describe('curated plugin-ui public API', () => {
  it.each(['list', 'board', 'grid'] as const)('renders the public %s Collection anatomy, including contributed glyph marks', async (presentation) => {
    const page = await createPluginUiTestkit({ identity: { instanceId: 'public-collection', mountNonce: presentation },
      authorPlugin: { id: 'example.public-api', version: '0.0.0' }, surfaceContext: createSurfaceContextFixture(),
      adapter: testingEntry.createPluginUiRnwSemanticSurfaceAdapter(),
      surface: rootEntry.defineUiSurface(() => <PublicCollection presentation={presentation} />) });
    try {
      await expect(page.getByText('Public entry')).resolves.toBeDefined();
      if (presentation === 'grid') await expect(page.getByText('Public card context')).resolves.toBeDefined();
    } finally { await page.dispose(); }
  });

  it('composes hosted Tabs, Step, Disclosure and the public multi-selection kit', async () => {
    const store = rootEntry.createListMultiSelectionStore({ scopeKey: 'public-kit', visibleOrderedKeys: ['entry'] });
    const page = await createPluginUiTestkit({ identity: { instanceId: 'public-controls', mountNonce: 'public' },
      authorPlugin: { id: 'example.public-api', version: '0.0.0' }, surfaceContext: createSurfaceContextFixture(),
      adapter: testingEntry.createPluginUiRnwSemanticSurfaceAdapter(),
      surface: rootEntry.defineUiSurface(() => <rootEntry.ListMultiSelectionProvider store={store}><PublicControls store={store} /></rootEntry.ListMultiSelectionProvider>) });
    try {
      await expect(page.getByText('Checks')).resolves.toBeDefined();
      expect(await page.queryByRole('tab', { name: 'Overview' })).toBeUndefined();
      expect(await page.queryByText('Inactive public panel')).toBeUndefined();
      await act(async () => { await page.press(await page.getByRole('button', { name: 'Select entry' })); });
      await expect(page.getByText('Selected: 1')).resolves.toBeDefined();
      await act(async () => { await page.press(await page.getByRole('button', { name: 'Inspect selection' })); });
      await expect(page.getByText('Selected: 0')).resolves.toBeDefined();
      await act(async () => { await page.press(await page.getByRole('button', { name: 'Show context' })); });
      await expect(page.getByText('Disclosed public context')).resolves.toBeDefined();
    } finally { await page.dispose(); }
  });

  it('keeps ordinary author imports curated and reserves raw composition for the advanced entry', () => {
    for (const entry of [rootEntry, componentsEntry, hostApiEntry]) {
      expect(entry).not.toHaveProperty('PluginUiProvider');
      expect(entry).not.toHaveProperty('PluginHostApiProvider');
      expect(entry).not.toHaveProperty('createPluginUiResourceStore');
      expect(entry).not.toHaveProperty('createPluginUiHostApiResourceClient');
    }

    for (const entry of [rootEntry, componentsEntry]) {
      expect(entry).toEqual(expect.objectContaining({
        Collection: expect.any(Function), BrandMark: expect.any(Function),
        Step: expect.any(Function), Tabs: expect.any(Function),
        createListMultiSelectionStore: expect.any(Function), useListMultiSelectionController: expect.any(Function),
        ListMultiSelectionProvider: expect.any(Function), useOptionalListMultiSelectionStore: expect.any(Function),
        useListMultiSelectionStoreSnapshot: expect.any(Function), useListMultiSelectionSnapshot: expect.any(Function),
        useListMultiSelectionRow: expect.any(Function), ListSelectionActionBar: expect.any(Function),
      }));
    }

    expect(rootEntry).toEqual(expect.objectContaining({
      defineUiSurface: expect.any(Function),
      useExecutePluginAction: expect.any(Function),
      usePluginResource: expect.any(Function),
      useLivePluginResource: expect.any(Function),
      usePluginUiEphemeralSharedScope: expect.any(Function),
    }));
    expect(advancedEntry).toEqual(expect.objectContaining({
      PluginUiProvider: expect.any(Function),
      PluginHostApiProvider: expect.any(Function),
      createPluginUiResourceStore: expect.any(Function),
      createPluginUiHostApiResourceClient: expect.any(Function),
    }));
  });
});

describe('plugin-ui semantic testing public API', () => {
  it('exposes only the RNW semantic adapter for author tests', () => {
    expect(Object.keys(testingEntry)).toEqual([
      'createPluginUiRnwSemanticSurfaceAdapter',
    ]);
    expect(testingEntry.createPluginUiRnwSemanticSurfaceAdapter).toBeTypeOf('function');
  });
});
