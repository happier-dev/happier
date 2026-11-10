import * as React from 'react';
import { useOptionalDetailsRegionTabOpener } from '@/components/appShell/panes/hooks/useAppPaneScope';
import type { DetailsTab } from '@/components/appShell/panes/model/appPaneReducer';

/** Chosen from a list where the phone Start sheet would open, the Start becomes that list's next step (`DetailsStartStep`). */
export type SessionAgentStartPlacement = Readonly<{ presentStart?: (scopeId: string) => void }>;

/** Every Session Agent start delegates placement to the same Details owner. */
export function useSessionAgentStartOpener(): (scopeId: string, tab: DetailsTab, placement?: SessionAgentStartPlacement) => void {
    const openInScope = useOptionalDetailsRegionTabOpener();
    return React.useCallback((scopeId: string, tab: DetailsTab, placement?: SessionAgentStartPlacement) => {
        openInScope?.(scopeId, tab, { intent: 'preview', start: true, ...placement });
    }, [openInScope]);
}
