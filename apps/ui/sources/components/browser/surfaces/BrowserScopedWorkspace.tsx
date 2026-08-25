import * as React from 'react';
import { Platform } from 'react-native';

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
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { t } from '@/text';

import { createBrowserViewDetailsSurfaceRenderer } from './browserDetailsSurfaceRenderer';
import type { BrowserSurfaceProductModels } from './BrowserSurfaceHost';
import {
    BROWSER_LAUNCHPAD_DETAILS_TAB_KEY,
    createBrowserLaunchpadDetailsTab,
    resolveBrowserTabPresentation,
} from './browserSurfaceDetailsTabModel';
import { createOpenBrowserTargetInWorkspace, type OpenBrowserTargetScope } from './openBrowserTargetInWorkspace';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';

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
    /**
     * The exact already-admitted plugin projection for this Browser surface.
     * Browser target identity is presentation context only; plugin effects use
     * this projection's currentness and execution facts.
     */
    pluginProjection?: PluginUiProjectionCurrentness;
    /** Session-only action context; project Browser surfaces deliberately pass `null`. */
    pluginBrowserActionSessionId?: string | null;
    testID?: string;
}>): React.ReactElement {
    const pane = useAppPaneScope(props.scopeId);

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
            machineId: props.pluginProjection?.machineId ?? null,
            serverId: props.pluginProjection?.serverId ?? null,
            pluginUiProjection: props.pluginProjection?.pluginUiProjection,
            pluginUiInteractionEnabled: props.pluginProjection?.phase === 'current'
                && props.pluginProjection?.interactionEnabled === true,
            pluginBrowserProjection: props.pluginProjection?.pluginBrowserProjection,
            pluginBrowserActionSessionId: props.pluginBrowserActionSessionId,
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
        props.pluginBrowserActionSessionId,
        props.pluginProjection?.interactionEnabled,
        props.pluginProjection?.phase,
        props.pluginProjection?.machineId,
        props.pluginProjection?.pluginBrowserProjection,
        props.pluginProjection?.pluginUiProjection,
        props.pluginProjection?.serverId,
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

    // The canonical icon-only button, not a bare `Pressable` with `hitSlop`. Q2 finding A3-C9:
    // react-native-web 0.21 never reads `hitSlop` on `Pressable`/`View` and the desktop app IS the
    // web bundle, so the declared target did not exist on two of three platforms (and was clipped to
    // the parent on Android). `IconButton` grows a real press frame with box model instead, and
    // brings the pressed/hover/focus-visible states this control had none of.
    const renderHeaderActions = React.useCallback(() => (
        <IconButton
            testID={`${props.testID ?? 'browser-scoped-workspace'}-new-tab`}
            iconName="plus"
            accessibilityLabel={t('browserShell.tabs.newTab')}
            tooltip={t('browserShell.tabs.newTab')}
            variant="plain"
            size={28}
            iconSize={16}
            minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
            onPress={openLaunchpad}
        />
    ), [openLaunchpad, props.testID]);

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
