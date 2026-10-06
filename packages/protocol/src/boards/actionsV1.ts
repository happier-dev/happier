import { z } from 'zod';

import { WorkBoardIntentV1Schema, WorkBoardV1StrictSchema } from './workBoardV1.js';

/** Closed V1 Action envelopes over the existing Board intent vocabulary. */
export const WorkBoardActionInputSchemasV1 = {
    'boards.list': z.object({}).strict(),
    'boards.apply': z.object({
        boardId: z.string().trim().min(1).optional(),
        intent: WorkBoardIntentV1Schema,
    }).strict().superRefine((input, context) => {
        const intentBoardId = input.intent.kind === 'create' ? input.intent.board.id : input.intent.boardId;
        if (input.boardId !== undefined && input.boardId !== intentBoardId) {
            context.addIssue({ code: 'custom', path: ['boardId'], message: 'Board id must match the intent target' });
        }
    }),
} as const;

export const WorkBoardActionOutputSchemasV1 = {
    'boards.list': z.object({ boards: z.array(WorkBoardV1StrictSchema) }).strict(),
    'boards.apply': z.object({
        boardId: z.string().trim().min(1),
        /** Delete has no remaining Board; all other intents return the acknowledged document. */
        board: WorkBoardV1StrictSchema.nullable(),
    }).strict(),
} as const;
