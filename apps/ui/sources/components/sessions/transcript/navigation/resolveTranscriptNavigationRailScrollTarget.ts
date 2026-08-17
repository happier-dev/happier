import { resolveScrollOffsetForVisibleRect } from '@/components/ui/scroll/useScrollRectIntoView';

/**
 * Breathing room kept between the addressed marker and the rail's viewport
 * edge: one marker pitch (4px line + 8px gap), so the marker always lands with
 * a neighbouring slot of context beside it instead of flush under the fade.
 */
export const TRANSCRIPT_NAVIGATION_RAIL_SCROLL_MARGIN_PX = 12;

/**
 * How much of the outgoing page an edge chevron keeps on screen: two marker
 * pitches, enough for the reader to see where the previous page ended without
 * spending a meaningful fraction of a short rail viewport.
 */
export const TRANSCRIPT_NAVIGATION_RAIL_PAGE_OVERLAP_PX = 24;

/**
 * How long the rail stops following the read anchor after the reader scrolls it
 * themselves. Long enough that a deliberate flick to inspect another part of the
 * session is not yanked back mid-read, short enough that the rail is tracking
 * again well before the reader finishes the turn they scrolled away to find.
 */
export const TRANSCRIPT_NAVIGATION_RAIL_USER_SCROLL_YIELD_MS = 1_500;

/**
 * Safety net, not a classifier: how long a commanded scroll may stay outstanding
 * without the scroller reporting a single frame before the rail stops
 * attributing events to it. A running smooth scroll reports continuously — one
 * event per animation frame — so an actual animation never reaches this bound;
 * it only releases a command the platform silently dropped, which would
 * otherwise swallow the reader's next converging scroll forever. Fifteen frames
 * at 60Hz: far above any plausible frame gap, far below the yield window it
 * protects.
 */
export const TRANSCRIPT_NAVIGATION_RAIL_COMMAND_IDLE_MS = 250;

/** Scroll offsets are fractional on high-DPI and zoomed viewports. */
const SCROLL_POSITION_EPSILON_PX = 0.5;

/**
 * A scroll this component asked for: where it sent the rail, and how far that
 * move has got. Held for exactly as long as the move is still running.
 */
export type TranscriptNavigationRailScrollCommand = Readonly<{
    /** When the command was issued, then when the last frame attributed to it arrived. */
    lastEventAtMs: number;
    /** Where the rail was when the command was issued, then the last position attributed to it. */
    positionPx: number;
    targetPx: number;
    /**
     * Whether the reader asked for this move (a chevron press, arrow keys) as
     * opposed to the rail following the read anchor. A move the reader asked for
     * is not interrupted by their pointer arriving on the rail: that guard
     * exists to stop the rail sliding under a resting cursor, and the cursor is
     * already on the rail when they press a chevron.
     */
    userInitiated: boolean;
}>;

export type TranscriptNavigationRailScrollEventOrigin = 'command' | 'reader';

export type ClassifyTranscriptNavigationRailScrollEventResult = Readonly<{
    /** The command still running after this event, or `null` once it is over. */
    command: TranscriptNavigationRailScrollCommand | null;
    origin: TranscriptNavigationRailScrollEventOrigin;
}>;

/**
 * The one answer to "was this scroll event mine or the reader's?".
 *
 * It is decided from position, never from elapsed time: an event belongs to the
 * outstanding command only while the rail is still closing on the target that
 * command named. The moment the position stops approaching it — or the target
 * lands — the command is over and the rail is the reader's again. Time cannot
 * tell a reader's flick from an animation frame, because both happen in the same
 * milliseconds; the commanded target can.
 */
export function classifyTranscriptNavigationRailScrollEvent(input: Readonly<{
    atMs: number;
    command: TranscriptNavigationRailScrollCommand | null;
    positionPx: number;
}>): ClassifyTranscriptNavigationRailScrollEventResult {
    const command = input.command;
    if (!command) return { command: null, origin: 'reader' };
    if (input.atMs - command.lastEventAtMs > TRANSCRIPT_NAVIGATION_RAIL_COMMAND_IDLE_MS) {
        return { command: null, origin: 'reader' };
    }

    const remainingPx = Math.abs(input.positionPx - command.targetPx);
    if (remainingPx > Math.abs(command.positionPx - command.targetPx) + SCROLL_POSITION_EPSILON_PX) {
        return { command: null, origin: 'reader' };
    }
    if (remainingPx <= SCROLL_POSITION_EPSILON_PX) {
        return { command: null, origin: 'command' };
    }
    return {
        command: {
            lastEventAtMs: input.atMs,
            positionPx: input.positionPx,
            targetPx: command.targetPx,
            userInitiated: command.userInitiated,
        },
        origin: 'command',
    };
}

export type TranscriptNavigationRailScrollGeometry = Readonly<{
    contentHeightPx: number;
    markerHeightPx: number;
    markerSpacingPx: number;
    scrollTopPx: number;
    viewportHeightPx: number;
}>;

export type ResolveTranscriptNavigationRailScrollIntoViewInput = TranscriptNavigationRailScrollGeometry & Readonly<{
    marginPx?: number;
    markerIndex: number;
}>;

export type ResolveTranscriptNavigationRailPageScrollInput = Readonly<{
    contentHeightPx: number;
    direction: 'up' | 'down';
    overlapPx?: number;
    scrollTopPx: number;
    viewportHeightPx: number;
}>;

function finiteNonNegative(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Minimum-distance scroll offset that brings a rail marker inside the rail
 * viewport, or `null` when it is already there.
 *
 * The rail's marker geometry is a pure function of the entry index and the
 * layout owner's pitch, so this never measures the DOM. Alignment is
 * deliberately `nearest`, never `center`: the active anchor changes at every
 * turn boundary while the reader scrolls the transcript, and re-centring on
 * each change would make the rail slide continuously under the cursor.
 */
export function resolveTranscriptNavigationRailScrollIntoView(
    input: ResolveTranscriptNavigationRailScrollIntoViewInput,
): number | null {
    if (!Number.isFinite(input.markerIndex) || input.markerIndex < 0) return null;
    const markerIndex = Math.trunc(input.markerIndex);
    const markerHeightPx = finiteNonNegative(input.markerHeightPx, 0);
    const markerSpacingPx = finiteNonNegative(input.markerSpacingPx, 0);
    const viewportHeightPx = finiteNonNegative(input.viewportHeightPx, 0);
    const contentHeightPx = finiteNonNegative(input.contentHeightPx, 0);
    if (viewportHeightPx <= 0 || contentHeightPx <= viewportHeightPx) return null;

    const scrollTopPx = finiteNonNegative(input.scrollTopPx, 0);
    const nextScrollTopPx = resolveScrollOffsetForVisibleRect({
        alignment: 'nearest',
        metrics: {
            contentHeight: contentHeightPx,
            offsetY: scrollTopPx,
            viewportHeight: viewportHeightPx,
        },
        padding: finiteNonNegative(input.marginPx, TRANSCRIPT_NAVIGATION_RAIL_SCROLL_MARGIN_PX),
        rect: {
            height: markerHeightPx,
            y: markerIndex * (markerHeightPx + markerSpacingPx),
        },
    });
    // The shared geometry helper answers with a clamped offset even when the
    // margin simply cannot be honoured — the first and last markers can never
    // clear it. Collapse that to "no change" so callers are not asked to
    // re-issue the position they already hold.
    return nextScrollTopPx === scrollTopPx ? null : nextScrollTopPx;
}

/**
 * Scroll offset one viewport further in `direction`, minus a small overlap, or
 * `null` when the rail is already parked against that end.
 */
export function resolveTranscriptNavigationRailPageScroll(
    input: ResolveTranscriptNavigationRailPageScrollInput,
): number | null {
    const viewportHeightPx = finiteNonNegative(input.viewportHeightPx, 0);
    const contentHeightPx = finiteNonNegative(input.contentHeightPx, 0);
    const maxScrollTopPx = Math.max(0, contentHeightPx - viewportHeightPx);
    if (viewportHeightPx <= 0 || maxScrollTopPx <= 0) return null;

    const overlapPx = finiteNonNegative(input.overlapPx, TRANSCRIPT_NAVIGATION_RAIL_PAGE_OVERLAP_PX);
    const stepPx = Math.max(1, viewportHeightPx - Math.min(overlapPx, viewportHeightPx - 1));
    const scrollTopPx = Math.min(maxScrollTopPx, finiteNonNegative(input.scrollTopPx, 0));
    const nextScrollTopPx = Math.max(
        0,
        Math.min(maxScrollTopPx, scrollTopPx + (input.direction === 'up' ? -stepPx : stepPx)),
    );
    return nextScrollTopPx === scrollTopPx ? null : nextScrollTopPx;
}
