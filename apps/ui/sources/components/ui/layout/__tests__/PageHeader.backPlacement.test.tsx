import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { renderInCollectionLayout } from '@/dev/testkit/render/renderInCollectionLayout';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks();

const { PageHeader } = await import('@/components/ui/layout/PageHeader');
const { NavigationBackChromeProvider } = await import('@/components/ui/layout/NavigationBackChrome');
const { PAGE_LIST_METRICS, resolvePageBackPlacement } = await import('@/components/ui/lists/pageListMetrics');

function BackArrow() {
    return React.createElement('BackArrow');
}

describe('resolvePageBackPlacement', () => {
    const columnMaxWidthPx = 720;

    it('switches exactly where the gutter stops fitting the control', () => {
        const textInset = PAGE_LIST_METRICS.pageTextInsetPx;
        const needed = PAGE_LIST_METRICS.backGutterWidthPx;
        // Leading space = half the pane's spare width + the column's own text inset.
        const fitsExactly = columnMaxWidthPx + 2 * (needed - textInset);
        expect(resolvePageBackPlacement({ paneWidthPx: fitsExactly, columnMaxWidthPx })).toBe('gutter');
        expect(resolvePageBackPlacement({ paneWidthPx: fitsExactly - 2, columnMaxWidthPx })).toBe('above-title');
    });

    it('does not place back before the pane has been measured', () => {
        expect(resolvePageBackPlacement({ paneWidthPx: null, columnMaxWidthPx })).toBeNull();
    });
});

async function renderHeader(leading?: React.ReactNode) {
    return renderScreen(
        <NavigationBackChromeProvider control={BackArrow}>
            <PageHeader testID="page-header" title="Members" description="Who is in this Team." leading={leading} />
        </NavigationBackChromeProvider>,
    );
}

function layoutPane(screen: Awaited<ReturnType<typeof renderHeader>>, widthPx: number) {
    const wrapper = screen.root.find((node: ReactTestInstance) => typeof node.type === 'string' && node.props.testID === 'page-header');
    act(() => {
        wrapper.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: widthPx, height: 80 } } });
    });
}

/** What leads the title row: the back control on the fallback, else the page's own content. */
function titleRowLead(screen: Awaited<ReturnType<typeof renderHeader>>): 'back' | 'content' {
    const row = screen.root.find((node: ReactTestInstance) => typeof node.type === 'string' && node.props.testID === 'page-header-title-row');
    const first = row.children.find((child): child is ReactTestInstance => typeof child !== 'string');
    if (!first) throw new Error('empty title row');
    const isBack = first.type === ('BackArrow' as never) || (first.findAllByType('BackArrow' as never).length > 0
        && first.findAll((node: ReactTestInstance) => node.props.testID === 'page-header-back-gutter').length === 0
        && first.children.length === 1);
    return isBack ? 'back' : 'content';
}

function gutterBacks(screen: Awaited<ReturnType<typeof renderHeader>>): number {
    return screen.root.findAll((node: ReactTestInstance) => typeof node.type === 'string' && node.props.testID === 'page-header-back-gutter').length;
}

describe('PageHeader back control placement', () => {
    it('keeps entity controls reachable after compact recomposition and column details outside the identity', async () => {
        let presses = 0;
        const screen = await renderScreen(<NavigationBackChromeProvider control={BackArrow}><PageHeader testID="page-header" title="Personal" compactPresentation="centered" detailsPlacement="column" details={React.createElement('Summary')} actions={React.createElement('Pressable', { testID: 'refresh', onPress: () => { presses += 1; } })} /></NavigationBackChromeProvider>);
        layoutPane(screen, 390);
        await screen.pressByTestIdAsync('refresh');
        expect(presses).toBe(1);
        const titleRow = screen.findHostByTestId('page-header-title-row');
        expect(titleRow?.findAllByType('Summary' as never)).toHaveLength(0);
        expect(screen.root.findAllByType('Summary' as never)).toHaveLength(1);
    });
    it('keeps back mounted (unseen) until the pane is measured, so no fallback arrow flashes', async () => {
        const screen = await renderHeader();
        expect(screen.root.findAllByType('BackArrow' as never)).toHaveLength(1);
        const backHosts = screen.root.findAll((node: ReactTestInstance) => typeof node.type === 'string'
            && (node.props.testID === 'page-header-back-gutter' || node.props.testID === 'page-header-back-line'));
        expect(backHosts).toHaveLength(1);
        expect(backHosts[0]?.props.style).toContainEqual({ opacity: 0 });
    });

    it('decides back from the split\'s detail width on the first paint, so a wide detail never reserves a line it then drops', async () => {
        const wide = await renderInCollectionLayout(
            <NavigationBackChromeProvider control={BackArrow}><PageHeader testID="page-header" title="Invitations" /></NavigationBackChromeProvider>,
            'split',
            2560,
        );
        expect(gutterBacks(wide)).toBe(1);
        expect(wide.findHostByTestId('page-header-back-line')).toBeNull();
        // A detail beside a narrow window's list still reserves nothing it does not need: its line is drawn, shown.
        const narrow = await renderInCollectionLayout(
            <NavigationBackChromeProvider control={BackArrow}><PageHeader testID="page-header" title="Invitations" /></NavigationBackChromeProvider>,
            'split',
            1000,
        );
        expect(gutterBacks(narrow)).toBe(0);
        expect(narrow.findHostByTestId('page-header-back-line')?.props.style).not.toContainEqual({ opacity: 0 });
    });

    it.each([
        { content: 'free', splitWidth: 1440, frameWidth: PAGE_LIST_METRICS.columnMaxWidthPx.reading - 2 * PAGE_LIST_METRICS.sheetInsetPx },
        { content: 'sections', splitWidth: 1056, frameWidth: 1056 - 272 - 2 * PAGE_LIST_METRICS.detailSideInsetPx },
    ] as const)('keeps the first title offset when the $content page is narrower than the split detail', async ({ content, splitWidth, frameWidth }) => {
        const { PageFrame } = await import('@/components/ui/layout/PageFrame');
        const { ListPresentationProvider } = await import('@/components/ui/lists/listPresentation');
        const screen = await renderInCollectionLayout(
            <ListPresentationProvider value="page">
                <PageFrame content={content}>
                    <NavigationBackChromeProvider control={BackArrow}>
                        <PageHeader testID="page-header" title="Team member" />
                    </NavigationBackChromeProvider>
                </PageFrame>
            </ListPresentationProvider>,
            'split',
            splitWidth,
        );
        const aboveTitleHeight = () => {
            const style = screen.findHostByTestId('page-header-back-line')?.props.style?.[0];
            return style ? style.height + style.marginBottom : 0;
        };
        const firstOffset = aboveTitleHeight();
        layoutPane(screen, frameWidth);
        expect(aboveTitleHeight()).toBe(PAGE_LIST_METRICS.backControlSizePx + PAGE_LIST_METRICS.pageHeaderLineGapPx);
        expect(firstOffset).toBe(aboveTitleHeight());
    });

    it('keeps the title on the content edge and puts back in the gutter on wide panes', async () => {
        const screen = await renderHeader();
        layoutPane(screen, 1400);
        expect(screen.root.findAllByType('BackArrow' as never)).toHaveLength(1);
        expect(gutterBacks(screen)).toBe(1);
        expect(titleRowLead(screen)).toBe('content');
    });

    it('puts back on its own line above the title when the gutter is too narrow, keeping the title on the content edge', async () => {
        const screen = await renderHeader();
        layoutPane(screen, 420);
        expect(screen.root.findAllByType('BackArrow' as never)).toHaveLength(1);
        expect(gutterBacks(screen)).toBe(0);
        // Title, purpose and sections share one left edge (DESIGN.md "Back stays out of the title").
        expect(titleRowLead(screen)).toBe('content');
        const line = screen.findHostByTestId('page-header-back-line');
        expect(line?.findAllByType('BackArrow' as never)).toHaveLength(1);
    });

    it('keeps a leading mark on the content edge with back in the gutter', async () => {
        const screen = await renderHeader(React.createElement('Mark'));
        layoutPane(screen, 1400);
        expect(gutterBacks(screen)).toBe(1);
        expect(titleRowLead(screen)).toBe('content');
    });

    it('places a back control that arrives after the pane was laid out, instead of hiding it while it measures forever', async () => {
        const header = (control: typeof BackArrow | null) => (
            <NavigationBackChromeProvider control={control}>
                <PageHeader testID="page-header" title="Sharing" description="Who can use this machine." />
            </NavigationBackChromeProvider>
        );
        // A phone pane lays out once on mount, before its back control (route-derived) is known.
        const screen = await renderScreen(header(null));
        const wrapper = screen.root.find((node: ReactTestInstance) => typeof node.type === 'string' && node.props.testID === 'page-header');
        act(() => { wrapper.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 80 } } }); });
        await screen.update(header(BackArrow));
        expect(gutterBacks(screen)).toBe(0);
        const line = screen.findHostByTestId('page-header-back-line');
        expect(line?.findAllByType('BackArrow' as never)).toHaveLength(1);
        expect(line?.props.style).not.toContainEqual({ opacity: 0 });
    });
});


describe('PageHeaderPlaceholder back control placement', () => {
    it.each([390, 1440])('reserves the back line the arriving header draws at %i px', async (widthPx) => {
        const { PageHeaderPlaceholder } = await import('@/components/ui/layout/PageHeader');
        const lineOf = async (element: React.ReactElement) => {
            const screen = await renderScreen(<NavigationBackChromeProvider control={BackArrow}>{element}</NavigationBackChromeProvider>);
            layoutPane(screen, widthPx);
            const placement = {
                line: screen.root.findAll((node: ReactTestInstance) => typeof node.type === 'string' && node.props.testID === 'page-header-back-line').length,
                gutter: gutterBacks(screen),
            };
            await screen.unmount();
            return placement;
        };
        // An entity page's placeholder and the header that replaces it put Back in the same place.
        expect(await lineOf(<PageHeaderPlaceholder testID="page-header" alwaysShowTitle />))
            .toEqual(await lineOf(<PageHeader testID="page-header" title="Tomas Berg" alwaysShowTitle />));
        expect(await lineOf(<PageHeaderPlaceholder testID="page-header" alwaysShowTitle />)).not.toEqual({ line: 0, gutter: 0 });
    });
});
