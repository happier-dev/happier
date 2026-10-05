import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
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

    it('puts back in the gutter when the space left of the content edge fits the control', () => {
        expect(resolvePageBackPlacement({ paneWidthPx: 1100, columnMaxWidthPx })).toBe('gutter');
    });

    it('falls back to the title row when the column fills the pane', () => {
        expect(resolvePageBackPlacement({ paneWidthPx: 600, columnMaxWidthPx })).toBe('title-row');
    });

    it('switches exactly where the gutter stops fitting the control', () => {
        const textInset = PAGE_LIST_METRICS.pageTextInsetPx;
        const needed = PAGE_LIST_METRICS.backGutterWidthPx;
        // Leading space = half the pane's spare width + the column's own text inset.
        const fitsExactly = columnMaxWidthPx + 2 * (needed - textInset);
        expect(resolvePageBackPlacement({ paneWidthPx: fitsExactly, columnMaxWidthPx })).toBe('gutter');
        expect(resolvePageBackPlacement({ paneWidthPx: fitsExactly - 2, columnMaxWidthPx })).toBe('title-row');
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
    });

    it('keeps the title on the content edge and puts back in the gutter on wide panes', async () => {
        const screen = await renderHeader();
        layoutPane(screen, 1400);
        expect(screen.root.findAllByType('BackArrow' as never)).toHaveLength(1);
        expect(gutterBacks(screen)).toBe(1);
        expect(titleRowLead(screen)).toBe('content');
    });

    it('puts back on the title row when the gutter is too narrow', async () => {
        const screen = await renderHeader();
        layoutPane(screen, 420);
        expect(screen.root.findAllByType('BackArrow' as never)).toHaveLength(1);
        expect(gutterBacks(screen)).toBe(0);
        expect(titleRowLead(screen)).toBe('back');
    });

    it('keeps a leading mark on the content edge with back in the gutter', async () => {
        const screen = await renderHeader(React.createElement('Mark'));
        layoutPane(screen, 1400);
        expect(gutterBacks(screen)).toBe(1);
        expect(titleRowLead(screen)).toBe('content');
    });
});
