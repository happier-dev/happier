import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

// Native layout delivery is the platform boundary; the header and its rule stay real.
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Pressable', Platform: { OS: 'ios' }, I18nManager: { isRTL: false } }));

import { HappierCollectionLayoutContext, type HappierCollectionLayoutState } from '../collection/collectionLayout.js';
import { HappierPageHeader, type HappierPageHeaderProps, type HappierPageHeaderTextRender } from './PageHeader.js';
import { HAPPIER_PAGE_METRICS } from './pageMetrics.js';
import { HappierShellTitleRowContext } from './shellTitleRow.js';

function renderHeader(props: Partial<HappierPageHeaderProps>, layout: HappierCollectionLayoutState | null = null, shellPane = false) {
  const roles: string[] = [];
  const renderText: HappierPageHeaderTextRender = (input) => {
    if (input.header) roles.push(input.role);
    return <Text>{input.text}</Text>;
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <HappierShellTitleRowContext.Provider value={shellPane}>
        <HappierCollectionLayoutContext.Provider value={layout}>
          <HappierPageHeader testID="header" title="Inbox" renderText={renderText} {...props} />
        </HappierCollectionLayoutContext.Provider>
      </HappierShellTitleRowContext.Provider>,
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

  // The title line holds a control's height (its actions never move it); its centre is the band's centre,
  // where the rail's first icon and every column title sit.
  it.each<[string, HappierCollectionLayoutState | null]>([
    ['alone in the pane', null],
    ['beside a list', { mode: 'split', detailBeside: true }],
  ])('puts the title on the shell title row when the page heads a desktop shell pane, %s', (_name, layout) => {
    const { paddingTop } = renderHeader({}, layout, true);
    expect(paddingTop + HAPPIER_PAGE_METRICS.controlHeightPx / 2).toBe(HAPPIER_PAGE_METRICS.paneHeaderHeightPx / 2);
  });

  // A main screen's head hangs its controls from the title's line (`actionsLayout="hang"`): the title is centred on
  // that same control-height line, not drawn at its own line's top 2 px above the row (SHELL-ACCEPT-1117 #7, live 66 vs 68).
  it('centres a hanging title on its controls\' line', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <HappierShellTitleRowContext.Provider value>
          <HappierPageHeader testID="header" title="Services" actionsLayout="hang" actions={<Text>+</Text>}
            renderText={(input) => <Text>{input.text}</Text>} />
        </HappierShellTitleRowContext.Provider>,
      );
    });
    const title = renderer.root.findAll((node) => node.type === 'Text' && node.props.children === 'Services')[0]!;
    let box = title.parent;
    while (box && !(box.type === 'View' && box.props.style?.minHeight !== undefined)) box = box.parent;
    expect(box?.props.style).toMatchObject({ minHeight: HAPPIER_PAGE_METRICS.controlHeightPx, justifyContent: 'center' });
  });
});
