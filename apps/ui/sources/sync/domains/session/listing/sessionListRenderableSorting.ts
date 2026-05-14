import type { SessionListRenderableSession } from './sessionListRenderable';

export function resolveSessionListRenderableUpdatedAt(session: SessionListRenderableSession): number {
    return Number.isFinite(session.updatedAt) && session.updatedAt > 0 ? session.updatedAt : session.createdAt;
}

export function sortSessionListRenderableSessionsNewestFirstIfNeeded(
    sessions: SessionListRenderableSession[],
): SessionListRenderableSession[] {
    let isAlreadyNewestFirst = true;
    for (let index = 1; index < sessions.length; index += 1) {
        const previous = sessions[index - 1];
        const current = sessions[index];
        if (current.createdAt !== previous.createdAt ? current.createdAt > previous.createdAt : current.id.localeCompare(previous.id) < 0) {
            isAlreadyNewestFirst = false;
            break;
        }
    }

    if (sessions.length > 1 && !isAlreadyNewestFirst) {
        sessions.sort((a, b) => {
            if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
            return a.id.localeCompare(b.id);
        });
    }

    return sessions;
}

export function sortSessionListRenderableSessionsNewestUpdatedFirstIfNeeded(
    sessions: SessionListRenderableSession[],
): SessionListRenderableSession[] {
    let isAlreadyNewestFirst = true;
    for (let index = 1; index < sessions.length; index += 1) {
        const previous = sessions[index - 1];
        const current = sessions[index];
        const previousUpdatedAt = resolveSessionListRenderableUpdatedAt(previous);
        const currentUpdatedAt = resolveSessionListRenderableUpdatedAt(current);
        if (currentUpdatedAt !== previousUpdatedAt ? currentUpdatedAt > previousUpdatedAt : current.id.localeCompare(previous.id) < 0) {
            isAlreadyNewestFirst = false;
            break;
        }
    }

    if (sessions.length > 1 && !isAlreadyNewestFirst) {
        sessions.sort((a, b) => {
            const left = resolveSessionListRenderableUpdatedAt(a);
            const right = resolveSessionListRenderableUpdatedAt(b);
            if (right !== left) return right - left;
            return a.id.localeCompare(b.id);
        });
    }

    return sessions;
}
