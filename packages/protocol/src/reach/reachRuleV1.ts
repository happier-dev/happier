import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ReachPlaceV1Schema } from './reachPlaceV1.js';

export const ReachRuleV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.minLength(1)), target: ReachPlaceV1Schema, agentId: z.optional(z.string().check(z.minLength(1))),
  enabled: z.boolean(), createdAt: z.number(), updatedAt: z.number(),
}));
export type ReachRuleV1 = z.infer<typeof ReachRuleV1Schema>;
export type ReachRulesV1 = readonly ReachRuleV1[];
export const ReachRuleDraftV1Schema = lazyZodSchema(() => z.pick(ReachRuleV1Schema, { target: true, agentId: true, enabled: true }));
export type ReachRuleDraftV1 = Readonly<z.infer<typeof ReachRuleDraftV1Schema>>;
export const SkillRuleV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ReachRuleV1Schema, { skillId: z.string().check(z.minLength(1)) })));
export type SkillRuleV1 = z.infer<typeof SkillRuleV1Schema>;
