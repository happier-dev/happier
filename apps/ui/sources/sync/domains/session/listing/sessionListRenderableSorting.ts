import type { SessionListRenderableSession } from './sessionListRenderable';

export function resolveSessionListRenderableMeaningfulActivityAt(session: Readonly<{
    createdAt: number;
    meaningfulActivityAt?: number | null;
}>): number {
    return typeof session.meaningfulActivityAt === 'number'
        && Number.isFinite(session.meaningfulActivityAt)
        && session.meaningfulActivityAt > 0
        ? session.meaningfulActivityAt
        : session.createdAt;
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
        const previousUpdatedAt = resolveSessionListRenderableMeaningfulActivityAt(previous);
        const currentUpdatedAt = resolveSessionListRenderableMeaningfulActivityAt(current);
        if (currentUpdatedAt !== previousUpdatedAt ? currentUpdatedAt > previousUpdatedAt : current.id.localeCompare(previous.id) < 0) {
            isAlreadyNewestFirst = false;
            break;
        }
    }

    if (sessions.length > 1 && !isAlreadyNewestFirst) {
        sessions.sort((a, b) => {
            const left = resolveSessionListRenderableMeaningfulActivityAt(a);
            const right = resolveSessionListRenderableMeaningfulActivityAt(b);
            if (right !== left) return right - left;
            return a.id.localeCompare(b.id);
        });
    }

    return sessions;
}
