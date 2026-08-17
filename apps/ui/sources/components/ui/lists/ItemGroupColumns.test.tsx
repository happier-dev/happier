/**
 * `ItemGroupColumns` resolves its column count from ONE input: the width its own
 * container actually got.
 *
 * The window is deliberately hostile in every test here — wide while the grid is
 * narrow, narrow while the grid is wide — because a grid is routinely a `flex: 1`
 * pane beside a fixed rail, where the window says nothing about the room a cell
 * gets. A viewport-class rule reads those cases exactly backwards.
 */

import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    windowWidth: 1600,
    windowHeight: 1200,
    windowDimensionReads: 0,
}));

installUiListsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        const base = await createReactNativeWebMock();
        return {
            ...base,
            Dimensions: {
                get: () => {
                    shared.windowDimensionReads += 1;
                    return { width: shared.windowWidth, height: shared.windowHeight, scale: 2, fontScale: 1 };
                },
            },
            useWindowDimensions: () => {
                shared.windowDimensionReads += 1;
                return { width: shared.windowWidth, height: shared.windowHeight };
            },
        };
    },
});

type Screen = Awaited<ReturnType<typeof renderScreen>>;
type Node = Screen['root'];

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    if (style && typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

function findMeasureHosts(screen: Screen): Node[] {
    return screen.root.findAll((node) => (
        typeof node.type === 'string' && typeof node.props.onLayout === 'function'
    ), { deep: true });
}

/** Reports the box width the grid actually got, the way a real layout would. */
async function measureGrid(screen: Screen, widthPx: number): Promise<void> {
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
 * The count as the LAYOUT resolves it: a collapsed cell is full width, an open
 * one is flexible. Read off the cells rather than off any internal state.
 */
function readActiveColumns(screen: Screen): number {
    const cells = screen.root.findAll((node) => (
        typeof node.props?.testID === 'string' && node.props.testID.startsWith('cell-')
    ), { deep: true }).map((child) => child.parent!);
    expect(cells.length).toBeGreaterThan(0);
    const isCollapsed = cells.map((cell) => flattenStyle(cell.props.style).width === '100%');
    expect(new Set(isCollapsed).size).toBe(1);
    return isCollapsed[0] ? 1 : 2;
}

async function renderGrid(props: Record<string, unknown> = {}, cellCount = 2) {
    const { ItemGroupColumns, ItemGroupColumn } = await import('./ItemGroupColumns');
    return await renderScreen(
        <ItemGroupColumns columns={2} {...props}>
            {Array.from({ length: cellCount }, (_, index) => (
                <ItemGroupColumn key={index}>
                    <View testID={`cell-${index}`} />
                </ItemGroupColumn>
            ))}
        </ItemGroupColumns>,
    );
}

beforeEach(() => {
    shared.windowWidth = 1600;
    shared.windowHeight = 1200;
    shared.windowDimensionReads = 0;
});

describe('ItemGroupColumns column ownership', () => {
    it('stays at one column until a width has actually been measured', async () => {
        const screen = await renderGrid();

        // No window-derived guess before the first layout.
        expect(readActiveColumns(screen)).toBe(1);
    });

    it('collapses a narrow grid to one column inside a wide window', async () => {
        shared.windowWidth = 1600;
        shared.windowHeight = 1200;
        const screen = await renderGrid();

        // A 500px pane cannot host two 320px columns, whatever the window does.
        // The default padding is 16 a side, so 468px is what the columns share.
        await measureGrid(screen, 500);

        expect(readActiveColumns(screen)).toBe(1);
    });

    it('opens two columns in a wide grid inside a narrow window', async () => {
        shared.windowWidth = 360;
        shared.windowHeight = 640;
        const screen = await renderGrid();

        await measureGrid(screen, 1000);

        expect(readActiveColumns(screen)).toBe(2);
    });

    it('measures against its own horizontal padding, which the columns never get', async () => {
        const screen = await renderGrid({ paddingHorizontal: 40 });

        // Two 320px columns plus the 12px gutter need 652px of content room,
        // which a 691px box with 40px of padding a side does not have.
        await measureGrid(screen, 651 + 80);
        expect(readActiveColumns(screen)).toBe(1);

        await measureGrid(screen, 652 + 80);
        expect(readActiveColumns(screen)).toBe(2);
    });

    it('honours a caller-declared cell floor for content narrower than a list row', async () => {
        const screen = await renderGrid({ minColumnWidthPx: 200 });

        // Two 200px columns plus the gutter need 412px, which a 468px content
        // box clears even though the 320px list-row floor would not.
        await measureGrid(screen, 500);

        expect(readActiveColumns(screen)).toBe(2);
    });

    it('never reads the window, so a resize that leaves its own width alone cannot re-render it', async () => {
        const screen = await renderGrid();
        await measureGrid(screen, 1000);
        expect(readActiveColumns(screen)).toBe(2);

        // The window is not an input. A viewport-derived owner would have to
        // subscribe to it and would re-render every cell on any window resize —
        // for a value the layout does not use.
        expect(shared.windowDimensionReads).toBe(0);
    });
});

describe('ItemGroupColumns explicit count', () => {
    it('takes an explicit activeColumns and does not measure at all', async () => {
        const screen = await renderGrid({ activeColumns: 2 });

        // The caller already measured; a second measuring host here would be a
        // second owner of the same number.
        expect(findMeasureHosts(screen)).toHaveLength(0);
        expect(readActiveColumns(screen)).toBe(2);
    });

    it('lets an explicit single column collapse the cells however wide the box is', async () => {
        const { ItemGroupColumns, ItemGroupColumn } = await import('./ItemGroupColumns');
        const screen = await renderScreen(
            <ItemGroupColumns columns={2} activeColumns={1}>
                <ItemGroupColumn><View testID="cell-a" /></ItemGroupColumn>
                <ItemGroupColumn><View testID="cell-b" /></ItemGroupColumn>
            </ItemGroupColumns>,
        );

        expect(readActiveColumns(screen)).toBe(1);
    });
});

describe('ItemGroupColumn spans', () => {
    it('gives a full-span cell the whole row', async () => {
        const { ItemGroupColumns, ItemGroupColumn } = await import('./ItemGroupColumns');
        const screen = await renderScreen(
            <ItemGroupColumns columns={2} activeColumns={2}>
                <ItemGroupColumn span={2}><View testID="wide" /></ItemGroupColumn>
            </ItemGroupColumns>,
        );

        expect(flattenStyle(screen.findByTestId('wide')?.parent?.props.style).width).toBe('100%');
    });
});
