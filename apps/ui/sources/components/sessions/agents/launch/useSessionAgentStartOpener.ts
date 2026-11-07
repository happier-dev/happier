import * as React from 'react';
import { useOptionalDetailsRegionTabOpener } from '@/components/appShell/panes/hooks/useAppPaneScope';
import type { DetailsTab } from '@/components/appShell/panes/model/appPaneReducer';

/** Every Session Agent start delegates placement to the same Details owner. */
export function useSessionAgentStartOpener(): (scopeId: string, tab: DetailsTab) => void {
    const openInScope = useOptionalDetailsRegionTabOpener();
    return React.useCallback((scopeId: string, tab: DetailsTab) => {
        openInScope?.(scopeId, tab, { intent: 'preview', start: true });
    }, [openInScope]);
}
