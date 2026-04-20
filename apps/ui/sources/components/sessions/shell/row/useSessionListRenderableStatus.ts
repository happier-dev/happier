import * as React from 'react';

import { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { getSessionStatus, type SessionStatus } from '@/utils/sessions/sessionUtils';

type SessionRowStatusSource = Session | SessionListRenderableSession;
const SESSION_ROW_STATUS_OPTIMISTIC_THINKING_TIMEOUT_MS = 15_000;

function readPendingFlag(
    session: SessionRowStatusSource,
    key: 'hasPendingPermissionRequests' | 'hasPendingUserActionRequests',
): boolean {
    const renderablePendingFlags = session as Partial<Record<typeof key, boolean>>;
    return renderablePendingFlags[key] === true;
}

function buildSessionStatusPhaseKey(session: SessionRowStatusSource): string {
    const nowMs = Date.now();
    const optimisticThinkingAt = session.optimisticThinkingAt ?? null;
    const isOptimisticThinking =
        typeof optimisticThinkingAt === 'number'
        && nowMs - optimisticThinkingAt < SESSION_ROW_STATUS_OPTIMISTIC_THINKING_TIMEOUT_MS;
    const thinkingGraceUntil = session.thinkingGraceUntil ?? null;
    const isThinkingGraceActive = typeof thinkingGraceUntil === 'number' && nowMs < thinkingGraceUntil;
    const isThinking = session.thinking === true || isOptimisticThinking || isThinkingGraceActive;

    return [
        session.id,
        session.presence === 'online' ? 'online' : 'offline',
        session.active === true ? 'active' : 'inactive',
        readPendingFlag(session, 'hasPendingPermissionRequests') ? 'permission' : 'no-permission',
        readPendingFlag(session, 'hasPendingUserActionRequests') ? 'action' : 'no-action',
        isThinking ? 'thinking' : 'idle',
    ].join('|');
}

export function useSessionListRenderableStatus(session: SessionRowStatusSource): SessionStatus {
    const statusPhaseKey = buildSessionStatusPhaseKey(session);
    const vibingIndex = React.useMemo(() => Math.floor(Math.random() * 1024), [statusPhaseKey]);
    return getSessionStatus(session, Date.now(), vibingIndex);
}
