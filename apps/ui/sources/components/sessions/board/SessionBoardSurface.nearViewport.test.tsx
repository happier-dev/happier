import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import {
    createSessionSurfaceNoteDocumentV1,
    type SessionBoardItemWidth,
    type SessionBoardLayoutV1,
    type SessionSurfaceItemV1,
} from '@happier-dev/protocol/sessions/board';

import { renderScreen } from '@/dev/testkit';
import {
    projectSessionBoard,
    type SessionBoardActionsPort,
    type SessionBoardSnapshot,
} from '@/sync/domains/session/board';

import { SessionBoardSurface } from './SessionBoardSurface';
import { useSessionBoardController } from './useSessionBoardController';

/**
 * Opening a Board must not build every card it holds.
 *
 * The measurement here is the render count itself: how many declarative bodies
 * the surface instantiates for a hundred placements, before and after the
 * viewport is known and after a scroll.
 */

const PLACEMENT_COUNT = 100;
/** `SessionBoardSurface`'s own `DEFAULT_HEIGHT_BOUNDS.min`. */
const MIN_CARD_HEIGHT = 96;
const ACTIONS: SessionBoardActionsPort = {
    upsertItem: async () => ({ status: 'unavailable', reason: 'board_actions_unavailable' }),
    removeItem: async () => ({ status: 'unavailable', reason: 'board_actions_unavailable' }),
    updateLayout: async () => ({ status: 'unavailable', reason: 'board_actions_unavailable' }),
};

function note(title: string): SessionSurfaceItemV1 {
    return {
        v: 1,
        title,
        frame: 'card',
        height: { mode: 'auto', fallback: 'regular' },
        source: { kind: 'declarative', document: createSessionSurfaceNoteDocumentV1(`${title} body`) },
    } as SessionSurfaceItemV1;
}

const ITEM_IDS = Array.from({ length: PLACEMENT_COUNT }, (_value, index) => `note-${index}`);

function itemIds(count: number): readonly string[] {
    return ITEM_IDS.slice(0, count);
}

function layoutFor(placed: readonly string[], width: SessionBoardItemWidth): SessionBoardLayoutV1 {
    return {
        v: 1,
        tabs: [{
            id: 'overview',
            title: 'Overview',
            items: placed.map((itemId) => ({ itemId, width })),
        }],
    } as SessionBoardLayoutV1;
}

function snapshot(
    present: readonly string[],
    placed: readonly string[],
    width: SessionBoardItemWidth,
): SessionBoardSnapshot {
    return projectSessionBoard({
        layout: { revision: 'rev-layout', outcome: { status: 'ready', value: layoutFor(placed, width) } },
        items: new Map(present.map((itemId) => [itemId, {
            revision: `rev-${itemId}`,
            outcome: { status: 'ready' as const, value: note(itemId) },
        }] as const)),
        capabilities: { readTranscript: true, editSessionRecords: true },
        freshness: 'fresh',
        reachability: 'reachable',
        loading: 'idle',
        incomplete: false,
    });
}

function Harness(props: Readonly<{
    /** Items the Board holds; every one is placed unless `placed` says otherwise. */
    present?: readonly string[];
    /** The shared layout's placements — empty means every item is recovered. */
    placed?: readonly string[];
    width?: SessionBoardItemWidth;
    layout?: 'single' | 'grid';
}> = {}): React.ReactElement {
    const present = props.present ?? ITEM_IDS;
    const placed = props.placed ?? present;
    const width = props.width ?? 'full';
    const controller = useSessionBoardController({
        sessionId: 'session-1',
        serverId: 'home-1',
        binding: { status: 'ready', snapshot: snapshot(present, placed, width), refresh: () => {} },
        actions: ACTIONS,
    });
    return (
        <SessionBoardSurface
            sessionId="session-1"
            controller={controller}
            host="details"
            density="full"
            layout={props.layout ?? 'single'}
        />
    );
}

type Screen = Awaited<ReturnType<typeof renderScreen>>;

/** Distinct testIDs: a rendered component and its host element both carry one. */
function testIdsBySuffix(screen: Screen, suffix: string): readonly string[] {
    return [...new Set(screen.tree.root.findAll(
        (node) => typeof (node.props as { testID?: unknown }).testID === 'string'
            && (node.props as { testID: string }).testID.endsWith(suffix),
        { deep: true },
    ).map((node) => (node.props as { testID: string }).testID))];
}

function countBySuffix(screen: Screen, suffix: string): number {
    return testIdsBySuffix(screen, suffix).length;
}

function mountedBodyItemIds(screen: Screen): readonly string[] {
    return testIdsBySuffix(screen, '-declarative')
        .map((testID) => testID.replace(/^session-board-item-/u, '').replace(/-declarative$/u, ''));
}

function nodeByTestId(screen: Screen, testID: string) {
    return screen.tree.root.findAll(
        (node) => (node.props as { testID?: unknown }).testID === testID,
        { deep: true },
    ).at(-1);
}

/** Report one measured rect the way the platform does after layout. */
function publishLayout(
    screen: Screen,
    testID: string,
    layout: Readonly<{ x: number; y: number; width: number; height: number }>,
): void {
    (nodeByTestId(screen, testID)?.props as { onLayout?: (event: unknown) => void } | undefined)
        ?.onLayout?.({ nativeEvent: { layout } });
}

function deferredItemIds(screen: Screen): readonly string[] {
    return testIdsBySuffix(screen, '-deferred')
        .map((testID) => testID.replace(/^session-board-item-/u, '').replace(/-deferred$/u, ''));
}

function scrollNode(screen: Screen) {
    return screen.tree.root.findAll(
        (node) => (node.props as { testID?: unknown }).testID === 'session-board-scroll',
        { deep: true },
    ).at(-1);
}

describe('SessionBoardSurface near-viewport body window', () => {
    it('builds only the bodies a viewport away and advances the window on scroll', async () => {
        const screen = await renderScreen(<Harness />);
        const scroll = scrollNode(screen);
        expect(scroll).toBeTruthy();

        await act(async () => {
            (scroll?.props as { onLayout?: (event: unknown) => void }).onLayout?.({
                nativeEvent: { layout: { x: 0, y: 0, width: 800, height: 600 } },
            });
        });

        // Nothing has been laid out yet, so each card is placed by the surface's own
        // minimum card height. A 600px viewport plus one viewport of overscan reaches
        // 1896px, which is at most twenty 96px cards — not a hundred.
        const unmeasuredBodies = countBySuffix(screen, '-declarative');
        expect(unmeasuredBodies).toBeGreaterThan(0);
        expect(unmeasuredBodies).toBeLessThanOrEqual(
            Math.floor((600 + 600 + MIN_CARD_HEIGHT) / MIN_CARD_HEIGHT) + 1,
        );
        expect(unmeasuredBodies + countBySuffix(screen, '-deferred')).toBe(PLACEMENT_COUNT);

        await act(async () => {
            // Real geometry: one full-width card per row, 200px tall.
            ITEM_IDS.forEach((itemId, ordinal) => {
                const placement = screen.tree.root.findAll(
                    (node) => (node.props as { testID?: unknown }).testID === `session-board-placement-${itemId}`,
                    { deep: true },
                ).at(-1);
                (placement?.props as { onLayout?: (event: unknown) => void } | undefined)?.onLayout?.({
                    nativeEvent: { layout: { x: 0, y: ordinal * 200, width: 800, height: 200 } },
                });
            });
        });
        await act(async () => {
            (scroll?.props as { onScroll?: (event: unknown) => void }).onScroll?.({
                nativeEvent: {
                    contentOffset: { y: 200 },
                    contentSize: { width: 800, height: 200 * PLACEMENT_COUNT },
                    layoutMeasurement: { width: 800, height: 600 },
                },
            });
        });
        const before = mountedBodyItemIds(screen);
        // A 600px viewport with one viewport of overscan either side reaches
        // 1800px of a 20000px Board: nine 200px cards, not a hundred.
        expect(before.length).toBeGreaterThan(0);
        expect(before.length).toBeLessThanOrEqual(12);
        expect(before).toContain('note-0');

        await act(async () => {
            (scroll?.props as { onScroll?: (event: unknown) => void }).onScroll?.({
                nativeEvent: {
                    contentOffset: { y: 200 * 40 },
                    contentSize: { width: 800, height: 200 * PLACEMENT_COUNT },
                    layoutMeasurement: { width: 800, height: 600 },
                },
            });
        });

        const after = mountedBodyItemIds(screen);
        // Still bounded, and it is a different set: the window moved with the
        // scroll instead of accumulating every card the person passed.
        expect(after.length).toBeGreaterThan(0);
        expect(after.length).toBeLessThanOrEqual(12);
        expect(after).not.toContain('note-0');
        expect(after).toContain('note-40');
        expect(after.length + countBySuffix(screen, '-deferred')).toBe(PLACEMENT_COUNT);
    });

    it('holds recovered rows to the same window instead of building every one', async () => {
        // A Board whose shared layout places nothing: every readable record is recovered.
        const screen = await renderScreen(<Harness placed={[]} />);
        const scroll = scrollNode(screen);
        expect(scroll).toBeTruthy();

        await act(async () => {
            (scroll?.props as { onLayout?: (event: unknown) => void }).onLayout?.({
                nativeEvent: { layout: { x: 0, y: 0, width: 800, height: 600 } },
            });
        });

        // Recovery is a list like any other: a hundred recovered documents must not all
        // instantiate, and the bound is the surface's own near-viewport window.
        const bodies = countBySuffix(screen, '-declarative');
        expect(bodies).toBeGreaterThan(0);
        expect(bodies).toBeLessThanOrEqual(
            Math.floor((600 + 600 + MIN_CARD_HEIGHT) / MIN_CARD_HEIGHT) + 1,
        );
        expect(bodies + countBySuffix(screen, '-deferred')).toBe(PLACEMENT_COUNT);

        // Real geometry then applies to recovered rows too: after they are measured, a row
        // a viewport away from the scroll position keeps its chrome and drops its body.
        await act(async () => {
            publishLayout(screen, 'session-board-recovered', { x: 0, y: 0, width: 800, height: 200 * PLACEMENT_COUNT });
            publishLayout(screen, 'session-board-recovered-rows', { x: 0, y: 40, width: 800, height: 200 * PLACEMENT_COUNT });
            ITEM_IDS.forEach((itemId, ordinal) => {
                publishLayout(screen, `session-board-recovered-row-${itemId}`, {
                    x: 0, y: ordinal * 200, width: 800, height: 200,
                });
            });
        });

        const measured = mountedBodyItemIds(screen);
        expect(measured).toContain('note-0');
        expect(measured).not.toContain('note-20');
    });

    it('admits a wrapped grid row by its real geometry without waiting for a scroll', async () => {
        // Sixty `compact` cards at the twelve-column tier: three to a row, twenty rows.
        const screen = await renderScreen(<Harness layout="grid" width="compact" present={itemIds(60)} />);
        const scroll = scrollNode(screen);

        await act(async () => {
            (scroll?.props as { onLayout?: (event: unknown) => void }).onLayout?.({
                nativeEvent: { layout: { x: 0, y: 0, width: 1200, height: 600 } },
            });
            publishLayout(screen, 'session-board-items', { x: 0, y: 0, width: 1200, height: 4000 });
        });

        // Nothing is measured yet, so the estimate places card `n` by the minimum card
        // height. Three cards share each row, so the eighteen cards of the first six rows
        // are inside a 600px viewport plus its overscan — a linear estimate would blank them.
        const unmeasuredDeferred = deferredItemIds(screen);
        itemIds(18).forEach((itemId) => expect(unmeasuredDeferred).not.toContain(itemId));

        await act(async () => {
            itemIds(60).forEach((itemId, ordinal) => {
                const row = Math.floor(ordinal / 3);
                publishLayout(screen, `session-board-placement-${itemId}`, {
                    x: (ordinal % 3) * 400, y: row * 200, width: 380, height: 200,
                });
            });
        });

        // Measuring is a geometry change: admission is recomputed there and then, so a card
        // the person can see is never left waiting for an unrelated scroll to build its body.
        const measured = mountedBodyItemIds(screen);
        expect(measured).toContain('note-20');
        expect(measured).not.toContain('note-21');
        expect(measured.length + countBySuffix(screen, '-deferred')).toBe(60);
    });

    it('rebuilds the body window when a responsive reflow moves a measured card into view', async () => {
        // Thirty `compact` cards: one per row in a narrow pane, three per row once it widens.
        const screen = await renderScreen(<Harness layout="grid" width="compact" present={itemIds(30)} />);
        const scroll = scrollNode(screen);

        await act(async () => {
            (scroll?.props as { onLayout?: (event: unknown) => void }).onLayout?.({
                nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 600 } },
            });
            publishLayout(screen, 'session-board-items', { x: 0, y: 0, width: 320, height: 6000 });
        });
        await act(async () => {
            itemIds(30).forEach((itemId, ordinal) => {
                publishLayout(screen, `session-board-placement-${itemId}`, {
                    x: 0, y: ordinal * 200, width: 320, height: 200,
                });
            });
        });
        // Measured at y=1600, more than a viewport below a 600px window.
        expect(deferredItemIds(screen)).toContain('note-8');

        // The pane widens. The same cards wrap three to a row, so this one is now in the
        // third row — on screen at y=400 — and the person has not scrolled.
        await act(async () => {
            (scroll?.props as { onLayout?: (event: unknown) => void }).onLayout?.({
                nativeEvent: { layout: { x: 0, y: 0, width: 1200, height: 600 } },
            });
            publishLayout(screen, 'session-board-items', { x: 0, y: 0, width: 1200, height: 2000 });
        });
        await act(async () => {
            itemIds(30).forEach((itemId, ordinal) => {
                publishLayout(screen, `session-board-placement-${itemId}`, {
                    x: (ordinal % 3) * 400, y: Math.floor(ordinal / 3) * 200, width: 380, height: 200,
                });
            });
        });

        expect(mountedBodyItemIds(screen)).toContain('note-8');
        // A card a viewport below the reflowed grid still waits, so the window moved
        // rather than collapsing into "build everything".
        expect(deferredItemIds(screen)).toContain('note-29');

        // Control: the later scroll must not be what admits it.
        await act(async () => {
            (scroll?.props as { onScroll?: (event: unknown) => void }).onScroll?.({
                nativeEvent: {
                    contentOffset: { y: 96 },
                    contentSize: { width: 1200, height: 2000 },
                    layoutMeasurement: { width: 1200, height: 600 },
                },
            });
        });
        expect(mountedBodyItemIds(screen)).toContain('note-8');
    });
    it('fits a card to a pane too narrow for columns instead of sizing the grid to its content', async () => {
        const screen = await renderScreen(<Harness layout="grid" width="medium" present={itemIds(2)} />);
        const styleOf = () => nodeByTestId(screen, 'session-board-placement-note-0')?.props.style as
            Readonly<{ width?: number; flexBasis?: string }> | undefined;

        await act(async () => {
            publishLayout(screen, 'session-board-items', { x: 0, y: 0, width: 300, height: 600 });
        });
        // A single-column tier fills its row: a wide card (a chart) must not size the wrapping grid past the pane.
        expect(styleOf()).toMatchObject({ flexBasis: '100%' });
        expect(styleOf()?.width).toBeUndefined();

        await act(async () => {
            publishLayout(screen, 'session-board-items', { x: 0, y: 0, width: 1200, height: 600 });
        });
        // Wide enough for columns, the card keeps its measured span.
        expect(styleOf()?.width).toBeGreaterThan(0);
        expect(styleOf()?.flexBasis).toBeUndefined();
    });
});
