import * as React from 'react';
import { Platform } from 'react-native';

import { useHappierTouchPrimaryPointer } from '@happier-dev/plugin-ui/environment';

/**
 * Transcript hover policy consumes the shared browser pointer fact; native visibility is
 * decided by the row policy's platform input, as before.
 */
export function useCoarsePrimaryPointer(): boolean {
    const touch = useHappierTouchPrimaryPointer(Platform.OS);
    return Platform.OS === 'web' && touch;
}

export type RowActionHoverHost = Readonly<{
    isHovered: boolean;
    /** Reveal or hide the row for a non-pointer cause (keyboard focus). */
    hoverIn: () => void;
    hoverOut: () => void;
    hoverProps: Readonly<{
        onPointerEnter: () => void;
        onPointerMove: () => void;
        onPointerLeave: () => void;
    }>;
}>;

/**
 * Whether content moved under a resting pointer: a wheel or scroll happened since the pointer last moved.
 * Scrolling a list under a resting pointer fires `pointerenter` on every row it carries past, after the
 * wheel and with no `pointermove` (observed in Chromium: wheel → pointerenter → scroll per step), and each
 * such "hover" used to reveal the row and mount its actions. One document-level watch serves every host.
 */
const contentMovedUnderPointer = { value: false, watching: false };

function watchContentMovedUnderPointer(): void {
    if (contentMovedUnderPointer.watching) return;
    const target = (globalThis as { document?: EventTarget }).document;
    if (!target || typeof target.addEventListener !== 'function') return;
    contentMovedUnderPointer.watching = true;
    const options = { capture: true, passive: true } as const;
    const moved = () => { contentMovedUnderPointer.value = true; };
    target.addEventListener('wheel', moved, options);
    target.addEventListener('scroll', moved, options);
    target.addEventListener('pointermove', () => { contentMovedUnderPointer.value = false; }, options);
}

/**
 * Hover tracking for a row host that is a plain `View` (tool cards, structured
 * tool rows) rather than a `Pressable`, feeding the one visibility policy.
 *
 * A pointer entering the host is hover, unless the content scrolled under a resting pointer; the first
 * real move then reveals the row (`onPointerMove`). Surfaces that never scroll behave as plain hover.
 */
export function useRowActionHoverHost(): RowActionHoverHost {
    const [isHovered, setIsHovered] = React.useState(false);
    const handlers = React.useMemo(() => {
        watchContentMovedUnderPointer();
        const hoverIn = () => setIsHovered(true);
        const hoverOut = () => setIsHovered(false);
        return {
            hoverIn,
            hoverOut,
            hoverProps: {
                onPointerEnter: () => { if (!contentMovedUnderPointer.value) hoverIn(); },
                onPointerMove: hoverIn,
                onPointerLeave: hoverOut,
            },
        };
    }, []);
    return { isHovered, ...handlers };
}
