import { useSessionArchivePending } from '@/hooks/session/useSessionArchivePending';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { readLatestLocalOutboundPendingUserMessageAt } from '@/sync/domains/messages/outgoingUserMessageActivity';
import { storage } from '@/sync/domains/state/storage';
import type { PendingMessage, Session } from '@/sync/domains/state/storageTypes';
import {
    deriveLatestPendingRequestObservedAtFromSession,
    derivePendingRequestFlagsFromSession,
} from '@/sync/domains/session/pending/listPendingSessionRequests';
import { hasMeaningfulActivityAfterRuntimeIssue } from '@/components/sessions/usageLimitRecovery/sessionUsageLimitActivityStaleness';

type SessionRuntimeStatusFields = Pick<
    Session,
    | 'active'
    | 'archivedAt'
    | 'viewer'
    | 'presence'
    | 'thinking'
    | 'thinkingAt'
    | 'latestTurnStatus'
    | 'latestTurnStatusObservedAt'
    | 'runtimeActivityState'
    | 'runtimeActivityActiveCount'
    | 'runtimeActivityObservedAt'
    | 'runtimeActivityRevision'
    | 'lastRuntimeIssue'
    | 'pendingPermissionRequestCount'
    | 'pendingUserActionRequestCount'
    | 'optimisticThinkingAt'
    | 'resumingAt'
> & Readonly<{
    /**
     * The one composer fact the Session's activity time feeds. Every arriving message moves
     * `meaningfulActivityAt`; projecting it raw re-ran the whole composer controller per message.
     */
    hasActivityAfterRuntimeIssue: boolean;
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
        archivedAt: session.archivedAt,
        viewer: session.viewer,
        presence: session.presence,
        thinking: session.thinking,
        thinkingAt: session.thinkingAt,
        latestTurnStatus: session.latestTurnStatus,
        latestTurnStatusObservedAt: session.latestTurnStatusObservedAt,
        runtimeActivityState: session.runtimeActivityState,
        runtimeActivityActiveCount: session.runtimeActivityActiveCount,
        runtimeActivityObservedAt: session.runtimeActivityObservedAt,
        runtimeActivityRevision: session.runtimeActivityRevision,
        lastRuntimeIssue: session.lastRuntimeIssue,
        hasActivityAfterRuntimeIssue: hasMeaningfulActivityAfterRuntimeIssue(session),
        pendingPermissionRequestCount: session.pendingPermissionRequestCount,
        pendingUserActionRequestCount: session.pendingUserActionRequestCount,
        optimisticThinkingAt: session.optimisticThinkingAt ?? optimisticPendingUserMessageAt ?? null,
        resumingAt: session.resumingAt,
        hasPendingPermissionRequests: pendingFlags.hasPendingPermissionRequests,
        hasPendingUserActionRequests: pendingFlags.hasPendingUserActionRequests,
        pendingRequestObservedAt: deriveLatestPendingRequestObservedAtFromSession(session),
        pendingCount: pendingMessages.length,
    };
}

/**
 * The composer's live runtime view of its Session. It carries no `meaningfulActivityAt`: the shell
 * session leaves it out of its facts and this projection replaces it with `hasActivityAfterRuntimeIssue`,
 * so a stale activity time can never be read from here.
 */
export type SessionRuntimeStatusSource = Omit<Session, 'meaningfulActivityAt'> & Readonly<{ hasActivityAfterRuntimeIssue: boolean }>;

export function useSessionRuntimeStatusSource(session: Session): SessionRuntimeStatusSource;
export function useSessionRuntimeStatusSource(session: null): null;
export function useSessionRuntimeStatusSource(session: Session | null): SessionRuntimeStatusSource | null;
export function useSessionRuntimeStatusSource(session: Session | null): SessionRuntimeStatusSource | null {
    const sessionId = session?.id ?? '';
    const activeServerId = useActiveServerSnapshot().serverId;
    const archiving = useSessionArchivePending(normalizeSessionAddress(session?.serverId ?? activeServerId, sessionId));
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
        if (!session) return session;
        const { meaningfulActivityAt: _shellActivityAt, ...shell } = session;
        return {
            ...shell,
            hasActivityAfterRuntimeIssue: hasMeaningfulActivityAfterRuntimeIssue(session),
            ...runtimeFields,
            archiving,
        };
    }, [archiving, runtimeFields, session]);
}
