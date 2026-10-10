import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { SessionWorkStateItemV1Schema, SessionWorkStateGoalCapabilitiesV1Schema } from '../sessions/work/state/sessionWorkStateV1.js';
import { SessionTurnInitiatorV1Schema } from '../sessions/turns/sessionTurnMutationV1.js';

/** Native goal usage is deliberately excluded; usage accounting owns tokensUsed. */
export const WorkflowSessionContextGoalV1Schema = lazyZodSchema(() => SessionWorkStateItemV1Schema.omit({ tokensUsed: true }).extend({
  goalCapabilities: SessionWorkStateGoalCapabilitiesV1Schema.strict().optional(),
}).strict());

export const WorkflowSessionContextV1Schema = lazyZodSchema(() => z.object({
  goal: WorkflowSessionContextGoalV1Schema.optional(),
  usage: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('accounted'), tokensUsed: z.number().finite().nonnegative() }).strict(),
    z.object({ kind: z.literal('unavailable') }).strict(),
  ]),
  turns: z.array(z.object({ initiator: SessionTurnInitiatorV1Schema, text: z.string() }).strict()),
  truncated: z.boolean(),
}).strict());
export type WorkflowSessionContextV1 = z.infer<typeof WorkflowSessionContextV1Schema>;
