import type { WorkBoardIntentV1 } from '@happier-dev/protocol/boards/workBoardV1';

import type { WorkBoardSaveFailure, WorkBoardSaveState } from './workBoardSaveQueue';

function intentBoardId(intent: WorkBoardIntentV1): string {
    return intent.kind === 'create' ? intent.board.id : intent.boardId;
}

/**
 * The refused save that belongs on this board's page: the queue holds one failure for the whole Home,
 * and it shows only where its edit was aimed — a refused create included, so a board that was never
 * made says why instead of reading as gone.
 */
export function resolveBoardSaveFailure(state: WorkBoardSaveState, boardId: string): WorkBoardSaveFailure | null {
    const failure = state.failure;
    return failure && intentBoardId(failure.intent) === boardId ? failure : null;
}

/**
 * The refused save the Boards collection says: every failure except the one the open board already
 * shows. A refused delete lands here — the person was sent back to the collection, and the board,
 * still acknowledged, is listed again.
 */
export function resolveCollectionSaveFailure(state: WorkBoardSaveState, openBoardId: string | null): WorkBoardSaveFailure | null {
    const failure = state.failure;
    return failure && intentBoardId(failure.intent) !== openBoardId ? failure : null;
}
