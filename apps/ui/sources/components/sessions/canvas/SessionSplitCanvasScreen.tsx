import * as React from 'react';

import { SplitCanvasHost } from '@/components/appShell/splitCanvas/components/SplitCanvasHost';
import type {
    SplitCanvasAction,
    SplitCanvasDropTarget,
    SplitCanvasLeafNode,
} from '@/components/appShell/splitCanvas/model/splitCanvasTypes';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import type { SessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import type { SessionRouteHydrationState } from '@/sync/domains/session/sessionRouteHydrationState';
import {
    type SessionSplitCanvasLeafPayload,
} from '@/sync/domains/session/sessionSplitCanvasPersistence';
import { SessionCanvasLeaf } from './SessionCanvasLeaf';
import {
    collectOpenSessionIds,
    findSessionLeafIdBySessionId,
    resolveSessionSplitCanvasRouteAnchorLeafId,
    resolveSessionSplitCanvasRouteSessionAfterAction,
} from './sessionSplitCanvasState';
import { registerSessionSplitCanvasRuntime } from './sessionSplitCanvasRuntime';
import { decodeSessionSplitCanvasDragData } from './sessionSplitCanvasDragData';
import { planSessionSplitCanvasDropAction } from './planSessionSplitCanvasDropAction';
import { useSessionSplitCanvasDragState } from './useSessionSplitCanvasDragState';
import { useSessionCanvasEligibility } from './useSessionCanvasEligibility';
import { useSessionSplitCanvasState, type SessionSplitCanvasState } from './useSessionSplitCanvasState';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';

type SessionSplitCanvasScreenProps = Readonly<{
    sessionId: string;
    routeServerId?: string;
    jumpToSeq?: number | null;
    paneUrlState?: SessionPaneUrlState;
    initialAttachmentDrafts?: readonly AttachmentDraft[] | null;
    routeHydrationState?: SessionRouteHydrationState | null;
}>;

type SessionSplitCanvasHostProps = Readonly<{
    state: SessionSplitCanvasState;
    dispatch: (action: SplitCanvasAction<SessionSplitCanvasLeafPayload>) => void;
    renderLeaf: (input: Readonly<{
        leaf: SplitCanvasLeafNode<SessionSplitCanvasLeafPayload>;
        isFocused: boolean;
        isMaximized: boolean;
    }>) => React.ReactNode;
    renderLeafLabel?: (leaf: SplitCanvasLeafNode<SessionSplitCanvasLeafPayload>) => string;
    onRequestSplitLeaf?: (input: Readonly<{
        leafId: string;
        direction: 'left' | 'right' | 'up' | 'down';
    }>) => void;
    activeDropTarget?: SplitCanvasDropTarget | null;
    onActiveDropTargetChange?: (target: SplitCanvasDropTarget | null) => void;
    onLeafDrop?: (input: Readonly<{
        payload: string;
        target: SplitCanvasDropTarget;
    }>) => void;
    keyboardEnabled?: boolean;
}>;

const SessionSplitCanvasHost = SplitCanvasHost as unknown as (props: SessionSplitCanvasHostProps) => React.ReactElement | null;

export function SessionSplitCanvasScreen(props: SessionSplitCanvasScreenProps) {
    const navigateToSession = useNavigateToSession();
    const eligibility = useSessionCanvasEligibility(props.sessionId, {
        routeServerId: props.routeServerId,
    });
    const {
        state,
        dispatch,
        openSessionInSplit,
        focusSession,
    } = useSessionSplitCanvasState({
        routeSessionId: props.sessionId,
        scope: eligibility.scope,
    });
    const stateRef = React.useRef(state);
    stateRef.current = state;
    const [activeDropTarget, setActiveDropTarget] = React.useState<SplitCanvasDropTarget | null>(null);
    const isSplitDragActive = useSessionSplitCanvasDragState();
    const openSessionIds = React.useMemo(() => collectOpenSessionIds(state), [state]);
    const focusedSessionId = React.useMemo(() => {
        for (const sessionId of openSessionIds) {
            if (findSessionLeafIdBySessionId(state, sessionId) === state.focusedLeafId) {
                return sessionId;
            }
        }
        return null;
    }, [openSessionIds, state]);
    const routeAnchorLeafId = React.useMemo(
        () => resolveSessionSplitCanvasRouteAnchorLeafId(state, props.sessionId),
        [props.sessionId, state],
    );

    React.useEffect(() => {
        return registerSessionSplitCanvasRuntime({
            snapshot: {
                routeSessionId: props.sessionId,
                focusedSessionId,
                openSessionIds,
                scope: eligibility.scope,
            },
            controller: {
                focusSession,
                openSessionInSplit,
            },
        });
    }, [eligibility.scope, focusSession, focusedSessionId, openSessionIds, openSessionInSplit, props.sessionId]);

    const handleDispatch = React.useCallback((action: SplitCanvasAction<SessionSplitCanvasLeafPayload>) => {
        const nextRouteSessionId = resolveSessionSplitCanvasRouteSessionAfterAction(stateRef.current, action, {
            routeSessionId: props.sessionId,
        });
        dispatch(action);
        if (!nextRouteSessionId || nextRouteSessionId === props.sessionId) {
            return;
        }
        void navigateToSession(nextRouteSessionId, props.routeServerId
            ? { serverId: props.routeServerId }
            : undefined);
    }, [dispatch, navigateToSession, props.routeServerId, props.sessionId]);

    const handleLeafDrop = React.useCallback((input: Readonly<{
        payload: string;
        target: SplitCanvasDropTarget;
    }>) => {
        const decoded = decodeSessionSplitCanvasDragData(input.payload);
        if (!decoded) {
            return;
        }

        const nextAction = planSessionSplitCanvasDropAction({
            state,
            droppedSessionId: decoded.sessionId,
            routeSessionId: props.sessionId,
            target: input.target,
        });
        if (!nextAction) {
            return;
        }
        if (nextAction.type === 'focusLeaf') {
            focusSession(decoded.sessionId);
            return;
        }
        handleDispatch(nextAction);
    }, [focusSession, handleDispatch, props.sessionId, state]);

    const renderLeaf = React.useCallback(({ leaf, isFocused }: Readonly<{
        leaf: SplitCanvasLeafNode<SessionSplitCanvasLeafPayload>;
        isFocused: boolean;
    }>) => {
        const isRouteAnchor = leaf.id === routeAnchorLeafId;
        const isVisible = state.maximizedLeafId == null || state.maximizedLeafId === leaf.id;
        return (
            <SessionCanvasLeaf
                sessionId={leaf.payload.sessionId}
                routeServerId={isRouteAnchor ? props.routeServerId : undefined}
                jumpToSeq={isRouteAnchor ? (props.jumpToSeq ?? null) : null}
                paneUrlState={isRouteAnchor ? props.paneUrlState : undefined}
                initialAttachmentDrafts={isRouteAnchor ? (props.initialAttachmentDrafts ?? null) : null}
                surfaceFocused={isFocused}
                surfaceVisible={isVisible}
                routeAnchor={isRouteAnchor}
                routeHydrationState={isRouteAnchor ? (props.routeHydrationState ?? null) : null}
                onSurfaceInteract={() => focusSession(leaf.payload.sessionId)}
            />
        );
    }, [
        focusSession,
        props.initialAttachmentDrafts,
        props.jumpToSeq,
        props.paneUrlState,
        props.routeServerId,
        props.routeHydrationState,
        props.sessionId,
        routeAnchorLeafId,
        state.maximizedLeafId,
    ]);

    return (
        <SessionSplitCanvasHost
            state={state}
            dispatch={handleDispatch}
            activeDropTarget={isSplitDragActive ? activeDropTarget : null}
            onActiveDropTargetChange={isSplitDragActive ? setActiveDropTarget : undefined}
            onLeafDrop={isSplitDragActive ? handleLeafDrop : undefined}
            renderLeaf={renderLeaf}
        />
    );
}
