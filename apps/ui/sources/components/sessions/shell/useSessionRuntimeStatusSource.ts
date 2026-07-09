import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { readLatestLocalOutboundPendingUserMessageAt } from '@/sync/domains/messages/outgoingUserMessage';
import { storage } from '@/sync/domains/state/storage';
import type { PendingMessage, Session } from '@/sync/domains/state/storageTypes';
import {
    deriveLatestPendingRequestObservedAtFromSession,
    derivePendingRequestFlagsFromSession,
} from '@/sync/domains/session/pending/listPendingSessionRequests';

type SessionRuntimeStatusFields = Pick<
    Session,
    | 'active'
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
    pendingCount: number;
}>;

function selectSessionRuntimeStatusFields(
    session: Session,
    pendingMessages: ReadonlyArray<PendingMessage>,
): SessionRuntimeStatusFields {
    const pendingFlags = derivePendingRequestFlagsFromSession(session);
    const optimisticPendingUserMessageAt = readLatestLocalOutboundPendingUserMessageAt(pendingMessages);
    return {
        active: session.active,
        presence: session.presence,
        thinking: session.thinking,
        thinkingAt: session.thinkingAt,
        latestTurnStatus: session.latestTurnStatus,
        latestTurnStatusObservedAt: session.latestTurnStatusObservedAt,
        meaningfulActivityAt: session.meaningfulActivityAt,
        lastRuntimeIssue: session.lastRuntimeIssue,
        pendingPermissionRequestCount: session.pendingPermissionRequestCount,
        pendingUserActionRequestCount: session.pendingUserActionRequestCount,
        optimisticThinkingAt: session.optimisticThinkingAt ?? optimisticPendingUserMessageAt ?? null,
        thinkingGraceUntil: session.thinkingGraceUntil,
        hasPendingPermissionRequests: pendingFlags.hasPendingPermissionRequests,
        hasPendingUserActionRequests: pendingFlags.hasPendingUserActionRequests,
        pendingRequestObservedAt: deriveLatestPendingRequestObservedAtFromSession(session),
        pendingCount: pendingMessages.length,
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
            const pendingMessages = sessionId.length > 0
                ? state.sessionPending[sessionId]?.messages ?? []
                : [];
            return liveSession ? selectSessionRuntimeStatusFields(liveSession, pendingMessages) : null;
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
