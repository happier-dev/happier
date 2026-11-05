import * as React from 'react';

import { useDestinationFocus } from '@/components/appShell/workspace/DestinationInstanceHost';
import { readPressFocusReturnTarget, restoreFocusToBestTarget, type FocusReturnTarget } from '@/keyboard/focusReturn';
import { paneRegionFocus, type PaneKeyboardRegion } from './paneRegionFocus';
export { focusPaneRegion } from './paneRegionFocus';

export { PaneRegionProvider, usePaneRegion, type PaneRegion } from './paneRegionContext';

let lastFocusedRegion: PaneKeyboardRegion | null = null;

/** Attach to the existing labelled region View; no wrapper or additional focus listener is needed. */
export function usePaneRegionFocusBoundary(
    region: PaneKeyboardRegion,
    visible: boolean,
    additionalRootRef?: React.RefObject<unknown>,
) {
    const destinationFocused = useDestinationFocus();
    const node = React.useRef<FocusReturnTarget>(null);
    const lastTarget = React.useRef<FocusReturnTarget>(null);
    const currentVisible = React.useRef(visible);
    currentVisible.current = visible;
    const ref = React.useCallback((value: unknown) => {
        // React Native host refs and DOM elements meet the shared focus-return boundary here.
        node.current = typeof value === 'object' && value !== null ? value as FocusReturnTarget : null;
    }, []);
    const onFocusCapture = React.useCallback((event: unknown) => {
        lastFocusedRegion = region;
        const focusEvent = typeof event === 'object' && event !== null
            ? event as Readonly<{ target?: unknown; nativeEvent?: unknown }> : null;
        lastTarget.current = readPressFocusReturnTarget({ currentTarget: focusEvent?.target, nativeEvent: focusEvent?.nativeEvent });
    }, [region]);
    React.useEffect(() => {
        if (!destinationFocused || !visible) return;
        return paneRegionFocus.register(region, () => {
            const root = node.current;
            const additionalRoot = additionalRootRef?.current;
            return {
                visible: currentVisible.current,
                containsFocus: typeof HTMLElement !== 'undefined'
                    ? (root instanceof HTMLElement && root.contains(document.activeElement))
                        || (additionalRoot instanceof HTMLElement && additionalRoot.contains(document.activeElement))
                    : lastFocusedRegion === region,
                focus: () => {
                    const restored = restoreFocusToBestTarget(lastTarget, node);
                    if (restored) lastFocusedRegion = region;
                    return restored;
                },
            };
        });
    }, [additionalRootRef, destinationFocused, region, visible]);
    return { ref, onFocusCapture, onFocus: onFocusCapture };
}
