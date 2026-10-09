import {
    clampCompanionPoint,
    resolveFloatingFrameRect,
    type CompanionReleaseMotion,
    type CompanionDragBounds,
    type CompanionPoint,
    type FrameRect,
} from '@happier-dev/plugin-ui/presentation';
import { VOICE_MOTION } from '@/components/voice/light/voiceLightTokens';

/** Measured floating-presence bounds; both Island and Orb use this geometry. */
export const VOICE_ORB_EDGE = 14;
/** The lab's resting inset. Production adds safe-area + bottom chrome on top of it. */
export const VOICE_ORB_BOTTOM = 34;
/** The orb clears the bottom chrome by this much before it starts. */
export const VOICE_ORB_CHROME_GAP = 12;
/** Breathing room between the pet's sprite and the orb when both companions are present. */
export const VOICE_ORB_PET_GAP = 12;
/** The orb is a corner companion, not a header ornament: it never climbs past this. */
export const VOICE_ORB_MIN_TOP = 60;

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
 * resolves the inset, and `resolveVoicePresenceGeometry` turns it into a point. Nothing else may
 * re-derive it.
 */
export function resolveVoiceOrbRestingBottomInset(chrome: VoiceOrbBottomChrome): number {
    return nonNegative(chrome.safeAreaBottom)
        + Math.max(nonNegative(chrome.bottomChromeHeight), nonNegative(chrome.keyboardHeight))
        + nonNegative(chrome.composerChromeHeight)
        + VOICE_ORB_CHROME_GAP
        + nonNegative(chrome.petOffset);
}

/** Shared measured shell space for a viewer or presence; chrome custody stays in the shell. */
export function resolveVoicePresenceAvailableRect(input: Readonly<{
    hostWidth: number;
    hostHeight: number;
    restingBottomInset: number;
    edgeInset: number;
    minimumTop: number;
    bottomMargin?: number;
}>): FrameRect {
    const right = Math.max(0, input.hostWidth - nonNegative(input.edgeInset));
    const bottom = Math.max(0, input.hostHeight - nonNegative(input.restingBottomInset) - nonNegative(input.bottomMargin ?? 0));
    const x = Math.min(right, nonNegative(input.edgeInset));
    const y = Math.min(bottom, nonNegative(input.minimumTop));
    return { x, y, width: right - x, height: bottom - y };
}

/** Measured interaction bounds shared by Island and Orb; chrome/keyboard custody stays in the shell. */
export function resolveVoicePresenceGeometry(input: Readonly<{
    hostWidth: number;
    hostHeight: number;
    containerWidth: number;
    containerHeight: number;
    restingBottomInset: number;
    edgeInset?: number;
    minimumTop?: number;
    bottomMargin?: number;
    /** Current viewer measurement, withdrawn by its owner when docked or closed. */
    viewerRect?: FrameRect | null;
    /** Other current shell companions, including a floating Island or pet. */
    avoidRects?: readonly FrameRect[];
    restCentred?: boolean;
}>): Readonly<{ restingPoint: CompanionPoint; dragBounds: CompanionDragBounds; availableRect: FrameRect; fits: boolean }> {
    const maxX = Math.max(0, input.hostWidth - nonNegative(input.edgeInset ?? VOICE_ORB_EDGE) - nonNegative(input.containerWidth));
    const maxY = Math.max(0, input.hostHeight - nonNegative(input.restingBottomInset)
        - nonNegative(input.bottomMargin ?? VOICE_ORB_BOTTOM) - nonNegative(input.containerHeight));
    const minX = Math.min(maxX, nonNegative(input.edgeInset ?? VOICE_ORB_EDGE));
    const minY = Math.min(maxY, nonNegative(input.minimumTop ?? VOICE_ORB_MIN_TOP));
    const availableRect = resolveVoicePresenceAvailableRect({
        ...input,
        edgeInset: input.edgeInset ?? VOICE_ORB_EDGE,
        minimumTop: input.minimumTop ?? VOICE_ORB_MIN_TOP,
        bottomMargin: input.bottomMargin ?? VOICE_ORB_BOTTOM,
    });
    const placement = resolveFloatingFrameRect({
        rect: { x: input.restCentred ? (minX + maxX) / 2 : maxX, y: maxY,
            width: nonNegative(input.containerWidth), height: nonNegative(input.containerHeight) },
        availableRect,
        avoidRects: input.viewerRect ? [...(input.avoidRects ?? []), input.viewerRect] : input.avoidRects,
    });
    return {
        restingPoint: { x: placement.rect.x, y: placement.rect.y },
        dragBounds: { minX, maxX, minY, maxY },
        availableRect,
        fits: placement.fits && input.containerWidth <= availableRect.width && input.containerHeight <= availableRect.height,
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
 * Where a released container lands, for native gestures and web pointers.
 *
 * Horizontal snaps to the nearer edge using the **projected** landing point, so a flick lands where
 * it was aimed rather than where the finger left; the Island also offers centre/top/bottom anchors.
 * The Orb retains its freely clamped vertical position. One owner for both
 * platforms: an orb that snapped to the right edge under a finger and to the left under a mouse
 * would be two different objects wearing the same paint.
 */
export function resolveVoicePresenceReleaseTarget(input: Readonly<{
    projected: CompanionPoint;
    bounds: CompanionDragBounds;
    anchors?: 'orb' | 'island';
    containerSize?: Readonly<{ width: number; height: number }>;
    avoidRects?: readonly FrameRect[];
}>): CompanionPoint {
    'worklet';
    const midpoint = (input.bounds.minX + input.bounds.maxX) / 2;
    let point: CompanionPoint;
    if (input.anchors === 'island') {
        const centreDistance = Math.abs(input.projected.x - midpoint);
        const edge = input.projected.x < midpoint ? input.bounds.minX : input.bounds.maxX;
        point = {
            x: centreDistance <= Math.abs(input.projected.x - edge) ? midpoint : edge,
            y: input.projected.y < (input.bounds.minY + input.bounds.maxY) / 2
                ? input.bounds.minY : input.bounds.maxY,
        };
    } else {
        point = {
            x: input.projected.x < midpoint ? input.bounds.minX : input.bounds.maxX,
            y: Math.min(input.bounds.maxY, Math.max(input.bounds.minY, input.projected.y)),
        };
    }
    if (!input.containerSize || !input.avoidRects?.length) return point;
    const { width, height } = input.containerSize;
    const placement = resolveFloatingFrameRect({
        rect: { ...point, width, height },
        availableRect: { x: input.bounds.minX, y: input.bounds.minY,
            width: input.bounds.maxX - input.bounds.minX + width,
            height: input.bounds.maxY - input.bounds.minY + height },
        avoidRects: input.avoidRects,
    });
    return { x: placement.rect.x, y: placement.rect.y };
}

/** Additional composer clearance from the measured Island rect above the shell's bottom band. */
export function resolveVoicePresenceBottomReservation(input: Readonly<{
    hostHeight: number;
    point: CompanionPoint;
    containerHeight: number;
    bottomChromeInset: number;
    dockedBottom: boolean;
}>): number {
    if (!input.dockedBottom || input.containerHeight <= 0) return 0;
    return nonNegative(input.hostHeight - input.point.y - nonNegative(input.bottomChromeInset));
}

/** Keeps a dragged orb inside its host. Shared by both platform drag paths. */
export function clampVoicePresencePoint(
    point: CompanionPoint,
    bounds: CompanionDragBounds,
): CompanionPoint {
    'worklet';
    return clampCompanionPoint(point, bounds);
}
