import * as React from 'react';
import { entityDragScopesEqualV1, type EntityDragScopeV1, type EntityDropEffectV1, type EntityDropOutcomeV1 } from '@happier-dev/protocol/plugins/ui';
import { isSessionCanvasActionId, SESSION_CANVAS_ACTION_OUTPUT_SCHEMAS, type SessionCanvasActionId } from '@happier-dev/protocol';

import { SplitCanvasHost, type SplitCanvasHostControls } from '@/components/appShell/splitCanvas/components/SplitCanvasHost';
import type { SplitCanvasLeafNode } from '@/components/appShell/splitCanvas/model/splitCanvasTypes';
import { collectSplitCanvasLeaves } from '@/components/appShell/splitCanvas/model/splitCanvasTree';
import { WORKSPACE_VIEW_MINIMUM } from '@/components/appShell/workspace/workspaceSplit';
import { useEntityDragDropRuntime } from '@/components/ui/treeDragDrop';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import type { SessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import type { SessionRouteHydrationState } from '@/sync/domains/session/sessionRouteHydrationState';
import type { SessionSplitCanvasLeafPayload } from '@/sync/domains/session/sessionSplitCanvasPersistence';
import { resolveSessionSplitCanvasScope, type SessionSplitCanvasScope } from '@/sync/domains/session/sessionSplitCanvasScope';
import { resolveWorkspaceTargetForSession } from '@/sync/domains/session/resolveWorkspaceTargetForSession';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { useSessionWorkspaceTarget } from '@/hooks/session/useSessionWorkspaceTarget';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { t } from '@/text';
import { SessionCanvasLeaf, SessionCanvasTabGroup, createSessionCanvasRetainedContents } from './SessionCanvasLeaf';
import { activeSessionForLeaf, collectOpenSessionIds, findSessionCanvasTab, findSessionLeafById, resolveSessionSplitCanvasRouteSessionAfterAction, type SessionSplitCanvasAction } from './sessionSplitCanvasState';
import { sessionCanvasTabId } from '@/sync/domains/session/sessionSplitCanvasPersistence';
import { registerSessionSplitCanvasRuntime } from './sessionSplitCanvasRuntime';
import { createSessionCanvasActionAdapter } from './sessionCanvasActions';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { resolveSessionCanvasEntityDrop } from './planSessionSplitCanvasDropAction';
import { useSessionSplitCanvasState } from './useSessionSplitCanvasState';
import { describePaneDropDestination, presentPaneDropAdmission } from '@/components/appShell/splitCanvas/presentation/paneDropPresentation';
import { createSessionCanvasDropScene, readSessionCanvasPaneTitle } from './sessionCanvasDropScene';

type SessionSplitCanvasScreenProps = Readonly<{
    sessionId: string;
    routeServerId?: string;
    jumpToSeq?: number | null;
    paneUrlState?: SessionPaneUrlState;
    initialAttachmentDrafts?: readonly AttachmentDraft[] | null;
    routeHydrationState?: SessionRouteHydrationState | null;
}>;
const minimumLeafSize = () => WORKSPACE_VIEW_MINIMUM;
// Destinations and files are accepted so the canvas can say why it will not take them: it renders
// Sessions only (lab C2: a denied place says why, rather than ignoring the carry).
const acceptedKinds = ['session', 'workspace-tab', 'destination', 'repository-file'] as const;

/** The mounted state belongs to the exact Account and workspace, rather than the route tab. */
export function SessionSplitCanvasScreen(props: SessionSplitCanvasScreenProps) {
    const accountScope = useActiveServerAccountScope();
    const workspaceTarget = useSessionWorkspaceTarget(props.sessionId, props.routeServerId);
    const workspaceScope = resolveSessionSplitCanvasScope(workspaceTarget, { routeServerId: props.routeServerId });
    const routeServerId = props.routeServerId?.trim()
        || (props.routeHydrationState?.sessionId === props.sessionId ? props.routeHydrationState.serverId?.trim() : '')
        || workspaceTarget?.serverId?.trim();
    const qualified = !!workspaceScope && !!accountScope?.accountId && accountScope.serverId === routeServerId
        && workspaceScope.serverId === accountScope.serverId;
    const mountKey = qualified ? JSON.stringify([accountScope.serverId, accountScope.accountId, workspaceScope.workspaceCacheKey]) : null;
    const currentKey = React.useRef(mountKey);
    currentKey.current = mountKey;
    const isCurrent = React.useCallback(() => currentKey.current === mountKey, [mountKey]);
    if (!mountKey || !workspaceScope || !accountScope) return <SessionCanvasLeaf {...props} routeAnchor surfaceFocused surfaceVisible />;
    return <QualifiedSessionSplitCanvas key={mountKey} {...props} routeServerId={routeServerId} canvasKey={workspaceScope.workspaceCacheKey}
        workspaceScope={workspaceScope} entityScope={accountScope} isCurrent={isCurrent} />;
}

function QualifiedSessionSplitCanvas(props: SessionSplitCanvasScreenProps & Readonly<{
    canvasKey: string;
    workspaceScope: SessionSplitCanvasScope;
    entityScope: EntityDragScopeV1;
    isCurrent: () => boolean;
}>) {
    const runtime = useEntityDragDropRuntime();
    const navigateToSession = useNavigateToSession();
    const { state, getState, dispatch } = useSessionSplitCanvasState({
        routeSessionId: props.sessionId, scope: props.workspaceScope, entityScope: props.entityScope,
    });
    const controlsRef = React.useRef<SplitCanvasHostControls | null>(null);
    const readCanvas = React.useCallback(() => controlsRef.current, []);
    const isCurrent = props.isCurrent;
    const resolveWorkspaceScope = React.useCallback((identity: Readonly<{ serverId: string; accountId: string; sessionId: string }>) => {
        if (!isCurrent() || !entityDragScopesEqualV1(identity, props.entityScope)) return null;
        return resolveSessionSplitCanvasScope(resolveWorkspaceTargetForSession(identity));
    }, [isCurrent, props.entityScope.serverId, props.entityScope.accountId]);
    const handleDispatch = React.useCallback((action: SessionSplitCanvasAction) => {
        if (!isCurrent()) return getState();
        const before = getState();
        const next = dispatch(action);
        const nextRoute = resolveSessionSplitCanvasRouteSessionAfterAction(before, action, {
            routeSessionId: props.sessionId, committedState: next,
        });
        if (nextRoute && nextRoute !== props.sessionId) void navigateToSession(nextRoute, { serverId: props.entityScope.serverId });
        return next;
    }, [dispatch, getState, isCurrent, navigateToSession, props.entityScope.serverId, props.sessionId]);
    const actionAdapter = React.useMemo(() => createSessionCanvasActionAdapter({
        getState, dispatch: handleDispatch, canvasKey: props.canvasKey, readCanvas, getWorkspaceScope: resolveWorkspaceScope,
    }), [getState, handleDispatch, props.canvasKey, readCanvas, resolveWorkspaceScope]);
    const executeAction = React.useCallback((...args: Parameters<typeof actionAdapter>) => isCurrent()
        ? actionAdapter(...args) : { status: 'unavailable' as const }, [actionAdapter, isCurrent]);
    const uiActionExecutor = React.useMemo(() => createDefaultActionExecutor(), []);
    const requestTabAction = React.useCallback(async (actionId: SessionCanvasActionId, input: unknown): Promise<EntityDropOutcomeV1> => {
        const refuse = (code: string): EntityDropOutcomeV1 => ({ status: 'refused', reason: { code, message: t('entityDragDrop.reasons.generic') } });
        if (!isCurrent()) return refuse('canvas_unavailable');
        try {
            const result = await uiActionExecutor.execute(actionId, input, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                serverId: props.entityScope.serverId, expectedAccountId: props.entityScope.accountId });
            if (!result.ok) return refuse(result.errorCode);
            const outcome = SESSION_CANVAS_ACTION_OUTPUT_SCHEMAS[actionId].safeParse(result.result);
            if (!outcome.success) return { status: 'unknown', reason: { code: 'invalid_action_output', message: t('entityDragDrop.preview.unknownTitle') } };
            if (outcome.data.status === 'applied' || outcome.data.status === 'unchanged') return { status: 'applied' };
            return refuse(outcome.data.status === 'refused' ? outcome.data.reason : 'canvas_unavailable');
        } catch {
            return { status: 'unknown', reason: { code: 'canvas_outcome_unknown', message: t('entityDragDrop.preview.unknownTitle') } };
        }
    }, [isCurrent, uiActionExecutor, props.entityScope.serverId, props.entityScope.accountId]);
    const executeDrop = React.useCallback(async (effect: EntityDropEffectV1): Promise<EntityDropOutcomeV1> => isSessionCanvasActionId(effect.actionId)
        ? requestTabAction(effect.actionId, effect.input)
        : { status: 'refused', reason: { code: 'unsupported_action', message: t('entityDragDrop.reasons.generic') } }, [requestTabAction]);
    const openSessionIds = React.useMemo(() => collectOpenSessionIds(state), [state]);
    const focusedSessionId = activeSessionForLeaf(findSessionLeafById(state, state.focusedLeafId))?.address.sessionId ?? null;
    const focusSession = React.useCallback((sessionId: string) => {
        const tab = findSessionCanvasTab(getState(), sessionCanvasTabId(props.entityScope, sessionId));
        if (tab) void requestTabAction('session.canvas.tabs.activate', { scope: props.entityScope, canvasKey: props.canvasKey, tabId: tab.tab.id });
    }, [getState, requestTabAction, props.entityScope, props.canvasKey]);
    const openSessionInSplit = React.useCallback((input: Readonly<{ sessionId: string; direction: 'right' | 'down' }>) => {
        const leafId = getState().focusedLeafId;
        if (leafId) void requestTabAction('session.canvas.tabs.open', { scope: props.entityScope, canvasKey: props.canvasKey,
            sessionId: input.sessionId, leafId, placement: input.direction });
    }, [getState, requestTabAction, props.entityScope, props.canvasKey]);
    React.useEffect(() => registerSessionSplitCanvasRuntime({
        snapshot: { routeSessionId: props.sessionId, focusedSessionId, openSessionIds, scope: props.workspaceScope,
            entityScope: props.entityScope, canvasKey: props.canvasKey },
        controller: { focusSession, openSessionInSplit, executeAction },
    }), [props.sessionId, focusedSessionId, openSessionIds, props.workspaceScope, props.entityScope, props.canvasKey, focusSession, openSessionInSplit, executeAction]);

    const entityDrop = React.useMemo(() => ({
        runtime, id: `session-canvas:${props.canvasKey}`, scope: props.entityScope, acceptedKinds, isCurrent,
        label: (target: Parameters<NonNullable<React.ComponentProps<typeof SplitCanvasHost>['entityDrop']>['resolve']>[0]['target']) =>
            describePaneDropDestination(target.placement, readSessionCanvasPaneTitle(getState(), target.leafId)),
        resolve: ({ item, target, availableSizePx, minimumExistingSizePx, declinedSplit }: Parameters<NonNullable<React.ComponentProps<typeof SplitCanvasHost>['entityDrop']>['resolve']>[0]) => {
            const current = getState();
            return presentPaneDropAdmission(resolveSessionCanvasEntityDrop({
                state: current, canvasKey: props.canvasKey, workspaceScope: props.workspaceScope, item, target, resolveWorkspaceScope,
                ...(availableSizePx === undefined || minimumExistingSizePx === undefined ? {} : { measurement: { availableSizePx, minimumExistingSizePx } }),
            }), createSessionCanvasDropScene(current, { paneId: target.leafId, declinedSplit: Boolean(declinedSplit) }));
        }, execute: executeDrop,
    }), [runtime, props.canvasKey, props.entityScope, props.workspaceScope, isCurrent, getState, resolveWorkspaceScope, executeDrop]);
    const renderLeafHeader = React.useCallback(({ leaf, isFocused }: Readonly<{ leaf: SplitCanvasLeafNode<SessionSplitCanvasLeafPayload>; isFocused: boolean }>) => (
        <SessionCanvasTabGroup leaf={leaf} focused={isFocused} visible={!state.maximizedLeafId || state.maximizedLeafId === leaf.id}
            routeProps={props} requestTabAction={requestTabAction} runtime={runtime} executeDrop={executeDrop} isCurrent={isCurrent}
            resolveDrop={(item, beforeTabId) => {
                const current = getState();
                return presentPaneDropAdmission(resolveSessionCanvasEntityDrop({ state: current, canvasKey: props.canvasKey,
                    workspaceScope: props.workspaceScope, item, target: { leafId: leaf.id, placement: 'center' }, beforeTabId,
                    resolveWorkspaceScope }), createSessionCanvasDropScene(current, { paneId: leaf.id, beforeTabId }));
            }} />
    ), [state.maximizedLeafId, props, requestTabAction, runtime, executeDrop, isCurrent, getState, resolveWorkspaceScope]);
    const retainedLeafContents = React.useMemo(() => createSessionCanvasRetainedContents({
        leaves: collectSplitCanvasLeaves(state.root), routeProps: props, requestTabAction,
    }), [state.root, props, requestTabAction]);
    return <SplitCanvasHost state={state} dispatch={handleDispatch} controlsRef={controlsRef} entityDrop={entityDrop}
        getLeafMinimumSizePx={minimumLeafSize} renderLeafHeader={renderLeafHeader} retainedLeafContents={retainedLeafContents} />;
}
