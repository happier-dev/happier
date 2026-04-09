import type { SessionListRenderableSession } from './sessionListRenderable';
import { didSessionListRenderableStructuralFieldsChange } from './sessionListRenderable';

export function shouldRebuildSessionListIndexForRowStateChange(
    previousRows: Readonly<Record<string, SessionListRenderableSession>> | null | undefined,
    nextRows: Readonly<Record<string, SessionListRenderableSession>> | null | undefined,
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
        if (didSessionListRenderableStructuralFieldsChange(previous, next)) {
            return true;
        }
    }

    return false;
}
