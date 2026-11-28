import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentVolumeRemovalOutcomeV1Schema } from './deploymentVolumeRemovalV1.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision,
  DeploymentTimestampV1Schema as timestamp } from './deploymentIdentifiersV1.js';
import { DeploymentTargetCredentialPrincipalV1Schema, DeploymentTargetRoleFailureV1Schema, DeploymentTargetRoleResultV1Schema,
  type DeploymentTargetRoleResultV1 } from '../plugins/contributions/deploymentTargetRolesV1.js';
import { asProtocolZod, projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';
import { readDeploymentArtifactJsonBodyV1, deploymentArtifactReadFailureV1, type DeploymentArtifactContentReferenceV1,
  type OpenedDeploymentArtifactV1, type DeploymentArtifactReadFailureV1 } from './deploymentArtifactContentReferenceV1.js';
import { DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1 } from '../artifacts/deploymentArtifactKindsV1.js';
import { ActionInputIssueSchema } from '../actions/executor/actionInputValidation.js';
import { ActionFailureCauseV1Schema } from '../actions/actionExecutionResult.js';
import { DeploymentEnvironmentRefV1Schema } from './deploymentEnvironmentRefV1.js';
import type { AutomationPluginEventTrigger } from '../automations/automationTriggerProjectionV1.js';
import type { HealthCheckSubjectV1 } from './healthCheckSubjectV1.js';
import { AutomationEventFilterV1Schema } from '../automations/automationEventFilterV1.js';
import { AutomationEventSourceInstanceIdV1Schema } from '../automations/automationEventJsonBoundsV1.js';
import { AutomationPluginEventRefSchema, AutomationTriggerIdSchema } from '../automations/automationTriggerIdentity.js';
import { AutomationIdV1Schema } from '../automations/automationIdV1.js';
import { DeploymentFailureRecoveryV1Schema } from './deploymentFailureFactsV1.js';
import { DeploymentReviewRevisionV1Schema } from './deploymentSourceLabelV1.js';
import { DeploymentReceiptOperationV1Schema, DeploymentStateV1Schema } from './deploymentStateV1.js';
import * as receiptResult from './deploymentReceiptResultV1.js';
import { DeploymentFolderSourceIntentV1Schema, DeploymentRepositorySourceIntentV1Schema,
  DeploymentStoredDefinitionV1Schema, type DeploymentSourceIntentV1 } from './storedAppInputV1.js';

// Fast Refresh enumerates these exports while the cyclic result module is still
// loading. Forward on use so enumeration never reads its uninitialized exports.
export const DeploymentReceiptSettlementFailureDetailsV1Schema = lazyZodSchema(() =>
  receiptResult.DeploymentReceiptSettlementFailureDetailsV1Schema);
export function readDeploymentReceiptFailureCodeV1(
  state: z.infer<typeof DeploymentStateV1Schema>,
): ReturnType<typeof receiptResult.readDeploymentReceiptFailureCodeV1> {
  return receiptResult.readDeploymentReceiptFailureCodeV1(state);
}

/** Private parser diagnostics contain schema facts, never rejected values or prose. */
export const DeploymentOutputValidationV1Schema = lazyZodSchema(() => z.strictObject({
  source: id, httpStatus: z.optional(z.number().check(z.int())), issues: z.array(ActionInputIssueSchema),
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
  nativeCompose: DeploymentFailureRecoveryV1Schema.shape.nativeCompose,
  nativeActivation: DeploymentFailureRecoveryV1Schema.shape.nativeActivation,
  statefulService: DeploymentFailureRecoveryV1Schema.shape.statefulService,
  nativeCleanupWarnings: z.optional(z.array(receiptResult.DeploymentNativeCleanupWarningV1Schema)),
  effectAttempted: z.optional(z.boolean()),
}));
export type DeploymentReceiptFailureV1 = z.infer<typeof DeploymentReceiptFailureV1Schema>;

/** Structural failure facts exposed by the exact receipt reader; private content stays host-owned. */
export const DeploymentReceiptFailureSummaryV1Schema = lazyZodSchema(() => z.strictObject({
  phase: DeploymentReceiptFailureV1Schema.shape.phase, code: DeploymentReceiptFailureV1Schema.shape.code,
  requiredFact: DeploymentReceiptFailureV1Schema.shape.requiredFact,
  remedy: DeploymentReceiptFailureV1Schema.shape.remedy,
}));

/** Exact native receipt evidence without the private Compose document, selectors or logs. */
export const DeploymentReceiptInvestigationV1Schema = lazyZodSchema(() => z.strictObject({
  /** Exact Account-host source label; null means the Receipt did not establish it. */
  sourceLabel: z.optional(z.nullable(DeploymentReviewRevisionV1Schema)),
  source: z.optional(z.discriminatedUnion('kind', [
    z.extend(z.pick(DeploymentRepositorySourceIntentV1Schema, { kind: true, projectSourceId: true, sourceRevision: true, sha: true }),
      z.pick(DeploymentTargetRoleResultV1Schema, { builtSha: true }).shape),
    z.pick(DeploymentStoredDefinitionV1Schema, { kind: true, contentRevision: true, composeDigest: true }),
    z.pick(DeploymentFolderSourceIntentV1Schema, { kind: true, manifestFingerprint: true }),
  ])),
  failure: z.optional(DeploymentReceiptFailureV1Schema),
  volumeRemoval: z.optional(DeploymentVolumeRemovalOutcomeV1Schema),
}));
export type DeploymentReceiptInvestigationV1 = z.infer<typeof DeploymentReceiptInvestigationV1Schema>;

/** Only the Account-opened exact receipt owner supplies these private evidence facts. */
export function projectDeploymentReceiptInvestigationV1(content: Readonly<{
  sourceIntent?: DeploymentSourceIntentV1; failure?: DeploymentReceiptFailureV1;
  platform?: Readonly<{ observation: Pick<DeploymentTargetRoleResultV1, 'builtSha'> & Pick<DeploymentReceiptInvestigationV1, 'volumeRemoval'> }>;
}>): DeploymentReceiptInvestigationV1 {
  const source = content.sourceIntent;
  const volumeRemoval = content.platform?.observation.volumeRemoval;
  return {
    ...(source ? { source: source.kind === 'repository'
      ? { kind: source.kind, projectSourceId: source.projectSourceId, sourceRevision: source.sourceRevision, sha: source.sha,
          ...(content.platform?.observation.builtSha ? { builtSha: content.platform.observation.builtSha } : {}) }
      : source.kind === 'folder' ? { kind: source.kind, manifestFingerprint: source.manifestFingerprint }
        : { kind: source.kind, contentRevision: source.contentRevision, composeDigest: source.composeDigest } } : {}),
    ...(content.failure ? { failure: content.failure } : {}),
    ...(volumeRemoval ? { volumeRemoval } : {}),
  };
}

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
  logsAvailable: z.optional(z.boolean()),
  nativeCleanupWarnings: z.optional(z.array(receiptResult.DeploymentNativeCleanupWarningV1Schema)),
  cleanupFailure: z.optional(z.strictObject({ ...DeploymentReceiptFailureV1Schema.shape, phase: z.literal('cleanup') })),
}));
export type DeploymentExecutionFailureDetailsV1 = z.infer<typeof DeploymentExecutionFailureDetailsV1Schema>;

export const DEPLOYMENT_RECEIPT_EVENT_REFS_V1 = {
  failed: { pluginId: 'happier.machine.services', localId: 'deployment-failed' },
  succeeded: { pluginId: 'happier.machine.services', localId: 'deployment-succeeded' },
} as const;
/** Current receipt changes serve preview publication independently of platform outcome notices. */
export const DEPLOYMENT_RECEIPT_CHANGED_EVENT_REF_V1 = {
  pluginId: 'happier.machine.services', localId: 'deployment-receipt-changed',
} as const;
const sourceAddress = { v: z.literal(1), serverId: id, environmentId: z.optional(id) };
const periodMs = lazyZodSchema(() => z.number().check(z.int(), z.positive(), z.maximum(Number.MAX_SAFE_INTEGER)));
export const DeploymentReceiptEventSetupV1Schema = lazyZodSchema(() => z.strictObject({
  ...sourceAddress, targetLinkId: z.optional(id), periodMs: z.optional(periodMs), previewChildren: z.optional(z.literal(true)),
}).check(z.refine(input => input.environmentId !== undefined || input.targetLinkId === undefined && input.previewChildren === undefined,
  'Targeted observation requires an Environment')));
export const DeploymentReceiptEventSourceConfigV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...sourceAddress, observingSince: timestamp, periodMs: z.optional(periodMs),
    targetLinkId: z.optional(z.never()), credentialPrincipal: z.optional(z.never()), previewChildren: z.optional(z.literal(true))
  }).check(z.refine(input => input.environmentId !== undefined || input.previewChildren === undefined, 'Preview observation requires an Environment')),
  z.strictObject({ ...sourceAddress, environmentId: id, observingSince: timestamp, periodMs: z.optional(periodMs),
    targetLinkId: id, credentialPrincipal: DeploymentTargetCredentialPrincipalV1Schema, previewChildren: z.optional(z.never()) }),
]));
export type DeploymentReceiptEventSetupV1 = z.infer<typeof DeploymentReceiptEventSetupV1Schema>;
export type DeploymentReceiptEventSourceConfigV1 = z.infer<typeof DeploymentReceiptEventSourceConfigV1Schema>;
export function isDeploymentReceiptEventSourceV1(source: Pick<AutomationPluginEventTrigger, 'eventRef' | 'sourceContractVersion'>): boolean {
  return source.sourceContractVersion === 1 && Object.values(DEPLOYMENT_RECEIPT_EVENT_REFS_V1).some(ref =>
    ref.pluginId === source.eventRef.pluginId && ref.localId === source.eventRef.localId);
}

/** A receipt Event's saved source names its subject; this is no execution or lifecycle binding. */
export function readDeploymentReceiptEventSubjectV1(sourceConfig: unknown): HealthCheckSubjectV1 | null {
  const source = DeploymentReceiptEventSourceConfigV1Schema.safeParse(sourceConfig);
  return source.success && source.data.environmentId !== undefined
    ? { kind: 'environment', environmentId: source.data.environmentId } : null;
}
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
export const DeploymentReceiptChangedEventV1Schema = lazyZodSchema(() => z.strictObject({ ...receipt,
  operation: DeploymentReceiptOperationV1Schema, state: DeploymentStateV1Schema,
}));
export const DeploymentReceiptChangedEventV1ProtocolSchema = projectZodProtocolSchema(DeploymentReceiptChangedEventV1Schema);
export const DeploymentFailedEventV1Schema = lazyZodSchema(() => z.strictObject({ ...receipt,
  operation: DeploymentReceiptOperationV1Schema, state: z.literal('failed'),
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
  if (!opened.body || typeof opened.body !== 'object' || Array.isArray(opened.body)) return deploymentArtifactReadFailureV1('content');
  if (!('failure' in opened.body)) return { ok: true, failure: null };
  const failure = DeploymentReceiptFailureV1Schema.safeParse(opened.body.failure);
  return failure.success ? { ok: true, failure: failure.data } : deploymentArtifactReadFailureV1('content');
}

export const DeploymentAccountChangeHintV1Schema = lazyZodSchema(() => z.strictObject({
  deployment: z.strictObject({ projectSourceId: z.optional(id), environmentId: id,
    deploymentId: z.optional(id), activityChanged: z.optional(z.literal(true)),
    revision: revision }).check(z.refine(value => value.activityChanged !== true || value.deploymentId === undefined)),
}));
export type DeploymentAccountChangeIdentityV1 = Readonly<{ projectSourceId?: string; environmentId: string; deploymentId?: string; activityChanged?: true }>;

/** Producer-known Source routing survives both durable hints and content-free socket wakes. */
export function buildDeploymentAccountChangeV1(input: DeploymentAccountChangeIdentityV1 & Readonly<{ revision: number }>) {
  const hint = DeploymentAccountChangeHintV1Schema.parse({ deployment: input });
  const environment = encodeURIComponent(hint.deployment.environmentId);
  const identity = hint.deployment.activityChanged === true ? `deployment-activity:${environment}`
    : hint.deployment.deploymentId === undefined ? `deployment-environment:${environment}`
    : `deployment-receipt:${environment}:${encodeURIComponent(hint.deployment.deploymentId)}`;
  const entityId = hint.deployment.projectSourceId === undefined ? identity
    : `${identity}:${encodeURIComponent(hint.deployment.projectSourceId)}`;
  return { kind: 'account' as const, entityId, hint };
}

/** Reads both durable hints and the existing content-free socket entity-id wake. */
export function readDeploymentAccountChangeV1(change: Readonly<{ kind: string; entityId: string; hint?: unknown }>): DeploymentAccountChangeIdentityV1 | null {
  if (change.kind !== 'account') return null;
  try {
    const parts = change.entityId.split(':');
    const isReceipt = parts[0] === 'deployment-receipt';
    const activityChanged = parts[0] === 'deployment-activity' ? true : undefined;
    const legacyLength = isReceipt ? 3 : 2;
    if ((!isReceipt && !activityChanged && parts[0] !== 'deployment-environment') || (parts.length !== legacyLength && parts.length !== legacyLength + 1)) return null;
    const environmentId = id.parse(decodeURIComponent(parts[1]!));
    const deploymentId = isReceipt ? id.parse(decodeURIComponent(parts[2]!)) : undefined;
    // Retained unqualified feed rows stay conservative; no consumer guesses their Source.
    const projectSourceId = parts.length === legacyLength ? undefined
      : id.parse(decodeURIComponent(parts[legacyLength]!));
    if (change.hint !== undefined) {
      const hint = DeploymentAccountChangeHintV1Schema.safeParse(change.hint);
      if (!hint.success || hint.data.deployment.environmentId !== environmentId
        || hint.data.deployment.deploymentId !== deploymentId
        || hint.data.deployment.projectSourceId !== projectSourceId
        || hint.data.deployment.activityChanged !== activityChanged) return null;
    }
    return { environmentId, ...(deploymentId === undefined ? {} : { deploymentId }),
      ...(activityChanged ? { activityChanged } : {}),
      ...(projectSourceId === undefined ? {} : { projectSourceId }) };
  } catch { return null; }
}
