import * as React from 'react';

import { AppScopeRightSidebar, AppScopeRightSidebarActionRail } from '@/components/appShell/rightSidebar/AppScopeRightSidebar';
import { APP_PANE_SCOPE_ID } from '@/components/appShell/rightSidebar/appScopeRightSidebarNavigation';
import { useAppRightSidebarTabs } from '@/components/appShell/rightSidebar/appRightSidebarTabs';

import { AppPaneScopeHost, type AppPaneDestinationDetails } from './AppPaneScopeHost';
import type { PaneRightSidebarAdapter } from './types';
import { useDestinationPaneScopeId } from '../workspace/DestinationInstanceHost';

const APP_RIGHT_SIDEBAR_ADAPTER: PaneRightSidebarAdapter = Object.freeze({
    available: false,
    render: ({ scopeId }: Readonly<{ scopeId: string }>) => (
        <AppScopeRightSidebar scopeId={scopeId} closable testID="app-scope-right-sidebar" />
    ),
});
const APP_RIGHT_SIDEBAR_RAIL_ADAPTER: PaneRightSidebarAdapter = Object.freeze({
    ...APP_RIGHT_SIDEBAR_ADAPTER,
    available: true,
    renderActionRail: ({ scopeId }) => <AppScopeRightSidebarActionRail scopeId={scopeId} />,
});

/**
 * The pane host of the App's own pages (Plugins, plugin pages): one `PaneColumnsHost` for the page, its
 * destination-owned details and the App's right sidebar (design §3.3). The route stays the only owner of
 * the details selection; the right sidebar's selection lives in the one App pane scope.
 */
export const AppScopePaneHost = React.memo(function AppScopePaneHost(props: Readonly<{
    main: React.ReactNode;
    paneScopeId?: string;
    selectedPaneTabKey?: string;
    mainColumn?: React.ComponentProps<typeof AppPaneScopeHost>['mainColumn'];
    /** The destination's open details, or `null` while none is open. */
    destinationDetails?: AppPaneDestinationDetails | null;
    mainMinWidthPx?: number;
    onMainColumnControlsChange?: React.ComponentProps<typeof AppPaneScopeHost>['onMainColumnControlsChange'];
}>) {
    const tabs = useAppRightSidebarTabs();
    const destinationScopeId = useDestinationPaneScopeId(APP_PANE_SCOPE_ID);
    const scopeId = props.paneScopeId ?? destinationScopeId;
    return (
        <AppPaneScopeHost
            scopeId={scopeId}
            selectedPaneTabKey={props.selectedPaneTabKey}
            main={props.main}
            mainColumn={props.mainColumn}
            rightSidebarAdapter={tabs.length > 0 ? APP_RIGHT_SIDEBAR_RAIL_ADAPTER : APP_RIGHT_SIDEBAR_ADAPTER}
            onMainColumnControlsChange={props.onMainColumnControlsChange}
            destinationDetails={props.destinationDetails ?? null}
            mainMinWidthPx={props.mainMinWidthPx}
        />
    );
});
