import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';

const matchRule = lazyZodSchema(() => z.strictObject({
  includes: z.array(z.string().check(z.minLength(1))).check(z.minLength(1)), caseSensitive: z.optional(z.boolean()),
}));

/** The same closed declarative rules feed contributed and configured ACP runtimes. */
export const PluginAgentAcpStderrRulesV2Schema = lazyZodSchema(() => z.strictObject({
  authenticationErrorDetail: z.optional(z.string().check(z.trim(), z.minLength(1))),
  suppress: z.optional(z.array(matchRule).check(z.minLength(1))),
  statusErrors: z.optional(z.array((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(matchRule, { detail: z.string().check(z.minLength(1)) }))).check(z.minLength(1))),
}).check(z.refine(value => value.authenticationErrorDetail !== undefined || value.suppress !== undefined || value.statusErrors !== undefined, 'ACP stderr rules must declare at least one rule.')));
export type PluginAgentAcpStderrRulesV2 = z.infer<typeof PluginAgentAcpStderrRulesV2Schema>;
