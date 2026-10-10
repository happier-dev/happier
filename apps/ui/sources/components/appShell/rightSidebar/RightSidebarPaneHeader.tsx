import * as React from 'react';

import { PaneHeader } from '@/components/appShell/panes/PaneHeader';
import { usePublishedPaneHeaderContent } from '@/components/appShell/panes/paneHeaderSlot';
import { PaneHeaderActions } from '@/components/appShell/panes/PaneHeaderActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';

import type { RightSidebarTabDefinition } from './rightSidebarBuiltinTabs';
import { getRightSidebarTabLabel } from './rightSidebarTabRegistry';

/**
 * The open right sidebar's header band, beside the page header: it names the tab the action rail
 * picked, from the tab registry (the same label the rail's tooltip uses), with the live line and
 * trailing action the active tab publishes through the pane header slot. No tab draws a header of
 * its own.
 */
export function RightSidebarPaneHeader(props: Readonly<{
    tabs: readonly RightSidebarTabDefinition[];
    activeTabId: string | null;
    size?: 'band' | 'large';
    onClose?: () => void;
    /** The pane's own operations (for a session pane: Add to Companion), in the band's one ⋯. */
    menuActions?: readonly ItemAction[];
    testID: string;
}>): React.ReactElement | null {
    const tab = props.activeTabId ? props.tabs.find((candidate) => candidate.id === props.activeTabId) : undefined;
    const published = usePublishedPaneHeaderContent(tab ? tab.id : null);
    if (!tab) return null;
    const title = getRightSidebarTabLabel(tab);
    return (
        <PaneHeader
            testID={props.testID}
            title={title}
            line={published?.line ?? null}
            actions={<PaneHeaderActions published={published} title={title} paneMenuActions={props.menuActions} testID={props.testID} />}
            size={props.size}
            onClose={props.onClose}
        />
    );
}
