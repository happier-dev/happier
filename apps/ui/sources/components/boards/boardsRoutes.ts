import { WORK_BOARD_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/boards/workBoardArtifactV1';

/** The Boards destination's routes. */
export const BOARDS_ROUTE = '/boards';

export function createBoardRoute(boardId: string): string {
    return `${BOARDS_ROUTE}/${encodeURIComponent(boardId)}`;
}

/** Typed Board Artifacts open their domain editor, never the generic note writer. */
export function readBoardArtifactRoute(artifact: Readonly<{
    id: string; header?: Readonly<{ kind?: string }> | null;
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
