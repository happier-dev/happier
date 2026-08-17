import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { getTranscriptNavigationVisibilityStore } from '@/components/sessions/transcript/viewport/visibility/transcriptNavigationVisibilityStore';

import {
    TRANSCRIPT_NAVIGATION_RAIL_PAGE_OVERLAP_PX,
    TRANSCRIPT_NAVIGATION_RAIL_SCROLL_MARGIN_PX,
    TRANSCRIPT_NAVIGATION_RAIL_USER_SCROLL_YIELD_MS,
} from './resolveTranscriptNavigationRailScrollTarget';
import type { TranscriptNavigationEntry } from './transcriptNavigationTypes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({});
});

const SESSION_ID = 'session-overflow';

// Shipped rail geometry for a 240px pane: viewport = floor(240 * 0.8) = 192px,
// markers at a 12px pitch (4px line + 8px gap).
const PANE_HEIGHT_PX = 240;
const VIEWPORT_HEIGHT_PX = 192;
const MARKER_PITCH_PX = 12;
const MARKER_HEIGHT_PX = 4;
const ENTRY_COUNT = 120;
const CONTENT_HEIGHT_PX = (ENTRY_COUNT * MARKER_HEIGHT_PX) + ((ENTRY_COUNT - 1) * 8);
const MAX_SCROLL_TOP_PX = CONTENT_HEIGHT_PX - VIEWPORT_HEIGHT_PX;
const PAGE_STEP_PX = VIEWPORT_HEIGHT_PX - TRANSCRIPT_NAVIGATION_RAIL_PAGE_OVERLAP_PX;

type ScrollToCall = Readonly<{ animated?: boolean; y?: number }>;

function entry(index: number): TranscriptNavigationEntry {
    return {
        createdAtMs: null,
        id: `turn-${index + 1}`,
        kind: 'user-turn',
        label: `Prompt ${index + 1}`,
        loaded: true,
        pinned: false,
        pinnedAtMs: null,
        promptPreview: `Prompt preview ${index + 1}`,
        responsePreview: null,
        role: 'user',
        routeMessageId: `server:message-${index + 1}`,
        seq: index + 1,
        sessionId: SESSION_ID,
        transcriptBlockIndex: null,
    };
}

const longEntries: readonly TranscriptNavigationEntry[] = Array.from({ length: ENTRY_COUNT }, (_, index) => entry(index));
const shortEntries: readonly TranscriptNavigationEntry[] = longEntries.slice(0, 4);

function seedAnchor(currentAnchorId: string | null) {
    getTranscriptNavigationVisibilityStore(SESSION_ID).set({
        currentAnchorId,
        visibleAnchorIds: currentAnchorId ? [currentAnchorId] : [],
    });
}

function flattenStyle(style: unknown): Readonly<Record<string, unknown>> {
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((accumulator, item) => ({
            ...accumulator,
            ...flattenStyle(item),
        }), {});
    }
    if (!style || typeof style !== 'object') return {};
    return style as Readonly<Record<string, unknown>>;
}

async function renderRail(overrides: Readonly<{
    anchorId?: string | null;
    entries?: readonly TranscriptNavigationEntry[];
    paneHeightPx?: number;
    reducedMotion?: boolean;
}> = {}) {
    seedAnchor(overrides.anchorId === undefined ? 'turn-1' : overrides.anchorId);
    const scrollTo = vi.fn<(options: ScrollToCall) => void>();
    const { TranscriptNavigationRail } = await import('./TranscriptNavigationRail');
    const screen = await renderScreen(
        <TranscriptNavigationRail
            entries={overrides.entries ?? longEntries}
            onJumpToEntry={vi.fn()}
            paneHeightPx={overrides.paneHeightPx ?? PANE_HEIGHT_PX}
            paneWidthPx={1000}
            platformOS="web"
            reducedMotion={overrides.reducedMotion === true}
            sessionId={SESSION_ID}
            transcriptContentWidthPx={800}
        />,
        {
            createNodeMock: (element) => (element.type === 'ScrollView' ? { scrollTo } : null),
        },
    );
    return { screen, scrollTo };
}

function lastScrollTo(scrollTo: ReturnType<typeof vi.fn>): ScrollToCall | undefined {
    const call = scrollTo.mock.calls.at(-1);
    return call?.[0] as ScrollToCall | undefined;
}

/**
 * Emits one raw scroll event at `y`. Deliberately not named for an actor: who
 * owns a scroll event is the rail's decision, made from the position it
 * commanded, and a test that pre-labels the event cannot prove that decision.
 */
async function emitRailScrollTo(screen: Awaited<ReturnType<typeof renderRail>>['screen'], y: number) {
    await act(async () => {
        screen.findByTestId('transcript-navigation-rail.scroll')?.props.onScroll?.({
            nativeEvent: { contentOffset: { y } },
        });
    });
}

async function hoverRail(screen: Awaited<ReturnType<typeof renderRail>>['screen'], hovered: boolean) {
    await act(async () => {
        const rail = screen.findByTestId('transcript-navigation-rail');
        const handler = hovered ? rail?.props.onPointerEnter : rail?.props.onPointerLeave;
        handler?.({ nativeEvent: { pointerType: 'mouse' } });
    });
}

// Marker 59 spans 708..712; bringing it into a 192px viewport with the 12px
// margin lands the rail here.
const TURN_60_SCROLL_TOP_PX = (59 * MARKER_PITCH_PX) + MARKER_HEIGHT_PX
    + TRANSCRIPT_NAVIGATION_RAIL_SCROLL_MARGIN_PX - VIEWPORT_HEIGHT_PX;

/**
 * The chevron's pressable box in marker-viewport coordinates (y = 0 at the top
 * of the scrolling marker column), composed from the edge box's own anchor and
 * the chevron's offset inside it.
 *
 * A chevron that fills its box carries no explicit height, so that case is
 * reconstructed from its inset pair rather than read as absent — the point of
 * the assertion is where the press target lands, not which style keys spell it.
 */
function chevronLaneBounds(
    screen: Awaited<ReturnType<typeof renderRail>>['screen'],
    edge: 'top' | 'bottom',
): Readonly<{ topPx: number; bottomPx: number }> {
    const box = flattenStyle(screen.findByTestId(`transcript-navigation-rail.edge.${edge}`)?.props.style);
    const chevron = flattenStyle(screen.findByTestId(`transcript-navigation-rail.chevron.${edge}`)?.props.style);
    const boxHeightPx = Number(box.height);
    const insetTopPx = Number(chevron.top ?? 0);
    const insetBottomPx = Number(chevron.bottom ?? 0);
    const chevronHeightPx = typeof chevron.height === 'number'
        ? chevron.height
        : boxHeightPx - insetTopPx - insetBottomPx;
    // A `top` box is anchored to the viewport top; a `bottom` box is anchored to
    // the viewport bottom, so it resolves through the viewport height.
    const boxTopPx = typeof box.top === 'number'
        ? box.top
        : VIEWPORT_HEIGHT_PX - Number(box.bottom) - boxHeightPx;
    const offsetInBoxPx = typeof chevron.bottom === 'number' && typeof chevron.height === 'number'
        ? boxHeightPx - insetBottomPx - chevronHeightPx
        : insetTopPx;
    const topPx = boxTopPx + offsetInBoxPx;
    return { topPx, bottomPx: topPx + chevronHeightPx };
}

describe('TranscriptNavigationRail overflow affordance', () => {
    it('scrolls the active marker into view when the read anchor moves outside the rail viewport', async () => {
        const { screen, scrollTo } = await renderRail();
        expect(scrollTo).not.toHaveBeenCalled();

        // Marker 59 spans 708..712 while the rail viewport shows 0..192.
        await act(async () => {
            seedAnchor('turn-60');
        });

        expect(lastScrollTo(scrollTo)).toEqual({
            animated: true,
            y: (59 * MARKER_PITCH_PX) + MARKER_HEIGHT_PX + TRANSCRIPT_NAVIGATION_RAIL_SCROLL_MARGIN_PX - VIEWPORT_HEIGHT_PX,
        });

        // The hover preview places itself against the rail's scroll position, so
        // a programmatic scroll must land it on the marker it describes.
        await act(async () => {
            screen.findByTestId('transcript-navigation-rail.marker:turn-60')?.props.onPointerEnter?.({
                nativeEvent: { pointerType: 'mouse' },
            });
        });
        const previewTopPx = flattenStyle(
            screen.findByTestId('transcript-navigation-rail.preview')?.props.style,
        ).top;
        expect(previewTopPx).toBeGreaterThanOrEqual(-VIEWPORT_HEIGHT_PX);
        expect(previewTopPx).toBeLessThanOrEqual(VIEWPORT_HEIGHT_PX);
    });

    it('jumps instantly instead of animating under reduced motion', async () => {
        const { scrollTo } = await renderRail({ reducedMotion: true });

        await act(async () => {
            seedAnchor('turn-60');
        });

        expect(lastScrollTo(scrollTo)?.animated).toBe(false);
    });

    it('does not auto-scroll while the pointer is inside the rail, and catches up once it leaves', async () => {
        const { screen, scrollTo } = await renderRail();

        await act(async () => {
            screen.findByTestId('transcript-navigation-rail')?.props.onPointerEnter?.({
                nativeEvent: { pointerType: 'mouse' },
            });
        });
        await act(async () => {
            seedAnchor('turn-60');
        });
        expect(scrollTo).not.toHaveBeenCalled();

        await act(async () => {
            screen.findByTestId('transcript-navigation-rail')?.props.onPointerLeave?.({
                nativeEvent: { pointerType: 'mouse' },
            });
        });
        expect(scrollTo).toHaveBeenCalledTimes(1);
    });

    it('yields to a user rail scroll for a short window, then resumes tracking the anchor', async () => {
        const { screen, scrollTo } = await renderRail();

        await emitRailScrollTo(screen, 300);
        await act(async () => {
            seedAnchor('turn-60');
        });
        expect(scrollTo).not.toHaveBeenCalled();

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, TRANSCRIPT_NAVIGATION_RAIL_USER_SCROLL_YIELD_MS + 120));
        });

        expect(scrollTo).toHaveBeenCalledTimes(1);
        expect(lastScrollTo(scrollTo)?.y).toBe(
            (59 * MARKER_PITCH_PX) + MARKER_HEIGHT_PX + TRANSCRIPT_NAVIGATION_RAIL_SCROLL_MARGIN_PX - VIEWPORT_HEIGHT_PX,
        );
    });

    it('follows arrow-key focus movement even inside the user-scroll yield window', async () => {
        // Marker 14 ends at 172, inside the 0..180 usable viewport; marker 15
        // ends at 184, just past it.
        const { screen, scrollTo } = await renderRail({ anchorId: 'turn-15' });
        expect(scrollTo).not.toHaveBeenCalled();

        await emitRailScrollTo(screen, 0);
        await act(async () => {
            screen.findByTestId('transcript-navigation-rail.roving-tabstop')?.props.onKeyDown?.({
                key: 'ArrowDown',
                preventDefault: vi.fn(),
            });
        });

        expect(lastScrollTo(scrollTo)?.y).toBe(
            (15 * MARKER_PITCH_PX) + MARKER_HEIGHT_PX + TRANSCRIPT_NAVIGATION_RAIL_SCROLL_MARGIN_PX - VIEWPORT_HEIGHT_PX,
        );
    });

    it('issues one command per anchor move, not one per frame of its own smooth scroll', async () => {
        const { screen, scrollTo } = await renderRail();

        await act(async () => {
            seedAnchor('turn-60');
        });
        expect(scrollTo).toHaveBeenCalledTimes(1);

        // The frames a smooth scroll reports on its way to that target are the
        // rail's own motion; re-deciding from them re-issues the command they
        // came from, once per frame.
        for (const y of [120, 260, 400, 500, TURN_60_SCROLL_TOP_PX]) {
            await emitRailScrollTo(screen, y);
        }

        expect(scrollTo).toHaveBeenCalledTimes(1);
    });

    it('arms the yield for a reader scroll that arrives while its own auto-scroll is still in flight', async () => {
        const { screen, scrollTo } = await renderRail();

        await act(async () => {
            seedAnchor('turn-60');
        });
        expect(lastScrollTo(scrollTo)).toEqual({ animated: true, y: TURN_60_SCROLL_TOP_PX });

        // One genuine frame of that command, then the reader flicks the rail
        // back the other way — away from where it was sent.
        await emitRailScrollTo(screen, 200);
        await emitRailScrollTo(screen, 40);
        scrollTo.mockClear();

        await act(async () => {
            seedAnchor('turn-70');
        });
        expect(scrollTo).not.toHaveBeenCalled();
    });

    it('cancels an in-flight auto-scroll where it stands when the pointer enters the rail', async () => {
        const { screen, scrollTo } = await renderRail();

        await act(async () => {
            seedAnchor('turn-60');
        });
        expect(lastScrollTo(scrollTo)).toEqual({ animated: true, y: TURN_60_SCROLL_TOP_PX });
        await emitRailScrollTo(screen, 180);

        await hoverRail(screen, true);
        // Stopped under the cursor, not carried on to the target.
        expect(lastScrollTo(scrollTo)).toEqual({ animated: false, y: 180 });

        const callCountAfterCancel = scrollTo.mock.calls.length;
        await act(async () => {
            seedAnchor('turn-70');
        });
        expect(scrollTo).toHaveBeenCalledTimes(callCountAfterCancel);
    });

    it('does not cancel a page the reader just asked for when the pointer arrives on the rail', async () => {
        const { screen, scrollTo } = await renderRail();

        await act(async () => {
            screen.findByTestId('transcript-navigation-rail.chevron.bottom')?.props.onPress?.();
        });
        expect(lastScrollTo(scrollTo)).toEqual({ animated: true, y: PAGE_STEP_PX });

        // Pressing a chevron re-renders the rail, and a page that lands against
        // an end unmounts the pressed chevron from under the cursor. The browser
        // re-delivers pointerEnter when it remounts (relatedTarget is gone, so
        // it cannot be recognised as a move within the rail) — which must not
        // undo the move the reader explicitly asked for.
        await hoverRail(screen, true);

        expect(lastScrollTo(scrollTo)).toEqual({ animated: true, y: PAGE_STEP_PX });
    });

    it('schedules no timer per frame while the reader scrolls the rail', async () => {
        const { screen, scrollTo } = await renderRail();

        await emitRailScrollTo(screen, 100);
        await act(async () => {
            seedAnchor('turn-60');
        });
        expect(scrollTo).not.toHaveBeenCalled();

        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
        try {
            for (const y of [140, 180, 220, 260]) {
                await emitRailScrollTo(screen, y);
            }
            expect(setTimeoutSpy).not.toHaveBeenCalled();
        } finally {
            setTimeoutSpy.mockRestore();
        }
    });

    it('re-arms the yield when the reader pages with a chevron', async () => {
        await act(async () => {
            seedAnchor('turn-1');
        });
        const { screen, scrollTo } = await renderRail();

        await act(async () => {
            screen.findByTestId('transcript-navigation-rail.chevron.bottom')?.props.onPress?.();
        });
        expect(lastScrollTo(scrollTo)).toEqual({ animated: true, y: PAGE_STEP_PX });
        scrollTo.mockClear();

        await act(async () => {
            seedAnchor('turn-60');
        });
        expect(scrollTo).not.toHaveBeenCalled();
    });

    it('re-arms the yield when the reader moves keyboard focus', async () => {
        await act(async () => {
            seedAnchor('turn-15');
        });
        const { screen, scrollTo } = await renderRail({ anchorId: 'turn-15' });

        await act(async () => {
            screen.findByTestId('transcript-navigation-rail.roving-tabstop')?.props.onKeyDown?.({
                key: 'End',
                preventDefault: vi.fn(),
            });
        });
        expect(lastScrollTo(scrollTo)).toEqual({ animated: true, y: MAX_SCROLL_TOP_PX });
        scrollTo.mockClear();

        await act(async () => {
            seedAnchor('turn-60');
        });
        expect(scrollTo).not.toHaveBeenCalled();
    });

    it('renders an edge chevron only where the rail actually overflows', async () => {
        const settled = await renderRail({ entries: shortEntries, paneHeightPx: 900 });
        expect(settled.screen.findByTestId('transcript-navigation-rail.chevron.top')).toBeNull();
        expect(settled.screen.findByTestId('transcript-navigation-rail.chevron.bottom')).toBeNull();

        const overflowing = await renderRail({ anchorId: 'turn-1' });
        expect(overflowing.screen.findByTestId('transcript-navigation-rail.chevron.top')).toBeNull();
        expect(overflowing.screen.findByTestId('transcript-navigation-rail.chevron.bottom')).toBeTruthy();

        await emitRailScrollTo(overflowing.screen, 300);
        expect(overflowing.screen.findByTestId('transcript-navigation-rail.chevron.top')).toBeTruthy();
    });

    it('keeps the chevron press lane outside the marker column so no marker loses its hit area', async () => {
        const { screen } = await renderRail();
        // Mid-scroll, so both edges overflow and both chevrons are mounted.
        await emitRailScrollTo(screen, 300);
        // Measured revealed: that is the state in which the chevron accepts the
        // pointer, and it is also exactly when the reader is aiming at markers.
        await hoverRail(screen, true);

        const top = chevronLaneBounds(screen, 'top');
        const bottom = chevronLaneBounds(screen, 'bottom');

        expect(top.bottomPx - top.topPx).toBeGreaterThan(0);
        expect(bottom.bottomPx - bottom.topPx).toBeGreaterThan(0);
        // Markers tile the whole viewport at a contiguous 12px pitch, so every
        // pixel the chevron takes inside 0..viewport is a marker that can no
        // longer be clicked or previewed.
        expect(top.bottomPx).toBeLessThanOrEqual(0);
        expect(bottom.topPx).toBeGreaterThanOrEqual(VIEWPORT_HEIGHT_PX);
    });

    it('keeps the chevron hidden until the rail is hovered or holds keyboard focus', async () => {
        const { screen } = await renderRail();
        const readChevronOpacity = () => flattenStyle(
            screen.findByTestId('transcript-navigation-rail.chevron.bottom')?.props.style,
        ).opacity;

        expect(readChevronOpacity()).toBe(0);

        await act(async () => {
            screen.findByTestId('transcript-navigation-rail')?.props.onPointerEnter?.({
                nativeEvent: { pointerType: 'mouse' },
            });
        });
        expect(readChevronOpacity()).toBe(1);

        await act(async () => {
            screen.findByTestId('transcript-navigation-rail')?.props.onPointerLeave?.({
                nativeEvent: { pointerType: 'mouse' },
            });
        });
        expect(readChevronOpacity()).toBe(0);

        await act(async () => {
            screen.findByTestId('transcript-navigation-rail.roving-tabstop')?.props.onFocus?.({});
        });
        expect(readChevronOpacity()).toBe(1);
    });

    it('pages by one viewport minus an overlap on chevron press and clamps at the ends', async () => {
        const { screen, scrollTo } = await renderRail();

        await act(async () => {
            screen.findByTestId('transcript-navigation-rail.chevron.bottom')?.props.onPress?.();
        });
        expect(lastScrollTo(scrollTo)).toEqual({ animated: true, y: PAGE_STEP_PX });

        await emitRailScrollTo(screen, 40);
        await act(async () => {
            screen.findByTestId('transcript-navigation-rail.chevron.top')?.props.onPress?.();
        });
        expect(lastScrollTo(scrollTo)).toEqual({ animated: true, y: 0 });

        await emitRailScrollTo(screen, MAX_SCROLL_TOP_PX - 10);
        await act(async () => {
            screen.findByTestId('transcript-navigation-rail.chevron.bottom')?.props.onPress?.();
        });
        expect(lastScrollTo(scrollTo)).toEqual({ animated: true, y: MAX_SCROLL_TOP_PX });
    });

    it('keeps the rail on a single tab stop: chevrons never precede the markers in tab order', async () => {
        const { screen } = await renderRail();

        expect(screen.findByTestId('transcript-navigation-rail.roving-tabstop')?.props.tabIndex).toBe(0);
        expect(screen.findByTestId('transcript-navigation-rail.chevron.bottom')?.props.tabIndex).toBe(-1);
        expect(screen.findByTestId('transcript-navigation-rail.marker:turn-1')?.props.tabIndex).toBe(-1);

        const tabbable = screen.findAll((node) => node.props?.tabIndex === 0);
        expect(tabbable).toHaveLength(1);
    });
});
