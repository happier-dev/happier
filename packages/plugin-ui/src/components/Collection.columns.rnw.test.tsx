import { act } from 'react';
import { describe, expect, it } from 'vitest';

import type { HappierLayoutChangeEvent } from '../presentation/portableTypes.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import {
  PluginUiPresentationHostProviderInternal,
  type PluginUiPresentationHost,
} from '../presentationHost/context.js';
import {
  createHostApiStub,
  createSurfaceContext,
} from '../surfaceFixture.testSupport.js';
import { useHappierCollection } from '../presentation/collection/useCollection.js';
import { Collection, type CollectionField } from './Collection.js';
import { PluginUiProvider } from './PluginUiProvider.js';

type Row = Readonly<{
  id: string;
  deploy: string;
  runsOn: string;
  requests: string;
  state: string;
}>;

const ROWS: readonly Row[] = [
  {
    id: 'billing-api',
    deploy: 'v1.43 · 18:40',
    runsOn: 'hetzner-fsn1',
    requests: '3.3/s',
    state: 'Check failing',
  },
  {
    id: 'status',
    deploy: '2.0.2 · Nov 9',
    runsOn: 'hetzner-fsn1',
    requests: '',
    state: '',
  },
];

const field = (
  key: keyof Row,
  title: string,
  extra: Partial<CollectionField<Row>> = {},
): CollectionField<Row> => ({
  key,
  title,
  render: (row) => row[key],
  minWidth: 96,
  priority: 1,
  listColumn: true,
  ...extra,
});

const FIELDS: readonly CollectionField<Row>[] = [
  field('deploy', 'Last deploy', { priority: 4 }),
  field('runsOn', 'Runs on', { priority: 3 }),
  field('requests', 'Requests', {
    defaultHidden: true,
    source: 'Telemetry',
    align: 'end',
  }),
  field('state', 'State', { priority: 5, align: 'end' }),
];

function mount(
  input: Readonly<{
    shownKeys?: readonly string[] | null;
    items?: readonly Row[];
    bound?: boolean;
    fields?: readonly CollectionField<Row>[];
    width?: number;
    titleMinWidth?: number;
    onColumnsFit?: (keys: readonly string[] | null) => void;
  }>,
) {
  const context = createSurfaceContext();
  const reads: string[] = [];
  const host: PluginUiPresentationHost = {
    renderMarkdown: () => null,
    renderCodeBlock: () => null,
    renderPopover: () => null,
    renderIcon: () => null,
    ...(input.shownKeys === undefined
      ? {}
      : {
          collectionColumns: {
            useShownFieldKeys: ({ collectionId }) => {
              reads.push(collectionId);
              return input.shownKeys ?? null;
            },
          },
        }),
  };
  function Rows() {
    const model = useHappierCollection({
      items: input.items ?? ROWS,
      keyOf: (row) => row.id,
      openKey: null,
      onOpenChange() {},
    });
    return (
      <Collection
        model={model}
        accessibilityLabel="Apps"
        presentation="list"
        detail="none"
        scroll="page"
        testID="collection"
        {...(input.onColumnsFit === undefined ? {} : { onColumnsFit: input.onColumnsFit })}
        {...(input.bound === false
          ? {}
          : { columns: { collectionId: 'happier.services.apps' } })}
        anatomy={{
          title: (row) => row.id,
          glyph: () => null,
          byline: () => 'Production',
          testID: (row) => `row:${row.id}`,
          fields: input.fields ?? FIELDS,
          accessibilityLabel: (row) => row.id,
          columnTitles: { title: 'Environment' },
          ...(input.titleMinWidth === undefined ? {} : { titleMinWidth: input.titleMinWidth }),
        }}
      />
    );
  }
  const view = mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <PluginUiPresentationHostProviderInternal host={host}>
        <Rows />
      </PluginUiPresentationHostProviderInternal>
    </PluginUiProvider>,
  );
  const query = (testID: string) =>
    view.container.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
  const stage = query('collection:stage') as unknown as {
    __reactLayoutHandler: (event: HappierLayoutChangeEvent) => void;
  };
  act(() =>
    stage.__reactLayoutHandler({
      nativeEvent: { layout: { x: 0, y: 0, width: input.width ?? 1200, height: 800 } },
    }),
  );
  const columns = () =>
    FIELDS.map((entry) => entry.key).filter(
      (key) => query(`row:billing-api:column:${key}`) !== null,
    );
  const drawnOrder = () =>
    [
      ...view.container.querySelectorAll<HTMLElement>(
        '[data-testid^="row:billing-api:column:"]',
      ),
    ].map((node) =>
      node.dataset.testid!.slice('row:billing-api:column:'.length),
    );
  return { view, query, reads, columns, drawnOrder };
}

describe('Collection Columns choice', () => {
  it('keeps the phone identity and shipped byline when every optional column is hidden', () => {
    const { view, drawnOrder, query } = mount({ shownKeys: [], width: 390 });
    try {
      expect(drawnOrder()).toEqual([]);
      expect(query('row:billing-api')?.textContent).toContain('billing-api');
      expect(query('row:billing-api')?.textContent).toContain('Production');
    } finally {
      view.unmount();
    }
  });

  it('draws the declared default when the person has made no choice: an optional column stays out', () => {
    const { view, drawnOrder, query, reads } = mount({ shownKeys: null });
    try {
      expect(drawnOrder()).toEqual(['deploy', 'runsOn', 'state']);
      expect(query('collection:sheet-header')?.textContent).not.toContain(
        'Requests',
      );
      expect(reads).toContain('happier.services.apps');
    } finally {
      view.unmount();
    }
  });

  it('draws the chosen columns in the chosen order, including an optional one, and drops a hidden built-in', () => {
    const { view, drawnOrder, query } = mount({
      shownKeys: ['requests', 'deploy', 'state', 'gone.plugin:p95'],
    });
    try {
      expect(drawnOrder()).toEqual(['requests', 'deploy', 'state']);
      const bar = query('collection:sheet-header')?.textContent ?? '';
      expect(bar.indexOf('Requests')).toBeLessThan(bar.indexOf('Last deploy'));
      expect(bar).not.toContain('Runs on');
      // The unknown saved key (a retired plugin's column) draws nothing.
      expect(bar).toContain('Environment');
    } finally {
      view.unmount();
    }
  });

  it('a Collection that does not opt in never reads a choice', () => {
    const { view, drawnOrder, reads } = mount({
      shownKeys: ['requests'],
      bound: false,
    });
    try {
      expect(reads).toEqual([]);
      expect(drawnOrder()).toEqual(['deploy', 'runsOn', 'state']);
    } finally {
      view.unmount();
    }
  });

  it('reads the column choice per Collection entry, independent of the number of rendered rows', () => {
    const small = mount({ shownKeys: ['state'], items: [ROWS[0]!] });
    const readsForOne = small.reads.length;
    small.view.unmount();
    const rows = Array.from({ length: 24 }, (_, index) => ({ ...ROWS[0]!, id: `service-${index}` }));
    const large = mount({ shownKeys: ['state'], items: rows });
    try {
      expect(readsForOne).toBeGreaterThan(0);
      expect(large.reads.length).toBe(readsForOne);
      expect(large.view.container.querySelectorAll('[data-testid$=":column:state"]')).toHaveLength(rows.length);
    } finally {
      large.view.unmount();
    }
  });

  it('grows a column toward its owner-declared maximum from the spare room, and keeps a figure at its minimum', () => {
    const fields = [
      field('runsOn', 'Runs on', { maxWidth: 220 }),
      field('state', 'State', { align: 'end' }),
    ];
    const { view, query } = mount({ shownKeys: null, fields });
    try {
      const width = (key: string) =>
        Number.parseFloat(
          getComputedStyle(query(`row:billing-api:column:${key}`)!).width,
        );
      expect(width('runsOn')).toBeGreaterThan(96);
      expect(width('runsOn')).toBeLessThanOrEqual(220);
      expect(width('state')).toBe(96);
    } finally {
      view.unmount();
    }
  });

  it('yields chosen columns to width lowest priority first, keeps the title at its declared floor, and reports what fits', () => {
    const fits: (readonly string[])[] = [];
    // Title floor 200 + three 96 px figures (each a leading gap on) need more than a 520 px row: Runs on (priority 3) gives way.
    const { view, drawnOrder } = mount({ shownKeys: null, width: 560, titleMinWidth: 200, onColumnsFit: (keys) => fits.push(keys) });
    try {
      expect(drawnOrder()).toEqual(['deploy', 'state']);
      expect(fits.at(-1)).toEqual(['deploy', 'state']);
      // One report per fit, not per render.
      expect(fits).toHaveLength(1);
    } finally { view.unmount(); }
  });

  it('reports no column set at all where the rows draw no columns, so no Columns menu is offered there', () => {
    const fits: (readonly string[] | null)[] = [];
    const { view, drawnOrder } = mount({ shownKeys: null, width: 390, onColumnsFit: (keys) => fits.push(keys) });
    try {
      expect(drawnOrder()).toEqual([]);
      expect(fits).toEqual([null]);
    } finally { view.unmount(); }
  });
});
