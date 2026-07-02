import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import {
    deriveLatestPendingRequestObservedAtFromSession,
    derivePendingRequestFlagsFromSession,
} from '@/sync/domains/session/pending/listPendingSessionRequests';

type SessionRuntimeStatusFields = Pick<
    Session,
    | 'active'
    | 'activeAt'
    | 'presence'
    | 'thinking'
    | 'thinkingAt'
    | 'latestTurnStatus'
    | 'latestTurnStatusObservedAt'
    | 'meaningfulActivityAt'
    | 'lastRuntimeIssue'
    | 'pendingPermissionRequestCount'
    | 'pendingUserActionRequestCount'
    | 'optimisticThinkingAt'
    | 'thinkingGraceUntil'
> & Readonly<{
    hasPendingPermissionRequests: boolean;
    hasPendingUserActionRequests: boolean;
    pendingRequestObservedAt: number | null;
}>;

function selectSessionRuntimeStatusFields(session: Session): SessionRuntimeStatusFields {
    const pendingFlags = derivePendingRequestFlagsFromSession(session);
    return {
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
        optimisticThinkingAt: session.optimisticThinkingAt,
        thinkingGraceUntil: session.thinkingGraceUntil,
        hasPendingPermissionRequests: pendingFlags.hasPendingPermissionRequests,
        hasPendingUserActionRequests: pendingFlags.hasPendingUserActionRequests,
        pendingRequestObservedAt: deriveLatestPendingRequestObservedAtFromSession(session),
    };
}

export function useSessionRuntimeStatusSource(session: Session): Session;
export function useSessionRuntimeStatusSource(session: null): null;
export function useSessionRuntimeStatusSource(session: Session | null): Session | null;
export function useSessionRuntimeStatusSource(session: Session | null): Session | null {
    const sessionId = session?.id ?? '';
    const runtimeFields = storage(
        useShallow((state) => {
            const liveSession = sessionId.length > 0 ? state.sessions[sessionId] ?? null : null;
            return liveSession ? selectSessionRuntimeStatusFields(liveSession) : null;
        }),
    );

    return React.useMemo(() => {
        if (!session || !runtimeFields) return session;
        return {
            ...session,
            ...runtimeFields,
        };
    }, [runtimeFields, session]);
}
