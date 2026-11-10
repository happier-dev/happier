import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginDiagnosticRemediationV1Schema } from '../../daemon/pluginContributionIntrospection.js';

/** The existing public contributed Action refusal, shared by RPCs and finite receipts. */
export const PluginActionFailureResponseV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(false),
  code: z.string().check(z.trim(), z.minLength(1)),
  retryable: z.optional(z.boolean()),
  actionHandlerInvocation: z.optional(z.literal('notStarted')),
  message: z.optional(z.string().check(z.trim(), z.minLength(1))),
  remediation: z.optional(PluginDiagnosticRemediationV1Schema),
}));
