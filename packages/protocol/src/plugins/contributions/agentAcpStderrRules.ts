import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';

const matchRule = lazyZodSchema(() => z.object({
  includes: z.array(z.string().min(1)).min(1), caseSensitive: z.boolean().optional(),
}).strict());

/** The same closed declarative rules feed contributed and configured ACP runtimes. */
export const PluginAgentAcpStderrRulesV2Schema = lazyZodSchema(() => z.object({
  authenticationErrorDetail: z.string().trim().min(1).optional(),
  suppress: z.array(matchRule).min(1).optional(),
  statusErrors: z.array(matchRule.extend({ detail: z.string().min(1) }).strict()).min(1).optional(),
}).strict().refine(
  value => value.authenticationErrorDetail !== undefined || value.suppress !== undefined || value.statusErrors !== undefined,
  'ACP stderr rules must declare at least one rule.',
));
export type PluginAgentAcpStderrRulesV2 = z.infer<typeof PluginAgentAcpStderrRulesV2Schema>;
