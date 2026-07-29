import * as React from 'react';
import { Platform } from 'react-native';

import { isCoarsePrimaryPointerEnvironment } from '@/utils/platform/webMobileHeuristics';

const PRIMARY_POINTER_MEDIA_QUERY = '(pointer: coarse)';

type MediaQueryListLike = Readonly<{
    addEventListener?: (event: 'change', listener: () => void) => void;
    addListener?: (listener: () => void) => void;
}>;

type WindowLike = Readonly<{ matchMedia?: (query: string) => MediaQueryListLike }>;

let coarsePrimaryPointer: boolean | null = null;
let pointerCapabilityWatchStarted = false;

/**
 * One module-scope listener invalidates the cache when the host's primary
 * pointer changes — a convertible switching between laptop and tablet mode. Per
 * row this would be hundreds of listeners for one host property, so rows pick
 * the new capability up on their next render instead of being notified.
 */
function startPointerCapabilityWatch(): void {
    if (pointerCapabilityWatchStarted) return;
    pointerCapabilityWatchStarted = true;
    const maybeWindow = (globalThis as { window?: WindowLike }).window;
    if (typeof maybeWindow?.matchMedia !== 'function') return;
    let query: MediaQueryListLike;
    try {
        query = maybeWindow.matchMedia(PRIMARY_POINTER_MEDIA_QUERY);
    } catch {
        // Hosts without pointer-media support keep the first resolved value.
        return;
    }
    const invalidate = (): void => {
        coarsePrimaryPointer = null;
    };
    if (typeof query.addEventListener === 'function') {
        query.addEventListener('change', invalidate);
        return;
    }
    query.addListener?.(invalidate);
}

/**
 * Resolves the primary-pointer capability once per host capability change
 * instead of once per transcript row: the media query result is a host
 * property, and evaluating `matchMedia` inside every row render would be pure
 * churn on long transcripts.
 */
export function readCoarsePrimaryPointer(): boolean {
    if (Platform.OS !== 'web') return false;
    startPointerCapabilityWatch();
    if (coarsePrimaryPointer === null) {
        coarsePrimaryPointer = isCoarsePrimaryPointerEnvironment();
    }
    return coarsePrimaryPointer;
}

export type RowActionHoverHost = Readonly<{
    isHovered: boolean;
    hoverProps: Readonly<{
        onPointerEnter: () => void;
        onPointerLeave: () => void;
    }>;
}>;

/**
 * Hover tracking for a row host that is a plain `View` (tool cards, structured
 * tool rows) rather than a `Pressable`. Pointer events are the same signal
 * `Pressable`'s `onHoverIn`/`onHoverOut` are built on, so both hosts feed the
 * one visibility policy.
 */
export function useRowActionHoverHost(): RowActionHoverHost {
    const [isHovered, setIsHovered] = React.useState(false);
    const hoverProps = React.useMemo(() => ({
        onPointerEnter: () => setIsHovered(true),
        onPointerLeave: () => setIsHovered(false),
    }), []);
    return { isHovered, hoverProps };
}
