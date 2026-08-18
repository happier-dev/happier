import * as React from 'react';
import { Keyboard, Platform, type KeyboardEvent } from 'react-native';

import {
    isWebKeyboardEditableElementFocused,
    isWebMobileLikeViewportWidth,
    resolveWebVisualViewportKeyboardInset,
} from './resolveWebVisualViewportKeyboardInset';
import {
    resolveWebKeyboardReferenceViewportHeight,
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
            // On mobile web, RN Keyboard events never fire; the software keyboard is the visual
            // viewport shrinkage from its unoccluded baseline (same canonical resolution the
            // composer scaffold uses — window.innerHeight lies on Firefox Android). Bottom
            // chrome hides/releases its reservation from this signal.
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
                const reference = updateWebVisualViewportKeyboardReference(referenceRef.current, {
                    width: visualViewport.width,
                    visualBottom: visualViewport.height + visualViewport.offsetTop,
                    layoutViewportHeight: window.innerHeight,
                    isEditableElementFocused: isEditableFocused,
                });
                referenceRef.current = reference;
                const inset = resolveWebVisualViewportKeyboardInset({
                    layoutViewportHeight: resolveWebKeyboardReferenceViewportHeight(reference, {
                        layoutViewportHeight: window.innerHeight,
                        currentVisualBottom: visualViewport.height + visualViewport.offsetTop,
                    }),
                    visualViewportHeight: visualViewport.height,
                    visualViewportOffsetTop: visualViewport.offsetTop,
                    isEditableElementFocused: isEditableFocused,
                    isMobileLikeHost: isWebMobileLikeViewportWidth(visualViewport.width),
                });
                setHeight((current) => (current === inset ? current : inset));
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
