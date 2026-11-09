import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';

import * as advancedEntry from './advanced/index.js';
import * as componentsEntry from './components/index.js';
import * as hostApiEntry from './hostApi/index.js';
import * as rootEntry from './index.js';
import * as testingEntry from './testing/index.js';
import * as chartEntry from '@happier-dev/plugin-ui/components';
import { renderSurface as renderChartFamily } from '../fixtures/external-authoring/src/chartFamilySurface.js';
import { HappierDisclosure, HappierPressable, HAPPIER_INSTANT_DISCLOSURE_MOTION, useHappierCollection } from './presentation/index.js';

const publicItems = [{ id: 'entry', title: 'Public entry' }];
const publicKeyOf = (item: typeof publicItems[number]) => item.id;

function PublicCollection({ presentation }: { presentation: 'list' | 'board' | 'grid' }) {
  const model = useHappierCollection({ items: publicItems, keyOf: publicKeyOf, openKey: null, onOpenChange: () => {} });
  const anatomy = {
    glyph: () => <rootEntry.Icon name="file" />,
    glyphBadge: () => ({ mark: (pixelSize: number) => <rootEntry.BrandMark pixelSize={pixelSize} externallyLabelled />, tone: 'success' } satisfies rootEntry.CollectionGlyphBadge),
    title: (item: typeof publicItems[number]) => item.title,
    columnTitles: { title: 'Entry' },
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
  it('formats measured durations through the public author entry with canonical locale and invalid-input behavior', async () => {
    const { formatUsageDurationCompact: canonical } = await import('@happier-dev/protocol/usage/usageFormatting');
    const format = chartEntry.formatUsageDurationCompact;
    expect(format).toBeTypeOf('function');
    expect(format(40_000, 'en-US')).toBe('40s');
    expect(format(3_570_000, 'en-US')).toBe('1h');
    expect(format(11_520_000, 'en-US')).toBe('3h 12m');
    expect(format(40_000, 'fr-FR')).toBe(new Intl.NumberFormat('fr-FR', {
      style: 'unit', unit: 'second', unitDisplay: 'narrow',
    }).format(40));
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(format(value, 'en-US')).toBe(canonical(value, 'en-US'));
    }
  });

  it('renders the complete public chart author fixture and preserves keyboard selection and exact accessible facts', async () => {
    expect(chartEntry).toEqual(expect.objectContaining({
      Treemap: expect.any(Function), Sunburst: expect.any(Function),
      StackedSeriesChart: expect.any(Function), CapacityBar: expect.any(Function),
      CoreLoadBars: expect.any(Function), HappierStateLine: expect.any(Function),
      layoutHappierTreemap: expect.any(Function), squarifyHappierTreemap: expect.any(Function),
      createHappierTreemapHitGrid: expect.any(Function),
      layoutHappierSunburst: expect.any(Function), hitHappierSunburst: expect.any(Function),
    }));
    const page = await createPluginUiTestkit({ identity: { instanceId: 'public-charts', mountNonce: 'public' },
      authorPlugin: { id: 'example.chart-family', version: '0.0.0' }, surfaceContext: createSurfaceContextFixture(),
      adapter: testingEntry.createPluginUiRnwSemanticSurfaceAdapter(), surface: renderChartFamily });
    try {
      for (const [id, label] of [['author-treemap', 'Storage map'], ['author-sunburst', 'Storage rings'],
        ['author-capacity', 'Storage in use, 100 GB / 200 GB'], ['author-cores', 'CPU cores']] as const) {
        expect(document.querySelector(`[data-testid="${id}"]`)?.getAttribute('aria-label')).toBe(label);
      }
      expect(document.querySelector('[data-testid="author-series"]')).not.toBeNull();
      await expect(page.getByText('CPU rose from 20 to 40 percent')).resolves.toBeDefined();
      expect(document.querySelector('[data-testid="author-cores-core-0"]')?.getAttribute('aria-label')).toBe('Core 1, 40% in use');
      expect(document.querySelector('[data-testid="author-cores-core-1"]')?.getAttribute('aria-label')).toBe('Core 2, not reported');
      expect(document.querySelector('[data-testid="author-state-line"]')?.getAttribute('aria-live')).toBe('polite');
      await act(async () => {
        await page.press(await page.getByRole('button', { name: 'Open Archives, 40 GB' }));
      });
      await expect(page.getByText('Opened List: archives')).resolves.toBeDefined();
      await act(async () => {
        await page.press(await page.getByRole('button', { name: 'Details' }));
      });
      expect(document.querySelector('[data-testid="author-series-values-row-0"]')?.getAttribute('aria-label')).toContain('CPU: 20');
      expect(document.querySelector('[data-testid="author-series-values-row-1"]')?.getAttribute('aria-label')).toContain('CPU: 40');
      for (const [id, opened] of [['author-treemap', 'Map: projects'], ['author-sunburst', 'Rings: projects']] as const) {
        const chart = document.querySelector(`[data-testid="${id}"]`)!;
        await act(async () => {
          chart.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        });
        await act(async () => {
          chart.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });
        await expect(page.getByText(`Opened ${opened}`)).resolves.toBeDefined();
      }
    } finally { await page.dispose(); }
  });

  it('uses the public geometry helpers for matching layout and hit testing', () => {
    const nodes = [{ key: 'projects', value: 60 }, { key: 'archives', value: 40 }];
    const size = { width: 400, height: 240 };
    const { tiles } = chartEntry.layoutHappierTreemap(nodes, { ...size, minNodePx: { width: 56, height: 20 } });
    const tile = tiles.find((entry) => entry.key === 'projects')!;
    const hit = chartEntry.createHappierTreemapHitGrid(tiles, size);
    expect(hit(tile.rect.x + tile.rect.width / 2, tile.rect.y + tile.rect.height / 2)).toBe('projects');
    expect(hit(-1, 0)).toBeNull();
    const rectangles = chartEntry.squarifyHappierTreemap(nodes, { x: 0, y: 0, ...size });
    expect(rectangles.reduce((area, entry) => area + entry.rect.width * entry.rect.height, 0)).toBeCloseTo(size.width * size.height);
    const rings = [{ inner: 20, outer: 100 }];
    const { arcs } = chartEntry.layoutHappierSunburst(nodes, { rings, minArcPx: 1 });
    const arc = arcs.find((entry) => entry.key === 'projects')!;
    const angle = (arc.a0 + arc.a1) / 2;
    expect(chartEntry.hitHappierSunburst(arcs, rings, { cx: 0, cy: 0 }, Math.sin(angle) * 60, -Math.cos(angle) * 60)).toBe('projects');
    expect(chartEntry.hitHappierSunburst(arcs, rings, { cx: 0, cy: 0 }, 0, 0)).toBeNull();
    expect(chartEntry.layoutHappierTreemap([], { ...size, minNodePx: { width: 56, height: 20 } }).tiles).toEqual([]);
    expect(chartEntry.layoutHappierSunburst([], { rings, minArcPx: 1 }).arcs).toEqual([]);
  });

  it('composes the public timeline, feedback and approval anatomy with inline status', async () => {
    const page = await createPluginUiTestkit({ identity: { instanceId: 'public-story', mountNonce: 'public' },
      authorPlugin: { id: 'example.public-api', version: '0.0.0' }, surfaceContext: createSurfaceContextFixture(),
      adapter: testingEntry.createPluginUiRnwSemanticSurfaceAdapter(),
      surface: rootEntry.defineUiSurface(() => <rootEntry.Stack grow>
        <rootEntry.Timeline items={publicItems} keyForItem={publicKeyOf} accessibilityLabel="Activity"
          renderItem={(item) => ({ glyph: <rootEntry.Icon name="file" />, heading: item.title, body: <rootEntry.Text value="Public timeline context" /> })} />
        <rootEntry.MotionFeedback trigger={0} decorative><rootEntry.Icon name="check" /></rootEntry.MotionFeedback>
        <rootEntry.Status presentation="inline" tone="success" label="Checks passed" testID="public-inline-status" />
        <rootEntry.ApprovalPrompt title="Review permission" subtitle="Read repository files"
          footer={<rootEntry.Button title="Allow once" onPress={() => {}} />}>
          <rootEntry.Text value="Requested by this session" />
        </rootEntry.ApprovalPrompt>
      </rootEntry.Stack>) });
    try {
      await expect(page.getByText('Public entry')).resolves.toBeDefined();
      await expect(page.getByText('Public timeline context')).resolves.toBeDefined();
      await expect(page.getByText('Requested by this session')).resolves.toBeDefined();
      await expect(page.getByRole('button', { name: 'Allow once' })).resolves.toBeDefined();
      const inline = document.querySelector('[data-testid="public-inline-status"]');
      expect(inline?.textContent).toBe('Checks passed');
      expect(inline?.getAttribute('aria-live')).toBeNull();
    } finally { await page.dispose(); }
  });
  it.each(['list', 'board', 'grid'] as const)('renders the public %s Collection anatomy, including contributed glyph marks', async (presentation) => {
    // jsdom has no layout; substitute only the DOM measurement boundary so
    // the real RNW onLayout path can establish the grid's viewport.
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
    vi.stubGlobal('ResizeObserver', class implements ResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback([{ target, contentRect: new DOMRect(0, 0, 800, 600),
          borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }], this);
      }
      unobserve() {}
      disconnect() {}
    });
    let page: PluginUiTestkit | undefined;
    try {
      page = await createPluginUiTestkit({ identity: { instanceId: 'public-collection', mountNonce: presentation },
        authorPlugin: { id: 'example.public-api', version: '0.0.0' }, surfaceContext: createSurfaceContextFixture(),
        adapter: testingEntry.createPluginUiRnwSemanticSurfaceAdapter(),
        surface: rootEntry.defineUiSurface(() => <PublicCollection presentation={presentation} />) });
      const mountedPage = page;
      await vi.waitFor(async () => { await expect(mountedPage.getByText('Public entry')).resolves.toBeDefined(); });
      if (presentation === 'grid') await expect(page.getByText('Public card context')).resolves.toBeDefined();
    } finally { await page?.dispose(); width.mockRestore(); height.mockRestore(); vi.unstubAllGlobals(); }
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
      expect(entry).not.toHaveProperty('PluginUiButtonFillContext');
      expect(entry).not.toHaveProperty('useButtonFace');
      expect(entry).toEqual(expect.objectContaining({
        Button: expect.any(Function), IconButton: expect.any(Function),
        Collection: expect.any(Function), BrandMark: expect.any(Function), DetailsPaneFooter: expect.any(Function),
        Step: expect.any(Function), Tabs: expect.any(Function), InlineCode: expect.any(Function),
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
