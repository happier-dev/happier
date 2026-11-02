import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { SCM_COMPARISON_VIEWS, ScmComparisonSourceSchema } from '../scm/comparison.js';

/** The same Session pane destination is retained across main and window presentation. */
export const SessionOpenDestinationSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('scmReview'),
  comparison: ScmComparisonSourceSchema,
  view: z.enum(SCM_COMPARISON_VIEWS),
  explain: z.optional(z.boolean()),
  comparisonId: z.optional(z.string().check(z.regex(/^[a-f0-9]{64}$/))),
}));
export type SessionOpenDestination = z.infer<typeof SessionOpenDestinationSchema>;
