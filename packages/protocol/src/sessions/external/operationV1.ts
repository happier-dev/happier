import { z } from 'zod';

import { SessionIdSchema } from '../idsV1.js';
import { AbsoluteWorkspacePathSchema } from '../../workspaces/locationSchema.js';
import { LinkedExternalSessionQualifiedIdentityV1Schema } from './linkedSessionMetadata.js';
import {
  ExternalSessionAgentIdSchema,
  ExternalSessionRefSchema,
  ExternalSessionSourceIdSchema,
} from './sourceCatalog.js';
import { ExternalSessionTakeoverStorageModeV1Schema } from './takeoverV1.js';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";

const OperationIdSchema = z.string().trim().min(1).max(256);
const OperationReferenceIdSchema = z.string().trim().min(1).max(512);
const OperationSourceCursorEvidenceSchema = z.string().trim().min(1).max(4_096);
const OperationGenerationSchema = z.string().trim().min(1).max(256);
const OperationTimestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const OperationRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const OperationCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const OperationServerSequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * The local working directory selected on the linked owner machine before a
 * takeover is admitted. It is retained in semantic operation state and the
 * owner-only operation progress, never in the shared recipient presentation.
 */
export const ExternalSessionTakeoverTargetDirectoryV1Schema = z.string()
  .min(1)
  .max(10_000)
  .refine(
    (value) => AbsoluteWorkspacePathSchema.safeParse(value).success,
    'takeover target directory must be an absolute workspace path',
  );

export const ExternalSessionOperationAuthorIntentV1Schema = z.discriminatedUnion('kind', [
  z.object({
    v: z.literal(1),
    surface: z.literal('plugin'),
    kind: z.literal('takeover'),
    agentId: ExternalSessionAgentIdSchema,
    sourceId: ExternalSessionSourceIdSchema,
    remoteSessionId: ExternalSessionRefSchema.shape.remoteSessionId,
    targetStorageMode: ExternalSessionTakeoverStorageModeV1Schema,
  }).strict(),
  z.object({
    v: z.literal(1),
    surface: z.literal('plugin'),
    kind: z.literal('materialize'),
    sessionId: asProtocolZod(SessionIdSchema),
    targetStorageMode: z.literal('external-linked'),
  }).strict(),
]);
export type ExternalSessionOperationAuthorIntentV1 = z.infer<
  typeof ExternalSessionOperationAuthorIntentV1Schema
>;

export const ExternalSessionOperationPlanV1Schema = z.enum(['materialize', 'takeover']);
export type ExternalSessionOperationPlanV1 = z.infer<
  typeof ExternalSessionOperationPlanV1Schema
>;

export const ExternalSessionOperationPhaseV1Schema = z.enum([
  'validating',
  'quiescing',
  'staging',
  'importing',
  'final_catch_up',
  'admitting',
  'spawning',
  'finalizing',
  'publishing',
]);
export type ExternalSessionOperationPhaseV1 = z.infer<
  typeof ExternalSessionOperationPhaseV1Schema
>;

export const ExternalSessionOperationStatusV1Schema = z.enum([
  'running',
  'awaiting_user_resume',
  'cancel_requested',
  'cancelled',
  'failed',
  'reconciliation_required',
  'completed',
  'discarded',
]);
export type ExternalSessionOperationStatusV1 = z.infer<
  typeof ExternalSessionOperationStatusV1Schema
>;

export const ExternalSessionStorageStateV1Schema = z.enum([
  'machine_only',
  'server_partial',
  'snapshot_complete',
  'hosted',
  'legacy_external_unknown',
]);
export type ExternalSessionStorageStateV1 = z.infer<
  typeof ExternalSessionStorageStateV1Schema
>;

const ExternalSessionOperationSourceBindingV1Schema = z.object({
  machineId: OperationIdSchema,
  remoteSessionId: z.string().trim().min(1).max(2_000),
  qualifiedIdentity: LinkedExternalSessionQualifiedIdentityV1Schema,
  linkGeneration: OperationGenerationSchema,
  sourceGeneration: OperationGenerationSchema,
  contributionGeneration: OperationGenerationSchema,
}).strict();

const ExternalSessionMaterializeRequestV1Schema = z.object({
  v: z.literal(1),
  idempotencyKey: OperationIdSchema,
  sessionId: asProtocolZod(SessionIdSchema),
  source: ExternalSessionOperationSourceBindingV1Schema,
  plan: z.literal('materialize'),
  targetStorageMode: z.literal('external-linked'),
  targetRuntimeMode: z.null(),
}).strict();

const ExternalSessionTakeoverRequestV1Schema = z.object({
  v: z.literal(1),
  idempotencyKey: OperationIdSchema,
  sessionId: asProtocolZod(SessionIdSchema),
  source: ExternalSessionOperationSourceBindingV1Schema,
  plan: z.literal('takeover'),
  targetStorageMode: ExternalSessionTakeoverStorageModeV1Schema,
  targetDirectory: ExternalSessionTakeoverTargetDirectoryV1Schema,
  // Remote takeover is explicitly outside ES-EXTERNAL-SESSIONS-v1.
  targetRuntimeMode: z.literal('terminal'),
}).strict();

/**
 * Immutable identity used by the narrow operation owner for idempotency.
 * The complete source/plan/target request is retained so equality never relies
 * on a content-derived digest or a caller-supplied semantic hash.
 */
export const ExternalSessionOperationSemanticRequestV1Schema = z.discriminatedUnion('plan', [
  ExternalSessionMaterializeRequestV1Schema,
  ExternalSessionTakeoverRequestV1Schema,
]);
export type ExternalSessionOperationSemanticRequestV1 = z.infer<
  typeof ExternalSessionOperationSemanticRequestV1Schema
>;

export const EXTERNAL_SESSION_OPERATION_TIMELINES_V1 = Object.freeze({
  materialize: Object.freeze([
    'validating',
    'staging',
    'importing',
    'publishing',
  ]),
  takeover_external_linked: Object.freeze([
    'validating',
    'quiescing',
    'admitting',
    'spawning',
    'finalizing',
  ]),
  takeover_persisted: Object.freeze([
    'validating',
    'quiescing',
    'staging',
    'importing',
    'final_catch_up',
    'admitting',
    'spawning',
    'finalizing',
  ]),
} as const satisfies Readonly<Record<string, readonly ExternalSessionOperationPhaseV1[]>>);

export type ExternalSessionOperationTimelineKindV1 =
  keyof typeof EXTERNAL_SESSION_OPERATION_TIMELINES_V1;

type ExternalSessionOperationPlanTargetV1 = Readonly<
  | {
    plan: 'materialize';
    targetStorageMode: 'external-linked';
  }
  | {
    plan: 'takeover';
    targetStorageMode: 'external-linked' | 'persisted';
  }
>;

function resolveTimelineKind(
  request: ExternalSessionOperationPlanTargetV1,
): ExternalSessionOperationTimelineKindV1 {
  if (request.plan === 'materialize') return 'materialize';
  return request.targetStorageMode === 'persisted'
    ? 'takeover_persisted'
    : 'takeover_external_linked';
}

function resolveTimelineFromPlanTarget(
  request: ExternalSessionOperationPlanTargetV1,
): readonly ExternalSessionOperationPhaseV1[] {
  return EXTERNAL_SESSION_OPERATION_TIMELINES_V1[resolveTimelineKind(request)];
}

export function resolveExternalSessionOperationTimelineV1(
  requestInput: ExternalSessionOperationSemanticRequestV1,
): readonly ExternalSessionOperationPhaseV1[] {
  const request = ExternalSessionOperationSemanticRequestV1Schema.parse(requestInput);
  return resolveTimelineFromPlanTarget(request);
}

export const ExternalSessionMaterializationPublicationV1Schema = z.object({
  materializationPublicationId: OperationIdSchema,
  materializedThroughSourceAt: OperationTimestampSchema,
  publishedThroughServerSeq: OperationServerSequenceSchema,
}).strict();
export type ExternalSessionMaterializationPublicationV1 = z.infer<
  typeof ExternalSessionMaterializationPublicationV1Schema
>;

export const ExternalSessionPriorStableStorageV1Schema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('machine_only'),
  }).strict(),
  z.object({
    state: z.literal('snapshot_complete'),
    publication: ExternalSessionMaterializationPublicationV1Schema,
  }).strict(),
]);
export type ExternalSessionPriorStableStorageV1 = z.infer<
  typeof ExternalSessionPriorStableStorageV1Schema
>;

export const EXTERNAL_SESSION_REQUIRED_ITEM_DIAGNOSTIC_CAP_V1 = 32;

export const ExternalSessionRequiredItemDiagnosticV1Schema = z.object({
  category: z.enum(['record', 'media', 'conversion']),
  sourceGeneration: OperationGenerationSchema,
  sourcePageIndex: OperationCountSchema,
  sourceItemIndex: OperationCountSchema,
}).strict();
export type ExternalSessionRequiredItemDiagnosticV1 = z.infer<
  typeof ExternalSessionRequiredItemDiagnosticV1Schema
>;

export const ExternalSessionRequiredItemFailuresV1Schema = z.object({
  total: OperationCountSchema,
  record: OperationCountSchema,
  media: OperationCountSchema,
  conversion: OperationCountSchema,
  diagnosticsTruncated: z.boolean(),
  diagnostics: z
    .array(ExternalSessionRequiredItemDiagnosticV1Schema)
    .max(EXTERNAL_SESSION_REQUIRED_ITEM_DIAGNOSTIC_CAP_V1)
    .readonly()
    .optional(),
}).strict().superRefine((failures, context) => {
  if (failures.record + failures.media + failures.conversion !== failures.total) {
    context.addIssue({
      code: 'custom',
      path: ['total'],
      message: 'Required-item failure total must equal the categorized failure counts.',
    });
  }
  if (failures.diagnostics) {
    const expectedDiagnosticCount = Math.min(
      failures.total,
      EXTERNAL_SESSION_REQUIRED_ITEM_DIAGNOSTIC_CAP_V1,
    );
    if (failures.diagnostics.length !== expectedDiagnosticCount) {
      context.addIssue({
        code: 'custom',
        path: ['diagnostics'],
        message: 'Required-item diagnostics must cover every failure up to the diagnostic cap.',
      });
    }
    if (
      failures.diagnosticsTruncated
      !== (failures.total > EXTERNAL_SESSION_REQUIRED_ITEM_DIAGNOSTIC_CAP_V1)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['diagnosticsTruncated'],
        message: 'Required-item diagnostic truncation must reflect the bounded diagnostic cap.',
      });
    }
  }
});
export type ExternalSessionRequiredItemFailuresV1 = z.infer<
  typeof ExternalSessionRequiredItemFailuresV1Schema
>;

export const ExternalSessionOperationCheckpointV1Schema = z.object({
  sourcePagesRead: OperationCountSchema,
  stagedItemCount: OperationCountSchema,
  importedItemCount: OperationCountSchema,
  totalItemEstimate: OperationCountSchema.optional(),
  requiredItemFailures: ExternalSessionRequiredItemFailuresV1Schema,
  /**
   * The current import job's acknowledged server ceiling. This is not a
   * session publication watermark and cannot outlive the operation binding.
   */
  acceptedThroughServerSeq: OperationServerSequenceSchema.optional(),
  acknowledgedBatchId: OperationReferenceIdSchema.optional(),
}).strict().superRefine((checkpoint, context) => {
  if (
    checkpoint.totalItemEstimate !== undefined
    && checkpoint.importedItemCount > checkpoint.totalItemEstimate
  ) {
    context.addIssue({
      code: 'custom',
      path: ['totalItemEstimate'],
      message: 'Imported item count cannot exceed the current total estimate.',
    });
  }
  if (
    (checkpoint.acceptedThroughServerSeq === undefined)
    !== (checkpoint.acknowledgedBatchId === undefined)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['acceptedThroughServerSeq'],
      message: 'An accepted server sequence and acknowledged batch id must be recorded together.',
    });
  }
});
export type ExternalSessionOperationCheckpointV1 = z.infer<
  typeof ExternalSessionOperationCheckpointV1Schema
>;

/**
 * References to canonical owners. These ids let recovery reread their current
 * facts; their presence never grants, transfers, or rolls back authority.
 */
export const ExternalSessionOperationBindingsV1Schema = z.object({
  operationClaimId: OperationReferenceIdSchema,
  historicalImportJobId: OperationReferenceIdSchema.optional(),
  privateStagingId: OperationReferenceIdSchema.optional(),
  runtimeControlClaimId: OperationReferenceIdSchema.optional(),
  pendingAdmissionId: OperationReferenceIdSchema.optional(),
  targetRuntimeAttemptId: OperationReferenceIdSchema.optional(),
}).strict();
export type ExternalSessionOperationBindingsV1 = z.infer<
  typeof ExternalSessionOperationBindingsV1Schema
>;

export const ExternalSessionCanonicalOwnerDisagreementV1Schema = z.object({
  owner: z.enum([
    'linked_session',
    'runtime_control',
    'transcript_authority',
    'pending_admission',
    'publication',
  ]),
  expectedRevision: OperationRevisionSchema,
  observedRevision: OperationRevisionSchema,
}).strict();
export type ExternalSessionCanonicalOwnerDisagreementV1 = z.infer<
  typeof ExternalSessionCanonicalOwnerDisagreementV1Schema
>;

export const ExternalSessionCanonicalOwnerEvidenceV1Schema = z.object({
  linkedSessionRevision: OperationRevisionSchema,
  sourceSnapshotEvidenceRef: OperationSourceCursorEvidenceSchema.optional(),
  runtimeControlRevision: OperationRevisionSchema.optional(),
  transcriptAuthorityRevision: OperationRevisionSchema.optional(),
  pendingAdmissionRevision: OperationRevisionSchema.optional(),
  publicationRevision: OperationRevisionSchema.optional(),
  disagreement: ExternalSessionCanonicalOwnerDisagreementV1Schema.optional(),
}).strict();
export type ExternalSessionCanonicalOwnerEvidenceV1 = z.infer<
  typeof ExternalSessionCanonicalOwnerEvidenceV1Schema
>;

export const ExternalSessionOperationFenceV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('none'),
  }).strict(),
  z.object({
    kind: z.literal('initial_server_partial'),
    acceptedThroughServerSeq: OperationServerSequenceSchema,
  }).strict(),
  z.object({
    kind: z.literal('incomplete_update'),
    publication: ExternalSessionMaterializationPublicationV1Schema,
  }).strict(),
]);
export type ExternalSessionOperationFenceV1 = z.infer<
  typeof ExternalSessionOperationFenceV1Schema
>;

export const ExternalSessionOperationErrorCodeV1Schema = z.enum([
  'source_unavailable',
  'source_changed',
  'staging_capacity_exceeded',
  'required_items_failed',
  'historical_import_failed',
  'publication_failed',
  'admission_failed',
  'spawn_failed',
  'external_writer_conflict',
  'reconciliation_required',
  'internal_error',
]);
export type ExternalSessionOperationErrorCodeV1 = z.infer<
  typeof ExternalSessionOperationErrorCodeV1Schema
>;

export const ExternalSessionOperationErrorV1Schema = z.object({
  code: ExternalSessionOperationErrorCodeV1Schema,
  message: z.string().trim().min(1).max(2_000),
  retryable: z.boolean(),
  occurredAtMs: OperationTimestampSchema,
}).strict();
export type ExternalSessionOperationErrorV1 = z.infer<
  typeof ExternalSessionOperationErrorV1Schema
>;

const ExternalSessionOperationCancellationV1Schema = z.object({
  requestedAtMs: OperationTimestampSchema,
  requestedAtRevision: OperationRevisionSchema,
}).strict();

const ExternalSessionOperationTerminalResultV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('completed') }).strict(),
  z.object({ kind: z.literal('cancelled') }).strict(),
  z.object({ kind: z.literal('discarded') }).strict(),
]);

const ExternalSessionOperationTimelineV1Schema = z
  .array(ExternalSessionOperationPhaseV1Schema)
  .min(1)
  .max(9)
  .readonly();

const OPERATION_ERROR_PHASES: Readonly<
  Partial<Record<ExternalSessionOperationErrorCodeV1, readonly ExternalSessionOperationPhaseV1[]>>
> = Object.freeze({
  source_unavailable: [
    'validating',
    'quiescing',
    'staging',
    'importing',
    'final_catch_up',
    'admitting',
    'spawning',
    'publishing',
  ],
  source_changed: ['validating', 'staging', 'importing', 'final_catch_up', 'publishing'],
  staging_capacity_exceeded: ['staging'],
  required_items_failed: ['importing', 'final_catch_up', 'publishing'],
  historical_import_failed: ['importing', 'final_catch_up', 'publishing'],
  publication_failed: ['publishing'],
  admission_failed: ['admitting'],
  spawn_failed: ['spawning', 'finalizing'],
  external_writer_conflict: ['admitting', 'spawning', 'finalizing'],
});

function publicationsEqual(
  left: ExternalSessionMaterializationPublicationV1,
  right: ExternalSessionMaterializationPublicationV1,
): boolean {
  return left.materializationPublicationId === right.materializationPublicationId
    && left.materializedThroughSourceAt === right.materializedThroughSourceAt
    && left.publishedThroughServerSeq === right.publishedThroughServerSeq;
}

function addOperationIssue(
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
): void {
  context.addIssue({ code: 'custom', path, message });
}

type ExternalSessionOperationValidationError = Readonly<
  Pick<ExternalSessionOperationErrorV1, 'code'>
>;

function validateTimelineAndRecovery(
  value: Readonly<{
    request: ExternalSessionOperationPlanTargetV1;
    timeline: readonly ExternalSessionOperationPhaseV1[];
    phase: ExternalSessionOperationPhaseV1;
    status: ExternalSessionOperationStatusV1;
    retryTargetPhase?: ExternalSessionOperationPhaseV1;
    error?: ExternalSessionOperationValidationError;
  }>,
  context: z.RefinementCtx,
): void {
  const expectedTimeline = resolveTimelineFromPlanTarget(value.request);
  if (
    value.timeline.length !== expectedTimeline.length
    || value.timeline.some((phase, index) => phase !== expectedTimeline[index])
  ) {
    addOperationIssue(context, ['timeline'], 'Operation timeline must match the semantic request.');
  }

  const currentPhaseIndex = expectedTimeline.indexOf(value.phase);
  if (currentPhaseIndex < 0) {
    addOperationIssue(context, ['phase'], 'Operation phase is invalid for the semantic request.');
  }

  const recoveryStatuses: readonly ExternalSessionOperationStatusV1[] = [
    'awaiting_user_resume',
    'failed',
    'reconciliation_required',
  ];
  if (recoveryStatuses.includes(value.status)) {
    if (!value.retryTargetPhase) {
      addOperationIssue(context, ['retryTargetPhase'], 'Recovery status requires an explicit retry target phase.');
    }
  } else if (value.retryTargetPhase) {
    addOperationIssue(context, ['retryTargetPhase'], 'Retry target phase is only valid for a recovery status.');
  }

  if (value.retryTargetPhase) {
    const retryIndex = expectedTimeline.indexOf(value.retryTargetPhase);
    if (retryIndex < 0 || (currentPhaseIndex >= 0 && retryIndex > currentPhaseIndex)) {
      addOperationIssue(
        context,
        ['retryTargetPhase'],
        'Retry target phase must be a reached phase in the selected operation timeline.',
      );
    }
  }

  if (value.status === 'failed' && !value.error) {
    addOperationIssue(context, ['error'], 'Failed operation requires a typed error.');
  }
  if (value.status === 'reconciliation_required') {
    if (value.error?.code !== 'reconciliation_required') {
      addOperationIssue(
        context,
        ['error', 'code'],
        'Canonical-owner disagreement requires reconciliation_required.',
      );
    }
  } else if (value.error?.code === 'reconciliation_required') {
    addOperationIssue(
      context,
      ['status'],
      'reconciliation_required errors require reconciliation_required status.',
    );
  }

  if (value.error) {
    const admittedPhases = OPERATION_ERROR_PHASES[value.error.code];
    if (admittedPhases && !admittedPhases.includes(value.phase)) {
      addOperationIssue(context, ['error', 'code'], 'Operation error is invalid for the current phase.');
    }
    if (
      value.request.plan === 'materialize'
      && ['admission_failed', 'spawn_failed', 'external_writer_conflict'].includes(value.error.code)
    ) {
      addOperationIssue(context, ['error', 'code'], 'Materialization cannot report runtime takeover errors.');
    }
    if (
      value.request.plan === 'takeover'
      && value.request.targetStorageMode === 'external-linked'
      && [
        'staging_capacity_exceeded',
        'required_items_failed',
        'historical_import_failed',
        'publication_failed',
      ].includes(value.error.code)
    ) {
      addOperationIssue(context, ['error', 'code'], 'External-linked takeover cannot report import errors.');
    }
  }
}

function validateStorageFence(
  value: Readonly<{
    priorStableStorage: ExternalSessionPriorStableStorageV1;
    currentStorageState: ExternalSessionStorageStateV1;
    checkpoint: ExternalSessionOperationCheckpointV1;
    fence: ExternalSessionOperationFenceV1;
    publication?: ExternalSessionMaterializationPublicationV1;
  }>,
  context: z.RefinementCtx,
): void {
  if (value.currentStorageState === 'snapshot_complete' && !value.publication) {
    addOperationIssue(context, ['publication'], 'Complete snapshot state requires publication metadata.');
  }
  if (value.currentStorageState !== 'snapshot_complete' && value.publication) {
    addOperationIssue(context, ['publication'], 'Publication metadata is valid only for complete snapshots.');
  }

  if (value.fence.kind === 'initial_server_partial') {
    if (
      value.priorStableStorage.state !== 'machine_only'
      || value.currentStorageState !== 'server_partial'
      || value.checkpoint.acceptedThroughServerSeq !== value.fence.acceptedThroughServerSeq
    ) {
      addOperationIssue(
        context,
        ['fence'],
        'Initial partial fence must use this operation job’s accepted server sequence.',
      );
    }
  } else if (value.currentStorageState === 'server_partial') {
    addOperationIssue(context, ['fence'], 'Server partial state requires an initial partial fence.');
  }

  if (value.fence.kind === 'incomplete_update') {
    if (
      value.priorStableStorage.state !== 'snapshot_complete'
      || value.currentStorageState !== 'snapshot_complete'
      || !value.publication
      || !publicationsEqual(value.fence.publication, value.priorStableStorage.publication)
      || !publicationsEqual(value.publication, value.priorStableStorage.publication)
    ) {
      addOperationIssue(
        context,
        ['fence'],
        'Incomplete update must retain the exact prior complete publication.',
      );
    }
  }
}

function validateOperationOutcome(
  value: Readonly<{
    request: ExternalSessionOperationPlanTargetV1;
    status: ExternalSessionOperationStatusV1;
    priorStableStorage: ExternalSessionPriorStableStorageV1;
    currentStorageState: ExternalSessionStorageStateV1;
    checkpoint: ExternalSessionOperationCheckpointV1;
    fence: ExternalSessionOperationFenceV1;
    publication?: ExternalSessionMaterializationPublicationV1;
    retryTargetPhase?: ExternalSessionOperationPhaseV1;
    error?: ExternalSessionOperationValidationError;
  }>,
  context: z.RefinementCtx,
): void {
  const isExternalLinkedTakeover = value.request.plan === 'takeover'
    && value.request.targetStorageMode === 'external-linked';
  const isPublishedPersistedTakeoverAdmissionCheckpoint =
    value.request.plan === 'takeover'
    && value.request.targetStorageMode === 'persisted'
    && value.status === 'awaiting_user_resume'
    && value.retryTargetPhase === 'admitting'
    && value.currentStorageState === 'snapshot_complete'
    && value.publication !== undefined
    && value.fence.kind === 'none';

  if (value.checkpoint.requiredItemFailures.total > 0 && value.status === 'completed') {
    addOperationIssue(context, ['status'], 'Required-item failures block operation completion.');
  }

  const interruptedStatuses: readonly ExternalSessionOperationStatusV1[] = [
    'awaiting_user_resume',
    'cancelled',
    'failed',
  ];
  if (
    interruptedStatuses.includes(value.status)
    && value.checkpoint.acceptedThroughServerSeq !== undefined
    && !isPublishedPersistedTakeoverAdmissionCheckpoint
  ) {
    if (
      value.priorStableStorage.state === 'machine_only'
      && value.fence.kind !== 'initial_server_partial'
    ) {
      addOperationIssue(
        context,
        ['fence'],
        'Interrupted initial import with acknowledged rows requires the server_partial fence.',
      );
    }
    if (
      value.priorStableStorage.state === 'snapshot_complete'
      && value.fence.kind !== 'incomplete_update'
    ) {
      addOperationIssue(
        context,
        ['fence'],
        'Interrupted snapshot catch-up must retain an explicit incomplete-update fence.',
      );
    }
  }

  if (value.status !== 'completed') return;

  if (value.error || value.retryTargetPhase || value.fence.kind !== 'none') {
    addOperationIssue(context, ['status'], 'Completed operation cannot retain recovery state.');
  }
  if (
    value.request.plan === 'materialize'
    && (value.currentStorageState !== 'snapshot_complete' || !value.publication)
  ) {
    addOperationIssue(context, ['currentStorageState'], 'Materialization completes at a published snapshot.');
  }
  if (
    value.request.plan === 'materialize'
    && value.publication
    && value.checkpoint.acceptedThroughServerSeq !== value.publication.publishedThroughServerSeq
    && !(
      value.checkpoint.acceptedThroughServerSeq === undefined
      && value.publication.publishedThroughServerSeq === 0
    )
  ) {
    addOperationIssue(
      context,
      ['publication', 'publishedThroughServerSeq'],
      'Published materialization sequence must equal the operation job’s acknowledged ceiling.',
    );
  }
  if (
    isExternalLinkedTakeover
    && value.currentStorageState !== value.priorStableStorage.state
  ) {
    addOperationIssue(
      context,
      ['currentStorageState'],
      'External-linked takeover must retain the prior stable storage state.',
    );
  }
  if (
    isExternalLinkedTakeover
    && value.priorStableStorage.state === 'snapshot_complete'
    && (
      !value.publication
      || !publicationsEqual(value.publication, value.priorStableStorage.publication)
    )
  ) {
    addOperationIssue(
      context,
      ['publication'],
      'External-linked takeover cannot advance the prior snapshot publication.',
    );
  }
  if (
    value.request.plan === 'takeover'
    && value.request.targetStorageMode === 'persisted'
    && value.currentStorageState !== 'hosted'
  ) {
    addOperationIssue(context, ['currentStorageState'], 'Persisted takeover completes at hosted storage.');
  }
}

function isRetryableExternalLinkedAdmissionAcknowledgementReconciliation(
  operation: Readonly<{
    request: ExternalSessionOperationPlanTargetV1;
    status: ExternalSessionOperationStatusV1;
    phase: ExternalSessionOperationPhaseV1;
    retryTargetPhase?: ExternalSessionOperationPhaseV1;
    error?: ExternalSessionOperationErrorV1;
    priorStableStorage: ExternalSessionPriorStableStorageV1;
    currentStorageState: ExternalSessionStorageStateV1;
    checkpoint: ExternalSessionOperationCheckpointV1;
    bindings: ExternalSessionOperationBindingsV1;
    canonicalOwnerEvidence: ExternalSessionCanonicalOwnerEvidenceV1;
    fence: ExternalSessionOperationFenceV1;
  }>,
): boolean {
  return operation.request.plan === 'takeover'
    && operation.request.targetStorageMode === 'external-linked'
    && operation.status === 'reconciliation_required'
    && operation.phase === 'admitting'
    && operation.retryTargetPhase === 'admitting'
    && operation.error?.code === 'reconciliation_required'
    && operation.error.retryable
    && operation.currentStorageState === operation.priorStableStorage.state
    && operation.checkpoint.acceptedThroughServerSeq === undefined
    && operation.checkpoint.acknowledgedBatchId === undefined
    && operation.checkpoint.requiredItemFailures.total === 0
    && operation.bindings.historicalImportJobId === undefined
    && operation.bindings.targetRuntimeAttemptId !== undefined
    && operation.fence.kind === 'none'
    && operation.canonicalOwnerEvidence.disagreement === undefined;
}

export const ExternalSessionOperationRecordV1Schema = z.object({
  v: z.literal(1),
  operationId: OperationIdSchema,
  revision: OperationRevisionSchema,
  request: ExternalSessionOperationSemanticRequestV1Schema,
  authorIntent: ExternalSessionOperationAuthorIntentV1Schema.optional(),
  status: ExternalSessionOperationStatusV1Schema,
  phase: ExternalSessionOperationPhaseV1Schema,
  timeline: ExternalSessionOperationTimelineV1Schema,
  createdAtMs: OperationTimestampSchema,
  updatedAtMs: OperationTimestampSchema,
  priorStableStorage: ExternalSessionPriorStableStorageV1Schema,
  currentStorageState: ExternalSessionStorageStateV1Schema,
  checkpoint: ExternalSessionOperationCheckpointV1Schema,
  bindings: ExternalSessionOperationBindingsV1Schema,
  progressProjection: z.object({
    acknowledgedRevision: OperationRevisionSchema.nullable(),
  }).strict(),
  canonicalOwnerEvidence: ExternalSessionCanonicalOwnerEvidenceV1Schema,
  fence: ExternalSessionOperationFenceV1Schema,
  publication: ExternalSessionMaterializationPublicationV1Schema.optional(),
  retryTargetPhase: ExternalSessionOperationPhaseV1Schema.optional(),
  error: ExternalSessionOperationErrorV1Schema.optional(),
  cancellation: ExternalSessionOperationCancellationV1Schema.optional(),
  terminalResult: ExternalSessionOperationTerminalResultV1Schema.optional(),
}).strict().superRefine((operation, context) => {
  validateTimelineAndRecovery(operation, context);
  validateStorageFence(operation, context);
  validateOperationOutcome(operation, context);

  if (operation.updatedAtMs < operation.createdAtMs) {
    addOperationIssue(context, ['updatedAtMs'], 'Operation update time cannot precede creation.');
  }
  if (
    operation.cancellation
    && operation.cancellation.requestedAtRevision > operation.revision
  ) {
    addOperationIssue(
      context,
      ['cancellation', 'requestedAtRevision'],
      'Cancellation cannot refer to a future operation revision.',
    );
  }
  if (
    operation.progressProjection.acknowledgedRevision !== null
    && operation.progressProjection.acknowledgedRevision > operation.revision
  ) {
    addOperationIssue(
      context,
      ['progressProjection', 'acknowledgedRevision'],
      'Progress projection cannot acknowledge a future operation revision.',
    );
  }

  if (operation.authorIntent?.kind === 'takeover') {
    if (
      operation.request.plan !== 'takeover'
      || operation.authorIntent.agentId
        !== operation.request.source.qualifiedIdentity.agent.localId
      || operation.authorIntent.remoteSessionId
        !== operation.request.source.remoteSessionId
      || operation.authorIntent.targetStorageMode
        !== operation.request.targetStorageMode
    ) {
      addOperationIssue(
        context,
        ['authorIntent'],
        'Plugin takeover author intent must match the retained semantic request.',
      );
    }
  }
  if (
    operation.authorIntent?.kind === 'materialize'
    && (
      operation.request.plan !== 'materialize'
      || operation.authorIntent.sessionId !== operation.request.sessionId
      || operation.authorIntent.targetStorageMode
        !== operation.request.targetStorageMode
    )
  ) {
    addOperationIssue(
      context,
      ['authorIntent'],
      'Plugin materialize author intent must match the retained semantic request.',
    );
  }

  const terminalResultByStatus = {
    completed: 'completed',
    cancelled: 'cancelled',
    discarded: 'discarded',
  } as const;
  const expectedTerminalResult = terminalResultByStatus[
    operation.status as keyof typeof terminalResultByStatus
  ];
  if (expectedTerminalResult) {
    if (operation.terminalResult?.kind !== expectedTerminalResult) {
      addOperationIssue(context, ['terminalResult'], 'Terminal status requires its matching result.');
    }
  } else if (operation.terminalResult) {
    addOperationIssue(context, ['terminalResult'], 'Nonterminal status cannot carry a terminal result.');
  }
  if (
    (operation.status === 'cancel_requested' || operation.status === 'cancelled')
    && !operation.cancellation
  ) {
    addOperationIssue(context, ['cancellation'], 'Cancellation status requires cancellation intent.');
  }
  if (
    operation.status !== 'cancel_requested'
    && operation.status !== 'cancelled'
    && operation.cancellation
  ) {
    addOperationIssue(context, ['cancellation'], 'Cancellation intent is invalid for this status.');
  }

  if (
    operation.status === 'reconciliation_required'
    && !operation.canonicalOwnerEvidence.disagreement
    && !isRetryableExternalLinkedAdmissionAcknowledgementReconciliation(operation)
  ) {
    addOperationIssue(
      context,
      ['canonicalOwnerEvidence', 'disagreement'],
      'Reconciliation requires typed canonical-owner disagreement evidence or an exact retryable external-linked admission acknowledgement.',
    );
  }
  if (
    operation.status !== 'reconciliation_required'
    && operation.canonicalOwnerEvidence.disagreement
  ) {
    addOperationIssue(
      context,
      ['canonicalOwnerEvidence', 'disagreement'],
      'Canonical-owner disagreement must surface as reconciliation_required.',
    );
  }

  const isExternalLinkedTakeover = operation.request.plan === 'takeover'
    && operation.request.targetStorageMode === 'external-linked';
  if (operation.request.plan === 'materialize') {
    if (
      operation.bindings.runtimeControlClaimId
      || operation.bindings.pendingAdmissionId
      || operation.bindings.targetRuntimeAttemptId
    ) {
      addOperationIssue(context, ['bindings'], 'Materialization cannot bind runtime admission or spawn.');
    }
  }
  if (isExternalLinkedTakeover) {
    if (operation.bindings.historicalImportJobId || operation.bindings.privateStagingId) {
      addOperationIssue(context, ['bindings'], 'External-linked takeover cannot bind import or staging.');
    }
    if (
      operation.checkpoint.sourcePagesRead !== 0
      || operation.checkpoint.stagedItemCount !== 0
      || operation.checkpoint.importedItemCount !== 0
      || operation.checkpoint.acceptedThroughServerSeq !== undefined
      || operation.checkpoint.requiredItemFailures.total !== 0
      || operation.fence.kind !== 'none'
    ) {
      addOperationIssue(context, ['checkpoint'], 'External-linked takeover cannot import transcript history.');
    }
  }

  if (operation.status === 'discarded') {
    if (
      operation.priorStableStorage.state !== 'machine_only'
      || operation.currentStorageState !== 'machine_only'
      || operation.fence.kind !== 'none'
      || operation.checkpoint.sourcePagesRead !== 0
      || operation.checkpoint.stagedItemCount !== 0
      || operation.checkpoint.importedItemCount !== 0
      || operation.checkpoint.acceptedThroughServerSeq !== undefined
      || operation.checkpoint.acknowledgedBatchId !== undefined
      || operation.checkpoint.requiredItemFailures.total !== 0
      || operation.bindings.historicalImportJobId !== undefined
      || operation.bindings.privateStagingId !== undefined
    ) {
      addOperationIssue(
        context,
        ['status'],
        'Discard requires confirmed machine-only storage with no partial checkpoint, fence, or import binding.',
      );
    }
  }

  if (
    operation.priorStableStorage.state === 'snapshot_complete'
    && operation.currentStorageState === 'snapshot_complete'
    && operation.publication
    && operation.status !== 'completed'
    && !publicationsEqual(operation.priorStableStorage.publication, operation.publication)
  ) {
    addOperationIssue(
      context,
      ['publication'],
      'A nonterminal update cannot advance the prior complete publication.',
    );
  }
});
export type ExternalSessionOperationRecordV1 = z.infer<
  typeof ExternalSessionOperationRecordV1Schema
>;

const ExternalSessionOperationProgressRequestV1Schema = z.discriminatedUnion('plan', [
  z.object({
    plan: z.literal('materialize'),
    targetStorageMode: z.literal('external-linked'),
    targetRuntimeMode: z.null(),
  }).strict(),
  z.object({
    plan: z.literal('takeover'),
    targetStorageMode: ExternalSessionTakeoverStorageModeV1Schema,
    // Read old owner-only progress emitted before this projection carried the
    // already-required semantic target. Canonical projection always writes it.
    targetDirectory: ExternalSessionTakeoverTargetDirectoryV1Schema.optional(),
    targetRuntimeMode: z.literal('terminal'),
  }).strict(),
]);

const ExternalSessionOperationPublicRequiredItemFailuresV1Schema = z.object({
  total: OperationCountSchema,
  record: OperationCountSchema,
  media: OperationCountSchema,
  conversion: OperationCountSchema,
  diagnosticsTruncated: z.boolean(),
}).strict().superRefine((failures, context) => {
  if (failures.record + failures.media + failures.conversion !== failures.total) {
    context.addIssue({
      code: 'custom',
      path: ['total'],
      message: 'Required-item failure total must equal the categorized failure counts.',
    });
  }
});

const ExternalSessionOperationPublicCheckpointV1Schema = z.object({
  sourcePagesRead: OperationCountSchema,
  stagedItemCount: OperationCountSchema,
  importedItemCount: OperationCountSchema,
  totalItemEstimate: OperationCountSchema.optional(),
  requiredItemFailures: ExternalSessionOperationPublicRequiredItemFailuresV1Schema,
  acceptedThroughServerSeq: OperationServerSequenceSchema.optional(),
}).strict().superRefine((checkpoint, context) => {
  if (
    checkpoint.totalItemEstimate !== undefined
    && checkpoint.importedItemCount > checkpoint.totalItemEstimate
  ) {
    context.addIssue({
      code: 'custom',
      path: ['totalItemEstimate'],
      message: 'Imported item count cannot exceed the current total estimate.',
    });
  }
});

const ExternalSessionOperationPublicErrorV1Schema = z.object({
  code: ExternalSessionOperationErrorCodeV1Schema,
  retryable: z.boolean(),
  occurredAtMs: OperationTimestampSchema,
}).strict();

/**
 * Owner-only operation progress. Private source evidence, staging ids, owner
 * references, transcript items, native cursors, and watermarks are
 * intentionally absent and rejected by strict parsing. Takeover's bounded
 * host-selected target directory remains visible here; the separate shared
 * presentation intentionally omits it.
 */
export const ExternalSessionOperationProgressV1Schema = z.object({
  v: z.literal(1),
  operationId: OperationIdSchema,
  revision: OperationRevisionSchema,
  request: ExternalSessionOperationProgressRequestV1Schema,
  status: ExternalSessionOperationStatusV1Schema,
  phase: ExternalSessionOperationPhaseV1Schema,
  timeline: ExternalSessionOperationTimelineV1Schema,
  updatedAtMs: OperationTimestampSchema,
  priorStableStorage: ExternalSessionPriorStableStorageV1Schema,
  currentStorageState: ExternalSessionStorageStateV1Schema,
  checkpoint: ExternalSessionOperationPublicCheckpointV1Schema,
  fence: ExternalSessionOperationFenceV1Schema,
  publication: ExternalSessionMaterializationPublicationV1Schema.optional(),
  retryTargetPhase: ExternalSessionOperationPhaseV1Schema.optional(),
  error: ExternalSessionOperationPublicErrorV1Schema.optional(),
}).strict().superRefine((progress, context) => {
  validateTimelineAndRecovery({
    ...progress,
    request: progress.request,
  }, context);
  validateStorageFence(progress, context);
  validateOperationOutcome({
    ...progress,
    request: progress.request,
  }, context);
});
export type ExternalSessionOperationProgressV1 = z.infer<
  typeof ExternalSessionOperationProgressV1Schema
>;

export const ExternalSessionOperationSharedPresentationV1Schema = z.object({
  v: z.literal(1),
  operationId: OperationIdSchema,
  revision: OperationRevisionSchema,
  kind: z.enum([
    'materialize',
    'takeover_external_linked',
    'takeover_persisted',
  ]),
  status: ExternalSessionOperationStatusV1Schema,
  phase: ExternalSessionOperationPhaseV1Schema,
}).strict();
export type ExternalSessionOperationSharedPresentationV1 = z.infer<
  typeof ExternalSessionOperationSharedPresentationV1Schema
>;

export const EXTERNAL_SESSION_OPERATION_METADATA_KEY =
  'externalSessionOperationV1' as const;
export const EXTERNAL_SESSION_OPERATION_PRESENTATION_METADATA_KEY =
  'externalSessionOperationPresentationV1' as const;

export const ExternalSessionOperationStateV1Schema = z.object({
  v: z.literal(1),
  progress: ExternalSessionOperationProgressV1Schema,
}).strict();
export type ExternalSessionOperationStateV1 = z.infer<
  typeof ExternalSessionOperationStateV1Schema
>;

export function projectExternalSessionOperationProgressV1(
  operationInput: ExternalSessionOperationRecordV1,
): ExternalSessionOperationProgressV1 {
  const operation = ExternalSessionOperationRecordV1Schema.parse(operationInput);
  const retryableAdmissionAcknowledgement =
    isRetryableExternalLinkedAdmissionAcknowledgementReconciliation(operation);
  return ExternalSessionOperationProgressV1Schema.parse({
    v: 1,
    operationId: operation.operationId,
    revision: operation.revision,
    request: {
      plan: operation.request.plan,
      targetStorageMode: operation.request.targetStorageMode,
      ...(operation.request.plan === 'takeover'
        ? { targetDirectory: operation.request.targetDirectory }
        : {}),
      targetRuntimeMode: operation.request.targetRuntimeMode,
    },
    status: operation.status,
    phase: operation.phase,
    timeline: operation.timeline,
    updatedAtMs: operation.updatedAtMs,
    priorStableStorage: operation.priorStableStorage,
    currentStorageState: operation.currentStorageState,
    checkpoint: {
      sourcePagesRead: operation.checkpoint.sourcePagesRead,
      stagedItemCount: operation.checkpoint.stagedItemCount,
      importedItemCount: operation.checkpoint.importedItemCount,
      ...(operation.checkpoint.totalItemEstimate === undefined
        ? {}
        : { totalItemEstimate: operation.checkpoint.totalItemEstimate }),
      requiredItemFailures: {
        total: operation.checkpoint.requiredItemFailures.total,
        record: operation.checkpoint.requiredItemFailures.record,
        media: operation.checkpoint.requiredItemFailures.media,
        conversion: operation.checkpoint.requiredItemFailures.conversion,
        diagnosticsTruncated:
          operation.checkpoint.requiredItemFailures.diagnosticsTruncated,
      },
      ...(operation.checkpoint.acceptedThroughServerSeq === undefined
        ? {}
        : {
            acceptedThroughServerSeq:
              operation.checkpoint.acceptedThroughServerSeq,
          }),
    },
    fence: operation.fence,
    ...(operation.publication ? { publication: operation.publication } : {}),
    ...(operation.retryTargetPhase ? { retryTargetPhase: operation.retryTargetPhase } : {}),
    ...(operation.error
      ? {
          error: {
            code: operation.error.code,
            retryable:
              operation.error.code === 'reconciliation_required'
                && operation.request.plan === 'takeover'
                && operation.request.targetStorageMode === 'external-linked'
                ? retryableAdmissionAcknowledgement
                : operation.error.retryable,
            occurredAtMs: operation.error.occurredAtMs,
          },
        }
      : {}),
  });
}

export function projectExternalSessionOperationSharedPresentationV1(
  progress: ExternalSessionOperationProgressV1,
): ExternalSessionOperationSharedPresentationV1 {
  return ExternalSessionOperationSharedPresentationV1Schema.parse({
    v: 1,
    operationId: progress.operationId,
    revision: progress.revision,
    kind: resolveTimelineKind(progress.request),
    status: progress.status,
    phase: progress.phase,
  });
}

export type ExternalSessionOperationIdempotencyDecisionV1 =
  | Readonly<{ kind: 'same_operation' }>
  | Readonly<{ kind: 'different_idempotency_key' }>
  | Readonly<{ kind: 'semantic_mismatch' }>;

function semanticRequestJson(request: ExternalSessionOperationSemanticRequestV1): string {
  return JSON.stringify(ExternalSessionOperationSemanticRequestV1Schema.parse(request));
}

export function classifyExternalSessionOperationIdempotencyV1(
  existingInput: ExternalSessionOperationSemanticRequestV1,
  incomingInput: ExternalSessionOperationSemanticRequestV1,
): ExternalSessionOperationIdempotencyDecisionV1 {
  const existing = ExternalSessionOperationSemanticRequestV1Schema.parse(existingInput);
  const incoming = ExternalSessionOperationSemanticRequestV1Schema.parse(incomingInput);
  if (existing.idempotencyKey !== incoming.idempotencyKey) {
    return Object.freeze({ kind: 'different_idempotency_key' });
  }
  return semanticRequestJson(existing) === semanticRequestJson(incoming)
    ? Object.freeze({ kind: 'same_operation' })
    : Object.freeze({ kind: 'semantic_mismatch' });
}

export type ExternalSessionOperationUpdateDecisionV1 =
  | Readonly<{ kind: 'accept' }>
  | Readonly<{ kind: 'duplicate' }>
  | Readonly<{ kind: 'operation_mismatch' }>
  | Readonly<{ kind: 'semantic_mismatch' }>
  | Readonly<{ kind: 'stale_revision' }>
  | Readonly<{ kind: 'revision_gap' }>
  | Readonly<{ kind: 'phase_regression' }>
  | Readonly<{ kind: 'updated_at_regression' }>
  | Readonly<{ kind: 'terminal_operation' }>;

const TERMINAL_OPERATION_STATUSES: readonly ExternalSessionOperationStatusV1[] = [
  'cancelled',
  'completed',
  'discarded',
];

function isCancelledDiscardTransition(
  previous: ExternalSessionOperationRecordV1,
  next: ExternalSessionOperationRecordV1,
): boolean {
  const isDiscardingPrivateMaterialization = previous.request.plan === 'materialize'
    || previous.request.targetStorageMode === 'persisted';
  const isPrivateMachineOnlyDiscard = next.status === 'discarded'
    && next.priorStableStorage.state === 'machine_only'
    && next.currentStorageState === 'machine_only'
    && next.checkpoint.sourcePagesRead === 0
    && next.checkpoint.stagedItemCount === 0
    && next.checkpoint.importedItemCount === 0
    && next.checkpoint.acceptedThroughServerSeq === undefined
    && next.checkpoint.acknowledgedBatchId === undefined
    && next.bindings.operationClaimId === previous.bindings.operationClaimId
    && next.bindings.historicalImportJobId === undefined
    && next.fence.kind === 'none'
    && next.cancellation === undefined
    && next.terminalResult?.kind === 'discarded';
  if (
    previous.status !== 'cancelled'
    || !isDiscardingPrivateMaterialization
    || !isPrivateMachineOnlyDiscard
  ) {
    return false;
  }
  const isCancelledLocalPrivateCapture = previous.priorStableStorage.state === 'machine_only'
    && previous.currentStorageState === 'machine_only'
    && previous.fence.kind === 'none'
    && previous.checkpoint.acceptedThroughServerSeq === undefined
    && previous.checkpoint.acknowledgedBatchId === undefined
    && previous.bindings.historicalImportJobId === undefined;
  const isCancelledInitialPartial = previous.priorStableStorage.state === 'machine_only'
    && previous.currentStorageState === 'server_partial'
    && previous.fence.kind === 'initial_server_partial'
    && previous.checkpoint.acceptedThroughServerSeq
      === previous.fence.acceptedThroughServerSeq
    && previous.bindings.historicalImportJobId !== undefined;
  return isCancelledLocalPrivateCapture || isCancelledInitialPartial;
}

export function decideExternalSessionOperationUpdateV1(
  previousInput: ExternalSessionOperationRecordV1,
  nextInput: ExternalSessionOperationRecordV1,
): ExternalSessionOperationUpdateDecisionV1 {
  const previous = ExternalSessionOperationRecordV1Schema.parse(previousInput);
  const next = ExternalSessionOperationRecordV1Schema.parse(nextInput);

  if (previous.operationId !== next.operationId) {
    return Object.freeze({ kind: 'operation_mismatch' });
  }
  if (
    classifyExternalSessionOperationIdempotencyV1(previous.request, next.request).kind
    !== 'same_operation'
    || JSON.stringify(previous.authorIntent)
      !== JSON.stringify(next.authorIntent)
  ) {
    return Object.freeze({ kind: 'semantic_mismatch' });
  }
  if (next.revision === previous.revision) {
    return JSON.stringify(previous) === JSON.stringify(next)
      ? Object.freeze({ kind: 'duplicate' })
      : Object.freeze({ kind: 'stale_revision' });
  }
  if (next.revision < previous.revision) {
    return Object.freeze({ kind: 'stale_revision' });
  }
  if (next.revision !== previous.revision + 1) {
    return Object.freeze({ kind: 'revision_gap' });
  }
  if (
    TERMINAL_OPERATION_STATUSES.includes(previous.status)
    && !isCancelledDiscardTransition(previous, next)
  ) {
    return Object.freeze({ kind: 'terminal_operation' });
  }
  if (next.updatedAtMs < previous.updatedAtMs) {
    return Object.freeze({ kind: 'updated_at_regression' });
  }

  const timeline = resolveExternalSessionOperationTimelineV1(previous.request);
  if (timeline.indexOf(next.phase) < timeline.indexOf(previous.phase)) {
    return Object.freeze({ kind: 'phase_regression' });
  }
  return Object.freeze({ kind: 'accept' });
}
