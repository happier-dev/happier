import * as React from 'react';

import { isWebMobileLikeHost } from '@/utils/platform/webMobileHeuristics';

import { resolveWebVisualViewportKeyboardInset } from './resolveWebVisualViewportKeyboardInset';

type EditableElement = Element & {
    isContentEditable?: boolean;
};

function isEditableElementFocused(element: Element | null): boolean {
    if (element == null) return false;
    if ((element as EditableElement).isContentEditable === true) return true;
    const tagName = typeof element.tagName === 'string' ? element.tagName.toLowerCase() : '';
    if (tagName === 'textarea') return true;
    if (tagName !== 'input') return false;
    const input = element as HTMLInputElement;
    return input.disabled !== true && input.readOnly !== true;
}

function readWebKeyboardHeight(): number {
    if (typeof window === 'undefined' || typeof document === 'undefined') return 0;
    const visualViewport = window.visualViewport;
    if (visualViewport == null) return 0;

    return resolveWebVisualViewportKeyboardInset({
        layoutViewportHeight: window.innerHeight,
        visualViewportHeight: visualViewport.height,
        visualViewportOffsetTop: visualViewport.offsetTop,
        isEditableElementFocused: isEditableElementFocused(document.activeElement),
        isMobileLikeHost: isWebMobileLikeHost({
            width: visualViewport.width,
            height: visualViewport.height,
        }),
    });
}

export function useKeyboardHeight(): number {
    const [height, setHeight] = React.useState(() => readWebKeyboardHeight());

    React.useEffect(() => {
        if (typeof window === 'undefined' || typeof document === 'undefined') return;

        let frame = 0;
        const scheduleUpdate = () => {
            if (frame !== 0 && typeof window.cancelAnimationFrame === 'function') {
                window.cancelAnimationFrame(frame);
            }
            if (typeof window.requestAnimationFrame === 'function') {
                frame = window.requestAnimationFrame(() => {
                    frame = 0;
                    setHeight(readWebKeyboardHeight());
                });
                return;
            }
            setHeight(readWebKeyboardHeight());
        };

        scheduleUpdate();

        const visualViewport = window.visualViewport;
        visualViewport?.addEventListener('resize', scheduleUpdate);
        visualViewport?.addEventListener('scroll', scheduleUpdate);
        window.addEventListener('resize', scheduleUpdate);
        document.addEventListener('focusin', scheduleUpdate);
        document.addEventListener('focusout', scheduleUpdate);

        return () => {
            if (frame !== 0 && typeof window.cancelAnimationFrame === 'function') {
                window.cancelAnimationFrame(frame);
            }
            visualViewport?.removeEventListener('resize', scheduleUpdate);
            visualViewport?.removeEventListener('scroll', scheduleUpdate);
            window.removeEventListener('resize', scheduleUpdate);
            document.removeEventListener('focusin', scheduleUpdate);
            document.removeEventListener('focusout', scheduleUpdate);
        };
    }, []);

    return height;
}
