import * as React from 'react';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { hrefForDestinationRef, type CompactAppDestination } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { DETAILS_TAB_STRIP_METRICS as M } from '@/components/appShell/panes/details/header/detailsTabHeaderMetrics';
import { SplitCanvasHost, type SplitCanvasRetainedLeafContent } from '@/components/appShell/splitCanvas/components/SplitCanvasHost';
import type { SplitCanvasAction, SplitCanvasDirection, SplitCanvasLeafNode } from '@/components/appShell/splitCanvas/model/splitCanvasTypes';
import { useWorkspaceRefs, useActiveServerAccountScope, useLocalSetting } from '@/sync/domains/state/storage';
import { DEFAULT_EDITOR_MIN_PX } from '@/components/ui/panels/paneBreakpoints';
import { useEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropHooks';
import { executeWorkspaceEntityDrop, resolveWorkspaceEntityDrop, WORKSPACE_ENTITY_KINDS } from './workspaceEntityDrop';
import { describePaneDropDestination, presentPaneDropAdmission } from '@/components/appShell/splitCanvas/presentation/paneDropPresentation';
import { createWorkspaceDropScene, readWorkspaceTabTitle } from './workspaceDropScene';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { DestinationInstanceHost } from './DestinationInstanceHost';
import { useOptionalWorkspaceNavigation, type WorkspaceNavigationContextValue } from './WorkspaceNavigationContext';
import type { WorkspaceGroup } from './workspaceState';
import { createWorkspaceSplit, WORKSPACE_VIEW_MINIMUM } from './workspaceSplit';
import { WorkspaceGroupTabs } from './titleBar/WorkspaceGroupTabs';
import { executeWorkspaceUiAction } from './workspaceActionRuntime';
import { resolveWorkspaceTopRowGroupIds, WorkspaceBarGeometryContext } from './titleBar/workspaceBarGeometry';
// The body selector shares Expo's already-loaded context, not a second lazy graph.
import { WorkspaceDestinationBody as DestinationBody } from './WorkspaceDestinationBody';
import { getDeviceType } from '@/utils/platform/responsive';

const SessionBody = retryableLazy(async () => ({
    default: (await import('@/components/sessions/shell/SessionDestinationBody')).SessionDestinationBody,
}));
const SessionDetailsBody = retryableLazy(async () => ({
    default: (await import('@/components/sessions/shell/SessionDetailsDestinationBody')).SessionDetailsDestinationBody,
}));
const renderSession = () => <SessionBody />;
const renderSessionDetails = () => <SessionDetailsBody />;
const EDITOR_WORKSPACE_MINIMUM = { ...WORKSPACE_VIEW_MINIMUM, width: DEFAULT_EDITOR_MIN_PX };
type GroupPayload = Readonly<{ groupId: string }>;

const styles = StyleSheet.create(() => ({
    group: { minWidth: 0, minHeight: 0 },
    // A pane below the top row carries its tabs on the title bar's own material: the rail continued into the
    // split, transparent over the window atmosphere and flush to the divider, so the gutter shows no second surface.
    strip: {
        flexDirection: 'row', alignItems: 'center', minHeight: M.heightPx,
        paddingLeft: M.paddingStartPx, paddingRight: M.paddingEndPx,
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
export function WorkspaceShell(props: Readonly<{ catalog: readonly CompactAppDestination[]; presentation?: 'destination' }>): React.ReactNode {
    const workspace = useOptionalWorkspaceNavigation();
    if (!workspace?.active) return null;
    return <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
        <WorkspaceCanvas workspace={workspace} catalog={props.catalog} presentation={props.presentation} />
    </PluginSurfaceFocusEligibilityProvider>;
}

function WorkspaceCanvas(props: Readonly<{
    workspace: WorkspaceNavigationContextValue;
    catalog: readonly CompactAppDestination[];
    presentation?: 'destination';
}>) {
    const workspace = props.workspace;
    const arrangement = useLocalSetting('paneArrangement');
    const leafMinimum = React.useCallback((leaf: SplitCanvasLeafNode<GroupPayload>) => {
        const group = workspace.state.groups[leaf.payload.groupId];
        const destination = group ? workspace.state.tabs[group.activeTabId]?.target : undefined;
        return arrangement === 'editor' && (destination?.kind === 'session' || destination?.kind === 'project')
            ? EDITOR_WORKSPACE_MINIMUM : WORKSPACE_VIEW_MINIMUM;
    }, [arrangement, workspace.state.groups, workspace.state.tabs]);
    const scope = useActiveServerAccountScope();
    const workspaceRefs = useWorkspaceRefs();
    const runtime = useEntityDragDropRuntime();
    const dispatchCanvas = React.useCallback((action: SplitCanvasAction<GroupPayload>) => {
        switch (action.type) {
            case 'focusLeaf':
                if (action.leafId) {
                    const group = workspace.state.groups[action.leafId];
                    if (group) workspace.activateTab(group.id, group.activeTabId);
                }
                break;
            case 'closeLeaf': {
                const lifetime = captureActiveServerAccountScopeCurrentness();
                const group = workspace.state.groups[action.leafId];
                if (!group) break;
                // Closing a pane explicitly closes pinned members too; Close All keeps them.
                fireAndForget((async () => {
                    for (const tabId of group.tabIds) {
                        if (!lifetime.isCurrent()) return;
                        const result = await executeWorkspaceUiAction({ actionId: 'workspace.tabs.close', input: { tabId } }, href => {
                            const navigation = workspace.navigationForTab(group.activeTabId);
                            (navigation.pushRetainingCurrent ?? navigation.push)(href);
                        });
                        if (!result.ok || ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success) return;
                    }
                })(), { tag: 'Workspace.pane.close' });
                break;
            }
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
    const renderLeafHeader = React.useCallback((input: Readonly<{
        leaf: SplitCanvasLeafNode<GroupPayload>;
        isFocused: boolean;
        requestSplit: (direction: SplitCanvasDirection) => void;
    }>) => {
        if (props.presentation === 'destination') return null;
        const group = workspace.state.groups[input.leaf.payload.groupId];
        if (!group) return null;
        return <WorkspaceGroupView workspace={workspace} group={group} catalog={props.catalog}
            focused={input.isFocused}
            tabsInTitleBar={titleBarGroupIds.includes(group.id)} />;
    }, [props.catalog, props.presentation, titleBarGroupIds, workspace]);
    const retainedLeafContents = React.useMemo(() => Object.values(workspace.state.groups).flatMap(group =>
        (props.presentation === 'destination'
            ? group.id === workspace.state.focusedGroupId && group.activeTabId ? [group.activeTabId] : []
            : group.tabIds).flatMap((tabId): SplitCanvasRetainedLeafContent[] => {
            const tab = workspace.state.tabs[tabId];
            if (!tab) return [];
            const href = hrefForDestinationRef(props.catalog, tab.target);
            const pathname = href?.split(/[?#]/, 1)[0] ?? null;
            const safeGroup = toTestIdSafeValue(group.id);
            return [{ id: tabId, leafId: group.id, isActive: tabId === group.activeTabId,
                render: ({ isFocused, isVisible }) => <View style={styles.body} role="tabpanel"
                    testID={`workspace-retained-${tabId}`}
                    nativeID={`workspace-${safeGroup}-panel-${toTestIdSafeValue(tabId)}`}
                    aria-labelledby={`workspace-${safeGroup}-tab-${toTestIdSafeValue(tabId)}`}>
                    <DestinationInstanceHost tabId={tabId} ref={tab.target}
                        pathname={pathname ?? ''} focused={isFocused && isVisible} visible={isVisible}
                        navigation={workspace.navigationForTab(tabId)} phone={workspace.phone !== null && workspace.phone !== undefined}>
                            {pathname ? <React.Suspense fallback={<PaneLoadingFallback />}>
                                <DestinationBody target={tab.target} pathname={pathname}
                                    renderSession={renderSession} renderSessionDetails={renderSessionDetails} />
                            </React.Suspense> : <SurfaceStateCard kind="unavailable" title={t('common.unavailable')} />}
                    </DestinationInstanceHost>
                </View> }];
        })), [props.catalog, workspace]);
    return <SplitCanvasHost
        entityDrop={scope ? {
            runtime, id: 'workspace', scope, acceptedKinds: WORKSPACE_ENTITY_KINDS,
            isCurrent: () => workspace.active && !workspace.phone,
            label: target => {
                const group = workspace.state.groups[target.leafId];
                return describePaneDropDestination(target.placement,
                    group ? readWorkspaceTabTitle(workspace.state, props.catalog, group.activeTabId, workspace.destinationTitles) : null);
            },
            resolve: ({ declinedSplit, ...input }) => presentPaneDropAdmission(
                resolveWorkspaceEntityDrop({ ...input, workspace, scope, catalog: props.catalog, workspaceRefs }),
                createWorkspaceDropScene(workspace.state, props.catalog, { paneId: input.target.leafId, declinedSplit: Boolean(declinedSplit), destinationTitles: workspace.destinationTitles })),
            execute: effect => executeWorkspaceEntityDrop(effect, scope),
        } : undefined}
        controlsRef={workspace.canvasControlsRef}
        state={{ root: workspace.state.root, focusedLeafId: workspace.state.focusedGroupId,
            maximizedLeafId: workspace.phone ? workspace.state.focusedGroupId : workspace.state.maximizedGroupId }}
        dispatch={dispatchCanvas}
        renderLeafHeader={renderLeafHeader}
        retainedLeafContents={retainedLeafContents}
        getLeafMinimumSizePx={leafMinimum}
        onRequestSplitLeaf={(input) => splitTab(workspace, { ...input, groupId: input.leafId })}
        keyboardEnabled={workspace.active}
        chrome="flat"
        gutterSizePx={8}
    />;
}

function WorkspaceGroupView(props: Readonly<{
    workspace: WorkspaceNavigationContextValue;
    group: WorkspaceGroup;
    catalog: readonly CompactAppDestination[];
    focused: boolean;
    /** The pane's tabs live in the window's top strip (a top-row pane under a strip that carries them). */
    tabsInTitleBar: boolean;
}>) {
    const { workspace, group } = props;
    const safeGroup = toTestIdSafeValue(group.id);
    const geometry = React.useContext(WorkspaceBarGeometryContext);
    const frameRef = React.useRef<View | null>(null);
    // Hidden title chrome retains its last real wide geometry; phone measurements cannot retire tabs.
    const publishFrame = React.useCallback(() => {
        if (!geometry || !props.tabsInTitleBar || getDeviceType() === 'phone') return;
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
    </View>;
}
