import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision,
  DeploymentTimestampV1Schema as timestamp } from './deploymentIdentifiersV1.js';
import { DeploymentTargetRoleFailureV1Schema } from '../plugins/contributions/deploymentTargetRolesV1.js';
import { projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';
import { readDeploymentArtifactJsonBodyV1, type DeploymentArtifactContentReferenceV1,
  type OpenedDeploymentArtifactV1, type DeploymentArtifactReadFailureV1 } from './deploymentArtifactContentReferenceV1.js';
import { DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1 } from '../artifacts/deploymentArtifactKindsV1.js';
import { ActionInputIssueSchema } from '../actions/executor/actionInputValidation.js';

/** Private parser diagnostics contain schema facts, never rejected values or prose. */
export const DeploymentOutputValidationV1Schema = lazyZodSchema(() => z.strictObject({
  source: id, httpStatus: z.number().check(z.int()), issues: z.array(ActionInputIssueSchema),
}));

/** One failure vocabulary for private receipt content and structural Events. */
export const DeploymentReceiptFailureV1Schema = lazyZodSchema(() => z.strictObject({
  code: id, phase: z.union([DeploymentTargetRoleFailureV1Schema.shape.phase,
    z.enum(['source', 'build', 'activate', 'restore', 'cleanup', 'observe', 'admission'])]),
  validation: z.optional(DeploymentOutputValidationV1Schema),
}));
export type DeploymentReceiptFailureV1 = z.infer<typeof DeploymentReceiptFailureV1Schema>;

/** Secret-free receipt recovery coordinates retained by failed Action approvals. */
export const DeploymentExecutionFailureDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: id, environmentId: id, targetLinkId: id, deploymentId: id,
  failure: DeploymentReceiptFailureV1Schema,
  cleanupFailure: z.optional(z.strictObject({ ...DeploymentReceiptFailureV1Schema.shape, phase: z.literal('cleanup') })),
}));
export type DeploymentExecutionFailureDetailsV1 = z.infer<typeof DeploymentExecutionFailureDetailsV1Schema>;

export const DeploymentReceiptEventSetupV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), serverId: id, environmentId: id,
}));
export const DeploymentReceiptEventSourceConfigV1Schema = lazyZodSchema(() => z.strictObject({
  ...DeploymentReceiptEventSetupV1Schema.shape, observingSince: timestamp,
}));
export type DeploymentReceiptEventSetupV1 = z.infer<typeof DeploymentReceiptEventSetupV1Schema>;
export type DeploymentReceiptEventSourceConfigV1 = z.infer<typeof DeploymentReceiptEventSourceConfigV1Schema>;
const receipt = { environmentId: id, deploymentId: id, targetLinkId: id, receiptRevision: revision, observedAt: timestamp };
export const DeploymentFailedEventV1Schema = lazyZodSchema(() => z.strictObject({ ...receipt,
  operation: z.enum(['deploy', 'rollback', 'promote', 'teardown']), state: z.literal('failed'),
  phase: z.nullable(DeploymentReceiptFailureV1Schema.shape.phase),
  failureCode: z.nullable(DeploymentReceiptFailureV1Schema.shape.code),
}));
export const DeploymentRollbackCompletedEventV1Schema = lazyZodSchema(() => z.strictObject({ ...receipt,
  operation: z.literal('rollback'), state: z.literal('succeeded'),
}));
export const DeploymentReceiptEventSourceConfigV1ProtocolSchema = projectZodProtocolSchema(DeploymentReceiptEventSourceConfigV1Schema);
export const DeploymentReceiptEventSetupV1ProtocolSchema = projectZodProtocolSchema(DeploymentReceiptEventSetupV1Schema);
export const DeploymentFailedEventV1ProtocolSchema = projectZodProtocolSchema(DeploymentFailedEventV1Schema);
export const DeploymentRollbackCompletedEventV1ProtocolSchema = projectZodProtocolSchema(DeploymentRollbackCompletedEventV1Schema);
/** These receipt outcomes share a closed structural payload. Event selection
 * stays with the receipt adapter; private Artifact content is never needed. */
export const DeploymentReceiptOutcomeEventV1Schema = lazyZodSchema(() => z.strictObject({ ...receipt,
  operation: DeploymentFailedEventV1Schema.shape.operation,
  state: z.enum(['succeeded', 'cancelled', 'outcome_unknown']),
}));
export const DeploymentReceiptOutcomeEventV1ProtocolSchema = projectZodProtocolSchema(DeploymentReceiptOutcomeEventV1Schema);

/** Read only the consumed leaf, behind the existing exact Artifact identity owner.
 * Older receipts may have no failure detail; absence is explicitly unknown. */
export function readDeploymentReceiptEventFailureV1(reference: DeploymentArtifactContentReferenceV1,
  artifact: OpenedDeploymentArtifactV1 | null,
): Readonly<{ ok: true; failure: DeploymentReceiptFailureV1 | null }> | DeploymentArtifactReadFailureV1 {
  const opened = readDeploymentArtifactJsonBodyV1(reference, artifact, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1);
  if (!opened.ok) return opened;
  if (!opened.body || typeof opened.body !== 'object' || Array.isArray(opened.body)) return { ok: false, error: 'deployment_content_unavailable' };
  if (!('failure' in opened.body)) return { ok: true, failure: null };
  const failure = DeploymentReceiptFailureV1Schema.safeParse(opened.body.failure);
  return failure.success ? { ok: true, failure: failure.data } : { ok: false, error: 'deployment_content_unavailable' };
}
