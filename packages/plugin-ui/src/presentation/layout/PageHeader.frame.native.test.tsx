import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

// Native layout delivery is the platform boundary; the header and its rule stay real.
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Pressable', Platform: { OS: 'ios' } }));

import { HappierCollectionLayoutContext, type HappierCollectionLayoutState } from '../collection/collectionLayout.js';
import { HappierPageHeader, type HappierPageHeaderProps, type HappierPageHeaderTextRender } from './PageHeader.js';
import { HAPPIER_PAGE_METRICS } from './pageMetrics.js';

function renderHeader(props: Partial<HappierPageHeaderProps>, layout: HappierCollectionLayoutState | null = null) {
  const roles: string[] = [];
  const renderText: HappierPageHeaderTextRender = (input) => {
    if (input.header) roles.push(input.role);
    return <Text>{input.text}</Text>;
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <HappierCollectionLayoutContext.Provider value={layout}>
        <HappierPageHeader testID="header" title="Inbox" renderText={renderText} {...props} />
      </HappierCollectionLayoutContext.Provider>,
    );
  });
  const column = renderer.root.findByProps({ testID: 'header' }).findAllByType('View')[1]!;
  return { titleRole: roles.at(-1), paddingTop: column.props.style.paddingTop as number };
}

describe('the one title rule', () => {
  it('draws the page title unless navigation leaves the name to the page', () => {
    expect(renderHeader({}).titleRole).toBe('pageTitle');
    expect(renderHeader({ largeTitle: true }).titleRole).toBe('heroTitle');
  });

  it('never gives an entity the large title: its mark already leads', () => {
    expect(renderHeader({ largeTitle: true, leading: <Text>mark</Text> }).titleRole).toBe('pageTitle');
  });
});

describe('the top of the page', () => {
  const page = HAPPIER_PAGE_METRICS.pageHeaderPaddingTopPx;
  const band = HAPPIER_PAGE_METRICS.pageHeaderUnderChromePaddingTopPx;

  // A large title is a phone page whose bar left the name to the page: it sits right under that bar.
  it('keeps a large title under the bar it hangs from', () => {
    expect(renderHeader({ largeTitle: true }, null).paddingTop).toBe(band);
  });

  it('joins the list+detail band only when a detail really stands beside the list', () => {
    expect(renderHeader({}, { mode: 'split', detailBeside: true }).paddingTop).toBe(band);
  });

  it.each<[string, HappierCollectionLayoutState | null]>([
    ['no collection around it', null],
    ['a window wide enough for a split with no detail open', { mode: 'split', detailBeside: false }],
    ['a stacked collection', { mode: 'stacked', detailBeside: false }],
  ])('keeps the page offset with %s', (_name, layout) => {
    expect(renderHeader({}, layout).paddingTop).toBe(page);
  });
});
