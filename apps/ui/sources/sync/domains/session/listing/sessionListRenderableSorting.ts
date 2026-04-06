import type { SessionListRenderableSession } from './sessionListRenderable';

export function compareSessionsStableNewestFirst(
    a: SessionListRenderableSession,
    b: SessionListRenderableSession,
): number {
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return a.id.localeCompare(b.id);
}

export function isSessionListRenderableSessionsAlreadyNewestFirst(
    sessions: ReadonlyArray<SessionListRenderableSession>,
): boolean {
    if (sessions.length < 2) return true;

    for (let index = 1; index < sessions.length; index += 1) {
        if (compareSessionsStableNewestFirst(sessions[index - 1], sessions[index]) > 0) {
            return false;
        }
    }

    return true;
}

export function sortSessionListRenderableSessionsNewestFirstIfNeeded(
    sessions: SessionListRenderableSession[],
): SessionListRenderableSession[] {
    if (sessions.length > 1 && !isSessionListRenderableSessionsAlreadyNewestFirst(sessions)) {
        sessions.sort(compareSessionsStableNewestFirst);
    }

    return sessions;
}
