import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { PluginUiPresentationHostProviderInternal, type PluginUiPresentationHost } from '../presentationHost/context.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { useHappierCollection } from '../presentation/collection/useCollection.js';
import { Collection } from './Collection.js';
import { CollectionRowNeedsYouHighlight } from './CollectionRowNeedsYouHighlight.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import type { HappierNeedsYouHighlightPreference } from '../presentation/collection/needsYouHighlight.js';

function mount(
  facts: Readonly<{ preference: HappierNeedsYouHighlightPreference; reducedMotion?: boolean; presented?: boolean }> | null,
  row: Readonly<{ unopened: boolean; visible: boolean }>,
) {
  const context = createSurfaceContext();
  const host: PluginUiPresentationHost = {
    renderMarkdown: () => null, renderCodeBlock: () => null, renderPopover: () => null, renderIcon: () => null,
    ...(facts === null ? {} : { collectionRowNeedsYou: { useFacts: () => ({ reducedMotion: false, presented: true, ...facts }) } }),
  };
  return mountThroughReactNativeWeb(<PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
    <PluginUiPresentationHostProviderInternal host={host}>
      <CollectionRowNeedsYouHighlight {...row} testID="row" />
    </PluginUiPresentationHostProviderInternal>
  </PluginUiProvider>);
}

const part = (view: ReturnType<typeof mount>, kind: string) => view.container.querySelector(`[data-testid="row:${kind}"]`);

describe('public CollectionRowNeedsYouHighlight', () => {
  it('stays on the default Dot in a realm without host facts, which adds nothing', () => {
    const view = mount(null, { unopened: true, visible: true });
    try { expect(view.container.querySelector('[data-testid^="row:"]')).toBeNull(); } finally { view.unmount(); }
  });

  it.each(['glint', 'shimmer'] as const)('sweeps a visible unopened row for %s, and stops once it is opened or hidden', (preference) => {
    const moving = mount({ preference }, { unopened: true, visible: true });
    const opened = mount({ preference }, { unopened: false, visible: true });
    const hidden = mount({ preference, presented: false }, { unopened: true, visible: true });
    try {
      expect(part(moving, preference)).not.toBeNull();
      expect(part(opened, preference)).toBeNull();
      expect(part(hidden, preference)).toBeNull();
    } finally { moving.unmount(); opened.unmount(); hidden.unmount(); }
  });

  it('draws the static bar for Accent and in place of motion under reduced motion', () => {
    const accent = mount({ preference: 'accent' }, { unopened: false, visible: false });
    const reduced = mount({ preference: 'shimmer', reducedMotion: true }, { unopened: true, visible: true });
    try {
      expect(part(accent, 'accent')).not.toBeNull();
      expect(part(reduced, 'accent')).not.toBeNull();
      expect(part(reduced, 'shimmer')).toBeNull();
    } finally { accent.unmount(); reduced.unmount(); }
  });

  it("Collection's anatomy places it on the row that needs the person and leaves calm rows unread", () => {
    const reads: string[] = [];
    const context = createSurfaceContext();
    const host: PluginUiPresentationHost = {
      renderMarkdown: () => null, renderCodeBlock: () => null, renderPopover: () => null, renderIcon: () => null,
      collectionRowNeedsYou: { useFacts: () => { reads.push('facts'); return { preference: 'shimmer', reducedMotion: false, presented: true }; } },
    };
    const rows = [{ id: 'waiting', unopened: true, needsYou: true }, { id: 'calm', unopened: false, needsYou: false }];
    function List() {
      const model = useHappierCollection({ items: rows, keyOf: (row) => row.id, openKey: null, onOpenChange: () => undefined });
      return <Collection model={model} accessibilityLabel="Rows" presentation="list" detail="none" scroll="page" anatomy={{
        title: (row) => row.id, glyph: () => null, testID: (row) => `row-${row.id}`,
        needsYou: (row) => (row.needsYou ? { unopened: row.unopened } : null),
        accessibilityLabel: (row) => row.id,
        columnTitles: { title: 'Row' },
      }} />;
    }
    const view = mountThroughReactNativeWeb(<PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <PluginUiPresentationHostProviderInternal host={host}><List /></PluginUiPresentationHostProviderInternal>
    </PluginUiProvider>);
    try {
      expect(view.container.querySelector('[data-testid="row-waiting:needs-you:shimmer"]')).not.toBeNull();
      expect(view.container.querySelector('[data-testid^="row-calm:needs-you"]')).toBeNull();
      expect(reads.length).toBeGreaterThan(0);
    } finally { view.unmount(); }
  });
});
