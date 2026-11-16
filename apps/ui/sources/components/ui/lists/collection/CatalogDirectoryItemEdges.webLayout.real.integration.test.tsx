// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { View } from 'react-native';
import { afterEach, expect, it, vi } from 'vitest';

import {
  installWebLayoutBridge,
  measureWebLayout,
} from '@/dev/testkit/render/measureWebLayout';
import { HAPPIER_COLLECTION_LIST_METRICS } from '@happier-dev/plugin-ui/presentation';
import { CapabilityRow } from '@/components/capabilities/row/CapabilityRow';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import {
  ItemGroupColumn,
  ItemGroupColumns,
} from '@/components/ui/lists/ItemGroupColumns';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { PageDirectoryRowsContext } from '@/components/ui/lists/listPresentation';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);
// The native animation/gradient boundaries keep real RNW layout boxes during browser measurement.
vi.mock('react-native-reanimated', async () => {
  const mock = (
    await import('@/dev/testkit/mocks/reanimated')
  ).createReanimatedModuleMock();
  const native =
    await vi.importActual<typeof import('react-native-web')>(
      'react-native-web',
    );
  return {
    ...mock,
    default: {
      ...mock.default,
      View: native.View,
      Text: native.Text,
      ScrollView: native.ScrollView,
    },
  };
});
vi.mock('expo-linear-gradient', async () => {
  const native =
    await vi.importActual<typeof import('react-native-web')>(
      'react-native-web',
    );
  return { LinearGradient: native.View };
});

installWebLayoutBridge();
let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

const ROWS = [
  { key: 'staging', title: 'Staging', where: 'NLDW4-5-40-40' },
  { key: 'production', title: 'Production', where: 'NLDW4-5-40-41' },
  { key: 'fixture', title: 'QA local fixture', where: 'NLDW4-5-40-42' },
] as const;

/**
 * The Store Installed shape: a page section with no sheet, its directory rows in columns, a trailing "All ›". A section
 * of names alone (Agents, Apps without facts) draws title-only rows (`rowRole="item"`), as Installed does.
 */
function InstalledLikeSection(props: Readonly<{ columns: 1 | 2; described: boolean }>) {
  const rows = ROWS.map((row) => {
    const rendered = (
      <CapabilityRow
        key={row.key}
        testID={`row:${row.key}`}
        title={row.title}
        description={props.described ? 'Runs the service on its Machine.' : null}
        rowRole={props.described ? undefined : 'item'}
        whereSummary={row.where}
        mark={
          <View testID={`mark:${row.key}`} style={{ width: 20, height: 20 }} />
        }
        divider={false}
        onPress={() => {}}
      />
    );
    return props.columns > 1 ? (
      <ItemGroupColumn key={row.key}>{rendered}</ItemGroupColumn>
    ) : (
      rendered
    );
  });
  return (
    <ItemList pageColumn="wide">
      <ItemGroup
        testID="apps"
        title="Apps"
        action={
          <SectionActionButton
            testID="apps.all"
            title="All 3"
            destination
            onPress={() => {}}
          />
        }
        actionLayout="trailing"
        surface="none"
      >
        <PageDirectoryRowsContext.Provider value>
        {props.columns > 1 ? (
          <ItemGroupColumns
            columns={props.columns}
            paddingHorizontal={0}
            paddingVertical={0}
            columnGap={HAPPIER_COLLECTION_LIST_METRICS.catalogRow.directoryColumnGap}
          >
            {rows}
          </ItemGroupColumns>
        ) : (
          rows
        )}
        </PageDirectoryRowsContext.Provider>
      </ItemGroup>
    </ItemList>
  );
}

/**
 * A page directory's core rows (Store Installed), described or title-only, stand on the section's edges by the same rule as the Collection
 * directory (owner A9): each row's mark starts on the section title's edge, its trailing text ends on the "All ›" edge.
 */
it.each([
  ['described, two columns', 1200, 2, true],
  ['described, one column (phone)', 358, 1, true],
  ['title-only, two columns', 1200, 2, false],
  ['title-only, one column (phone)', 358, 1, false],
] as const)(
  'puts row marks on the section title edge and trailing ends on the All edge (%s)',
  async (_label, width, columns, described) => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () =>
      root!.render(
        <View style={{ width, height: 900 }}>
          <InstalledLikeSection columns={columns} described={described} />
        </View>,
      ),
    );
    const layout = await measureWebLayout(host, {
      viewport: { width: width + 200, height: 1000 },
      texts: ['Apps', ...ROWS.map((row) => row.where)],
      settle: (replay) => act(replay),
    });
    const titleLeft = layout
      .textRects('Apps')
      .find((rect) => rect.width > 1)!.left;
    const allRight = layout.rect('apps.all').right;
    const marks = ROWS.map((row) => layout.rect(`mark:${row.key}`).left);
    const ends = ROWS.map(
      (row) =>
        layout.textRects(row.where).find((rect) => rect.width > 1)!.right,
    );
    // The page column may be narrower than the host: the section's own middle parts its columns.
    const middle = (titleLeft + allRight) / 2;
    const firstColumnMarks = marks.filter((left) => left < middle);
    const lastColumnEnds = ends.filter((right) => right > middle);
    expect(firstColumnMarks.length).toBeGreaterThan(0);
    expect(lastColumnEnds.length).toBeGreaterThan(0);
    // Two columns really stand side by side: the rows' marks take two distinct edges.
    expect(new Set(marks).size).toBe(columns);
    for (const left of firstColumnMarks)
      expect.soft(Math.abs(left - titleLeft)).toBeLessThanOrEqual(1);
    for (const right of lastColumnEnds)
      expect.soft(Math.abs(right - allRight)).toBeLessThanOrEqual(1);
  },
);
