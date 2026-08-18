import * as React from 'react';
import { Keyboard, Platform, type KeyboardEvent } from 'react-native';

import {
    MIN_WEB_SOFTWARE_KEYBOARD_INSET_PX,
    isWebKeyboardEditableElementFocused,
    isWebMobileLikeViewportWidth,
    resolveWebVisualViewportKeyboardInset,
} from './resolveWebVisualViewportKeyboardInset';
import {
    resolveWebKeyboardReferenceViewportHeight,
    resolveWebSoftwareKeyboardOccupancy,
    updateWebVisualViewportKeyboardReference,
    type WebVisualViewportKeyboardReference,
} from './webVisualViewportKeyboardReference';

function getKeyboardHeight(e?: KeyboardEvent): number {
    const h = e?.endCoordinates?.height;
    return typeof h === 'number' && Number.isFinite(h) ? h : 0;
}

export function useKeyboardHeight(): number {
    const [height, setHeight] = React.useState(0);

    React.useEffect(() => {
        if (Platform.OS === 'web') {
            // On mobile web, RN Keyboard events never fire. This hook feeds VISIBILITY gating
            // (bottom-chrome hiding, popover suppression), so it reports the UNCLAMPED
            // occupancy from the unoccluded baseline: on content-resizing browsers
            // (interactive-widget=resizes-content) the layout viewport shrinks to the keyboard
            // top, the clamped geometry inset is ~0, and only the unclamped drop (742 -> 387
            // measured on-device) proves the keyboard is open. Geometry consumers use the
            // composer scaffold's clamped inset instead.
            if (typeof window === 'undefined') return undefined;
            const referenceRef: { current: WebVisualViewportKeyboardReference | null } = { current: null };
            const update = () => {
                const visualViewport = window.visualViewport;
                if (!visualViewport) {
                    setHeight(0);
                    return;
                }
                const isEditableFocused = typeof document !== 'undefined'
                    && isWebKeyboardEditableElementFocused(document);
                const currentVisualBottom = visualViewport.height + visualViewport.offsetTop;
                const reference = updateWebVisualViewportKeyboardReference(referenceRef.current, {
                    width: visualViewport.width,
                    visualBottom: currentVisualBottom,
                    layoutViewportHeight: window.innerHeight,
                    isEditableElementFocused: isEditableFocused,
                });
                referenceRef.current = reference;
                const occupancy = isWebMobileLikeViewportWidth(visualViewport.width)
                    ? resolveWebSoftwareKeyboardOccupancy(reference, currentVisualBottom, MIN_WEB_SOFTWARE_KEYBOARD_INSET_PX)
                    : 0;
                setHeight((current) => (current === occupancy ? current : occupancy));
            };
            update();
            const visualViewport = window.visualViewport;
            visualViewport?.addEventListener('resize', update);
            visualViewport?.addEventListener('scroll', update);
            window.addEventListener('focusin', update);
            window.addEventListener('focusout', update);
            return () => {
                visualViewport?.removeEventListener('resize', update);
                visualViewport?.removeEventListener('scroll', update);
                window.removeEventListener('focusin', update);
                window.removeEventListener('focusout', update);
            };
        }
        if (typeof (Keyboard as any)?.addListener !== 'function') return;

        const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
        const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

        const showSub = Keyboard.addListener(showEvent as any, (e: KeyboardEvent) => {
            setHeight(getKeyboardHeight(e));
        });
        const hideSub = Keyboard.addListener(hideEvent as any, () => {
            setHeight(0);
        });

        return () => {
            showSub.remove();
            hideSub.remove();
        };
    }, []);

    return height;
}
