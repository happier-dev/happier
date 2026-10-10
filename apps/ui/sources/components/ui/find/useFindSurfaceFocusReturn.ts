import * as React from 'react';
import { Platform, TextInput } from 'react-native';

import { readDocumentFocusReturnTarget, restoreFocusToBestTarget, type FocusReturnTarget } from '@/keyboard/focusReturn';

/** Capture only on the closed → open transition, before the Find field takes focus. */
export function useFindSurfaceFocusReturn() {
    const target = React.useRef<FocusReturnTarget>(null);
    const capture = React.useCallback((isOpen: boolean) => {
        if (isOpen) return;
        target.current = Platform.OS === 'web' && typeof document !== 'undefined'
            ? readDocumentFocusReturnTarget(document) : TextInput.State?.currentlyFocusedInput() ?? null;
    }, []);
    const clear = React.useCallback(() => { target.current = null; }, []);
    const restore = React.useCallback((fallback?: () => void) => {
        if (!restoreFocusToBestTarget(target)) fallback?.();
        target.current = null;
    }, []);
    return { capture, clear, restore };
}
