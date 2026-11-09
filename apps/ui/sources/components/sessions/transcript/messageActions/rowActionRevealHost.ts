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
