import * as React from 'react';

import { useAppPaneScope, type AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { DetailsSplitWorkspace } from '@/components/appShell/panes/details/workspace/DetailsSplitWorkspace';
import type { DetailsTabState } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import {
    DetailsSurfaceHost,
    createDetailsSurfacePaneCallbacks,
    type DetailsSurfaceScopeV1,
} from '@/components/appShell/panes/details/surfaces';
import type { BrowserPlatformV1 } from '@happier-dev/protocol/browser/view/v1';
import type { BrowserLaunchpadRow } from '@/sync/domains/browser/targets';
import type { LocalServicePreviewState } from '@/sync/domains/local/services/preview/store';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { t } from '@/text';

import { createBrowserViewDetailsSurfaceRenderer } from './browserDetailsSurfaceRenderer';
import type { BrowserSurfaceProductModels } from './BrowserSurfaceHost';
import {
    BROWSER_LAUNCHPAD_DETAILS_TAB_KEY,
    createBrowserLaunchpadDetailsTab,
    readBrowserViewDetailsResource,
    resolveBrowserTabPresentation,
    selectBrowserWorkspaceViewerTab,
} from './browserSurfaceDetailsTabModel';
import type { OpenBrowserTargetScope } from './openBrowserTargetInWorkspace';
import { useOpenBrowserTargetInWorkspace } from './useOpenBrowserTargetInWorkspace';
import { useSessionViewerSourceAccountLifetime } from '@/components/sessions/viewer/SessionViewerSourceAccountScope';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { useRetainedPresentationSlotVisible } from '@/components/ui/presentation/retainedPresentationSlots';

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
    presentation?: 'workspace' | 'viewer';
    visible?: boolean;
    presentationSlotId?: string;
    keepAliveAboveRouter?: boolean;
    localServicePreviewState?: LocalServicePreviewState | null;
    localServicePreviewServerId?: string | null;
    /**
     * Workspace-ranked launchpad rows for the mobile new-tab/launchpad page. Threaded from the
     * mounting surface (which assembles the live feed via `useBrowserSurfaceHostProps`) so the
     * mobile launchpad shows running services + recents, not just URL entry.
     */
    launchpadRows?: readonly BrowserLaunchpadRow[];
    localServiceTargets?: readonly import('@/sync/domains/local/services/launch').LocalServiceLaunchTarget[];
    launchpadRefreshStatus?: 'idle' | 'refreshing' | 'error';
    launchpadRefreshError?: string | null;
    onRefreshLaunchpad?: () => void;
    productModels?: BrowserSurfaceProductModels | null;
    /**
     * The exact already-admitted plugin projection for this Browser surface.
     * Browser target identity is presentation context only; plugin effects use
     * this projection's currentness and execution facts.
     */
    pluginProjection?: PluginUiProjectionCurrentness;
    /** Session-only action context; project Browser surfaces deliberately pass `null`. */
    pluginBrowserActionSessionId?: string | null;
    /**
     * A phone page (lab Qp): with one tab or none there is no tab strip, the page is the pane, and
     * New tab and Close tab live in the page's ⋯. The strip returns once a second tab exists.
     */
    collapseSingleTab?: boolean;
    /** The surface's pane header, told whether a page (not the launchpad) is what the pane shows. */
    renderPaneHeader?: (state: Readonly<{ pageOpen: boolean }>) => React.ReactNode;
    testID?: string;
}>): React.ReactElement {
    const pane = useAppPaneScope(props.scopeId);
    const retainedSlotVisible = useRetainedPresentationSlotVisible();
    const visible = props.visible !== false && retainedSlotVisible;
    const sourceServerId = props.presentation === 'viewer' && props.scope.kind === 'session'
        ? props.scope.serverId ?? null
        : props.pluginProjection?.serverId ?? null;

    const viewerAccountLifetime = useSessionViewerSourceAccountLifetime();
    const details = pane.scopeState?.details ?? null;
    const selectedTab = selectBrowserWorkspaceViewerTab(details);
    const pageOpen = Boolean(selectedTab && readBrowserViewDetailsResource(selectedTab.resource));
    const stripCollapsed = props.collapseSingleTab === true && props.presentation !== 'viewer' && (details?.tabs.length ?? 0) <= 1;
    // The launchpad IS the new-tab page: render it as the empty-group state, and the strip `+`
    // (or, without a strip, the page's ⋯) re-opens it as a pinned tab so choosing a row routes
    // through the canonical opener.
    const openLaunchpad = React.useCallback(() => {
        pane.openDetailsTab(createBrowserLaunchpadDetailsTab(), { intent: 'pinned' });
    }, [pane]);
    const onOpenNewTab = stripCollapsed && pageOpen ? openLaunchpad : undefined;

    const openBrowserViewTarget = useOpenBrowserTargetInWorkspace({
        scopeId: props.scopeId,
        accountLifetime: props.pluginProjection?.accountLifetime ?? viewerAccountLifetime,
        openDetailsTab: pane.openDetailsTab,
        scope: props.openScope,
        platform: props.platform,
        browserProfile: props.productModels?.browserProfile?.profile,
        localServicePreviewState: props.localServicePreviewState,
        localServiceTargets: props.localServiceTargets,
        launchpadRows: props.launchpadRows,
        localServiceAddressScope: props.scope.kind !== 'global' && props.scope.machineId ? {
            machineId: props.scope.machineId,
            ...(props.scope.kind === 'session' ? { sessionId: props.scope.sessionId } : {}),
            ...(props.scope.rootPath ? { scope: 'workspace', workspaceRoot: props.scope.rootPath } : {}),
        } : undefined,
    });

    const renderers = React.useMemo(() => [
        createBrowserViewDetailsSurfaceRenderer({
            platform: props.platform,
            visible,
            presentationSlotId: props.presentationSlotId,
            keepAliveAboveRouter: props.keepAliveAboveRouter,
            localServicePreviewState: props.localServicePreviewState,
            localServicePreviewServerId: props.localServicePreviewServerId,
            machineId: props.pluginProjection?.machineId ?? null,
            serverId: sourceServerId,
            pluginUiProjection: props.pluginProjection?.pluginUiProjection,
            pluginAccountLifetime: props.pluginProjection?.accountLifetime,
            pluginUiInteractionEnabled: props.pluginProjection?.phase === 'current'
                && props.pluginProjection?.interactionEnabled === true,
            pluginBrowserProjection: props.pluginProjection?.pluginBrowserProjection,
            pluginBrowserActionSessionId: props.pluginBrowserActionSessionId,
            launchpadRows: props.launchpadRows,
            localServiceTargets: props.localServiceTargets,
            launchpadRefreshStatus: props.launchpadRefreshStatus,
            launchpadRefreshError: props.launchpadRefreshError,
            onRefreshLaunchpad: props.onRefreshLaunchpad,
            productModels: props.productModels ?? undefined,
            onOpenTarget: openBrowserViewTarget,
            onOpenNewTab,
        }),
    ], [
        onOpenNewTab,
        openBrowserViewTarget,
        props.launchpadRefreshError,
        props.onRefreshLaunchpad,
        props.launchpadRefreshStatus,
        props.launchpadRows,
        props.localServiceTargets,
        props.localServicePreviewServerId,
        props.localServicePreviewState,
        props.platform,
        visible,
        props.presentationSlotId,
        props.keepAliveAboveRouter,
        props.pluginBrowserActionSessionId,
        props.pluginProjection?.interactionEnabled,
        props.pluginProjection?.phase,
        props.pluginProjection?.machineId,
        props.pluginProjection?.pluginBrowserProjection,
        props.pluginProjection?.pluginUiProjection,
        props.pluginProjection?.accountLifetime,
        sourceServerId,
        props.productModels,
    ]);

    const callbacks = React.useMemo(() => createDetailsSurfacePaneCallbacks({
        openTab: pane.openDetailsTab,
        closeTab: pane.closeDetailsTab,
        pinTab: pane.pinDetailsTab,
        unpinTab: pane.unpinDetailsTab,
        replaceTab: (tabKey, tab, options) => pane.replaceDetailsTab(tabKey, tab, {
            ...options,
            openIfMissing: tabKey === BROWSER_LAUNCHPAD_DETAILS_TAB_KEY,
        }),
    }), [
        pane.closeDetailsTab,
        pane.openDetailsTab,
        pane.pinDetailsTab,
        pane.replaceDetailsTab,
        pane.unpinDetailsTab,
    ]);

    const renderTabContent = React.useCallback((tab: DetailsTabState) => (
        <DetailsSurfaceHost paneScopeId={props.scopeId}
            tab={tab}
            scope={props.scope}
            region="details"
            renderers={renderers}
            callbacks={callbacks}
        />
    ), [callbacks, props.scope, props.scopeId, renderers]);

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
            onPress={openLaunchpad}
        />
    ), [openLaunchpad, props.testID]);

    const resolveTabIconName = React.useCallback((tab: DetailsTabState) => (
        // A page tab takes the strip's own per-kind globe; only the launchpad differs.
        tab.key === BROWSER_LAUNCHPAD_DETAILS_TAB_KEY ? 'home' : null
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

    const paneHeader = props.renderPaneHeader?.({ pageOpen }) ?? null;
    if (props.presentation === 'viewer' || stripCollapsed) {
        return <>
            {paneHeader}
            {renderTabContent(selectedTab ?? {
                ...createBrowserLaunchpadDetailsTab(),
                isPreview: false,
                isPinned: true,
            })}
        </>;
    }

    return <>
        {paneHeader}
        <DetailsSplitWorkspace
            pane={singleGroupPane}
            resolveTabIconName={resolveTabIconName}
            resolveTabPresentation={resolveTabPresentation}
            renderTabContent={renderTabContent}
            renderHeaderActions={renderHeaderActions}
            renderEmptyState={renderEmptyState}
            testIds={{ root: props.testID }}
        />
    </>;
}
