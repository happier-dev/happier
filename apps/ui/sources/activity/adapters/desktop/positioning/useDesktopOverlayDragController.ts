import * as React from 'react';
import { PanResponder } from 'react-native';

import { applyDesktopActivityOverlayDragDelta } from '@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge';
import { fireAndForget } from '@/utils/system/fireAndForget';

export function useDesktopOverlayDragController(params: Readonly<{
    enabled: boolean;
}>): Readonly<Record<string, unknown>> {
    const previousDxRef = React.useRef(0);
    const previousDyRef = React.useRef(0);

    return React.useMemo(() => {
        if (!params.enabled) {
            return {};
        }

        const responder = PanResponder.create({
            onStartShouldSetPanResponder: () => true,
            onMoveShouldSetPanResponder: () => true,
            onPanResponderGrant: () => {
                previousDxRef.current = 0;
                previousDyRef.current = 0;
            },
            onPanResponderMove: (_event, gesture) => {
                const deltaX = gesture.dx - previousDxRef.current;
                const deltaY = gesture.dy - previousDyRef.current;
                previousDxRef.current = gesture.dx;
                previousDyRef.current = gesture.dy;
                if (deltaX === 0 && deltaY === 0) {
                    return;
                }
                fireAndForget(applyDesktopActivityOverlayDragDelta(deltaX, deltaY), {
                    tag: 'useDesktopOverlayDragController.applyDragDelta',
                });
            },
            onPanResponderRelease: () => {
                previousDxRef.current = 0;
                previousDyRef.current = 0;
            },
            onPanResponderTerminate: () => {
                previousDxRef.current = 0;
                previousDyRef.current = 0;
            },
        });
        return responder.panHandlers as Readonly<Record<string, unknown>>;
    }, [params.enabled]);
}
