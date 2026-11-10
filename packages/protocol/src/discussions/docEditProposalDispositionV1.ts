import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ArtifactRevisionV1Schema } from '../artifacts/artifactRevisionV1.js';
import { DiscussionAccountIdSchema } from './references.js';

/** Host-authenticated decision output, never part of authored content or retry equality. */
export const DocEditProposalDispositionV1Schema = lazyZodSchema(() => {
  const decidedBy = z.strictObject({
    accountId: DiscussionAccountIdSchema,
    atMs: z.number().check(z.int(), z.nonnegative()),
  });
  return z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('open') }),
    z.strictObject({ state: z.literal('accepted'), acceptedRevision: ArtifactRevisionV1Schema, decidedBy }),
    z.strictObject({ state: z.literal('declined'), decidedBy }),
  ]);
});
export type DocEditProposalDispositionV1 = z.infer<typeof DocEditProposalDispositionV1Schema>;
