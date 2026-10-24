import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { useSessionArchivePending } from '@/hooks/session/useSessionArchivePending';

type SessionRuntimeStatusFields = Pick<
    Session,
    | 'active'
    | 'activeAt'
    | 'presence'
    | 'thinking'
    | 'thinkingAt'
    | 'latestTurnStatus'
    | 'latestTurnStatusObservedAt'
    | 'runtimeActivityState'
    | 'runtimeActivityActiveCount'
    | 'runtimeActivityObservedAt'
    | 'runtimeActivityRevision'
    | 'meaningfulActivityAt'
    | 'lastRuntimeIssue'
    | 'pendingPermissionRequestCount'
    | 'pendingUserActionRequestCount'
    | 'pendingRequestObservedAt'
    | 'optimisticThinkingAt'
    | 'resumingAt'
    | 'thinkingGraceUntil'
> & Pick<SessionListRenderableSession, 'hasPendingPermissionRequests' | 'hasPendingUserActionRequests'>;

type UseSessionRuntimeStatusSourceOptions = Readonly<{
    subscribeToRuntimeActivity?: boolean;
}>;

function selectSessionRuntimeStatusFields(
    session: Session,
    subscribeToRuntimeActivity: boolean,
    renderable: SessionListRenderableSession | undefined,
): Partial<SessionRuntimeStatusFields> {
    const foregroundFields = {
        active: session.active,
        activeAt: session.activeAt,
        presence: session.presence,
        thinking: session.thinking,
        thinkingAt: session.thinkingAt,
        latestTurnStatus: session.latestTurnStatus,
        latestTurnStatusObservedAt: session.latestTurnStatusObservedAt,
        meaningfulActivityAt: session.meaningfulActivityAt,
        lastRuntimeIssue: session.lastRuntimeIssue,
        pendingPermissionRequestCount: session.pendingPermissionRequestCount,
        pendingUserActionRequestCount: session.pendingUserActionRequestCount,
        pendingRequestObservedAt: session.pendingRequestObservedAt,
        optimisticThinkingAt: session.optimisticThinkingAt,
        resumingAt: session.resumingAt,
        thinkingGraceUntil: session.thinkingGraceUntil,
        // Transcript-only permission settlements update this canonical summary without
        // changing the runtime session. Subscribe to its flags instead of every message.
        ...(renderable ? {
            hasPendingPermissionRequests: renderable.hasPendingPermissionRequests,
            hasPendingUserActionRequests: renderable.hasPendingUserActionRequests,
            pendingRequestObservedAt: renderable.pendingRequestObservedAt,
        } : {}),
    };
    return subscribeToRuntimeActivity
        ? {
            ...foregroundFields,
            runtimeActivityState: session.runtimeActivityState,
            runtimeActivityActiveCount: session.runtimeActivityActiveCount,
            runtimeActivityObservedAt: session.runtimeActivityObservedAt,
            runtimeActivityRevision: session.runtimeActivityRevision,
        }
        : foregroundFields;
}

export type SessionRuntimeStatusSource = Session & Pick<
    SessionListRenderableSession,
    'archiving' | 'hasPendingPermissionRequests' | 'hasPendingUserActionRequests'
>;

export function useSessionRuntimeStatusSource(
    session: Session,
    options: UseSessionRuntimeStatusSourceOptions = {},
): SessionRuntimeStatusSource {
    const sessionId = session.id;
    const subscribeToRuntimeActivity = options.subscribeToRuntimeActivity !== false;
    const runtimeFields = storage(
        useShallow((state) => {
            const liveSession = state.sessions[sessionId] ?? null;
            return liveSession
                ? selectSessionRuntimeStatusFields(
                    liveSession,
                    subscribeToRuntimeActivity,
                    state.sessionListRenderables[sessionId],
                )
                : null;
        }),
    );

    const archiving = useSessionArchivePending(sessionId, session.serverId);

    return React.useMemo(() => {
        if (!runtimeFields && subscribeToRuntimeActivity && !archiving) return session;
        return {
            ...session,
            ...runtimeFields,
            archiving,
            ...(subscribeToRuntimeActivity
                ? {}
                : {
                    runtimeActivityState: undefined,
                    runtimeActivityActiveCount: undefined,
                    runtimeActivityObservedAt: undefined,
                    runtimeActivityRevision: undefined,
                }),
        };
    }, [archiving, runtimeFields, session, subscribeToRuntimeActivity]);
}
