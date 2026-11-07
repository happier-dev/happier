import { WORK_BOARD_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/boards/workBoardArtifactV1';
import { normalizeSessionListFilterV1, SessionListFilterV1Schema, type SessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';

/** The Boards destination's routes. */
export const BOARDS_ROUTE = '/boards';

export function createBoardRoute(boardId: string): string {
    return `${BOARDS_ROUTE}/${encodeURIComponent(boardId)}`;
}

/** A live, read-only filter view, not a saved Board or a coordinator-specific store. */
export function createFilteredBoardRoute(filter: SessionListFilterV1): string {
    return `${BOARDS_ROUTE}?filter=${encodeURIComponent(JSON.stringify(normalizeSessionListFilterV1(SessionListFilterV1Schema.parse(filter))))}`;
}

export function readFilteredBoardRoute(value: unknown): SessionListFilterV1 | null {
    if (typeof value !== 'string') return null;
    try {
        const parsed = SessionListFilterV1Schema.safeParse(JSON.parse(value));
        return parsed.success ? normalizeSessionListFilterV1(parsed.data) : null;
    } catch { return null; }
}

/** Typed Board Artifacts open their domain editor, never the generic note writer. */
export function readBoardArtifactRoute(artifact: Readonly<{
    id: string; header?: Readonly<{ kind?: unknown }> | null;
}> | null): string | null {
    return artifact?.header?.kind === WORK_BOARD_ARTIFACT_KIND_V1 ? createBoardRoute(artifact.id) : null;
}

/** The board a `/boards/<id>` route has open, or `null` on the index. */
export function readOpenBoardId(pathname: string): string | null {
    const match = /^\/boards\/([^/?#]+)/.exec(pathname);
    if (!match) return null;
    try {
        return decodeURIComponent(match[1]!);
    } catch {
        return match[1]!;
    }
}
