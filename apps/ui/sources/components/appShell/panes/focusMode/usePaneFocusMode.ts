import * as React from 'react';
import { usePathname } from 'expo-router';
import { Platform } from 'react-native';
import { useDeviceType } from '@/utils/platform/responsive';

import { useOptionalAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';

import { resolvePaneFocusModeRouteScopeId } from './resolvePaneFocusModeRouteScopeId';

export function usePaneFocusMode(scopeId: string): Readonly<{
    active: boolean;
    canEnter: boolean;
    toggle: () => void;
}> {
    const paneContext = useOptionalAppPaneContext();
    const deviceType = useDeviceType();
    const pathname = usePathname();
    const routeScopeId = React.useMemo(() => resolvePaneFocusModeRouteScopeId(pathname), [pathname]);
    const state = paneContext?.state;
    const scope = state?.scopes[scopeId];
    const hasFocusablePane = Boolean(scope?.right.isOpen || scope?.details.isOpen);
    const nativeTabletPermanentSidebar = Platform.OS !== 'web' && deviceType === 'tablet';
    const canEnter =
        !nativeTabletPermanentSidebar
        && state != null
        && state.activeScopeId === scopeId
        && routeScopeId === scopeId
        && hasFocusablePane;
    const active = canEnter && state?.focusMode.scopeId === scopeId;

    React.useEffect(() => {
        if (!paneContext || !nativeTabletPermanentSidebar) {
            return;
        }
        if (state?.focusMode.scopeId !== scopeId) {
            return;
        }
        paneContext.dispatch({ type: 'exitFocusMode', scopeId });
    }, [nativeTabletPermanentSidebar, paneContext, scopeId, state?.focusMode.scopeId]);

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
