import * as React from 'react';
import { View } from 'react-native';
import { describe, expect, it } from 'vitest';

import { HAPPIER_PAGE_METRICS } from '../presentation/layout/pageMetrics.js';
import { useHappierCollection } from '../presentation/collection/useCollection.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { Collection, type CollectionProps } from './Collection.js';
import { Stack } from './Layout.js';
import { PluginUiProviderInternal } from './PluginUiProvider.js';
import { Text } from './Text.js';

type Row = Readonly<{ id: string; title: string }>;

const ROWS: readonly Row[] = [
  { id: 't1', title: 'Audit webhook retry backoff' },
  { id: 't2', title: 'Add Bot pause indicator' },
];

function CollectionColumnFixture(props: Readonly<{ pageColumn?: CollectionProps<Row>['pageColumn'] }>) {
  const model = useHappierCollection<Row>({
    items: ROWS,
    keyOf: row => row.id,
  });
  return (
    <Collection<Row>
      model={model}
      pageColumn={props.pageColumn}
      accessibilityLabel="Ready tasks"
      presentation="table"
      detail="none"
      testID="ready-collection"
      listTestID="ready-collection-list"
      minListWidth={320}
      minDetailWidth={360}
      preferredListRatio={0.5}
      header={<View testID="ready-header"><Text value="Ready" /></View>}
      anatomy={{
        glyph: () => null,
        title: row => row.title,
        accessibilityLabel: row => row.title,
        columnTitles: { title: 'Task' },
      }}
    />
  );
}

function mount(pageColumn?: CollectionProps<Row>['pageColumn']) {
  const context = createSurfaceContext();
  return mountThroughReactNativeWeb(
    <PluginUiProviderInternal hostApi={createHostApiStub(context)} context={context}>
      <CollectionColumnFixture pageColumn={pageColumn} />
    </PluginUiProviderInternal>,
  );
}

function findAncestorWithMaxWidth(node: HTMLElement | null, root: HTMLElement, px: number): HTMLElement | null {
  for (let at = node?.parentElement ?? null; at !== null && at !== root; at = at.parentElement) {
    if (at.style.maxWidth === `${px}px`) return at;
  }
  return null;
}

describe('Collection pageColumn', () => {
  it('bounds both header and stage to the canonical wide (944px) page column and preserves vertical flex', () => {
    const view = mount('wide');
    try {
      const widePx = HAPPIER_PAGE_METRICS.columnMaxWidthPx.wide;
      expect(widePx).toBe(944);
      const header = view.container.querySelector<HTMLElement>('[data-testid="ready-header"]');
      const stage = view.container.querySelector<HTMLElement>('[data-testid="ready-collection:stage"]');
      expect(header).not.toBeNull();
      expect(stage).not.toBeNull();

      const headerColumn = findAncestorWithMaxWidth(header, view.container, widePx);
      const stageColumn = findAncestorWithMaxWidth(stage, view.container, widePx);
      expect(headerColumn).not.toBeNull();
      expect(stageColumn).not.toBeNull();
      expect(stageColumn?.style.flexGrow).toBe('1');
    } finally {
      view.unmount();
    }
  });

  it('leaves the collection uncapped when pageColumn is omitted', () => {
    const view = mount(undefined);
    try {
      const stage = view.container.querySelector<HTMLElement>('[data-testid="ready-collection:stage"]');
      expect(stage).not.toBeNull();
      expect(findAncestorWithMaxWidth(stage, view.container, HAPPIER_PAGE_METRICS.columnMaxWidthPx.wide)).toBeNull();
    } finally {
      view.unmount();
    }
  });
});
