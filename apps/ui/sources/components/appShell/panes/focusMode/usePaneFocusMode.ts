import * as React from 'react';
import { usePathname } from 'expo-router';

import { useOptionalAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';

import { resolvePaneFocusModeRouteScopeId } from './resolvePaneFocusModeRouteScopeId';

export function usePaneFocusMode(scopeId: string): Readonly<{
    active: boolean;
    canEnter: boolean;
    toggle: () => void;
}> {
    const paneContext = useOptionalAppPaneContext();
    const pathname = usePathname();
    const routeScopeId = React.useMemo(() => resolvePaneFocusModeRouteScopeId(pathname), [pathname]);
    const state = paneContext?.state;
    const scope = state?.scopes[scopeId];
    const hasFocusablePane = Boolean(scope?.right.isOpen || scope?.details.isOpen);
    const canEnter = state != null && state.activeScopeId === scopeId && routeScopeId === scopeId && hasFocusablePane;
    const active = canEnter && state?.focusMode?.scopeId === scopeId;

    const toggle = React.useCallback(() => {
        if (!paneContext) return;
        if (active) {
            paneContext.dispatch({ type: 'exitFocusMode', scopeId });
            return;
        }
        if (canEnter) {
            paneContext.dispatch({ type: 'enterFocusMode', scopeId });
        }
    }, [active, canEnter, paneContext, scopeId]);

    return { active, canEnter, toggle };
}
