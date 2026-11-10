import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

await import('./Item');

afterEach(() => {
  standardCleanup();
  vi.resetModules();
});

type Lead = 'glyph' | 'avatar' | 'listMark';

/**
 * The flattened style of the box that holds a page row's leading element: its width decides where the
 * title starts, so every row of every sheet must report the same one.
 */
async function leadingColumn(lead: Lead, rowRole?: 'catalogRow') {
  const { Item } = await import('./Item');
  const { ListPresentationProvider } = await import('./listPresentation');
  const { HappierCollectionListMark } =
    await import('@happier-dev/plugin-ui/presentation');
  const { StyleSheet, View } = await import('react-native');
  // An identity mark drawn larger than the glyph column (a 36 pt Team logo) or wrapped in the list mark.
  const mark = <View testID="lead-mark" style={{ width: 36, height: 36 }} />;
  const props =
    lead === 'avatar'
      ? { leftElement: mark }
      : lead === 'listMark'
        ? {
            icon: <HappierCollectionListMark>{mark}</HappierCollectionListMark>,
          }
        : {
            icon: <View testID="lead-mark" style={{ width: 20, height: 20 }} />,
          };
  const screen = await renderScreen(
    <ListPresentationProvider value="page">
      <Item
        testID="row"
        title="Build infrastructure"
        subtitle="Member · 2 members"
        onPress={() => {}}
        rowRole={rowRole}
        {...props}
      />
    </ListPresentationProvider>,
  );
  const markNode = screen.findAll(
    (node) => node.props?.testID === 'lead-mark',
  )[0]!;
  // Walk up from the mark to the first ancestor that carries the column's trailing gap.
  let node = markNode.parent;
  while (
    node &&
    typeof StyleSheet.flatten(node.props?.style)?.marginRight !== 'number'
  )
    node = node.parent;
  return StyleSheet.flatten(node!.props.style);
}

describe('Item page row leading column', () => {
  it('keeps one glyph column whatever the leading element, so every page title shares one edge', async () => {
    const { PAGE_LIST_METRICS } = await import('./pageListMetrics');
    for (const lead of ['glyph', 'avatar', 'listMark'] as const) {
      const style = await leadingColumn(lead);
      // Where the title starts: the box (its width, or its floor when it fits its content) and its margins.
      const box = typeof style.width === 'number' ? style.width : style.minWidth;
      const footprint = box + (style.marginLeft ?? 0) + style.marginRight;
      expect({ lead, footprint }).toEqual({
        lead,
        footprint: PAGE_LIST_METRICS.rowLeadingColumnPx + PAGE_LIST_METRICS.rowLeadingGapPx,
      });
    }
  });

  it('keeps a catalog record\'s mark box fixed beside an identity mark, so Teams and People share the edge', async () => {
    const { HAPPIER_COLLECTION_LIST_METRICS } =
      await import('@happier-dev/plugin-ui/presentation');
    const style = await leadingColumn('avatar', 'catalogRow');
    expect(style.width).toBe(HAPPIER_COLLECTION_LIST_METRICS.catalogRow.markBox);
  });

  it('owns one identity-mark size that sits on the glyph axis without reaching the title', async () => {
    const { PAGE_LIST_METRICS } = await import('./pageListMetrics');
    const overhang =
      (PAGE_LIST_METRICS.rowIdentityMarkPx -
        PAGE_LIST_METRICS.rowLeadingColumnPx) /
      2;
    expect(overhang).toBeGreaterThanOrEqual(0);
    // The mark's half-overhang never eats more than a third of the gap to the title.
    expect(overhang).toBeLessThanOrEqual(PAGE_LIST_METRICS.rowLeadingGapPx / 3);
  });
});
