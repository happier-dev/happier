import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

/** The private PR selector shared by comment and failed-check triggers. */
export const AutomationPullRequestTriggerSchema = lazyZodSchema(() => z.strictObject({
  kind: z.enum(['prComment', 'ciFailed']),
  pullRequest: z.strictObject({
    repository: z.string().check(z.minLength(1)),
    number: z.number().check(z.int(), z.positive(), z.int()),
  }),
}));
export type AutomationPullRequestTrigger = z.infer<typeof AutomationPullRequestTriggerSchema>;
