import * as React from 'react';
import { View } from 'react-native';
import type { EntityDragScopeV1, EntityDropAdmissionV1, EntityDropEffectV1, EntityDropOutcomeV1 } from '@happier-dev/protocol/plugins/ui';
import type { SessionCanvasActionId } from '@happier-dev/protocol';
import { DocumentTabStrip, type DocumentTabStripProps, type DocumentTabItem } from '@/components/ui/navigation/DocumentTabStrip';
import { DETAILS_TAB_STRIP_METRICS } from '@/components/appShell/panes/details/header/detailsTabHeaderMetrics';
import type { SplitCanvasRetainedLeafContent } from '@/components/appShell/splitCanvas/components/SplitCanvasHost';
import { Icon } from '@/components/ui/icons/Icon';
import { useUnistyles } from 'react-native-unistyles';
import { useSessionDisplayTitles } from '@/utils/sessions/sessionDisplayTitle';
import { useDestinationInstanceTabPresentations } from '@/components/appShell/workspace/titleBar/useDestinationInstanceTabPresentations';
import { splitCanvasEntityTargetId } from '@/components/appShell/splitCanvas/hooks/useSplitCanvasDnD';
import { usePaneDropStripCue } from '@/components/appShell/splitCanvas/presentation/usePaneDropStripCue';
import type { EntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropTypes';
import type { SplitCanvasLeafNode } from '@/components/appShell/splitCanvas/model/splitCanvasTypes';
import type { SessionSplitCanvasLeafPayload } from '@/sync/domains/session/sessionSplitCanvasPersistence';
import type { resolveSessionCanvasEntityDrop } from './planSessionSplitCanvasDropAction';
import { t } from '@/text';

import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import type { SessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { SessionView } from '@/components/sessions/shell/SessionView';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import type { SessionRouteHydrationState } from '@/sync/domains/session/sessionRouteHydrationState';

type SessionCanvasLeafProps = Readonly<{
    sessionId: string;
    routeServerId?: string;
    jumpToSeq?: number | null;
    paneUrlState?: SessionPaneUrlState;
    initialAttachmentDrafts?: readonly AttachmentDraft[] | null;
    surfaceFocused?: boolean;
    surfaceVisible?: boolean;
    routeAnchor?: boolean;
    routeHydrationState?: SessionRouteHydrationState | null;
    onSurfaceInteract?: () => void;
    nativeID?: string;
}>;
const acceptedKinds = ['session', 'workspace-tab', 'destination', 'repository-file'] as const;
type SessionCanvasRouteProps = SessionCanvasLeafProps & Readonly<{ canvasKey: string; entityScope: EntityDragScopeV1 }>;
type RequestTabAction = (actionId: SessionCanvasActionId, input: unknown) => Promise<EntityDropOutcomeV1>;

export function SessionCanvasLeaf(props: SessionCanvasLeafProps) {
    const hydrationServerId = React.useMemo(() => {
        const normalized = String(props.routeServerId ?? '').trim();
        return normalized.length > 0 ? normalized : undefined;
    }, [props.routeServerId]);
    const ownRouteHydrationState = useHydrateSessionForRoute(
        props.sessionId,
        'SessionCanvasLeaf.ensureSessionVisible',
        hydrationServerId ? { serverId: hydrationServerId } : undefined,
    );
    const suppliedHydration = props.routeHydrationState;
    const routeHydrationState = suppliedHydration?.sessionId === props.sessionId
        && (!suppliedHydration.serverId || !hydrationServerId || suppliedHydration.serverId === hydrationServerId)
        ? suppliedHydration : ownRouteHydrationState;
    const handleSurfaceInteract = React.useCallback(() => {
        if (props.surfaceVisible !== false) props.onSurfaceInteract?.();
    }, [props.onSurfaceInteract, props.surfaceVisible]);

    return (
        <View
            nativeID={props.nativeID}
            testID={`session-canvas-surface-${props.sessionId}`}
            accessibilityState={props.surfaceFocused != null ? { selected: props.surfaceFocused } : undefined}
            aria-selected={props.surfaceFocused != null ? props.surfaceFocused : undefined}
            style={{ flex: 1, minWidth: 0, minHeight: 0 }}
            onPointerDownCapture={handleSurfaceInteract}
            onTouchStart={handleSurfaceInteract}
            onFocus={handleSurfaceInteract}
        >
            <SessionView
                id={props.sessionId}
                routeServerId={props.routeServerId}
                routeHydrationState={routeHydrationState}
                jumpToSeq={props.jumpToSeq ?? null}
                paneUrlState={props.paneUrlState}
                initialAttachmentDrafts={props.initialAttachmentDrafts}
                surfaceFocusedOverride={props.surfaceFocused}
                surfaceVisibleOverride={props.surfaceVisible ?? true}
                routeAnchorOverride={props.routeAnchor}
            />
        </View>
    );
}

export function SessionCanvasTabGroup(props: Readonly<{
    leaf: SplitCanvasLeafNode<SessionSplitCanvasLeafPayload>;
    focused: boolean;
    visible: boolean;
    routeProps: SessionCanvasRouteProps;
    requestTabAction: RequestTabAction;
    runtime: EntityDragDropRuntime;
    isCurrent: () => boolean;
    executeDrop: (effect: EntityDropEffectV1) => Promise<EntityDropOutcomeV1>;
    resolveDrop: (item: Parameters<typeof resolveSessionCanvasEntityDrop>[0]['item'], beforeTabId: string | null) => EntityDropAdmissionV1;
}>) {
    const { group, tabs } = props.leaf.payload;
    const tabAction = (actionId: SessionCanvasActionId, tabId: string, parameters?: Readonly<{ pinned: boolean }>) => {
        void props.requestTabAction(actionId, { scope: props.routeProps.entityScope, canvasKey: props.routeProps.canvasKey, tabId, ...parameters });
    };
    const { theme } = useUnistyles();
    // Tabs are named and marked the way the workspace names a Session tab: its live title and status.
    const addresses = React.useMemo(() => group.tabIds.map(id => tabs[id].address), [group.tabIds, tabs]);
    const titles = useSessionDisplayTitles(addresses);
    const titleEntries = React.useMemo(() => group.tabIds.map(id => ({ key: id, ref: { kind: 'session' as const,
        params: { id: tabs[id].address.sessionId, serverId: tabs[id].address.serverId } } })), [group.tabIds, tabs]);
    const presentations = useDestinationInstanceTabPresentations(titleEntries);
    const tabItems = group.tabIds.map((id, index) => ({ key: id, title: titles[index] ?? t('common.unavailable'),
        isPreview: tabs[id].preview, isPinned: tabs[id].pinned }));
    const dropTargetIds = React.useMemo(() => [splitCanvasEntityTargetId(`session-canvas:${props.routeProps.canvasKey}`, props.leaf.id, 'center')],
        [props.routeProps.canvasKey, props.leaf.id]);
    const dropCue = usePaneDropStripCue(props.runtime, { targetIds: dropTargetIds, tabIds: group.tabIds });
    const entityDragDrop: NonNullable<DocumentTabStripProps<DocumentTabItem>['entityDragDrop']> = {
        runtime: props.runtime, id: `session-canvas-tabs:${props.routeProps.canvasKey}:${props.leaf.id}`,
        scope: props.routeProps.entityScope, acceptedKinds,
        isCurrent: () => props.visible && props.isCurrent(),
        getItem: tabId => tabs[tabId] ? { kind: 'workspace-tab', scope: tabs[tabId].scope, tabId } : null,
        resolve: ({ item, beforeTabId }) => props.resolveDrop(item, beforeTabId), execute: props.executeDrop,
    };
    return <View style={{ flexDirection: 'row', minWidth: 0, minHeight: DETAILS_TAB_STRIP_METRICS.heightPx, flexShrink: 0 }}>
        <DocumentTabStrip variant="bar" tabs={tabItems} activeTabKey={group.activeTabId} accessibilityLabel={t('tabs.sessions')}
            onActivate={tabId => tabAction('session.canvas.tabs.activate', tabId)}
            onPin={tabId => tabAction('session.canvas.tabs.pin', tabId, { pinned: true })}
            onUnpin={tabId => tabAction('session.canvas.tabs.pin', tabId, { pinned: false })}
            onClose={tabId => tabAction('session.canvas.tabs.close', tabId)}
            resolveTabPresentation={tab => presentations.get(tab.key)}
            activeEmphasis={props.focused ? 'raised' : 'quiet'}
            renderLeadingIcon={(_tab, emphasized) => <Icon name="chat-circle" size={DETAILS_TAB_STRIP_METRICS.tabGlyphPx}
                color={emphasized ? theme.colors.text.primary : theme.colors.text.secondary} />}
            dropSlot={dropCue.slot} dropRingTabKey={dropCue.pulseTabKey}
            tabNativeId={id => `session-canvas-tab-${id}`} panelNativeId={id => `session-canvas-panel-${id}`}
            entityDragDrop={entityDragDrop} />
    </View>;
}

/** Membership changes the host placement, never the mounted Session content's parent. */
export function createSessionCanvasRetainedContents(props: Readonly<{
    leaves: readonly SplitCanvasLeafNode<SessionSplitCanvasLeafPayload>[];
    routeProps: SessionCanvasRouteProps;
    requestTabAction: RequestTabAction;
}>): readonly SplitCanvasRetainedLeafContent[] {
    return props.leaves.flatMap(leaf => leaf.payload.group.tabIds.map(tabId => {
        const tab = leaf.payload.tabs[tabId];
        const routeAnchor = tab.address.sessionId === props.routeProps.sessionId
            && tab.address.serverId === props.routeProps.routeServerId?.trim();
        return {
            id: tabId,
            leafId: leaf.id,
            isActive: tabId === leaf.payload.group.activeTabId,
            render: ({ isFocused, isVisible }) => <SessionCanvasLeaf
                sessionId={tab.address.sessionId} routeServerId={tab.address.serverId} nativeID={`session-canvas-panel-${tabId}`}
                routeAnchor={routeAnchor} surfaceVisible={isVisible} surfaceFocused={isVisible && isFocused}
                jumpToSeq={routeAnchor ? props.routeProps.jumpToSeq : null}
                paneUrlState={routeAnchor ? props.routeProps.paneUrlState : undefined}
                initialAttachmentDrafts={routeAnchor ? props.routeProps.initialAttachmentDrafts : null}
                routeHydrationState={routeAnchor ? props.routeProps.routeHydrationState : null}
                onSurfaceInteract={() => {
                    if (isFocused) return;
                    void props.requestTabAction('session.canvas.tabs.activate', {
                        scope: props.routeProps.entityScope, canvasKey: props.routeProps.canvasKey, tabId,
                    });
                }} />,
        } satisfies SplitCanvasRetainedLeafContent;
    }));
}
