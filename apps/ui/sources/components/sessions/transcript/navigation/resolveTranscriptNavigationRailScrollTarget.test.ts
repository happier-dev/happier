import { describe, expect, it } from 'vitest';

import {
    TRANSCRIPT_NAVIGATION_RAIL_COMMAND_IDLE_MS,
    TRANSCRIPT_NAVIGATION_RAIL_PAGE_OVERLAP_PX,
    TRANSCRIPT_NAVIGATION_RAIL_SCROLL_MARGIN_PX,
    classifyTranscriptNavigationRailScrollEvent,
    resolveTranscriptNavigationRailPageScroll,
    resolveTranscriptNavigationRailScrollIntoView,
} from './resolveTranscriptNavigationRailScrollTarget';

// Marker pitch of the shipped rail: a 4px line every 12px.
const MARKER_HEIGHT_PX = 4;
const MARKER_SPACING_PX = 8;
const PITCH_PX = MARKER_HEIGHT_PX + MARKER_SPACING_PX;
const ENTRY_COUNT = 60;
const CONTENT_HEIGHT_PX = (ENTRY_COUNT * MARKER_HEIGHT_PX) + ((ENTRY_COUNT - 1) * MARKER_SPACING_PX);
const VIEWPORT_HEIGHT_PX = 200;
const MAX_SCROLL_TOP_PX = CONTENT_HEIGHT_PX - VIEWPORT_HEIGHT_PX;

function intoView(markerIndex: number, scrollTopPx: number): number | null {
    return resolveTranscriptNavigationRailScrollIntoView({
        contentHeightPx: CONTENT_HEIGHT_PX,
        markerHeightPx: MARKER_HEIGHT_PX,
        markerIndex,
        markerSpacingPx: MARKER_SPACING_PX,
        scrollTopPx,
        viewportHeightPx: VIEWPORT_HEIGHT_PX,
    });
}

describe('resolveTranscriptNavigationRailScrollIntoView', () => {
    it('scrolls up by the minimum distance when the marker sits above the viewport', () => {
        // Marker 10 spans 120..124 while the viewport shows 300..500.
        expect(intoView(10, 300)).toBe((10 * PITCH_PX) - TRANSCRIPT_NAVIGATION_RAIL_SCROLL_MARGIN_PX);
    });

    it('scrolls down by the minimum distance when the marker sits below the viewport', () => {
        // Marker 40 ends at 484 while the viewport shows 100..300.
        const markerBottomPx = (40 * PITCH_PX) + MARKER_HEIGHT_PX;
        expect(intoView(40, 100)).toBe(markerBottomPx + TRANSCRIPT_NAVIGATION_RAIL_SCROLL_MARGIN_PX - VIEWPORT_HEIGHT_PX);
    });

    it('never re-centres: a marker one pitch below the fold moves by roughly one pitch, not half a viewport', () => {
        // The active anchor changes on every turn boundary; centring would slide
        // the whole rail on each change instead of nudging it.
        const scrollTopPx = 300;
        const firstHiddenIndex = Math.ceil((scrollTopPx + VIEWPORT_HEIGHT_PX) / PITCH_PX);
        const next = intoView(firstHiddenIndex, scrollTopPx);
        expect(next).not.toBeNull();
        expect(next! - scrollTopPx).toBeLessThanOrEqual(PITCH_PX + TRANSCRIPT_NAVIGATION_RAIL_SCROLL_MARGIN_PX);
        expect(next! - scrollTopPx).toBeGreaterThan(0);
    });

    it('returns null when the marker is already inside the viewport margin', () => {
        // Marker 30 spans 360..364, comfortably inside 300..500.
        expect(intoView(30, 300)).toBeNull();
    });

    it('clamps to the content start and end instead of overscrolling', () => {
        expect(intoView(0, 400)).toBe(0);
        expect(intoView(ENTRY_COUNT - 1, 0)).toBe(MAX_SCROLL_TOP_PX);
    });

    it('reports no change when the margin cannot be honoured because the rail is already parked at that end', () => {
        // Marker 0 starts at 0, so it can never sit a full margin below the
        // viewport top. Answering "scroll to 0" while already at 0 would make
        // every anchor update on the first turn issue a no-op scroll, leaving a
        // command outstanding that is already at its target — and the reader's
        // very next scroll would be attributed to it.
        expect(intoView(0, 0)).toBeNull();
        expect(intoView(ENTRY_COUNT - 1, MAX_SCROLL_TOP_PX)).toBeNull();
    });

    it('returns null when the content fits the viewport or the marker index is not addressable', () => {
        expect(resolveTranscriptNavigationRailScrollIntoView({
            contentHeightPx: 120,
            markerHeightPx: MARKER_HEIGHT_PX,
            markerIndex: 5,
            markerSpacingPx: MARKER_SPACING_PX,
            scrollTopPx: 0,
            viewportHeightPx: VIEWPORT_HEIGHT_PX,
        })).toBeNull();
        expect(intoView(-1, 300)).toBeNull();
        expect(intoView(Number.NaN, 300)).toBeNull();
        expect(resolveTranscriptNavigationRailScrollIntoView({
            contentHeightPx: CONTENT_HEIGHT_PX,
            markerHeightPx: MARKER_HEIGHT_PX,
            markerIndex: 10,
            markerSpacingPx: MARKER_SPACING_PX,
            scrollTopPx: 300,
            viewportHeightPx: 0,
        })).toBeNull();
    });
});

describe('resolveTranscriptNavigationRailPageScroll', () => {
    function page(direction: 'up' | 'down', scrollTopPx: number): number | null {
        return resolveTranscriptNavigationRailPageScroll({
            contentHeightPx: CONTENT_HEIGHT_PX,
            direction,
            scrollTopPx,
            viewportHeightPx: VIEWPORT_HEIGHT_PX,
        });
    }

    it('pages by one viewport minus a small overlap', () => {
        expect(page('down', 0)).toBe(VIEWPORT_HEIGHT_PX - TRANSCRIPT_NAVIGATION_RAIL_PAGE_OVERLAP_PX);
        expect(page('up', 400)).toBe(400 - (VIEWPORT_HEIGHT_PX - TRANSCRIPT_NAVIGATION_RAIL_PAGE_OVERLAP_PX));
    });

    it('clamps at both ends and reports no change once parked there', () => {
        expect(page('up', 40)).toBe(0);
        expect(page('up', 0)).toBeNull();
        expect(page('down', MAX_SCROLL_TOP_PX - 10)).toBe(MAX_SCROLL_TOP_PX);
        expect(page('down', MAX_SCROLL_TOP_PX)).toBeNull();
    });

    it('returns null when there is nothing to page through', () => {
        expect(resolveTranscriptNavigationRailPageScroll({
            contentHeightPx: 120,
            direction: 'down',
            scrollTopPx: 0,
            viewportHeightPx: VIEWPORT_HEIGHT_PX,
        })).toBeNull();
    });
});

describe('classifyTranscriptNavigationRailScrollEvent', () => {
    const command = { lastEventAtMs: 1_000, positionPx: 0, targetPx: 500, userInitiated: false } as const;

    it('reads a scroll with no outstanding command as the reader moving the rail', () => {
        expect(classifyTranscriptNavigationRailScrollEvent({ atMs: 1_000, command: null, positionPx: 120 }))
            .toEqual({ command: null, origin: 'reader' });
    });

    it('attributes frames converging on the commanded target to the command and tracks their position', () => {
        const first = classifyTranscriptNavigationRailScrollEvent({ atMs: 1_016, command, positionPx: 120 });
        expect(first.origin).toBe('command');
        expect(first.command).toEqual({ lastEventAtMs: 1_016, positionPx: 120, targetPx: 500, userInitiated: false });

        const second = classifyTranscriptNavigationRailScrollEvent({
            atMs: 1_032,
            command: first.command,
            positionPx: 340,
        });
        expect(second.origin).toBe('command');
        expect(second.command?.positionPx).toBe(340);
    });

    it('carries the reader-initiated mark across every frame of the move it belongs to', () => {
        // The rail decides whether to abandon an in-flight move by reading this
        // mark off the outstanding command, so losing it mid-approach would make
        // a reader's own page cancellable again the moment it started.
        const asked = { lastEventAtMs: 1_000, positionPx: 0, targetPx: 500, userInitiated: true } as const;
        const first = classifyTranscriptNavigationRailScrollEvent({ atMs: 1_016, command: asked, positionPx: 120 });
        expect(first.command?.userInitiated).toBe(true);
        const second = classifyTranscriptNavigationRailScrollEvent({
            atMs: 1_032,
            command: first.command,
            positionPx: 340,
        });
        expect(second.command?.userInitiated).toBe(true);
    });

    it('ends the command the moment the target lands, so the next event is the reader again', () => {
        const landed = classifyTranscriptNavigationRailScrollEvent({ atMs: 1_200, command, positionPx: 500 });
        expect(landed).toEqual({ command: null, origin: 'command' });

        expect(classifyTranscriptNavigationRailScrollEvent({ atMs: 1_216, command: landed.command, positionPx: 460 }))
            .toEqual({ command: null, origin: 'reader' });
    });

    it('hands the rail back the instant a position deviates from the approach', () => {
        // Time cannot tell a reader flick from an animation frame; position can:
        // the rail moved further from where it was sent than it already was.
        const inFlight = classifyTranscriptNavigationRailScrollEvent({ atMs: 1_016, command, positionPx: 300 });
        expect(classifyTranscriptNavigationRailScrollEvent({
            atMs: 1_032,
            command: inFlight.command,
            positionPx: 240,
        })).toEqual({ command: null, origin: 'reader' });
    });

    it('tolerates sub-pixel jitter within a converging approach', () => {
        const jittered = classifyTranscriptNavigationRailScrollEvent({
            atMs: 1_016,
            command: { lastEventAtMs: 1_000, positionPx: 300, targetPx: 500, userInitiated: false },
            positionPx: 299.75,
        });
        expect(jittered.origin).toBe('command');
    });

    it('stops swallowing the reader once a command has gone silent past the idle bound', () => {
        expect(classifyTranscriptNavigationRailScrollEvent({
            atMs: 1_000 + TRANSCRIPT_NAVIGATION_RAIL_COMMAND_IDLE_MS + 1,
            command,
            positionPx: 120,
        })).toEqual({ command: null, origin: 'reader' });
    });
});
