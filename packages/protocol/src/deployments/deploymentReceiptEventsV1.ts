import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision,
  DeploymentTimestampV1Schema as timestamp } from './deploymentIdentifiersV1.js';
import { DeploymentTargetCredentialPrincipalV1Schema, DeploymentTargetRoleFailureV1Schema } from '../plugins/contributions/deploymentTargetRolesV1.js';
import { asProtocolZod, projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';
import { readDeploymentArtifactJsonBodyV1, type DeploymentArtifactContentReferenceV1,
  type OpenedDeploymentArtifactV1, type DeploymentArtifactReadFailureV1 } from './deploymentArtifactContentReferenceV1.js';
import { DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1 } from '../artifacts/deploymentArtifactKindsV1.js';
import { ActionInputIssueSchema } from '../actions/executor/actionInputValidation.js';
import { ActionFailureCauseV1Schema } from '../actions/actionExecutionResult.js';
import { DeploymentEnvironmentRefV1Schema } from './deploymentEnvironmentRefV1.js';
import { AutomationPluginEventRefSchema } from '../automations/automationTriggerProjectionV1.js';
import { AutomationEventFilterV1Schema } from '../automations/automationEventFilterV1.js';
import { AutomationEventSourceInstanceIdV1Schema } from '../automations/automationEventJsonBoundsV1.js';
import { AutomationTriggerIdSchema } from '../automations/automationTriggerIdentity.js';
import { AutomationIdV1Schema } from '../automations/automationIdV1.js';
import { DeploymentFailureRecoveryV1Schema } from './deploymentFailureRecoveryV1.js';
export { DeploymentReceiptSettlementFailureDetailsV1Schema, readDeploymentReceiptFailureCodeV1 } from './deploymentReceiptResultV1.js';

/** Private parser diagnostics contain schema facts, never rejected values or prose. */
export const DeploymentOutputValidationV1Schema = lazyZodSchema(() => z.strictObject({
  source: id, httpStatus: z.number().check(z.int()), issues: z.array(ActionInputIssueSchema),
}));

/** Content-free source authority diagnostics shared by Action, receipt and approval. */
export const DeploymentSourceAdmissionFailureV1Schema = lazyZodSchema(() => z.strictObject({
  phase: z.literal('deployment_source_admission'),
  reason: z.enum(['requester_authority_unavailable', 'session_requester_unavailable', 'requester_workspace_requires_owner']),
  requiredFact: z.enum(['verified_root_requester', 'unrestricted_workspace_requester']),
  remedy: z.enum(['retry_original_request', 'run_from_authorized_host']),
}));
export type DeploymentSourceAdmissionFailureV1 = z.infer<typeof DeploymentSourceAdmissionFailureV1Schema>;

/** One failure vocabulary for private receipt content and structural Events. */
export const DeploymentReceiptFailureV1Schema = lazyZodSchema(() => z.strictObject({
  code: id, phase: z.union([DeploymentTargetRoleFailureV1Schema.shape.phase,
    z.enum(['source', 'build', 'activate', 'restore', 'cleanup', 'observe', 'admission'])]),
  validation: z.optional(DeploymentOutputValidationV1Schema),
  sourceAdmission: z.optional(DeploymentSourceAdmissionFailureV1Schema),
  requiredFact: z.optional(z.union([DeploymentSourceAdmissionFailureV1Schema.shape.requiredFact,
    DeploymentFailureRecoveryV1Schema.shape.requiredFact])),
  remedy: z.optional(z.string().check(z.trim(), z.minLength(1))),
  failureCause: z.optional(ActionFailureCauseV1Schema),
  effectAttempted: z.optional(z.boolean()),
}));
export type DeploymentReceiptFailureV1 = z.infer<typeof DeploymentReceiptFailureV1Schema>;

/** Structural failure facts exposed by the exact receipt reader; private content stays host-owned. */
export const DeploymentReceiptFailureSummaryV1Schema = lazyZodSchema(() => z.strictObject({
  phase: DeploymentReceiptFailureV1Schema.shape.phase, code: DeploymentReceiptFailureV1Schema.shape.code,
  requiredFact: DeploymentReceiptFailureV1Schema.shape.requiredFact,
  remedy: DeploymentReceiptFailureV1Schema.shape.remedy,
}));

/** A reviewed candidate was refused before dispatch against this observed revision. */
export const DeploymentReviewConflictFailureDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: id, environmentId: id, targetLinkId: id,
  requiredFact: z.literal('currentEnvironmentRevision'), currentEnvironmentRevision: revision,
  remedy: z.string().check(z.trim(), z.minLength(1)),
}));

/** Secret-free receipt recovery coordinates retained by failed Action approvals. */
export const DeploymentExecutionFailureDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: id, environmentId: id, targetLinkId: id, deploymentId: id,
  failure: DeploymentReceiptFailureV1Schema,
  cleanupFailure: z.optional(z.strictObject({ ...DeploymentReceiptFailureV1Schema.shape, phase: z.literal('cleanup') })),
}));
export type DeploymentExecutionFailureDetailsV1 = z.infer<typeof DeploymentExecutionFailureDetailsV1Schema>;

export const DEPLOYMENT_RECEIPT_EVENT_REFS_V1 = {
  failed: { pluginId: 'happier.machine.services', localId: 'deployment-failed' },
  succeeded: { pluginId: 'happier.machine.services', localId: 'deployment-succeeded' },
} as const;
const sourceAddress = { v: z.literal(1), serverId: id, environmentId: id };
const periodMs = lazyZodSchema(() => z.number().check(z.int(), z.positive(), z.maximum(Number.MAX_SAFE_INTEGER)));
export const DeploymentReceiptEventSetupV1Schema = lazyZodSchema(() => z.strictObject({
  ...sourceAddress, targetLinkId: z.optional(id), periodMs: z.optional(periodMs),
}));
export const DeploymentReceiptEventSourceConfigV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...sourceAddress, observingSince: timestamp, periodMs: z.optional(periodMs),
    targetLinkId: z.optional(z.never()), credentialPrincipal: z.optional(z.never()) }),
  z.strictObject({ ...sourceAddress, observingSince: timestamp, periodMs: z.optional(periodMs),
    targetLinkId: id, credentialPrincipal: DeploymentTargetCredentialPrincipalV1Schema }),
]));
export type DeploymentReceiptEventSetupV1 = z.infer<typeof DeploymentReceiptEventSetupV1Schema>;
export type DeploymentReceiptEventSourceConfigV1 = z.infer<typeof DeploymentReceiptEventSourceConfigV1Schema>;
export const DeploymentReceiptEventPendingObservationV1Schema = lazyZodSchema(() => z.strictObject({
  periodMs: z.nullable(periodMs),
}));

/** Secret-free review facts; private configuration stays with the trigger owner. */
export const PlatformFailureEnrollmentSourceV1Schema = lazyZodSchema(() => z.strictObject({
  automationId: asProtocolZod(AutomationIdV1Schema), triggerId: AutomationTriggerIdSchema,
  eventRef: AutomationPluginEventRefSchema, sourceInstanceId: AutomationEventSourceInstanceIdV1Schema,
  filter: z.nullable(AutomationEventFilterV1Schema),
  pendingObservation: z.nullable(DeploymentReceiptEventPendingObservationV1Schema),
}));

/** Link observes receipts and sends Account notices; it does not arm Agent work. */
export const PlatformFailureEnrollmentReadBackV1Schema = lazyZodSchema(() => z.strictObject({
  deploymentEnvironment: DeploymentEnvironmentRefV1Schema,
  targetLinkId: id,
  controller: z.strictObject({ machineId: id, online: z.boolean() }),
  execution: z.literal('observationOnly'), approvalProfile: z.null(),
  disclosure: z.strictObject({ kind: z.literal('account_notices') }),
  sources: z.array(PlatformFailureEnrollmentSourceV1Schema),
}));
export const PlatformFailureEnrollmentV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.literal('enrolled'), ...PlatformFailureEnrollmentReadBackV1Schema.shape,
}));
export type PlatformFailureEnrollmentReadBackV1 = z.infer<typeof PlatformFailureEnrollmentReadBackV1Schema>;
export type PlatformFailureEnrollmentV1 = z.infer<typeof PlatformFailureEnrollmentV1Schema>;
export type PlatformFailureEnrollmentSourceV1 = z.infer<typeof PlatformFailureEnrollmentSourceV1Schema>;

/** Pending platform receipts need the person's configured observation period. Local receipt
 * wakes do not. This is a read-back of H3's source contract, never a timer or a default. */
export function readDeploymentReceiptEventPendingObservationV1(sourceConfig: unknown): Readonly<{ periodMs: number | null }> | null {
  const config = DeploymentReceiptEventSourceConfigV1Schema.safeParse(sourceConfig);
  return config.success && config.data.targetLinkId !== undefined
    ? { periodMs: config.data.periodMs ?? null } : null;
}
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
