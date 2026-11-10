import { z } from '../zodRuntimePolicy.js';

import { WorkBoardIntentV1Schema, WorkBoardV1StrictSchema } from './workBoardV1.js';

/** Closed V1 Action envelopes over the existing Board intent vocabulary. */
export const WorkBoardActionInputSchemasV1 = {
    'boards.list': z.strictObject({}),
    'boards.apply': z.strictObject({
        boardId: z.optional(z.string().check(z.trim(), z.minLength(1))),
        intent: WorkBoardIntentV1Schema,
    }).check(z.superRefine((input, context) => {
        const intentBoardId = input.intent.kind === 'create' ? input.intent.board.id : input.intent.boardId;
        if (input.boardId !== undefined && input.boardId !== intentBoardId) {
            context.addIssue({ code: 'custom', path: ['boardId'], message: 'Board id must match the intent target' });
        }
    })),
} as const;

export const WorkBoardActionOutputSchemasV1 = {
    'boards.list': z.strictObject({ boards: z.array(WorkBoardV1StrictSchema) }),
    'boards.apply': z.strictObject({
        boardId: z.string().check(z.trim(), z.minLength(1)),
        /** Delete has no remaining Board; all other intents return the acknowledged document. */
        board: z.nullable(WorkBoardV1StrictSchema),
    }),
} as const;
