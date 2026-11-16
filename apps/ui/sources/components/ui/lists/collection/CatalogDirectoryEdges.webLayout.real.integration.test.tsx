// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { View } from 'react-native';
import { afterEach, expect, it, vi } from 'vitest';

import {
  Collection,
  useHappierCollection,
  type CollectionGroupAction,
} from '@happier-dev/plugin-ui';
import { buildCapabilityCollectionAnatomy } from '@/components/capabilities/row/buildCapabilityCollectionAnatomy';
import { CoreCollectionScope } from './CoreCollectionScope';
import {
  installWebLayoutBridge,
  measureWebLayout,
} from '@/dev/testkit/render/measureWebLayout';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

installWebLayoutBridge();
let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

type Entry = Readonly<{ id: string; group: string; title: string }>;
const ENTRIES: readonly Entry[] = [
  { id: 'router', group: 'apps', title: '9router' },
  { id: 'pieces', group: 'apps', title: 'Activepieces' },
  { id: 'budget', group: 'apps', title: 'Actualbudget' },
  { id: 'static', group: 'starters', title: 'Static website' },
  { id: 'expo', group: 'starters', title: 'Expo blank' },
];
const AXIS = [
  { key: 'apps', title: 'Apps' },
  { key: 'starters', title: 'Starters' },
];
const passThroughScroller = (children: React.ReactNode) => children;
const groupAction = (key: string): CollectionGroupAction => ({
  label: 'All',
  onPress: () => {},
  kind: 'link',
});

/** The Store's directory shape: catalog rows with a logo mark and a trailing "+" icon button, titled groups with "All ›". */
function Directory() {
  const model = useHappierCollection<Entry>({
    items: ENTRIES,
    keyOf: (entry) => entry.id,
    groups: { axis: AXIS, groupOf: (entry) => entry.group },
    openKey: null,
    onOpenChange: () => {},
  });
  const anatomy = React.useMemo(
    () =>
      buildCapabilityCollectionAnatomy<Entry>({
        title: (entry) => entry.title,
        description: () => 'A short description of what this item does.',
        mark: (entry) => (
          <View testID={`mark:${entry.id}`} style={{ width: 26, height: 26 }} />
        ),
        facts: () => ({}),
        // An icon button: its 20 px glyph inside the button's own 4 px hit padding.
        action: (entry) => (
          <View style={{ padding: 4 }}>
            <View
              testID={`plus:${entry.id}`}
              style={{ width: 20, height: 20 }}
            />
          </View>
        ),
        accessibilityLabel: (entry) => entry.title,
        testID: (entry) => `row:${entry.id}`,
      }),
    [],
  );
  return (
    <CoreCollectionScope renderPageScroller={passThroughScroller}>
      <Collection<Entry>
        testID="dir"
        model={model}
        anatomy={anatomy}
        accessibilityLabel="Discover"
        presentation="list"
        detail="none"
        scroll="page"
        minListWidth={280}
        minDetailWidth={280}
        preferredListRatio={1}
        groupAction={groupAction}
      />
    </CoreCollectionScope>
  );
}

/**
 * A directory's rows stand on their section's edges (owner A9, MOBILE-FIX H5): each row's mark starts on the section
 * title's left edge and each row's trailing "+" glyph ends on the "All ›" right edge, in two columns and in one.
 */
it.each([
  ['two columns', 912],
  ['one column (phone)', 358],
])(
  'puts every row mark on the section title edge and every trailing + on the All edge (%s)',
  async (_label, width) => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () =>
      root!.render(
        <View style={{ width }}>
          <Directory />
        </View>,
      ),
    );
    const layout = await measureWebLayout(host, {
      viewport: { width: width + 200, height: 1200 },
      texts: ['Apps', 'Starters'],
      settle: (replay) => act(replay),
    });
    const titleLeft = layout
      .textRects('Apps')
      .find((rect) => rect.width > 1)!.left;
    expect(
      Math.abs(
        layout.textRects('Starters').find((rect) => rect.width > 1)!.left -
          titleLeft,
      ),
    ).toBeLessThanOrEqual(0.5);
    const allRight = layout.rect('dir:group:apps:action').right;
    expect(
      Math.abs(layout.rect('dir:group:starters:action').right - allRight),
    ).toBeLessThanOrEqual(0.5);
    const marks = ENTRIES.map((entry) => layout.rect(`mark:${entry.id}`).left);
    const pluses = ENTRIES.map(
      (entry) => layout.rect(`plus:${entry.id}`).right,
    );
    // The first column's marks start on the title edge; the last column's "+" glyphs end on the All edge.
    const firstColumnMarks = marks.filter(
      (left) => left < titleLeft + width / 2 - 40,
    );
    const lastColumnPluses = pluses.filter(
      (right) => right > titleLeft + width / 2,
    );
    expect(firstColumnMarks.length).toBeGreaterThan(0);
    expect(lastColumnPluses.length).toBeGreaterThan(0);
    for (const left of firstColumnMarks)
      expect.soft(Math.abs(left - titleLeft)).toBeLessThanOrEqual(1);
    for (const right of lastColumnPluses)
      expect.soft(Math.abs(right - allRight)).toBeLessThanOrEqual(1);
  },
);
