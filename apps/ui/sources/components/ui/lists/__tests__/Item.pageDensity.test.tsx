import React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flattenTestStyle, renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const densityState = vi.hoisted(() => ({ preferred: 'cozy' as 'comfortable' | 'cozy' | 'compact', fontScale: 1 }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/layout/layout', () => ({
    useLayoutMaxWidth: () => 850,
}));

vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));

// The list-density preference is device-local storage: the one boundary this test controls.
vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: (key: string) => (key === 'uiItemDensity' ? densityState.preferred : key === 'uiFontScale' ? densityState.fontScale : null),
}));

afterEach(() => {
    densityState.fontScale = 1;
    standardCleanup();
    vi.resetModules();
});

type Screen = Awaited<ReturnType<typeof renderScreen>>;
type Density = 'comfortable' | 'cozy' | 'compact';

function textNode(screen: Screen, value: string): ReactTestInstance {
    const node = screen.findAll((candidate) => candidate.type === ('Text' as never) && candidate.props.children === value)[0];
    if (!node) throw new Error(`Missing text ${value}`);
    return node;
}

/** The row box: the nearest ancestor of the title that sets the row's minimum height. */
function rowBox(screen: Screen, title: string): Record<string, unknown> {
    let node: ReactTestInstance | null = textNode(screen, title).parent;
    while (node) {
        const style = flattenTestStyle(node.props.style);
        if (typeof style.minHeight === 'number') return style;
        node = node.parent;
    }
    throw new Error(`No row box for ${title}`);
}

/** The height a one- or two-line row actually takes: its padding around its text, floored by its minimum. */
function rowHeight(screen: Screen, title: string, subtitle?: string): number {
    const box = rowBox(screen, title);
    const titleStyle = flattenTestStyle(textNode(screen, title).props.style);
    const subtitleStyle = subtitle ? flattenTestStyle(textNode(screen, subtitle).props.style) : null;
    const padding = (box.paddingVertical as number) * 2;
    const text = (titleStyle.lineHeight as number)
        + (subtitleStyle ? (subtitleStyle.lineHeight as number) + ((subtitleStyle.marginTop as number | undefined) ?? 0) : 0);
    return Math.max(box.minHeight as number, padding + text);
}

async function renderPage(density: Density, section?: 'compact') {
    densityState.preferred = density;
    const { Item } = await import('../Item');
    const { ItemGroup } = await import('../ItemGroup');
    const { ListPresentationProvider } = await import('../listPresentation');
    return renderScreen(
        <ListPresentationProvider value="page">
            <ItemGroup title="Preferences">
                <Item title="Unified shortcuts" subtitle="Composer send keys follow the commands below." onPress={() => {}} />
                <Item title="Theme" onPress={() => {}} />
            </ItemGroup>
            <ItemGroup title="App" density={section}>
                <Item title="Open search" onPress={() => {}} />
            </ItemGroup>
        </ListPresentationProvider>,
    );
}

describe('Item page rows follow the list-density preference', () => {
    it('leaves web row metrics at their base size for the global CSS scale owner', async () => {
        densityState.fontScale = 1.3;
        const screen = await renderPage('cozy');
        const title = flattenTestStyle(textNode(screen, 'Theme').props.style);
        // Unistyles compiles the adapter's complete style into CSS. The global web override
        // applies 1.3 to that CSS; pre-scaling here would produce 14 × 1.3² = 23.66px.
        expect(title.fontSize).toBe(14);
        expect(title.lineHeight).toBe(20);
    });

    it('renders the default density exactly as the shared page anatomy plugin pages draw', async () => {
        const { HAPPIER_PAGE_METRICS, HAPPIER_PAGE_TEXT } = await import('@happier-dev/plugin-ui/presentation');
        const screen = await renderPage('cozy');
        const box = rowBox(screen, 'Theme');
        const title = flattenTestStyle(textNode(screen, 'Theme').props.style);
        expect(box.minHeight).toBe(HAPPIER_PAGE_METRICS.rowMinHeightPx);
        expect(box.paddingVertical).toBe(HAPPIER_PAGE_METRICS.rowPaddingVerticalPx);
        expect(title.fontSize).toBe(HAPPIER_PAGE_TEXT.rowTitle.fontSize);
        expect(title.lineHeight).toBe(HAPPIER_PAGE_TEXT.rowTitle.lineHeight);
    });

    it('makes every row roomier or denser as the preference changes, including long single-line lists', async () => {
        const heights: Record<Density, { twoLine: number; oneLine: number; list: number; titleSize: number }> = {} as never;
        for (const density of ['comfortable', 'cozy', 'compact'] as const) {
            const screen = await renderPage(density, 'compact');
            heights[density] = {
                twoLine: rowHeight(screen, 'Unified shortcuts', 'Composer send keys follow the commands below.'),
                oneLine: rowHeight(screen, 'Theme'),
                list: rowHeight(screen, 'Open search'),
                titleSize: flattenTestStyle(textNode(screen, 'Theme').props.style).fontSize as number,
            };
            standardCleanup();
            vi.resetModules();
        }
        for (const key of ['twoLine', 'oneLine', 'list'] as const) {
            expect(heights.comfortable[key]).toBeGreaterThan(heights.cozy[key]);
            expect(heights.cozy[key]).toBeGreaterThan(heights.compact[key]);
        }
        expect(heights.comfortable.titleSize).toBeGreaterThanOrEqual(heights.cozy.titleSize);
        expect(heights.cozy.titleSize).toBeGreaterThan(heights.compact.titleSize);
        // A list section is the compact shape of its density, never taller than a lone row.
        for (const density of ['comfortable', 'cozy', 'compact'] as const) {
            expect(heights[density].list).toBeLessThan(heights[density].oneLine);
        }
    });

    it('keeps the description within a few pixels of its title at every density', async () => {
        for (const density of ['comfortable', 'cozy', 'compact'] as const) {
            const screen = await renderPage(density);
            const title = flattenTestStyle(textNode(screen, 'Unified shortcuts').props.style);
            const subtitle = flattenTestStyle(textNode(screen, 'Composer send keys follow the commands below.').props.style);
            // The visible gap is the leading below the title's glyphs, the margin, and the leading above the
            // description's: half of each line's spare height plus the margin between them.
            const gap = ((title.lineHeight as number) - (title.fontSize as number)) / 2
                + ((subtitle.marginTop as number | undefined) ?? 0)
                + ((subtitle.lineHeight as number) - (subtitle.fontSize as number)) / 2;
            expect(gap, density).toBeGreaterThanOrEqual(2);
            expect(gap, density).toBeLessThanOrEqual(8);
            standardCleanup();
            vi.resetModules();
        }
    });
});

describe('page rows with a trailing control', () => {
    it('lets a control\'s touch box use the row padding instead of growing the row', async () => {
        const { Item } = await import('../Item');
        const { ItemGroup } = await import('../ItemGroup');
        const { ListPresentationProvider } = await import('../listPresentation');
        const { View } = await import('react-native');
        const heights: Record<Density, { plain: number; withControl: number }> = {} as never;
        for (const density of ['comfortable', 'cozy', 'compact'] as const) {
            densityState.preferred = density;
            // The shared switch draws a 22px track in a 44px focus and hit box (`HAPPIER_SWITCH_METRICS`).
            const screen = await renderScreen(
                <ListPresentationProvider value="page">
                    <ItemGroup title="Shortcuts">
                        <Item title="Plain row" subtitle="A description under the title." onPress={() => {}} />
                        <Item title="Switch row" subtitle="A description under the title." rightElement={<View testID="control" style={{ width: 44, height: 44 }} />} />
                    </ItemGroup>
                </ListPresentationProvider>,
            );
            // The control's box as laid out: its height, less any of it the right section lends to the row padding.
            let node = screen.findAll((candidate) => candidate.props.testID === 'control')[0]!.parent;
            let lent = 0;
            while (node && typeof flattenTestStyle(node.props.style).minHeight !== 'number') {
                const style = flattenTestStyle(node.props.style);
                lent += -Math.min(0, (style.marginTop ?? style.marginVertical ?? 0) as number) - Math.min(0, (style.marginBottom ?? style.marginVertical ?? 0) as number);
                node = node.parent;
            }
            const box = rowBox(screen, 'Switch row');
            const text = rowHeight(screen, 'Switch row', 'A description under the title.') - (box.paddingVertical as number) * 2;
            heights[density] = {
                plain: rowHeight(screen, 'Plain row', 'A description under the title.'),
                withControl: Math.max(box.minHeight as number, (box.paddingVertical as number) * 2 + Math.max(text, 44 - lent)),
            };
            standardCleanup();
        }
        for (const density of ['comfortable', 'cozy', 'compact'] as const) {
            expect(heights[density].withControl, density).toBe(heights[density].plain);
        }
    });
});

describe('page row metrics on touch', () => {
    it('never draws a row shorter than a touch target when the primary pointer is a finger', async () => {
        const { resolvePageRowMetrics, PAGE_ROW_TOUCH_MIN_HEIGHT_PX } = await import('../pageRowMetrics');
        for (const density of ['comfortable', 'cozy', 'compact'] as const) {
            for (const shape of ['standard', 'list'] as const) {
                expect(resolvePageRowMetrics({ density, shape, touch: true }).minHeightPx).toBeGreaterThanOrEqual(PAGE_ROW_TOUCH_MIN_HEIGHT_PX);
            }
        }
        // A precise pointer keeps the dense desktop list.
        expect(resolvePageRowMetrics({ density: 'compact', shape: 'list', touch: false }).minHeightPx).toBeLessThan(PAGE_ROW_TOUCH_MIN_HEIGHT_PX);
    });
});
