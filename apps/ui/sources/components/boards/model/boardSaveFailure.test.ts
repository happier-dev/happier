import { describe, expect, it } from 'vitest';
import { createWorkBoardArtifactPortV1} from '@happier-dev/protocol/boards/workBoardArtifactV1';
import { createWorkBoardV1, WorkBoardsV1Schema, type WorkBoardIntentV1 } from '@happier-dev/protocol/boards/workBoardV1';
import { createWorkBoardArtifactBoundary } from '@/dev/testkit/harness/workBoardArtifactBoundary';

import { resolveBoardSaveFailure, resolveCollectionSaveFailure } from './boardSaveFailure';
import { createWorkBoardSaveQueue, projectDisplayedWorkBoards } from './workBoardSaveQueue';

const rename = (boardId: string): WorkBoardIntentV1 => ({ kind: 'update', boardId, patch: { name: 'Renamed' } });

describe('resolveBoardSaveFailure', () => {
    it('shows a refused save on the board it was for, and nowhere else', () => {
        const failure = { intent: rename('b1'), reason: 'unavailable' as const };
        expect(resolveBoardSaveFailure({ pending: [], failure }, 'b1')).toBe(failure);
        expect(resolveBoardSaveFailure({ pending: [], failure }, 'b2')).toBeNull();
        expect(resolveBoardSaveFailure({ pending: [], failure: null }, 'b1')).toBeNull();
    });

    it('finds a refused create by the board it would have made, so its page can say why it is not there', () => {
        const failure = { intent: { kind: 'create', board: { id: 'b9', name: 'Release week' } } as const, reason: 'unavailable' as const };
        expect(resolveBoardSaveFailure({ pending: [], failure }, 'b9')).toBe(failure);
    });
});

describe('resolveCollectionSaveFailure', () => {
    it('keeps a board whose delete was refused and says so in the Boards collection, not only on that board', async () => {
        const acknowledged = WorkBoardsV1Schema.parse({ v: 1, boards: [createWorkBoardV1({ id: 'b1', name: 'Overview' }), createWorkBoardV1({ id: 'b2', name: 'Release' })] });
        const persistence = createWorkBoardArtifactBoundary(acknowledged);
        persistence.offline(true);
        const queue = createWorkBoardSaveQueue({ port: createWorkBoardArtifactPortV1(persistence.transport) });

        await queue.dispatch({ kind: 'delete', boardId: 'b2' });

        expect(projectDisplayedWorkBoards(acknowledged, queue.getState().pending).boards.map((board) => board.id)).toEqual(['b1', 'b2']);
        // The person was sent back to the collection while b1 is open there: the failure shows at the collection.
        expect(resolveCollectionSaveFailure(queue.getState(), 'b1')?.intent).toEqual({ kind: 'delete', boardId: 'b2' });
        // On b2's own page the board shows it instead, so the collection does not say it twice.
        expect(resolveCollectionSaveFailure(queue.getState(), 'b2')).toBeNull();
    });
});
