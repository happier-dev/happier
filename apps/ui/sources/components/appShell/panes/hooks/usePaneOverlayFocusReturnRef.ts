import * as React from 'react';

import { useAppPaneContext } from '../AppPaneProvider';
import type { PaneOverlayFocusSurface } from '../paneOverlayFocusReturn';
import type { FocusReturnMutableRef, FocusReturnTarget } from '@/keyboard/focusReturn';

/**
 * Resolves the AppPane-provider-local capture ref for one rendered scope. A
 * local empty ref keeps isolated/mocked pane harnesses on their normal pane
 * fallback path without inventing a global focus owner.
 */
export function usePaneOverlayFocusReturnRef(
    scopeId: string,
    surface: PaneOverlayFocusSurface,
): FocusReturnMutableRef {
    const context = useAppPaneContext();
    const localRef = React.useRef<FocusReturnTarget>(null);
    const owner = context.overlayFocusReturnOwner;

    return React.useMemo(
        () => owner?.getRef(scopeId, surface) ?? localRef,
        [owner, scopeId, surface],
    );
}
