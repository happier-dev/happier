import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema } from './deploymentIdentifiersV1.js';
import { DeploymentSourceIntentV1Schema } from './storedAppInputV1.js';
import { ScmCommitOidSchema } from '../scm/commitPublication.js';

/** Authored deploy operands shared by deployment and token preparation. */
export const DeploymentDeploySemanticInputV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: DeploymentIdentifierV1Schema,
  environmentId: DeploymentIdentifierV1Schema,
  targetLinkId: z.optional(DeploymentIdentifierV1Schema),
  sourceIntent: z.optional(DeploymentSourceIntentV1Schema),
  whenBusy: z.optional(z.enum(['refuse', 'supersede'])),
}));
export type DeploymentDeploySemanticInputV1 = z.infer<typeof DeploymentDeploySemanticInputV1Schema>;

/** Exact compact intent; preparation pins the current link before approval. */
export const DeploymentDeployIntentInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...DeploymentDeploySemanticInputV1Schema.shape,
  sha: z.optional(ScmCommitOidSchema),
  requestKey: z.optional(DeploymentIdentifierV1Schema),
}).check(z.refine(input => input.sha === undefined || input.sourceIntent === undefined,
  { message: 'Select one exact source representation.' }),
  z.refine(input => input.sha === undefined && input.sourceIntent === undefined
    ? input.targetLinkId !== undefined : input.requestKey !== undefined,
  { message: 'Exact source requests require their originating request key.' })));
export type DeploymentDeployIntentInputV1 = z.infer<typeof DeploymentDeployIntentInputV1Schema>;
