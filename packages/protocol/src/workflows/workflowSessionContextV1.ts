import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { SessionWorkStateItemV1Schema, SessionWorkStateGoalCapabilitiesV1Schema } from '../sessions/work/state/sessionWorkStateV1.js';
import { SessionTurnInitiatorV1Schema } from '../sessions/turns/sessionTurnMutationV1.js';

/** Native goal usage is deliberately excluded; usage accounting owns tokensUsed. */
export const WorkflowSessionContextGoalV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(SessionWorkStateItemV1Schema, { tokensUsed: true }), {
  goalCapabilities: z.optional((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(SessionWorkStateGoalCapabilitiesV1Schema)),
})));

export const WorkflowSessionContextV1Schema = lazyZodSchema(() => z.strictObject({
  goal: z.optional(WorkflowSessionContextGoalV1Schema),
  usage: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('accounted'), tokensUsed: z.number().check(z.nonnegative()) }),
    z.strictObject({ kind: z.literal('unavailable') }),
  ]),
  turns: z.array(z.strictObject({ initiator: SessionTurnInitiatorV1Schema, text: z.string() })),
  truncated: z.boolean(),
}));
export type WorkflowSessionContextV1 = z.infer<typeof WorkflowSessionContextV1Schema>;
