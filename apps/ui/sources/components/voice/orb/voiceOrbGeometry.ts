import type { CompanionReleaseMotion } from '@/components/companion/interaction/companionReleaseMotion';
import type {
    CompanionDragBounds,
    CompanionPoint,
} from '@/components/companion/interaction/useCompanionNativePanGesture';
import { VOICE_MOTION } from '@/components/voice/light/voiceLightTokens';

/**
 * Reference geometry for the floating Voice orb (§2.2).
 *
 * These are **default-scale target dimensions**, not clipping contracts: the sheet's real height is
 * content-derived and clamped to the available space, and it never truncates the way out of a
 * conversation.
 */
/** Collapsed diameter. Expanded is the same object scaled, never a second one. */
export const VOICE_ORB_SIZE = 34;
export const VOICE_ORB_EXPANDED_SCALE = 2.7;
/**
 * Bottom-sheet reference height at default theme and default text size.
 *
 * A **floor**, never a ceiling and never a clipping contract: `resolveVoiceOrbSheetLayout` grows the
 * sheet for content that needs more and clamps it to what the viewport, safe area and keyboard
 * actually leave.
 */
export const VOICE_ORB_SHEET_HEIGHT = 236;
/** How far below the sheet's top edge the docked planet's centre-line sits. */
export const VOICE_ORB_DOCK_INSET = 10;
/** Between the docked planet's lower limb and the status word. */
export const VOICE_ORB_DOCK_CAPTION_GAP = 12;
export const VOICE_ORB_BAR_RADIUS = 24;
export const VOICE_ORB_EDGE = 14;
/** The lab's resting inset. Production adds safe-area + bottom chrome on top of it. */
export const VOICE_ORB_BOTTOM = 34;
/**
 * `DESIGN.md:445` requires at least 44×44pt (iOS) / 48×48dp (Android). The visual orb stays 34pt,
 * so the pressable is a transparent expansion around the body.
 */
export const VOICE_ORB_HIT_TARGET = 48;
/** The visual planet is centred inside the physical interaction target. */
export const VOICE_ORB_INTERACTION_INSET = (VOICE_ORB_HIT_TARGET - VOICE_ORB_SIZE) / 2;
/** A decisive upward flick opens the sheet; there is no chevron. */
export const VOICE_ORB_SWIPE_OPEN_VELOCITY = -700;
/** Held, the orb grows 6%. */
export const VOICE_ORB_DRAG_LIFT_SCALE = 0.06;
/** The orb clears the bottom chrome by this much before it starts. */
export const VOICE_ORB_CHROME_GAP = 12;
/** Breathing room between the pet's sprite and the orb when both companions are present. */
export const VOICE_ORB_PET_GAP = 12;
/** The orb is a corner companion, not a header ornament: it never climbs past this. */
export const VOICE_ORB_MIN_TOP = 60;

export type VoiceOrbRect = Readonly<{ x: number; y: number; width: number; height: number }>;

/**
 * Everything anchored to the bottom of the app shell that the orb has to stay out of (§6.4).
 *
 * Two separate bands live down there and only one of them is the tab bar. The mobile bottom chrome
 * (`useSessionCockpitBottomChromeHeight`) floats over content and reserves nothing; the session
 * composer floats **directly above it**, in the session screen's own reservation. An orb that only
 * subtracts the tab bar therefore lands squarely on Send.
 */
export type VoiceOrbBottomChrome = Readonly<{
    /** Home-indicator / gesture inset. */
    safeAreaBottom: number;
    /** The floating mobile tab bar or cockpit bar. */
    bottomChromeHeight: number;
    /** The session composer band that floats above the tab bar. `0` when no composer is on screen. */
    composerChromeHeight: number;
    /**
     * The soft keyboard, above the safe-area inset.
     *
     * It **replaces** the tab bar rather than stacking on it: the mobile bottom chrome collapses to
     * `0` while the keyboard is up and the composer lifts to sit directly on the keyboard. An inset
     * that only summed the published chrome therefore dropped the orb onto the keyboard the moment
     * the user started typing — End Voice and every recovery action underneath it.
     */
    keyboardHeight: number;
    /** Vertical room a pet companion already occupies in the same corner. */
    petOffset: number;
}>;

function nonNegative(value: number): number {
    return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * How far above the host's bottom edge the orb's resting band begins.
 *
 * Single owner for the resting policy: the app-shell mount composes the measured chrome, this
 * resolves the inset, and `resolveVoiceOrbRestingCorner` turns it into a point. Nothing else may
 * re-derive it.
 */
export function resolveVoiceOrbRestingBottomInset(chrome: VoiceOrbBottomChrome): number {
    return nonNegative(chrome.safeAreaBottom)
        + Math.max(nonNegative(chrome.bottomChromeHeight), nonNegative(chrome.keyboardHeight))
        + nonNegative(chrome.composerChromeHeight)
        + VOICE_ORB_CHROME_GAP
        + nonNegative(chrome.petOffset);
}

/**
 * Vertical room the docked planet needs at the top of the sheet before content can start.
 *
 * Derived from the dock rather than typed in: the planet scales about its own centre, so it grows
 * `(SIZE × (SCALE − 1)) / 2` below the dock line as well as above it, and the status word starts one
 * caption gap under its lower limb.
 */
export const VOICE_ORB_DOCK_HEADROOM =
    VOICE_ORB_DOCK_INSET
    + VOICE_ORB_SIZE
    + (VOICE_ORB_SIZE * (VOICE_ORB_EXPANDED_SCALE - 1)) / 2
    + VOICE_ORB_DOCK_CAPTION_GAP;

/**
 * What the sheet is actually asked to hold, measured rather than assumed (§2.7).
 *
 * `captionHeight` is the only part that may be cut; `barHeight` carries End Voice, recovery and
 * every contextual action, so it is pinned.
 */
export type VoiceOrbSheetContent = Readonly<{
    /** Natural height of the status + caption block. `0` until it has laid out once. */
    captionHeight: number;
    /** Natural height of the transport bar. `0` until it has laid out once. */
    barHeight: number;
    /** Safe-area + chrome padding beneath the bar. */
    bottomPadding: number;
}>;

export type VoiceOrbSheetLayout = Readonly<{
    /** `min(desired, available)` — §2.7's rule, with `236` as the default-scale floor. */
    height: number;
    /** Ceiling for the sheet's single internal scroll owner. */
    captionMaxHeight: number;
    /** The content did not fit: the one scroll owner has to take over. */
    scrolls: boolean;
}>;

/**
 * The sheet's real height, and how much of it the scrollable region may take.
 *
 * `236` is a default-scale target: a long translation, 200% web text or Dynamic Type makes the
 * status and caption taller, and a short viewport or an open keyboard makes the available space
 * smaller. Both move independently, so the height is resolved from measured content clamped to
 * measured space — and the part that gives way is always the caption, never the way out.
 */
export function resolveVoiceOrbSheetLayout(input: Readonly<{
    availableHeight: number;
    content: VoiceOrbSheetContent;
}>): VoiceOrbSheetLayout {
    const captionHeight = nonNegative(input.content.captionHeight);
    const barHeight = nonNegative(input.content.barHeight);
    const bottomPadding = nonNegative(input.content.bottomPadding);
    const reserved = VOICE_ORB_DOCK_HEADROOM + barHeight + bottomPadding;
    const desiredHeight = Math.max(VOICE_ORB_SHEET_HEIGHT, reserved + captionHeight);
    const availableHeight = nonNegative(input.availableHeight);
    // An unmeasured host reports `0`; falling back to the desired height keeps the sheet usable for
    // the frame before layout lands instead of collapsing it to nothing.
    const height = availableHeight > 0 ? Math.min(desiredHeight, availableHeight) : desiredHeight;
    // Asked against the two heights rather than against the caption ceiling: they come from the
    // same `min`, so "it did not fit" cannot disagree with itself over a sub-pixel remainder.
    const scrolls = height < desiredHeight;
    const room = Math.max(0, height - reserved);
    return {
        height,
        // When the sheet grew to fit, the ceiling is the content itself: the same sub-pixel
        // remainder must not clip the last line the growth was for.
        captionMaxHeight: scrolls ? room : Math.max(room, captionHeight),
        scrolls,
    };
}

/** The orb's resting top-left corner inside its host, in host coordinates. */
export function resolveVoiceOrbRestingCorner(input: Readonly<{
    hostWidth: number;
    hostHeight: number;
    restingBottomInset: number;
}>): Readonly<{ x: number; y: number }> {
    return {
        x: Math.max(VOICE_ORB_EDGE, input.hostWidth - VOICE_ORB_EDGE - VOICE_ORB_SIZE),
        y: Math.max(
            VOICE_ORB_MIN_TOP,
            input.hostHeight - (input.restingBottomInset + VOICE_ORB_BOTTOM) - VOICE_ORB_SIZE,
        ),
    };
}

/**
 * The rect a tap actually lands in — deliberately **larger** than the orb (§2.6).
 *
 * The 34pt planet is centred in a physical 48pt target, so clearing the composer means moving this
 * rect, never shrinking it.
 */
export function resolveVoiceOrbHitRect(input: Readonly<{
    hostWidth: number;
    hostHeight: number;
    restingBottomInset: number;
}>): VoiceOrbRect {
    const corner = resolveVoiceOrbRestingCorner(input);
    return {
        x: corner.x - VOICE_ORB_INTERACTION_INSET,
        y: corner.y - VOICE_ORB_INTERACTION_INSET,
        width: VOICE_ORB_HIT_TARGET,
        height: VOICE_ORB_HIT_TARGET,
    };
}

/**
 * Physical interaction-frame geometry for the always-mounted Orb.
 *
 * Dragging and docking move the 48pt target, while the 34pt planet remains centred inside it. All
 * positions are shifted by the same canonical inset, preserving the planet's existing resting,
 * edge-clamp and docked coordinates without relying on clipped `hitSlop`.
 */
export function resolveVoiceOrbInteractionGeometry(input: Readonly<{
    hostWidth: number;
    hostHeight: number;
    restingBottomInset: number;
    sheetHeight: number;
}>): Readonly<{
    restingPoint: CompanionPoint;
    dockedPoint: CompanionPoint;
    dragBounds: CompanionDragBounds;
}> {
    const restingRect = resolveVoiceOrbHitRect(input);
    return {
        restingPoint: { x: restingRect.x, y: restingRect.y },
        dockedPoint: {
            x: (input.hostWidth - VOICE_ORB_SIZE) / 2 - VOICE_ORB_INTERACTION_INSET,
            y: input.hostHeight
                - input.sheetHeight
                + VOICE_ORB_DOCK_INSET
                - VOICE_ORB_INTERACTION_INSET,
        },
        dragBounds: {
            minX: VOICE_ORB_EDGE - VOICE_ORB_INTERACTION_INSET,
            maxX: restingRect.x,
            minY: VOICE_ORB_MIN_TOP - VOICE_ORB_INTERACTION_INSET,
            maxY: restingRect.y,
        },
    };
}

/**
 * Z-index band for the orb — `90_000` is already contended three ways.
 *
 * | Layer                                            | z-index            |
 * |--------------------------------------------------|--------------------|
 * | Modal content                                    | 100001+            |
 * | Modal backdrop                                   | 100000 (+10/stack) |
 * | Onboarding wizard (web fixed)                    | 100000             |
 * | `ModalProvider`'s `OverlayPortalHost`            | 90000              |
 * | Web pet companion                                | 90000              |
 * | **Voice orb**                                    | **80000**          |
 * | Theme transition                                 | 9999               |
 *
 * Above all app chrome, below popovers and modals: a popover the user opened must cover the orb,
 * and a modal must always win.
 */
export const VOICE_ORB_Z_INDEX = 80_000;

/**
 * The orb settles; it does not bounce (§2.2).
 *
 * `dampingRatio: 1` is the no-overshoot boundary, so the bounce is removed at its source rather
 * than clipped — clamping stops the overshoot by cutting the curve, which puts a hard edge on the
 * final milliseconds. The release velocity is still carried into the spring per axis: removing
 * bounce must not remove continuity.
 */
export const VOICE_ORB_RELEASE_MOTION: CompanionReleaseMotion = Object.freeze({
    durationMs: VOICE_MOTION.settle.durationMs,
    dampingRatio: VOICE_MOTION.settle.dampingRatio,
    overshootClamping: false,
    carryVelocity: true,
    projectionSeconds: VOICE_MOTION.throwProjectionSeconds,
});

/** Web DOM hooks for the shared companion pointer-drag session. */
export const VOICE_ORB_POINTER_DRAG_SELECTORS = Object.freeze({
    noDrag: '[data-voice-orb-no-drag="true"], .no-drag',
    handle: '[data-voice-orb="true"]',
});

/**
 * Where a released orb lands, for both the native gesture and the web pointer session.
 *
 * Horizontal snaps to the nearer edge using the **projected** landing point, so a flick lands where
 * it was aimed rather than where the finger left; vertical only clamps. One owner for both
 * platforms: an orb that snapped to the right edge under a finger and to the left under a mouse
 * would be two different objects wearing the same paint.
 */
export function resolveVoiceOrbReleaseTarget(input: Readonly<{
    projected: CompanionPoint;
    bounds: CompanionDragBounds;
}>): CompanionPoint {
    'worklet';
    const midpoint = (input.bounds.minX + input.bounds.maxX) / 2;
    return {
        x: input.projected.x < midpoint ? input.bounds.minX : input.bounds.maxX,
        y: Math.min(input.bounds.maxY, Math.max(input.bounds.minY, input.projected.y)),
    };
}

/** Keeps a dragged orb inside its host. Shared by both platform drag paths. */
export function clampVoiceOrbPoint(
    point: CompanionPoint,
    bounds: CompanionDragBounds,
): CompanionPoint {
    'worklet';
    return {
        x: Math.min(bounds.maxX, Math.max(bounds.minX, point.x)),
        y: Math.min(bounds.maxY, Math.max(bounds.minY, point.y)),
    };
}
