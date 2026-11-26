import * as React from 'react';
import { View } from 'react-native';

import { DeferredAnchoredTooltip } from '@/components/ui/overlays/DeferredAnchoredTooltip';

export function useActionTooltip(expanded?: boolean, hidden?: boolean) {
    // A press answers the pointer until it leaves. An open surface takes precedence over a hint.
    const [pressedSinceHover, setPressedSinceHover] = React.useState(false);
    const onPressIn = React.useCallback(() => setPressedSinceHover(true), []);
    const onHoverOut = React.useCallback(() => setPressedSinceHover(false), []);
    const isVisible = ({ hovered, focused }: { hovered: boolean; focused: boolean }) =>
        (hovered || focused) && expanded !== true && hidden !== true && !pressedSinceHover;
    return { isVisible, onPressIn, onHoverOut };
}

export function WebActionTooltip({ size, ...props }: Omit<React.ComponentProps<typeof DeferredAnchoredTooltip>, 'anchorRef'> & { size: number }) {
    const anchorRef = React.useRef<View>(null);
    return (
        <>
            <View ref={anchorRef} style={{ pointerEvents: 'none', position: 'absolute', top: 0, left: 0, width: size, height: size }} />
            <DeferredAnchoredTooltip {...props} anchorRef={anchorRef} />
        </>
    );
}
