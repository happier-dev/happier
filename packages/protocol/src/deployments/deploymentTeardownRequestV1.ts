import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema } from './deploymentIdentifiersV1.js';
import { DeploymentRuntimeContentCasV1Schema } from './deploymentArtifactContentReferenceV1.js';
import { WorkflowRunIdV1Schema, WorkflowInvocationRecordIdSchema } from '../workflows/workflowIdsV1.js';
import { DeploymentTeardownVolumesV1Schema } from './deploymentTeardownVolumesV1.js';

/** The controller selects the current runtime link unless the person names one. */
export const DeploymentTeardownRequestInputV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: DeploymentRuntimeContentCasV1Schema.shape.serverId,
  environmentId: DeploymentRuntimeContentCasV1Schema.shape.environmentId,
  targetLinkId: z.optional(DeploymentRuntimeContentCasV1Schema.shape.targetLinkId),
  requestKey: z.optional(DeploymentRuntimeContentCasV1Schema.shape.requestKey),
  reason: DeploymentTeardownReasonV1Schema,
  providerRemoval: z.optional(z.enum(['unlink', 'delete'])),
  removeEnvironment: z.optional(z.literal(true).check(z.describe('Also remove the saved Environment after teardown completes.'))),
  volumes: z.optional(DeploymentTeardownVolumesV1Schema.check(z.describe('Explicit volume keep/delete choices from the teardown preview. Omit to let preparation discover the inventory.'))),
  machines: DeploymentTeardownInputV1Schema.shape.machines,
  mode: z.optional(z.literal('preview').check(z.describe('Preview the teardown without applying it. Omit mode to request the reviewed teardown.'))),
}));
export type DeploymentTeardownRequestInputV1 = z.infer<typeof DeploymentTeardownRequestInputV1Schema>;

export const DEPLOYMENT_TEARDOWN_STEPS_V1 = ['admit', 'settleDeploy', 'removeTarget', 'removeDomain', 'removeRelease', 'withdrawBindings', 'verify'] as const;
export const DeploymentTeardownStepV1Schema = lazyZodSchema(() => z.enum(DEPLOYMENT_TEARDOWN_STEPS_V1));

/** Record-only final disposition. Native cleanup remains the signed teardown owner's effect. */
export const DeploymentTargetUnlinkInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...z.omit(DeploymentRuntimeContentCasV1Schema, { contentArtifactId: true, contentHeaderVersion: true, contentBodyVersion: true }).shape,
  detachKeepRunning: z.optional(z.boolean()), teardownDeploymentId: z.optional(DeploymentIdentifierV1Schema),
}).check(z.refine(input => input.detachKeepRunning !== true || input.teardownDeploymentId === undefined,
  { message: 'Choose a teardown receipt or explicit detach.' })));
export type DeploymentTargetUnlinkInputV1 = z.infer<typeof DeploymentTargetUnlinkInputV1Schema>;

export const DeploymentTeardownReasonV1Schema = lazyZodSchema(() => z.enum(['manual', 'previewClosed', 'move', 'decommission'])
  .check(z.describe('Why teardown is requested. Use manual for an explicit person or agent request.')));
/** Captured at teardown admission and retained alongside its final signed proof. */
export const DeploymentTeardownDispositionV1Schema = lazyZodSchema(() => z.object({ removeEnvironment: z.literal(true) }));
export const DeploymentTeardownInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...DeploymentRuntimeContentCasV1Schema.shape,
  reason: DeploymentTeardownReasonV1Schema,
  volumes: z.optional(DeploymentTeardownVolumesV1Schema),
  removeEnvironment: z.optional(DeploymentTeardownDispositionV1Schema.shape.removeEnvironment),
  machines: z.optional(z.array(DeploymentIdentifierV1Schema).check(z.minLength(1),
    z.refine(values => new Set(values).size === values.length, { message: 'Teardown Machines must be unique.' }))),
}));
export const DeploymentDataCreationReferenceV1Schema = lazyZodSchema(() => z.strictObject({
  runId: WorkflowRunIdV1Schema, invocationId: WorkflowInvocationRecordIdSchema,
}));
export type DeploymentDataCreationReferenceV1 = z.infer<typeof DeploymentDataCreationReferenceV1Schema>;
/** The host resolves exact authenticated creation custody before review. */
export const DeploymentTeardownIntentInputV1Schema = lazyZodSchema(() => z.extend(z.omit(DeploymentTeardownInputV1Schema, {
  contentArtifactId: true, contentHeaderVersion: true, contentBodyVersion: true,
}), { dataCreation: DeploymentDataCreationReferenceV1Schema }));
export type DeploymentTeardownIntentInputV1 = z.infer<typeof DeploymentTeardownIntentInputV1Schema>;
/** A target without a teardown role uses the existing record-only detach disposition. */
export const DeploymentTeardownDetachInputV1Schema = lazyZodSchema(() => z.safeExtend(DeploymentTargetUnlinkInputV1Schema, {
  detachKeepRunning: z.literal(true), reason: DeploymentTeardownReasonV1Schema,
}));
/** Complete empty History needs only the existing Environment disposition, never a deployment content artifact. */
export const DeploymentTeardownNothingDeployedInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...z.omit(DeploymentRuntimeContentCasV1Schema, { contentArtifactId: true, contentHeaderVersion: true, contentBodyVersion: true }).shape, reason: DeploymentTeardownReasonV1Schema,
  nothingDeployed: z.literal(true), removeEnvironment: z.literal(true),
  volumes: z.optional(DeploymentTeardownVolumesV1Schema.check(z.length(0))),
}));
export type DeploymentTeardownNothingDeployedInputV1 = z.infer<typeof DeploymentTeardownNothingDeployedInputV1Schema>;
export const DeploymentTeardownPreparedInputV1Schema = lazyZodSchema(() => z.union([
  DeploymentTeardownInputV1Schema, DeploymentTeardownDetachInputV1Schema, DeploymentTeardownNothingDeployedInputV1Schema,
]));
export type DeploymentTeardownPreparedInputV1 = z.infer<typeof DeploymentTeardownPreparedInputV1Schema>;
export const DeploymentTeardownActionInputV1Schema = lazyZodSchema(() => z.union([
  DeploymentTeardownPreparedInputV1Schema, DeploymentTeardownIntentInputV1Schema,
  DeploymentTeardownRequestInputV1Schema,
  // Native inventory belongs to the own-server owner, never the caller.
  z.omit(DeploymentTeardownInputV1Schema, { contentArtifactId: true, contentHeaderVersion: true, contentBodyVersion: true }),
]));
export type DeploymentTeardownActionInputV1 = z.infer<typeof DeploymentTeardownActionInputV1Schema>;
export const DeploymentTeardownAdmissionInputV1Schema = lazyZodSchema(() => z.extend(DeploymentTeardownInputV1Schema, {
  actionOperationId: DeploymentIdentifierV1Schema,
}));
export const DeploymentTeardownActionAdmissionInputV1Schema = lazyZodSchema(() => z.union([
  DeploymentTeardownAdmissionInputV1Schema, DeploymentTeardownDetachInputV1Schema, DeploymentTeardownNothingDeployedInputV1Schema,
]));
export type DeploymentTeardownInputV1 = z.infer<typeof DeploymentTeardownInputV1Schema>;
export type DeploymentTeardownAdmissionInputV1 = z.infer<typeof DeploymentTeardownAdmissionInputV1Schema>;
