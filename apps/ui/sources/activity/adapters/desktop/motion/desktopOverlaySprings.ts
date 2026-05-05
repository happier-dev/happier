import {
    DESKTOP_ACTIVITY_OVERLAY_CONTENT_SWAP_DURATION_MS,
    DESKTOP_ACTIVITY_OVERLAY_FADE_OUT_DURATION_MS,
    DESKTOP_ACTIVITY_OVERLAY_READY_BOUNCE_DURATION_MS,
} from '../desktopActivityOverlayTiming';

export type DesktopOverlaySpringSpec = Readonly<{
    kind: 'spring';
    response: number;
    dampingRatio: number;
    durationMs?: number;
}>;

export type DesktopOverlayTimingSpec = Readonly<{
    kind: 'timing';
    initialScale?: number;
    durationMs: number;
}>;

export type DesktopOverlayInstantMotionSpec = Readonly<{
    kind: 'instant';
    durationMs: 0;
}>;

export type DesktopOverlayMotionSpec =
    | DesktopOverlaySpringSpec
    | DesktopOverlayTimingSpec
    | DesktopOverlayInstantMotionSpec;

export const DESKTOP_OVERLAY_OPEN_SPRING: DesktopOverlaySpringSpec = {
    kind: 'spring',
    response: 0.42,
    dampingRatio: 0.8,
};

export const DESKTOP_OVERLAY_CLOSE_SPRING: DesktopOverlaySpringSpec = {
    kind: 'spring',
    response: 0.45,
    dampingRatio: 1,
};

export const DESKTOP_OVERLAY_BOUNCE_SPRING: DesktopOverlaySpringSpec = {
    kind: 'spring',
    response: 0.3,
    dampingRatio: 0.5,
    durationMs: DESKTOP_ACTIVITY_OVERLAY_READY_BOUNCE_DURATION_MS,
};

export const DESKTOP_OVERLAY_CONTENT_SWAP: DesktopOverlayTimingSpec = {
    kind: 'timing',
    initialScale: 0.8,
    durationMs: DESKTOP_ACTIVITY_OVERLAY_CONTENT_SWAP_DURATION_MS,
};

export const DESKTOP_OVERLAY_FADE_OUT: DesktopOverlayTimingSpec = {
    kind: 'timing',
    durationMs: DESKTOP_ACTIVITY_OVERLAY_FADE_OUT_DURATION_MS,
};

const DESKTOP_OVERLAY_INSTANT_MOTION: DesktopOverlayInstantMotionSpec = {
    kind: 'instant',
    durationMs: 0,
};

export type DesktopOverlayMotionKind = 'open' | 'close' | 'bounce' | 'content_swap' | 'fade_out';

export function resolveDesktopOverlayMotionSpec(
    kind: DesktopOverlayMotionKind,
    reducedMotion: boolean,
): DesktopOverlayMotionSpec {
    if (reducedMotion) return DESKTOP_OVERLAY_INSTANT_MOTION;

    if (kind === 'open') return DESKTOP_OVERLAY_OPEN_SPRING;
    if (kind === 'close') return DESKTOP_OVERLAY_CLOSE_SPRING;
    if (kind === 'bounce') return DESKTOP_OVERLAY_BOUNCE_SPRING;
    if (kind === 'fade_out') return DESKTOP_OVERLAY_FADE_OUT;
    return DESKTOP_OVERLAY_CONTENT_SWAP;
}
