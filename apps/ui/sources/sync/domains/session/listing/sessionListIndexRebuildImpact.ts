import type { SessionListRenderableSession } from './sessionListRenderable';
import { didSessionListRenderableStructuralFieldsChange } from './sessionListRenderable';
import { resolveSessionListRenderableMeaningfulActivityAt } from './sessionListRenderableSorting';
export type SessionListIndexRebuildSettings = Readonly<{
    layoutV1?: 'projects' | 'recent_activity';
}>;

export function shouldRebuildSessionListIndexForRenderableChange(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
    settings?: SessionListIndexRebuildSettings | null,
): boolean {
    if (didSessionListRenderableStructuralFieldsChange(previous, next)) {
        return true;
    }
    const previousActivityAt = previous
        ? resolveSessionListRenderableMeaningfulActivityAt(previous)
        : null;
    const nextActivityAt = resolveSessionListRenderableMeaningfulActivityAt(next);
    if (!previous || previousActivityAt === nextActivityAt) {
        return false;
    }

    return settings?.layoutV1 === 'recent_activity';
}

export function shouldRebuildSessionListIndexForRowStateChange(
    previousRows: Readonly<Record<string, SessionListRenderableSession>> | null | undefined,
    nextRows: Readonly<Record<string, SessionListRenderableSession>> | null | undefined,
    settings?: SessionListIndexRebuildSettings | null,
): boolean {
    if (previousRows === nextRows) {
        return false;
    }
    if (!previousRows || !nextRows) {
        return previousRows !== nextRows;
    }

    const previousIds = Object.keys(previousRows);
    const nextIds = Object.keys(nextRows);
    if (previousIds.length !== nextIds.length) {
        return true;
    }

    for (const sessionId of previousIds) {
        const previous = previousRows[sessionId];
        const next = nextRows[sessionId];
        if (!previous || !next) {
            return true;
        }
        if (shouldRebuildSessionListIndexForRenderableChange(previous, next, settings)) {
            return true;
        }
    }

    return false;
}
