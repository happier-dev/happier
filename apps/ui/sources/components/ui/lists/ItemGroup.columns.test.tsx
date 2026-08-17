/**
 * The `columns` variant end to end.
 *
 * The load-bearing claim is that the column count comes from the GROUP's own
 * measured width, not the window's: an ItemGroup is routinely a `flex: 1` pane
 * beside a fixed rail (settings panes, docked columns), so the window width says
 * nothing about the room a row actually gets. Every test here therefore keeps a
 * WIDE window and drives the group's `onLayout` directly, which is the only
 * signal the resolver reads.
 */

import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    windowWidth: 1280,
}));

installUiListsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        const base = await createReactNativeWebMock();
        return {
            ...base,
            Dimensions: { get: () => ({ width: shared.windowWidth, height: 900, scale: 2, fontScale: 1 }) },
            useWindowDimensions: () => ({ width: shared.windowWidth, height: 900 }),
        };
    },
});

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), eyebrow: () => ({}) },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

const mountCounts = new Map<string, number>();

function Row(props: { id: string; showDivider?: boolean }) {
    return React.createElement('RowStub', props);
}

/** Counts MOUNTS (not renders), so a renderer swap shows up as a second mount. */
function CountingRow(props: { id: string; showDivider?: boolean }) {
    const { id } = props;
    React.useEffect(() => {
        mountCounts.set(id, (mountCounts.get(id) ?? 0) + 1);
    }, [id]);
    return React.createElement('RowStub', props);
}

type Screen = Awaited<ReturnType<typeof renderScreen>>;
type Node = Screen['root'];

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    if (style && typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

function readRowIds(screen: Screen): string[] {
    return screen.findAllByType('RowStub' as never).map((row) => row.props.id as string);
}

function readShowDividers(screen: Screen): Array<boolean | undefined> {
    return screen.findAllByType('RowStub' as never).map((row) => row.props.showDivider as boolean | undefined);
}

/** The cell a row sits in: the nearest ancestor whose style resolves a column width. */
function findRowCells(screen: Screen): Node[] {
    return screen.findAllByType('RowStub' as never).map((row) => {
        let node: Node | null = row.parent;
        while (node) {
            if (flattenStyle(node.props?.style).flexBasis != null) return node;
            node = node.parent;
        }
        throw new Error(`row ${row.props.id} has no width-carrying cell ancestor`);
    });
}

/**
 * The column count as the LAYOUT resolves it, read off the cell widths rather
 * than off which component rendered them — the point of the fix is that the
 * component never changes.
 */
function readActiveColumns(screen: Screen): number {
    const bases = new Set(findRowCells(screen).map((cell) => String(flattenStyle(cell.props.style).flexBasis)));
    expect(bases.size).toBe(1);
    const percent = Number.parseFloat([...bases][0]!);
    expect(percent).toBeGreaterThan(0);
    return Math.round(100 / percent);
}

/** Every host node the group asked to measure. */
function findMeasureHosts(screen: Screen): Node[] {
    return screen.root.findAll((node) => (
        typeof node.type === 'string' && typeof node.props.onLayout === 'function'
    ), { deep: true });
}

/** Reports the width the group's own box actually got, the way a real layout would. */
async function measureGroup(screen: Screen, widthPx: number): Promise<void> {
    const hosts = findMeasureHosts(screen);
    if (hosts.length !== 1) {
        throw new Error(`expected exactly one measuring host, found ${hosts.length}`);
    }
    await act(async () => {
        (hosts[0]!.props.onLayout as (event: unknown) => void)({
            nativeEvent: { layout: { x: 0, y: 0, width: widthPx, height: 400 } },
        });
    });
}

/**
 * The style array a cell was rendered with. Identity, not contents: a re-render
 * rebuilds the array, so an unchanged reference proves the group did not render
 * again at all.
 */
function readCellStyleIdentity(screen: Screen): unknown {
    return findRowCells(screen)[0]!.props.style;
}

async function renderGroup(children: React.ReactNode, columns?: 1 | 2 | 3) {
    const { ItemGroup } = await import('./ItemGroup');
    return await renderScreen(
        <ItemGroup title="Group" columns={columns}>
            {children}
        </ItemGroup>,
    );
}

const THREE_ROWS = (
    <>
        <Row id="a" />
        <Row id="b" />
        <Row id="c" />
    </>
);

/** The margin the cards sit inside; the columns share what is left of the group's box. */
async function contentMarginPx(): Promise<number> {
    const { Platform } = await import('react-native');
    const { ITEM_GROUP_CONTENT_MARGIN_HORIZONTAL_PX } = await import('./itemGroupSpacing');
    return Platform.select(ITEM_GROUP_CONTENT_MARGIN_HORIZONTAL_PX) ?? 0;
}

describe('ItemGroup columns', () => {
    it('renders one shared card with dividers when no column count is requested', async () => {
        const screen = await renderGroup(THREE_ROWS);

        expect(readRowIds(screen)).toEqual(['a', 'b', 'c']);
        expect(readShowDividers(screen)).toEqual([true, true, false]);
        // A group that never asked for columns must not pay for a measurement.
        expect(findMeasureHosts(screen)).toHaveLength(0);
    });

    it('renders one column until a width has actually been measured', async () => {
        shared.windowWidth = 1600;
        const screen = await renderGroup(THREE_ROWS, 2);

        // No window-derived guess before the first layout.
        expect(readActiveColumns(screen)).toBe(1);
        expect(readShowDividers(screen)).toEqual([true, true, false]);
    });

    it('resolves one column for a narrow pane inside a wide window', async () => {
        shared.windowWidth = 1600;
        const screen = await renderGroup(THREE_ROWS, 2);

        // A 500px settings pane cannot host two 320px columns, whatever the
        // window around it is doing.
        await measureGroup(screen, 500);

        expect(readActiveColumns(screen)).toBe(1);
        expect(readShowDividers(screen)).toEqual([true, true, false]);
    });

    it('resolves two columns for a wide pane inside a narrow window', async () => {
        shared.windowWidth = 320;
        const screen = await renderGroup(THREE_ROWS, 2);

        await measureGroup(screen, 1000);

        expect(readActiveColumns(screen)).toBe(2);
    });

    it('leaves the content margin to the cards before opening a second column', async () => {
        shared.windowWidth = 1600;
        const margin = await contentMarginPx();
        // Two 320px columns plus the 12px gutter need 652px of card room.
        const screen = await renderGroup(THREE_ROWS, 2);

        await measureGroup(screen, 651 + (2 * margin));
        expect(readActiveColumns(screen)).toBe(1);

        await measureGroup(screen, 652 + (2 * margin));
        expect(readActiveColumns(screen)).toBe(2);
    });

    it('does not re-render for a sub-pixel width change that crosses no breakpoint', async () => {
        shared.windowWidth = 1600;
        const screen = await renderGroup(THREE_ROWS, 2);

        await measureGroup(screen, 1000);
        expect(readActiveColumns(screen)).toBe(2);
        const before = readCellStyleIdentity(screen);

        // A browser ResizeObserver reports a fresh width for every sub-pixel
        // reflow. The resolved COUNT is the state, so an identical layout must
        // cost nothing at all.
        await measureGroup(screen, 1000.4);

        expect(readCellStyleIdentity(screen)).toBe(before);
        expect(readActiveColumns(screen)).toBe(2);
    });

    it('keeps a lone row full width instead of stranding it in a half-width card', async () => {
        shared.windowWidth = 1600;
        const screen = await renderGroup(<Row id="only" />, 2);

        await measureGroup(screen, 1000);

        expect(readRowIds(screen)).toEqual(['only']);
        expect(readActiveColumns(screen)).toBe(1);
    });

    it('deals rows across columns in source order once the pane is wide enough', async () => {
        shared.windowWidth = 1600;
        const screen = await renderGroup(THREE_ROWS, 2);

        await measureGroup(screen, 1000);

        // Source order + a wrapping grid puts a/c in the first column and b in
        // the second, which is the reading order the layout wants.
        expect(readRowIds(screen)).toEqual(['a', 'b', 'c']);
        expect(readActiveColumns(screen)).toBe(2);
    });

    it('insets the grid inside its own width, so two columns never outgrow one card', async () => {
        shared.windowWidth = 1600;
        const contentMargin = await contentMarginPx();

        const screen = await renderGroup(THREE_ROWS, 2);
        await measureGroup(screen, 1000);
        const cell = findRowCells(screen)[0]!;
        const cellStyle = flattenStyle(cell.props.style);
        const rootStyle = flattenStyle(cell.parent?.props.style);

        // The grid root is `width: '100%'`. A horizontal MARGIN sits outside that
        // resolved width, so the grid would occupy 100% + 2*margin and overflow
        // the single card's box. The inset has to be padding, which is inside it —
        // split between the root and each cell so the outer card edges still land
        // exactly on the single-card margin.
        expect(rootStyle).not.toHaveProperty('marginHorizontal');
        expect(Number(rootStyle.paddingHorizontal) + Number(cellStyle.paddingHorizontal)).toBe(contentMargin);
    });

    it('drops dividers in the multi-column layout because each row is its own card', async () => {
        shared.windowWidth = 1600;
        const screen = await renderGroup(THREE_ROWS, 2);

        await measureGroup(screen, 1000);

        expect(readShowDividers(screen)).toEqual([false, false, false]);
    });

    it('keeps the group accessible name in the columned layout', async () => {
        shared.windowWidth = 1600;
        const { ItemGroup } = await import('./ItemGroup');
        const screen = await renderScreen(
            <ItemGroup title="Group" columns={2} accessibilityLabel="Connected services">
                {THREE_ROWS}
            </ItemGroup>,
        );

        expect(screen.findAllByProps({ 'aria-label': 'Connected services' }).length).toBeGreaterThan(0);
    });

    it('refuses to combine columns with a virtualized segment', async () => {
        shared.windowWidth = 1600;
        const { ItemGroup } = await import('./ItemGroup');

        await expect(renderScreen(
            <ItemGroup title="Group" columns={2} virtualizedSegment={{ first: true, last: false }}>
                {THREE_ROWS}
            </ItemGroup>,
        )).rejects.toThrow(/cannot combine columns with virtualized content/);
    });

    it('refuses to combine columns with a radiogroup, whose roving focus follows child order', async () => {
        shared.windowWidth = 1600;
        const { ItemGroup } = await import('./ItemGroup');

        await expect(renderScreen(
            <ItemGroup title="Group" columns={2} accessibilityRole="radiogroup" accessibilityLabel="Pick one">
                {THREE_ROWS}
            </ItemGroup>,
        )).rejects.toThrow(/columns with a radiogroup/);
    });

    it('keeps the group title and footer outside the columns', async () => {
        shared.windowWidth = 1600;
        const { ItemGroup } = await import('./ItemGroup');
        const screen = await renderScreen(
            <ItemGroup title="Group title" footer="Group footer" columns={2}>
                {THREE_ROWS}
            </ItemGroup>,
        );
        await measureGroup(screen, 1000);

        const texts = screen.findAllByType('Text' as never).map((node) => node.props.children);
        expect(texts).toContain('Group title');
        expect(texts).toContain('Group footer');
    });
});

describe('ItemGroup columns row identity', () => {
    // A FRESH element every time: a resize re-renders the group, and identical
    // element references would let React bail out before the layout is re-read.
    async function buildGroupElement(ids: readonly string[]) {
        const { ItemGroup } = await import('./ItemGroup');
        return (
            <ItemGroup title="Group" columns={2}>
                {ids.map((id) => <CountingRow key={id} id={id} />)}
            </ItemGroup>
        );
    }

    it('keeps every row mounted across the column-count breakpoint', async () => {
        mountCounts.clear();
        shared.windowWidth = 1600;
        const screen = await renderScreen(await buildGroupElement(['a', 'b', 'c']));

        await measureGroup(screen, 1000);
        expect(readActiveColumns(screen)).toBe(2);

        await measureGroup(screen, 500);
        expect(readActiveColumns(screen)).toBe(1);

        await measureGroup(screen, 1000);
        expect(readActiveColumns(screen)).toBe(2);

        // A resize is a LAYOUT change: every row keeps its state, its in-flight
        // animation and its measured height because it never unmounted.
        expect([...mountCounts.entries()].sort()).toEqual([['a', 1], ['b', 1], ['c', 1]]);
    });

    it('keeps the surviving row mounted when the group falls below two rows', async () => {
        mountCounts.clear();
        shared.windowWidth = 1600;
        const screen = await renderScreen(await buildGroupElement(['a', 'b', 'c']));

        await measureGroup(screen, 1000);
        expect(readActiveColumns(screen)).toBe(2);

        await screen.update(await buildGroupElement(['a']));
        expect(readActiveColumns(screen)).toBe(1);
        expect(mountCounts.get('a')).toBe(1);
    });
});
