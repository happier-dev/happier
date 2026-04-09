import type { SessionListRenderableSession } from './sessionListRenderable';

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
