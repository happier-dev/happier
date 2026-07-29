import * as React from 'react';
import { Pressable } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { useAppPaneScope, type AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { DetailsSplitWorkspace } from '@/components/appShell/panes/details/workspace/DetailsSplitWorkspace';
import type { DetailsTabState } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import {
    DetailsSurfaceHost,
    createDetailsSurfacePaneCallbacks,
    type DetailsSurfaceScopeV1,
} from '@/components/appShell/panes/details/surfaces';
import type { BrowserPlatformV1 } from '@happier-dev/protocol';
import type { BrowserLaunchpadRow } from '@/sync/domains/browser/targets';
import type { LocalServicePreviewState } from '@/sync/domains/local/services/preview/store';
import { t } from '@/text';

import { createBrowserViewDetailsSurfaceRenderer } from './browserDetailsSurfaceRenderer';
import type { BrowserSurfaceProductModels } from './BrowserSurfaceHost';
import {
    BROWSER_LAUNCHPAD_DETAILS_TAB_KEY,
    createBrowserLaunchpadDetailsTab,
    resolveBrowserTabPresentation,
} from './browserSurfaceDetailsTabModel';
import { createOpenBrowserTargetInWorkspace, type OpenBrowserTargetScope } from './openBrowserTargetInWorkspace';

/**
 * Mobile browser surface, mounted on BOTH the session cockpit and the project cockpit. It hosts the
 * SAME details-workspace tab engine as desktop (D2-revised): `browser-view` tabs reorder/close/
 * activate identically through the canonical reducer/strip/chrome. The launchpad is the new-tab
 * page (rendered as the empty-group state and reachable via the strip's `+`). Splits are off by
 * default (single-group mobile); opening a target lands a `browser-view` tab in the focused group.
 */
export function BrowserScopedWorkspace(props: Readonly<{
    scopeId: string;
    scope: DetailsSurfaceScopeV1;
    openScope: OpenBrowserTargetScope;
    platform: BrowserPlatformV1;
    localServicePreviewState?: LocalServicePreviewState | null;
    localServicePreviewServerId?: string | null;
    /**
     * Workspace-ranked launchpad rows for the mobile new-tab/launchpad page. Threaded from the
     * mounting surface (which assembles the live feed via `useBrowserSurfaceHostProps`) so the
     * mobile launchpad shows running services + recents, not just URL entry.
     */
    launchpadRows?: readonly BrowserLaunchpadRow[];
    launchpadRefreshStatus?: 'idle' | 'refreshing' | 'error';
    launchpadRefreshError?: string | null;
    productModels?: BrowserSurfaceProductModels | null;
    testID?: string;
}>): React.ReactElement {
    const pane = useAppPaneScope(props.scopeId);
    const { theme } = useUnistyles();

    const openBrowserViewTarget = React.useMemo(() => createOpenBrowserTargetInWorkspace({
        openDetailsTab: pane.openDetailsTab,
        scope: props.openScope,
        platform: props.platform,
        localServicePreviewState: props.localServicePreviewState,
    }), [pane.openDetailsTab, props.localServicePreviewState, props.openScope, props.platform]);

    const renderers = React.useMemo(() => [
        createBrowserViewDetailsSurfaceRenderer({
            platform: props.platform,
            localServicePreviewState: props.localServicePreviewState,
            localServicePreviewServerId: props.localServicePreviewServerId,
            launchpadRows: props.launchpadRows,
            launchpadRefreshStatus: props.launchpadRefreshStatus,
            launchpadRefreshError: props.launchpadRefreshError,
            productModels: props.productModels ?? undefined,
            onOpenTarget: openBrowserViewTarget,
        }),
    ], [
        openBrowserViewTarget,
        props.launchpadRefreshError,
        props.launchpadRefreshStatus,
        props.launchpadRows,
        props.localServicePreviewServerId,
        props.localServicePreviewState,
        props.platform,
        props.productModels,
    ]);

    const callbacks = React.useMemo(() => createDetailsSurfacePaneCallbacks({
        openTab: pane.openDetailsTab,
        closeTab: pane.closeDetailsTab,
        pinTab: pane.pinDetailsTab,
        unpinTab: pane.unpinDetailsTab,
        replaceTab: pane.replaceDetailsTab,
    }), [
        pane.closeDetailsTab,
        pane.openDetailsTab,
        pane.pinDetailsTab,
        pane.replaceDetailsTab,
        pane.unpinDetailsTab,
    ]);

    const renderTabContent = React.useCallback((tab: DetailsTabState) => (
        <DetailsSurfaceHost
            tab={tab}
            scope={props.scope}
            region="details"
            renderers={renderers}
            callbacks={callbacks}
        />
    ), [callbacks, props.scope, renderers]);

    // The launchpad IS the new-tab page: render it as the empty-group state, and the strip `+`
    // re-opens it as a pinned tab so choosing a row routes through the canonical opener.
    const openLaunchpad = React.useCallback(() => {
        pane.openDetailsTab(createBrowserLaunchpadDetailsTab(), { intent: 'pinned' });
    }, [pane]);

    const renderEmptyState = React.useCallback(() => renderTabContent({
        ...createBrowserLaunchpadDetailsTab(),
        isPreview: false,
        isPinned: true,
    } as DetailsTabState), [renderTabContent]);

    const renderHeaderActions = React.useCallback(() => (
        <Pressable
            testID={`${props.testID ?? 'browser-scoped-workspace'}-new-tab`}
            accessibilityRole="button"
            accessibilityLabel={t('browserShell.tabs.newTab')}
            onPress={openLaunchpad}
            hitSlop={10}
        >
            <Octicons name="plus" size={16} color={theme.colors.text.secondary} />
        </Pressable>
    ), [openLaunchpad, props.testID, theme.colors.text.secondary]);

    const resolveTabIconName = React.useCallback((tab: DetailsTabState) => (
        tab.key === BROWSER_LAUNCHPAD_DETAILS_TAB_KEY ? 'home' : 'globe'
    ), []);

    // Favicon/spinner slot for `browser-view` tabs (launchpad keeps its home icon). The shared
    // strip renders the slot; with no live favicon signal it falls back to the globe icon.
    const resolveTabPresentation = React.useCallback(
        (tab: DetailsTabState) => resolveBrowserTabPresentation(tab),
        [],
    );

    // Single-group mobile: pass a pane variant without the split affordance so the workspace does
    // not surface split-drag (splits remain a desktop-only escalation).
    const singleGroupPane = React.useMemo<AppPaneScopeApi>(() => ({
        ...pane,
        splitDetailsGroup: undefined,
    }), [pane]);

    return (
        <DetailsSplitWorkspace
            pane={singleGroupPane}
            resolveTabIconName={resolveTabIconName}
            resolveTabPresentation={resolveTabPresentation}
            renderTabContent={renderTabContent}
            renderHeaderActions={renderHeaderActions}
            renderEmptyState={renderEmptyState}
            testIds={{ root: props.testID }}
        />
    );
}
