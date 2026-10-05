import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { hrefForDestinationRef, type CompactAppDestination } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { DETAILS_TAB_STRIP_METRICS as M } from '@/components/appShell/panes/details/header/detailsTabHeaderMetrics';
import { SplitCanvasHost } from '@/components/appShell/splitCanvas/components/SplitCanvasHost';
import type { SplitCanvasAction, SplitCanvasDirection, SplitCanvasLeafNode } from '@/components/appShell/splitCanvas/model/splitCanvasTypes';
import { useActiveServerAccountScope, useSetting } from '@/sync/domains/state/storage';
import { useEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropHooks';
import { executeWorkspaceEntityDrop, resolveWorkspaceEntityDrop, WORKSPACE_ENTITY_KINDS } from './workspaceEntityDrop';
import { describePaneDropDestination, presentPaneDropAdmission } from '@/components/appShell/splitCanvas/presentation/paneDropPresentation';
import { createWorkspaceDropScene, readWorkspaceTabTitle } from './workspaceDropScene';
import { NavigationTitleChromeProvider } from '@/components/ui/layout/navigationTitleChrome';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { DestinationInstanceHost } from './DestinationInstanceHost';
import { useOptionalWorkspaceNavigation, type WorkspaceNavigationContextValue } from './WorkspaceNavigationContext';
import type { WorkspaceGroup } from './workspaceState';
import { createWorkspaceSplit, WORKSPACE_VIEW_MINIMUM } from './workspaceSplit';
import { WorkspaceGroupTabs } from './titleBar/WorkspaceGroupTabs';
import { resolveWorkspaceTopRowGroupIds, WorkspaceBarGeometryContext } from './titleBar/workspaceBarGeometry';
// The body selector shares Expo's already-loaded context, not a second lazy graph.
import { WorkspaceDestinationBody as DestinationBody } from './WorkspaceDestinationBody';

const SessionBody = React.lazy(() => import('@/components/sessions/shell/SessionDestinationBody').then((module) => ({ default: module.SessionDestinationBody })));
const SessionDetailsBody = React.lazy(() => import('@/components/sessions/shell/SessionDetailsDestinationBody').then((module) => ({ default: module.SessionDetailsDestinationBody })));
const renderSession = () => <SessionBody />;
const renderSessionDetails = () => <SessionDetailsBody />;
const leafMinimum = () => WORKSPACE_VIEW_MINIMUM;
type GroupPayload = Readonly<{ groupId: string }>;

const styles = StyleSheet.create((theme) => ({
    group: { flex: 1, minWidth: 0, minHeight: 0 },
    strip: {
        flexDirection: 'row', alignItems: 'center', minHeight: M.heightPx,
        paddingLeft: M.paddingStartPx, paddingRight: M.paddingEndPx,
        borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.border.subtle,
        backgroundColor: theme.colors.surface.inset,
    },
    body: { flex: 1, minWidth: 0, minHeight: 0 },
}));

function splitTab(workspace: WorkspaceNavigationContextValue, input: Readonly<{
    groupId: string;
    direction: SplitCanvasDirection;
    availableSizePx?: number;
    minimumExistingSizePx?: number;
}>) {
    if (input.availableSizePx === undefined || input.minimumExistingSizePx === undefined) return;
    const action = createWorkspaceSplit(workspace.state, { groupId: input.groupId, direction: input.direction,
        availableSizePx: input.availableSizePx, minimumExistingSizePx: input.minimumExistingSizePx, createId: randomUUID });
    if (action) workspace.dispatch(action);
}

/** The shell consumes workspace state; the canvas remains the geometry and keyboard owner. */
export function WorkspaceShell(props: Readonly<{ catalog: readonly CompactAppDestination[] }>): React.ReactNode {
    const workspace = useOptionalWorkspaceNavigation();
    if (!workspace?.active) return null;
    return <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
        <WorkspaceCanvas workspace={workspace} catalog={props.catalog} />
    </PluginSurfaceFocusEligibilityProvider>;
}

function WorkspaceCanvas(props: Readonly<{
    workspace: WorkspaceNavigationContextValue;
    catalog: readonly CompactAppDestination[];
}>) {
    const workspace = props.workspace;
    const scope = useActiveServerAccountScope();
    const workspaceRefs = useSetting('workspaceRefsV1');
    const runtime = useEntityDragDropRuntime();
    const dispatchCanvas = React.useCallback((action: SplitCanvasAction<GroupPayload>) => {
        switch (action.type) {
            case 'focusLeaf':
                if (action.leafId) {
                    const group = workspace.state.groups[action.leafId];
                    if (group) workspace.activateTab(group.id, group.activeTabId);
                }
                break;
            case 'closeLeaf':
                for (const tabId of workspace.state.groups[action.leafId]?.tabIds ?? []) workspace.closeTab(action.leafId, tabId);
                break;
            case 'toggleMaximizeLeaf':
                workspace.dispatch({ type: 'toggleMaximize', groupId: action.leafId });
                break;
            case 'restoreMaximize':
                workspace.dispatch({ type: 'restoreMaximize' });
                break;
            case 'setSplitRatio':
                if (action.availableSizePx !== undefined && action.minimumFirstSizePx !== undefined && action.minimumSecondSizePx !== undefined) {
                    workspace.dispatch({ type: 'resize', splitId: action.splitId, ratio: action.ratio,
                        availableSizePx: action.availableSizePx, minimumFirstSizePx: action.minimumFirstSizePx,
                        minimumSecondSizePx: action.minimumSecondSizePx });
                }
                break;
        }
    }, [workspace]);
    // Top-row panes' tabs live in the title strip when the shell draws one (workspace lab T/S).
    const titleBarGeometry = React.useContext(WorkspaceBarGeometryContext);
    const titleBarKey = titleBarGeometry ? resolveWorkspaceTopRowGroupIds(workspace.state).join('|') : '';
    const titleBarGroupIds = React.useMemo(() => (titleBarKey ? titleBarKey.split('|') : []), [titleBarKey]);
    const renderLeaf = React.useCallback((input: Readonly<{
        leaf: SplitCanvasLeafNode<GroupPayload>;
        isFocused: boolean;
        requestSplit: (direction: SplitCanvasDirection) => void;
    }>) => {
        const group = workspace.state.groups[input.leaf.payload.groupId];
        if (!group) return null;
        return <WorkspaceGroupView workspace={workspace} group={group} catalog={props.catalog}
            focused={input.isFocused}
            tabsInTitleBar={titleBarGroupIds.includes(group.id)}
            visible={workspace.phone ? workspace.state.focusedGroupId === group.id
                : !workspace.state.maximizedGroupId || workspace.state.maximizedGroupId === group.id} />;
    }, [props.catalog, titleBarGroupIds, workspace]);
    return <SplitCanvasHost
        entityDrop={scope ? {
            runtime, id: 'workspace', scope, acceptedKinds: WORKSPACE_ENTITY_KINDS,
            isCurrent: () => workspace.active && !workspace.phone,
            label: target => {
                const group = workspace.state.groups[target.leafId];
                return describePaneDropDestination(target.placement,
                    group ? readWorkspaceTabTitle(workspace.state, props.catalog, group.activeTabId) : null);
            },
            resolve: ({ declinedSplit, ...input }) => presentPaneDropAdmission(
                resolveWorkspaceEntityDrop({ ...input, workspace, scope, catalog: props.catalog, workspaceRefs }),
                createWorkspaceDropScene(workspace.state, props.catalog, { paneId: input.target.leafId, declinedSplit: Boolean(declinedSplit) })),
            execute: effect => executeWorkspaceEntityDrop(effect, scope),
        } : undefined}
        controlsRef={workspace.canvasControlsRef}
        state={{ root: workspace.state.root, focusedLeafId: workspace.state.focusedGroupId,
            maximizedLeafId: workspace.phone ? workspace.state.focusedGroupId : workspace.state.maximizedGroupId,
            maxLeaves: Number.POSITIVE_INFINITY }}
        dispatch={dispatchCanvas}
        renderLeaf={renderLeaf}
        getLeafMinimumSizePx={leafMinimum}
        onRequestSplitLeaf={(input) => splitTab(workspace, { ...input, groupId: input.leafId })}
        keyboardEnabled={workspace.active}
        chrome="flat"
    />;
}

function WorkspaceGroupView(props: Readonly<{
    workspace: WorkspaceNavigationContextValue;
    group: WorkspaceGroup;
    catalog: readonly CompactAppDestination[];
    focused: boolean;
    visible: boolean;
    /** The pane's tabs live in the window's top strip (a top-row pane under a strip that carries them). */
    tabsInTitleBar: boolean;
}>) {
    const { workspace, group } = props;
    const safeGroup = toTestIdSafeValue(group.id);
    const geometry = React.useContext(WorkspaceBarGeometryContext);
    const frameRef = React.useRef<View | null>(null);
    const publishFrame = React.useCallback(() => {
        if (!geometry || !props.tabsInTitleBar) return;
        frameRef.current?.measureInWindow?.((x, _y, width) => {
            if (Number.isFinite(x) && Number.isFinite(width) && width > 0) geometry.setGroupFrame(group.id, { x, width });
        });
    }, [geometry, group.id, props.tabsInTitleBar]);
    React.useLayoutEffect(() => {
        if (!geometry || !props.tabsInTitleBar) return;
        publishFrame();
        return () => geometry.setGroupFrame(group.id, null);
    }, [geometry, group.id, props.tabsInTitleBar, publishFrame]);
    return <View ref={frameRef} testID={`workspace-group-${safeGroup}`} style={styles.group} onLayout={publishFrame}>
        {props.tabsInTitleBar || workspace.phone ? null : <View style={styles.strip}>
            <WorkspaceGroupTabs workspace={workspace} group={group} catalog={props.catalog}
                focused={props.focused} placement="strip" />
        </View>}
        {group.tabIds.map((tabId) => {
            const tab = workspace.state.tabs[tabId];
            if (!tab) return null;
            const href = hrefForDestinationRef(props.catalog, tab.target);
            const pathname = href?.split(/[?#]/, 1)[0] ?? null;
            const visible = props.visible && tabId === group.activeTabId;
            return <RetainedPanelSurface key={tabId} isActive={visible} testID={`workspace-retained-${tabId}`}>
                <View style={styles.body} role="tabpanel"
                    nativeID={`workspace-${safeGroup}-panel-${toTestIdSafeValue(tabId)}`}
                    aria-labelledby={`workspace-${safeGroup}-tab-${toTestIdSafeValue(tabId)}`}>
                    <DestinationInstanceHost tabId={tabId} ref={tab.target}
                        pathname={pathname ?? ''} focused={props.focused && visible} visible={visible}
                        navigation={workspace.navigationForTab(tabId)}>
                        <NavigationTitleChromeProvider showsTitle={false}>
                            {pathname ? <React.Suspense fallback={<PaneLoadingFallback />}>
                                <DestinationBody target={tab.target} pathname={pathname}
                                    renderSession={renderSession} renderSessionDetails={renderSessionDetails} />
                            </React.Suspense> : <SurfaceStateCard kind="unavailable" title={t('common.unavailable')} />}
                        </NavigationTitleChromeProvider>
                    </DestinationInstanceHost>
                </View>
            </RetainedPanelSurface>;
        })}
    </View>;
}
