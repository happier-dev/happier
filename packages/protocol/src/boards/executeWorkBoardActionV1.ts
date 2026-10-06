import type { ActionExecuteResult } from '../actions/actionExecutionResult.js';
import type { ActionExecutorContext } from '../actions/executor/types.js';
import { WorkBoardActionInputSchemasV1 } from './actionsV1.js';
import type { WorkBoardActionIdV1 } from './actionIdsV1.js';
import { WorkBoardMutationErrorV1, type WorkBoardArtifactPortV1 } from './workBoardArtifactV1.js';
import { WorkBoardWidgetMutationErrorV1 } from './workBoardV1.js';

export async function executeWorkBoardActionV1(
    port: Pick<WorkBoardArtifactPortV1, 'read' | 'apply'>,
    actionId: WorkBoardActionIdV1,
    input: unknown,
    signal?: AbortSignal,
    context?: ActionExecutorContext,
): Promise<ActionExecuteResult> {
    try {
        signal?.throwIfAborted();
        if (actionId === 'boards.list') {
            const boards = await port.read(signal);
            signal?.throwIfAborted();
            return { ok: true, result: { boards: boards.boards } };
        }
        const { intent: parsedIntent } = WorkBoardActionInputSchemasV1['boards.apply'].parse(input);
        // Action callers have no authoritative live membership. Position edits use the owner's
        // no-membership path, even if the caller copied a stale UI projection.
        const intent = parsedIntent.kind === 'set_positions'
            ? { kind: parsedIntent.kind, boardId: parsedIntent.boardId, positionsByItemRef: parsedIntent.positionsByItemRef }
            : parsedIntent.kind === 'remove_item'
                ? { kind: parsedIntent.kind, boardId: parsedIntent.boardId, ref: parsedIntent.ref }
                : parsedIntent;
        const boardId = intent.kind === 'create' ? intent.board.id : intent.boardId;
        const committed = await port.apply(intent, signal, context);
        signal?.throwIfAborted();
        return { ok: true, result: { boardId, board: committed.boards.find((candidate) => candidate.id === boardId) ?? null } };
    } catch (error) {
        if (error instanceof WorkBoardMutationErrorV1 || error instanceof WorkBoardWidgetMutationErrorV1) return { ok: false, errorCode: error.code, error: error.message };
        throw error;
    }
}
