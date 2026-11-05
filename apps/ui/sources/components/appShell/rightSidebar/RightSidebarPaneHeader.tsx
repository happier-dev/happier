import * as React from 'react';

import { useOptionalAppPaneScopeLayout } from '@/components/appShell/panes/hooks/useAppPaneScopeLayout';
import { PaneHeader } from '@/components/appShell/panes/PaneHeader';
import { usePublishedPaneHeaderContent } from '@/components/appShell/panes/paneHeaderSlot';
import { PaneHeaderActions } from '@/components/appShell/panes/PaneHeaderActions';
import { PaneHeaderScrollKey } from '@/components/appShell/panes/paneHeaderScroll';
import type { ItemAction } from '@/components/ui/lists/itemActions';

import type { RightSidebarTabDefinition } from './rightSidebarBuiltinTabs';
import { getRightSidebarTabLabel } from './rightSidebarTabRegistry';
import { usePaneDestinationWindowActions } from '@/components/appShell/panes/useOpenPaneDestinationWindow';

/**
 * The open right sidebar's header band, beside the page header: it names the tab the action rail
 * picked, from the tab registry (the same label the rail's tooltip uses), with the live line and
 * trailing action the active tab publishes through the pane header slot. No tab draws a header of
 * its own.
 */
export function RightSidebarPaneHeader(props: Readonly<{
    tabs: readonly RightSidebarTabDefinition[];
    activeTabId: string | null;
    scopeId?: string;
    size?: 'band' | 'large';
    onClose?: () => void;
    /** The pane's own operations (for a session pane: Add to Companion), in the band's one ⋯. */
    menuActions?: readonly ItemAction[];
    /**
     * Presented inside the session column (lab AR1 EFv): Back to the transcript leads the band, and
     * the session's mark and name stand in for the session header the pane covers.
     */
    onBack?: () => void;
    leading?: React.ReactNode;
    context?: string;
    testID: string;
}>): React.ReactElement | null {
    const tab = props.activeTabId ? props.tabs.find((candidate) => candidate.id === props.activeTabId) : undefined;
    const published = usePublishedPaneHeaderContent(tab ? tab.id : null);
    const openActions = usePaneDestinationWindowActions(props.scopeId, 'right');
    const menuActions = React.useMemo(() => [...(props.menuActions ?? []), ...openActions.presentationItems.map(item => ({
        id: item.id, title: item.title, icon: item.icon, onPress: () => { openActions.select(item.id); },
    }))], [openActions, props.menuActions]);
    // With no editor column beside it, the side panel's header carries a hidden main column's
    // restore chip at its leading edge (lab H3).
    const showMainChip = useOptionalAppPaneScopeLayout()?.effectiveDetailsOpen === false;
    if (!tab) return null;
    const title = getRightSidebarTabLabel(tab);
    const publishedLine = published?.line ?? null;
    const line = props.context
        ? { ...publishedLine, segments: [props.context, ...(publishedLine?.segments ?? [])] }
        : publishedLine;
    return (
        // The shade under the band follows the shown tab's own scroller.
        <PaneHeaderScrollKey scrollKey={tab.id}>
        <PaneHeader
            testID={props.testID}
            mainRestoreChip={showMainChip}
            onBack={props.onBack}
            leading={props.leading}
            title={title}
            line={line}
            actions={<PaneHeaderActions published={published} title={title} paneMenuActions={menuActions} testID={props.testID} />}
            size={props.size}
            onClose={props.onClose}
        />
        </PaneHeaderScrollKey>
    );
}
