import * as React from 'react';
import { useSession } from '@/sync/domains/state/storage';
import { useSessionListRelativeNowMs, useSessionListRuntimeWake } from '@/hooks/session/sessionListRuntimeClock';
import { nowServerMs } from '@/sync/runtime/time';
import { deriveLatestPendingRequestObservedAtFromSession, derivePendingRequestFlagsFromSession } from '../pending/listPendingSessionRequests';
import { readSessionRuntimePresentationFreshnessExpirations } from '../attention/runtimePresentation';
import { projectUiSessionAwareness } from './sessionAwareness';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionAwarenessProjectionV1 } from '@happier-dev/protocol/sessions/awareness/projectionV1';

type AwarenessBinding<TSession extends Session | null, TAwareness extends SessionAwarenessProjectionV1 | null> = Readonly<{
    session: TSession;
    awareness: TAwareness;
    turnStartedAtMs: number | null;
}>;

/** Incumbent app awareness subscription, shared without importing the transcript host. */
export function useSessionAwareness(sessionId: string, serverId: string | null, fallbackSession: Session): AwarenessBinding<Session, SessionAwarenessProjectionV1>;
export function useSessionAwareness(sessionId: string, serverId: string | null): AwarenessBinding<Session | null, SessionAwarenessProjectionV1 | null>;
export function useSessionAwareness(sessionId: string, serverId: string | null, fallbackSession?: Session) {
    const liveSession = useSession(sessionId, serverId);
    // Summary retains its already-authorized shell while a live row is absent.
    // App transcripts deliberately provide no fallback and never invent activity.
    const session = liveSession ?? fallbackSession ?? null;
    const localNow = useSessionListRelativeNowMs(session !== null);
    const serverNow = React.useMemo(() => nowServerMs(), [localNow, session]);
    const wakeAt = React.useMemo(() => {
        if (!session) return null;
        const pending = derivePendingRequestFlagsFromSession(session, []);
        const expirations = readSessionRuntimePresentationFreshnessExpirations({
            ...session,
            ...pending,
            pendingRequestObservedAt: deriveLatestPendingRequestObservedAtFromSession(session, []),
        }, serverNow).filter((expiry) => expiry > serverNow);
        return expirations.length > 0 ? Math.min(...expirations) - (serverNow - localNow) : null;
    }, [localNow, serverNow, session]);
    useSessionListRuntimeWake(wakeAt, session !== null);
    const awareness = React.useMemo(() => session ? projectUiSessionAwareness(session, serverNow) : null, [serverNow, session]);
    const turnStartedAtMs = session?.latestTurnStatus === 'in_progress'
        && typeof session.latestTurnStatusObservedAt === 'number'
        && Number.isFinite(session.latestTurnStatusObservedAt) ? session.latestTurnStatusObservedAt : null;
    return { session, awareness, turnStartedAtMs };
}
