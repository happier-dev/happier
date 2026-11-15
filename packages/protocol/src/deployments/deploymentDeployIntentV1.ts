import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentRuntimeContentCasV1Schema } from './deploymentArtifactContentReferenceV1.js';
import { DeploymentPendingDeployV1Schema } from './storedAppInputV1.js';
import { DeploymentIdentifierV1Schema } from './deploymentIdentifiersV1.js';
import { DeploymentOnFailureV1Schema, DeploymentSourceIntentV1Schema, DeploymentSourceMethodV1Schema, DeploymentServiceSubsetV1Schema } from './storedAppInputV1.js';
import { ScmCommitOidSchema } from '../scm/commitPublication.js';

/** Authored deploy operands shared by deployment and token preparation. */
export const DeploymentDeploySemanticInputV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: DeploymentIdentifierV1Schema,
  environmentId: DeploymentIdentifierV1Schema,
  targetLinkId: z.optional(DeploymentIdentifierV1Schema),
  sourceIntent: z.optional(DeploymentSourceIntentV1Schema),
  sourceMethod: z.optional(DeploymentSourceMethodV1Schema),
  whenBusy: z.optional(z.enum(['refuse', 'supersede'])),
  onFailure: z.optional(DeploymentOnFailureV1Schema),
  services: z.optional(DeploymentServiceSubsetV1Schema),
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

export const DeploymentDeployInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...DeploymentRuntimeContentCasV1Schema.shape,
  whenBusy: z.optional(z.enum(['refuse', 'supersede'])),
  onFailure: z.optional(DeploymentOnFailureV1Schema),
  services: z.optional(DeploymentServiceSubsetV1Schema),
  pendingDeploy: z.optional(DeploymentPendingDeployV1Schema),
}).check(z.refine(input => input.pendingDeploy === undefined || input.whenBusy === 'supersede',
  { message: 'Retaining a pending intent requires explicit supersession.' }),
  z.refine(input => input.pendingDeploy?.t !== 'plain'
    || (input.pendingDeploy.v.requestKey === input.requestKey && input.pendingDeploy.v.targetLinkId === input.targetLinkId),
  { message: 'Pending intent must match the admitted deploy identity.' })));
export const DeploymentDeployActionInputV1Schema = lazyZodSchema(() => z.union([
  DeploymentDeployInputV1Schema, DeploymentDeployIntentInputV1Schema,
]));
export const DeploymentRollbackInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...DeploymentRuntimeContentCasV1Schema.shape,
  deploymentId: DeploymentIdentifierV1Schema.check(z.describe('Historical deployment receipt ID to roll back to, selected from deployments.receipts.list.')),
  restoreBackupId: z.optional(DeploymentIdentifierV1Schema.check(z.describe('Explicit backup ID to restore with this rollback; omit to roll back code only.'))),
}));
export const DeploymentRollbackIntentInputV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: DeploymentRuntimeContentCasV1Schema.shape.serverId,
  environmentId: DeploymentRuntimeContentCasV1Schema.shape.environmentId,
  deploymentId: DeploymentRollbackInputV1Schema.shape.deploymentId,
  requestKey: z.optional(DeploymentRuntimeContentCasV1Schema.shape.requestKey),
  restoreBackupId: DeploymentRollbackInputV1Schema.shape.restoreBackupId,
}));
export const DeploymentRollbackActionInputV1Schema = lazyZodSchema(() => z.union([
  DeploymentRollbackInputV1Schema, DeploymentRollbackIntentInputV1Schema,
]));
export type DeploymentDeployInputV1 = z.infer<typeof DeploymentDeployInputV1Schema>;
export type DeploymentDeployActionInputV1 = z.infer<typeof DeploymentDeployActionInputV1Schema>;
export type DeploymentRollbackInputV1 = z.infer<typeof DeploymentRollbackInputV1Schema>;
export type DeploymentRollbackIntentInputV1 = z.infer<typeof DeploymentRollbackIntentInputV1Schema>;
export type DeploymentRollbackActionInputV1 = z.infer<typeof DeploymentRollbackActionInputV1Schema>;
