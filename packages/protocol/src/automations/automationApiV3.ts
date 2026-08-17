import { z } from 'zod';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';

import { AutomationRunStateV3Schema } from './automationRunStateV3.js';
import {
  AutomationAccountCurrentnessWitnessV1Schema,
  AutomationEventPayloadV1Schema,
  AutomationEventFilterV1Schema,
  AutomationEventSourceConfigV1Schema,
  AutomationEventSourceDisplayLabelV1Schema,
  AutomationEventSourceInstanceIdV1Schema,
  AutomationEventSourceStatusV1Schema,
  MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES,
} from './automationEventV1.js';
import { PluginMachineMaterializationRefV1Schema } from '../plugins/availability/materializationRefV1.js';
import { AutomationEventPositiveSafeIntegerV1Schema } from './automationEventDeclarationV1.js';
import {
  AutomationOriginOccurredAtV1Schema,
  AutomationPluginEventOccurrenceEvidenceV1Schema,
} from './automationOccurrenceV1.js';
import {
  AutomationEventSourceCatalogStatusStateV1Schema,
  UNSIGNED_DECIMAL_BIGINT_SCHEMA,
} from './automationActionSpecsV1.js';
import { AutomationRunExecutionRecipeV1Schema } from './automationRunExecutionRecipeV1.js';
import { ExecutionRunWaitResultSchema } from '../execution/runs/index.js';

const PREDECESSOR_TIMESTAMP_SCHEMA = z.number().int();
const TIMESTAMP_SCHEMA = z.number().int().nonnegative().safe();
const IDENTIFIER_SCHEMA = z.string().min(1);
const UTF8_ENCODER = new TextEncoder();

/**
 * List/detail-safe catalog reconciliation facts for the current Event source.
 * Routing, Account, source, and materialization identity remain server-owned.
 */
export const AutomationV3EventSourceCatalogStatusSchema = z.object({
  observedRevision: UNSIGNED_DECIMAL_BIGINT_SCHEMA,
  adoptedRevision: UNSIGNED_DECIMAL_BIGINT_SCHEMA.nullable(),
  state: AutomationEventSourceCatalogStatusStateV1Schema,
  scanStartedAt: TIMESTAMP_SCHEMA.nullable(),
  nextRetryAt: TIMESTAMP_SCHEMA.nullable(),
}).strict();
export type AutomationV3EventSourceCatalogStatus = z.infer<
  typeof AutomationV3EventSourceCatalogStatusSchema
>;

export const AutomationTargetTypeV2Schema = z.enum(['new_session', 'existing_session']);
export type AutomationTargetTypeV2 = z.infer<typeof AutomationTargetTypeV2Schema>;

export const AutomationTargetTypeV3Schema = z.enum([
  'newSession',
  'existingSession',
  'executionRun',
]);
export type AutomationTargetTypeV3 = z.infer<typeof AutomationTargetTypeV3Schema>;

export const AutomationRunStateV2Schema = z.enum([
  'queued',
  'claimed',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
]);
export type AutomationRunStateV2 = z.infer<typeof AutomationRunStateV2Schema>;

/**
 * The currently published V3 state vocabulary. The additional terminal states
 * are intentionally accepted by the reader before their producer migration so
 * new clients can represent a current server without reinterpreting it.
 */
export {
  AutomationRunStateV3Schema,
  type AutomationRunStateV3,
} from './automationRunStateV3.js';

export const AutomationV2ScheduleSchema = z.object({
  kind: z.enum(['cron', 'interval']),
  scheduleExpr: z.string().nullable(),
  everyMs: z.number().int().nullable(),
  timezone: z.string().nullable(),
}).strict();
export type AutomationV2Schedule = z.infer<typeof AutomationV2ScheduleSchema>;

export const AutomationV2AssignmentSchema = z.object({
  machineId: z.string(),
  enabled: z.boolean(),
  priority: z.number().int(),
  updatedAt: PREDECESSOR_TIMESTAMP_SCHEMA.nullable(),
}).strict();
export type AutomationV2Assignment = z.infer<typeof AutomationV2AssignmentSchema>;

/** Exact released V2 definition wire shape. Do not add Event/Conversation fields. */
export const AutomationApiV2Schema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  schedule: AutomationV2ScheduleSchema,
  targetType: AutomationTargetTypeV2Schema,
  templateCiphertext: z.string(),
  templateVersion: z.number().int(),
  nextRunAt: PREDECESSOR_TIMESTAMP_SCHEMA.nullable(),
  lastRunAt: PREDECESSOR_TIMESTAMP_SCHEMA.nullable(),
  createdAt: PREDECESSOR_TIMESTAMP_SCHEMA,
  updatedAt: PREDECESSOR_TIMESTAMP_SCHEMA,
  assignments: z.array(AutomationV2AssignmentSchema),
}).strict();
export type AutomationApiV2 = z.infer<typeof AutomationApiV2Schema>;

/** Exact released V2 Run wire shape. Do not add origin or private-envelope fields. */
export const AutomationRunApiV2Schema = z.object({
  id: z.string(),
  automationId: z.string(),
  state: AutomationRunStateV2Schema,
  scheduledAt: PREDECESSOR_TIMESTAMP_SCHEMA,
  dueAt: PREDECESSOR_TIMESTAMP_SCHEMA,
  claimedAt: PREDECESSOR_TIMESTAMP_SCHEMA.nullable(),
  startedAt: PREDECESSOR_TIMESTAMP_SCHEMA.nullable(),
  finishedAt: PREDECESSOR_TIMESTAMP_SCHEMA.nullable(),
  claimedByMachineId: z.string().nullable(),
  leaseExpiresAt: PREDECESSOR_TIMESTAMP_SCHEMA.nullable(),
  attempt: z.number().int(),
  summaryCiphertext: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  producedSessionId: z.string().nullable(),
  createdAt: PREDECESSOR_TIMESTAMP_SCHEMA,
  updatedAt: PREDECESSOR_TIMESTAMP_SCHEMA,
}).strict();
export type AutomationRunApiV2 = z.infer<typeof AutomationRunApiV2Schema>;

export const AutomationV2RunListResponseSchema = z.object({
  runs: z.array(AutomationRunApiV2Schema),
  nextCursor: z.string().nullable(),
}).strict();
export type AutomationV2RunListResponse = z.infer<typeof AutomationV2RunListResponseSchema>;

export const AutomationV2RunMutationResponseSchema = z.object({
  run: AutomationRunApiV2Schema,
}).strict();
export type AutomationV2RunMutationResponse = z.infer<typeof AutomationV2RunMutationResponseSchema>;

export const AutomationV3AssignmentSchema = z.object({
  machineId: IDENTIFIER_SCHEMA,
  enabled: z.boolean(),
  priority: z.number().int(),
  updatedAt: TIMESTAMP_SCHEMA.nullable(),
}).strict();
export type AutomationV3Assignment = z.infer<typeof AutomationV3AssignmentSchema>;

/** Input form for the one existing Automation-assignment owner. */
export const AutomationV3AssignmentInputSchema = z.object({
  machineId: IDENTIFIER_SCHEMA,
  enabled: z.boolean().optional(),
  priority: z.number().int().min(-100).max(100).optional(),
}).strict();
export type AutomationV3AssignmentInput = z.infer<typeof AutomationV3AssignmentInputSchema>;

export const AutomationV3AssignmentUpdateRequestSchema = z.object({
  assignments: z.array(AutomationV3AssignmentInputSchema).max(50),
}).strict();
export type AutomationV3AssignmentUpdateRequest = z.infer<typeof AutomationV3AssignmentUpdateRequestSchema>;

const AutomationV3ScheduleSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('cron'),
    scheduleExpr: z.string(),
    everyMs: z.null(),
    timezone: z.string().nullable(),
  }).strict(),
  z.object({
    kind: z.literal('interval'),
    scheduleExpr: z.null(),
    everyMs: z.number().int(),
    timezone: z.string().nullable(),
  }).strict(),
]);

export const AutomationV3ScheduleTriggerSchema = z.object({
  kind: z.literal('schedule'),
  schedule: AutomationV3ScheduleSchema,
}).strict();
export type AutomationV3ScheduleTrigger = z.infer<typeof AutomationV3ScheduleTriggerSchema>;

export const AutomationV3ManualTriggerSchema = z.object({
  kind: z.literal('manual'),
}).strict();
export type AutomationV3ManualTrigger = z.infer<typeof AutomationV3ManualTriggerSchema>;

/**
 * A schedule definition has no immutable occurrence evidence yet. The same
 * strict Run recipe becomes frozen on each scheduled/manual Run, while Event
 * and Conversation admission later replace this null arm with their one
 * authoritative occurrence-evidence envelope.
 */
const AutomationV3DefinitionExecutionRecipeSchema = AutomationRunExecutionRecipeV1Schema.superRefine(
  (value, context) => {
    if (value.triggerEvidence !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['triggerEvidence'],
        message: 'A stored Automation definition cannot carry Run occurrence evidence',
      });
    }
  },
);

export const AutomationV3ScheduleDefinitionCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(128),
  description: z.string().max(2_000).nullable().optional(),
  enabled: z.boolean(),
  trigger: AutomationV3ScheduleTriggerSchema,
  executionRecipe: AutomationV3DefinitionExecutionRecipeSchema,
  assignments: z.array(AutomationV3AssignmentInputSchema).max(50).optional(),
}).strict();
export type AutomationV3ScheduleDefinitionCreateRequest = z.infer<
  typeof AutomationV3ScheduleDefinitionCreateRequestSchema
>;

export const AutomationV3ScheduleDefinitionPatchRequestSchema = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  description: z.string().max(2_000).nullable().optional(),
  enabled: z.boolean().optional(),
  trigger: AutomationV3ScheduleTriggerSchema.optional(),
  executionRecipe: AutomationV3DefinitionExecutionRecipeSchema.optional(),
  assignments: z.array(AutomationV3AssignmentInputSchema).max(50).optional(),
}).strict();
export type AutomationV3ScheduleDefinitionPatchRequest = z.infer<
  typeof AutomationV3ScheduleDefinitionPatchRequestSchema
>;

export const AutomationV3ManualDefinitionCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(128),
  description: z.string().max(2_000).nullable().optional(),
  enabled: z.boolean(),
  trigger: AutomationV3ManualTriggerSchema,
  executionRecipe: AutomationV3DefinitionExecutionRecipeSchema,
  assignments: z.array(AutomationV3AssignmentInputSchema).max(50).optional(),
}).strict();
export type AutomationV3ManualDefinitionCreateRequest = z.infer<
  typeof AutomationV3ManualDefinitionCreateRequestSchema
>;

export const AutomationV3ManualDefinitionPatchRequestSchema = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  description: z.string().max(2_000).nullable().optional(),
  enabled: z.boolean().optional(),
  trigger: AutomationV3ManualTriggerSchema,
  executionRecipe: AutomationV3DefinitionExecutionRecipeSchema.optional(),
  assignments: z.array(AutomationV3AssignmentInputSchema).max(50).optional(),
}).strict();
export type AutomationV3ManualDefinitionPatchRequest = z.infer<
  typeof AutomationV3ManualDefinitionPatchRequestSchema
>;

export const AutomationV3PluginEventDefinitionTriggerInputSchema = z.object({
  kind: z.literal('pluginEvent'),
  eventRef: z.object({
    pluginId: IDENTIFIER_SCHEMA,
    localId: IDENTIFIER_SCHEMA,
  }).strict(),
  sourceInstanceId: AutomationEventSourceInstanceIdV1Schema,
  sourceContractVersion: AutomationEventPositiveSafeIntegerV1Schema,
  sourceConfig: asProtocolZod(AutomationEventSourceConfigV1Schema),
  displayLabel: AutomationEventSourceDisplayLabelV1Schema,
  observationTransport: z.object({
    kind: z.literal('checkpointedPull'),
    watcherMaterializationRef: PluginMachineMaterializationRefV1Schema,
  }).strict(),
  filter: AutomationEventFilterV1Schema.nullable(),
  maximumObservationAgeMs: z.number().int().nonnegative().safe().nullable(),
}).strict();
export type AutomationV3PluginEventDefinitionTriggerInput = z.infer<
  typeof AutomationV3PluginEventDefinitionTriggerInputSchema
>;

export const AutomationV3PluginEventDefinitionCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(128),
  description: z.string().max(2_000).nullable().optional(),
  enabled: z.boolean(),
  trigger: AutomationV3PluginEventDefinitionTriggerInputSchema,
  executionRecipe: AutomationV3DefinitionExecutionRecipeSchema,
  assignments: z.array(AutomationV3AssignmentInputSchema).max(50).optional(),
}).strict();
export type AutomationV3PluginEventDefinitionCreateRequest = z.infer<
  typeof AutomationV3PluginEventDefinitionCreateRequestSchema
>;

export const AutomationV3PluginEventDefinitionPatchRequestSchema =
  AutomationV3PluginEventDefinitionCreateRequestSchema.extend({
    expectedTemplateVersion: z.number().int().nonnegative().safe(),
  }).strict();
export type AutomationV3PluginEventDefinitionPatchRequest = z.infer<
  typeof AutomationV3PluginEventDefinitionPatchRequestSchema
>;

export const AutomationV3PluginEventRefSchema = z.object({
  pluginId: IDENTIFIER_SCHEMA,
  localId: IDENTIFIER_SCHEMA,
}).strict();
export type AutomationV3PluginEventRef = z.infer<typeof AutomationV3PluginEventRefSchema>;

export const AutomationV3CheckpointedPullObservationSchema = z.object({
  kind: z.literal('checkpointedPull'),
  watcher: z.object({
    machineId: IDENTIFIER_SCHEMA,
    machineInstallationId: IDENTIFIER_SCHEMA,
    pluginId: IDENTIFIER_SCHEMA,
    materializationId: IDENTIFIER_SCHEMA,
  }).strict().nullable(),
}).strict();
export type AutomationV3CheckpointedPullObservation = z.infer<
  typeof AutomationV3CheckpointedPullObservationSchema
>;

export const AutomationV3DurablePushObservationSchema = z.object({
  kind: z.literal('durablePush'),
  webhookEndpointId: IDENTIFIER_SCHEMA,
  observationStartsAt: TIMESTAMP_SCHEMA,
}).strict();
export type AutomationV3DurablePushObservation = z.infer<
  typeof AutomationV3DurablePushObservationSchema
>;

export const AutomationV3PluginEventTriggerSchema = z.object({
  kind: z.literal('pluginEvent'),
  eventRef: AutomationV3PluginEventRefSchema,
  sourceSelectorId: IDENTIFIER_SCHEMA,
  sourceContractVersion: z.number().int().positive().safe(),
  observation: z.union([
    AutomationV3CheckpointedPullObservationSchema,
    AutomationV3DurablePushObservationSchema,
  ]),
}).strict();
export type AutomationV3PluginEventTrigger = z.infer<typeof AutomationV3PluginEventTriggerSchema>;

export const AutomationV3ConversationTriggerSchema = z.object({
  kind: z.literal('conversation'),
}).strict();
export type AutomationV3ConversationTrigger = z.infer<typeof AutomationV3ConversationTriggerSchema>;

const AutomationV3DefinitionBaseSchema = z.object({
  id: IDENTIFIER_SCHEMA,
  name: z.string(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  targetType: AutomationTargetTypeV3Schema,
  templateVersion: z.number().int().nonnegative().safe(),
  nextRunAt: TIMESTAMP_SCHEMA.nullable(),
  lastRunAt: TIMESTAMP_SCHEMA.nullable(),
  createdAt: TIMESTAMP_SCHEMA,
  updatedAt: TIMESTAMP_SCHEMA,
  assignments: z.array(AutomationV3AssignmentSchema),
}).strict();

function requireExactlyOneDefinitionContent(
  value: Readonly<{ templateCiphertext?: string; executionRecipe?: unknown }> ,
  context: z.RefinementCtx,
): void {
  if ((value.templateCiphertext === undefined) === (value.executionRecipe === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Definition detail requires exactly one current recipe or retained legacy template',
    });
  }
}

const AutomationV3DefinitionDetailContentShape = {
  /** Direct-reader-only predecessor bytes. Current writers never send this field. */
  templateCiphertext: z.string().min(1).optional(),
  /** Direct-reader-only current recipe; definition lists never disclose it. */
  executionRecipe: AutomationRunExecutionRecipeV1Schema.optional(),
};

/** Bounded definition list item; no private source/configuration envelope. */
export const AutomationV3DefinitionListItemSchema = z.union([
  AutomationV3DefinitionBaseSchema.extend({
    trigger: AutomationV3ManualTriggerSchema,
  }).strict(),
  AutomationV3DefinitionBaseSchema.extend({
    trigger: AutomationV3ScheduleTriggerSchema,
  }).strict(),
  AutomationV3DefinitionBaseSchema.extend({
    trigger: AutomationV3PluginEventTriggerSchema,
    sourceStatus: AutomationEventSourceStatusV1Schema.nullable().optional(),
    sourceCatalogStatus: AutomationV3EventSourceCatalogStatusSchema.nullable().optional(),
  }).strict(),
  AutomationV3DefinitionBaseSchema.extend({
    trigger: AutomationV3ConversationTriggerSchema,
  }).strict(),
]);
export type AutomationV3DefinitionListItem = z.infer<typeof AutomationV3DefinitionListItemSchema>;

/**
 * Direct authenticated definition detail. The private trigger envelope is
 * never returned from list/status/source projections.
 */
export const AutomationV3DefinitionDetailSchema = z.union([
  AutomationV3DefinitionBaseSchema.extend({
    trigger: AutomationV3ManualTriggerSchema,
    triggerDefinitionEnvelope: z.null(),
    ...AutomationV3DefinitionDetailContentShape,
  }).strict().superRefine(requireExactlyOneDefinitionContent),
  AutomationV3DefinitionBaseSchema.extend({
    trigger: AutomationV3ScheduleTriggerSchema,
    triggerDefinitionEnvelope: z.null(),
    ...AutomationV3DefinitionDetailContentShape,
  }).strict().superRefine(requireExactlyOneDefinitionContent),
  AutomationV3DefinitionBaseSchema.extend({
    trigger: AutomationV3PluginEventTriggerSchema,
    sourceStatus: AutomationEventSourceStatusV1Schema.nullable().optional(),
    sourceCatalogStatus: AutomationV3EventSourceCatalogStatusSchema.nullable().optional(),
    triggerDefinitionEnvelope: z.string().min(1),
    ...AutomationV3DefinitionDetailContentShape,
  }).strict().superRefine(requireExactlyOneDefinitionContent),
  AutomationV3DefinitionBaseSchema.extend({
    trigger: AutomationV3ConversationTriggerSchema,
    triggerDefinitionEnvelope: z.string().min(1),
    ...AutomationV3DefinitionDetailContentShape,
  }).strict().superRefine(requireExactlyOneDefinitionContent),
]);
export type AutomationV3DefinitionDetail = z.infer<typeof AutomationV3DefinitionDetailSchema>;

export const AutomationV3DefinitionListResponseSchema = z.object({
  automations: z.array(AutomationV3DefinitionListItemSchema),
}).strict();
export type AutomationV3DefinitionListResponse = z.infer<typeof AutomationV3DefinitionListResponseSchema>;

/**
 * Worker wake projection. It deliberately carries no definition/private
 * envelope: the durable claim endpoint remains the work authority.
 */
export const AutomationV3WorkerAssignmentSchema = z.object({
  machineId: IDENTIFIER_SCHEMA,
  automationId: IDENTIFIER_SCHEMA,
  nextClaimAt: TIMESTAMP_SCHEMA.nullable(),
}).strict();
export type AutomationV3WorkerAssignment = z.infer<typeof AutomationV3WorkerAssignmentSchema>;

export const AutomationV3WorkerAssignmentsResponseSchema = z.object({
  assignments: z.array(AutomationV3WorkerAssignmentSchema),
}).strict();
export type AutomationV3WorkerAssignmentsResponse = z.infer<
  typeof AutomationV3WorkerAssignmentsResponseSchema
>;

const AutomationV3WorkerMachineAttemptSchema = z.object({
  machineId: IDENTIFIER_SCHEMA,
  attempt: z.number().int().positive().safe(),
}).strict();

export const AutomationV3WorkerClaimRequestSchema = z.object({
  machineId: IDENTIFIER_SCHEMA,
  leaseDurationMs: z.number().int().min(5_000).max(15 * 60_000).optional(),
}).strict();
export type AutomationV3WorkerClaimRequest = z.infer<typeof AutomationV3WorkerClaimRequestSchema>;

const AutomationRunPluginEventEvidenceV1Schema = AutomationPluginEventOccurrenceEvidenceV1Schema.extend({
  // Evidence persists through the same bounded payload owner as admission.
  payload: asProtocolZod(AutomationEventPayloadV1Schema),
}).strict();

const AutomationRunOriginV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('scheduled'),
    scheduledFor: TIMESTAMP_SCHEMA,
  }).strict(),
  z.object({
    kind: z.literal('manual'),
    invokedAt: TIMESTAMP_SCHEMA,
  }).strict(),
  z.object({
    kind: z.literal('pluginEvent'),
    evidence: AutomationRunPluginEventEvidenceV1Schema,
    sourceInstanceId: AutomationEventSourceInstanceIdV1Schema,
    sourceContractVersion: AutomationEventPositiveSafeIntegerV1Schema,
    observationReceivedAt: TIMESTAMP_SCHEMA,
    filter: z.object({
      version: z.literal(1).nullable(),
      result: z.literal('matched'),
    }).strict(),
  }).strict(),
]);

const AutomationRunExecutionInputEnvelopeSchema = z.string().min(1)
  .max(MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES)
  .superRefine((value, context) => {
    if (UTF8_ENCODER.encode(value).byteLength > MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Execution input exceeds its UTF-8 byte limit',
      });
    }
  });

/**
 * Immutable execution recipe retained on a Run at admission time. Its nested
 * template envelope remains opaque to the server for encrypted Accounts;
 * target, template revision, and origin evidence are frozen with those exact
 * bytes so later definition edits cannot alter the execution request.
 */
export const AutomationRunExecutionInputV1Schema = z.object({
  kind: z.literal('happier_automation_run_execution_input_v1'),
  targetType: AutomationTargetTypeV2Schema,
  templateVersion: z.number().int().nonnegative().safe(),
  templateCiphertext: z.string().min(1).max(220_000),
  origin: AutomationRunOriginV1Schema,
}).strict().superRefine((value, context) => {
  if (
    UTF8_ENCODER.encode(JSON.stringify(value)).byteLength
    > MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Execution input exceeds its UTF-8 byte limit',
    });
  }
});
export type AutomationRunExecutionInputV1 = z.infer<typeof AutomationRunExecutionInputV1Schema>;

/**
 * Bounded durable Run origin. The worker receives this immutable Run fact
 * alongside its frozen recipe; it must never reconstruct origin from a
 * mutable Automation definition.
 */
export const AutomationV3RunOriginSchema = z.union([
  z.object({
    kind: z.literal('scheduled'),
    scheduledFor: TIMESTAMP_SCHEMA,
  }).strict(),
  z.object({
    kind: z.literal('manual'),
    invokedAt: TIMESTAMP_SCHEMA,
  }).strict(),
  z.object({
    kind: z.literal('pluginEvent'),
    occurrenceKey: IDENTIFIER_SCHEMA,
    sourceSelectorId: IDENTIFIER_SCHEMA,
    occurredAt: AutomationOriginOccurredAtV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('conversation'),
    occurrenceKey: IDENTIFIER_SCHEMA,
    occurredAt: AutomationOriginOccurredAtV1Schema,
  }).strict(),
]);
export type AutomationV3RunOrigin = z.infer<typeof AutomationV3RunOriginSchema>;

/**
 * Private worker-only correspondence for the one Conversation handoff that
 * awaits a final Session result. It is omitted for ordinary claims so a new
 * worker can continue to consume a released V3 server claim unchanged.
 */
export const AutomationV3WorkerResultDeliverySchema = z.object({
  kind: z.literal('finalResult'),
  accountId: IDENTIFIER_SCHEMA,
  handoffId: IDENTIFIER_SCHEMA,
}).strict();
export type AutomationV3WorkerResultDelivery = z.infer<
  typeof AutomationV3WorkerResultDeliverySchema
>;

/** Private worker payload; public Run reads remain bounded separately. */
export const AutomationV3WorkerClaimedRunSchema = z.object({
  id: IDENTIFIER_SCHEMA,
  automationId: IDENTIFIER_SCHEMA,
  attempt: z.number().int().positive().safe(),
  // Retained predecessor Runs may lack a recipe. A V3 worker must fail those
  // closed rather than consulting the mutable Automation definition.
  executionInputEnvelope: AutomationRunExecutionInputEnvelopeSchema.nullable(),
  /** Immutable Run-owned origin consumed by the strict recipe materializer. */
  origin: AutomationV3RunOriginSchema,
  /** Omitted for ordinary claims and released V3 predecessor servers. */
  resultDelivery: AutomationV3WorkerResultDeliverySchema.optional(),
}).strict();
export type AutomationV3WorkerClaimedRun = z.infer<typeof AutomationV3WorkerClaimedRunSchema>;

export const AutomationV3WorkerClaimedAutomationSchema = z.object({
  id: IDENTIFIER_SCHEMA,
  name: z.string(),
  enabled: z.boolean(),
}).strict();
export type AutomationV3WorkerClaimedAutomation = z.infer<
  typeof AutomationV3WorkerClaimedAutomationSchema
>;

export const AutomationV3WorkerClaimResponseSchema = z.object({
  run: AutomationV3WorkerClaimedRunSchema.nullable(),
  automation: AutomationV3WorkerClaimedAutomationSchema.nullable(),
  /** C: exact Account witness observed atomically with the successful claim. */
  accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema.nullable(),
}).strict().superRefine((value, context) => {
  if (
    (value.run === null) !== (value.automation === null)
    || (value.run === null) !== (value.accountCurrentness === null)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['accountCurrentness'],
      message: 'A worker claim contains Run, Automation, and Account currentness together or none',
    });
  }
});
export type AutomationV3WorkerClaimResponse = z.infer<typeof AutomationV3WorkerClaimResponseSchema>;

export const AutomationV3WorkerHeartbeatRequestSchema = AutomationV3WorkerMachineAttemptSchema.extend({
  leaseDurationMs: z.number().int().min(5_000).max(15 * 60_000).optional(),
}).strict();
export type AutomationV3WorkerHeartbeatRequest = z.infer<typeof AutomationV3WorkerHeartbeatRequestSchema>;

export const AutomationV3WorkerHeartbeatResponseSchema = z.object({
  ok: z.literal(true),
  leaseExpiresAt: TIMESTAMP_SCHEMA.nullable(),
}).strict();
export type AutomationV3WorkerHeartbeatResponse = z.infer<typeof AutomationV3WorkerHeartbeatResponseSchema>;

/** C must be echoed before a worker may transition a claimed Run to running. */
export const AutomationV3WorkerStartRequestSchema = AutomationV3WorkerMachineAttemptSchema.extend({
  accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema,
}).strict();
export type AutomationV3WorkerStartRequest = z.infer<typeof AutomationV3WorkerStartRequestSchema>;

/** Current writers carry a result envelope; predecessor summary bytes stay V2-only. */
export const AutomationV3WorkerSucceedRequestSchema = AutomationV3WorkerMachineAttemptSchema.extend({
  /** S: exact post-start Account witness. */
  accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema,
  producedSessionId: IDENTIFIER_SCHEMA.nullable().optional(),
  resultEnvelope: z.string().min(1).nullable().optional(),
}).strict();
export type AutomationV3WorkerSucceedRequest = z.infer<typeof AutomationV3WorkerSucceedRequestSchema>;

export const AutomationV3WorkerFailRequestSchema = AutomationV3WorkerMachineAttemptSchema.extend({
  /** S: exact post-start Account witness. */
  accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema,
  /** A known canonical new-Session id survives input failure/cancellation settlement. */
  producedSessionId: IDENTIFIER_SCHEMA.nullable().optional(),
  errorCode: z.string().min(1).max(128).nullable().optional(),
  /** Private Account-mode-correct detail; errorCode remains the structural outcome. */
  errorDetailEnvelope: z.string().min(1).max(MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES).nullable().optional(),
}).strict();
export type AutomationV3WorkerFailRequest = z.infer<typeof AutomationV3WorkerFailRequestSchema>;

export const AutomationV3WorkerExecutionDispatchOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('noRunCreated'),
    errorCode: z.string().min(1).max(128),
  }).strict(),
  z.object({
    kind: z.literal('outcomeUnknown'),
    errorCode: z.string().min(1).max(128),
  }).strict(),
  z.object({
    kind: z.literal('started'),
    runId: IDENTIFIER_SCHEMA,
    callId: IDENTIFIER_SCHEMA,
    sidechainId: IDENTIFIER_SCHEMA,
    wait: ExecutionRunWaitResultSchema.optional(),
  }).strict(),
]);
export type AutomationV3WorkerExecutionDispatchOutcome = z.infer<
  typeof AutomationV3WorkerExecutionDispatchOutcomeSchema
>;

export const AutomationV3WorkerExecutionDispatchSettlementRequestSchema =
  AutomationV3WorkerMachineAttemptSchema.extend({
    accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema,
    outcome: AutomationV3WorkerExecutionDispatchOutcomeSchema,
  }).strict();
export type AutomationV3WorkerExecutionDispatchSettlementRequest = z.infer<
  typeof AutomationV3WorkerExecutionDispatchSettlementRequestSchema
>;

export const AutomationExecutionDispatchStateV3Schema = z.enum([
  'notStarted',
  'dispatchPermitted',
  'retryWaiting',
  'started',
  'settled',
  'outcomeUnknown',
]);
export type AutomationExecutionDispatchStateV3 = z.infer<
  typeof AutomationExecutionDispatchStateV3Schema
>;

export const AutomationReplyHandoffStateV3Schema = z.enum([
  'none',
  'awaitingResult',
  'ready',
  'handingOff',
  'accepted',
  'suppressed',
  'blocked',
]);
export type AutomationReplyHandoffStateV3 = z.infer<typeof AutomationReplyHandoffStateV3Schema>;

/**
 * Bounded, non-secret Run list item. It intentionally omits equality tags,
 * error text, legacy summaries, request/result envelopes, reply context, and
 * receipt bytes.
 */
export const AutomationV3RunListItemSchema = z.object({
  id: IDENTIFIER_SCHEMA,
  automationId: IDENTIFIER_SCHEMA,
  state: AutomationRunStateV3Schema,
  origin: AutomationV3RunOriginSchema,
  dueAt: TIMESTAMP_SCHEMA,
  claimedAt: TIMESTAMP_SCHEMA.nullable(),
  startedAt: TIMESTAMP_SCHEMA.nullable(),
  finishedAt: TIMESTAMP_SCHEMA.nullable(),
  claimedByMachineId: IDENTIFIER_SCHEMA.nullable(),
  leaseExpiresAt: TIMESTAMP_SCHEMA.nullable(),
  attempt: z.number().int().nonnegative().safe(),
  errorCode: z.string().nullable(),
  producedSessionId: IDENTIFIER_SCHEMA.nullable(),
  executionDispatchState: AutomationExecutionDispatchStateV3Schema.nullable(),
  executionAttempt: z.number().int().nonnegative().safe(),
  replyHandoffState: AutomationReplyHandoffStateV3Schema,
  replyHandoffAttempt: z.number().int().nonnegative().safe(),
  replyHandoffDueAt: TIMESTAMP_SCHEMA.nullable(),
  createdAt: TIMESTAMP_SCHEMA,
  updatedAt: TIMESTAMP_SCHEMA,
}).strict();
export type AutomationV3RunListItem = z.infer<typeof AutomationV3RunListItemSchema>;

/** S: returned atomically with a successful start and required for settlement. */
export const AutomationV3WorkerStartResponseSchema = z.object({
  run: AutomationV3RunListItemSchema,
  accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema,
}).strict();
export type AutomationV3WorkerStartResponse = z.infer<typeof AutomationV3WorkerStartResponseSchema>;

/**
 * Exact Run detail deliberately permits only direct user request/result and
 * private failure-detail envelopes. Opaque reply routing/receipt content
 * remains Channels-owned.
 */
export const AutomationV3RunDetailSchema = AutomationV3RunListItemSchema.extend({
  triggerEvidenceEnvelope: z.string().min(1).nullable(),
  executionInputEnvelope: z.string().min(1).nullable(),
  resultEnvelope: z.string().min(1).nullable(),
  legacySummaryCiphertext: z.string().min(1).nullable(),
  /** Exact private Run failure detail; never emitted by list or mutation projections. */
  errorDetailEnvelope: z.string().min(1).max(MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES).nullable().optional(),
}).strict().superRefine((value, context) => {
  if (value.resultEnvelope !== null && value.legacySummaryCiphertext !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['resultEnvelope'],
      message: 'A Run detail has either a current result envelope or a predecessor summary, not both',
    });
  }
});
export type AutomationV3RunDetail = z.infer<typeof AutomationV3RunDetailSchema>;

export const AutomationV3RunListResponseSchema = z.object({
  runs: z.array(AutomationV3RunListItemSchema),
  nextCursor: z.string().nullable(),
}).strict();
export type AutomationV3RunListResponse = z.infer<typeof AutomationV3RunListResponseSchema>;

export const AutomationV3RunMutationResponseSchema = z.object({
  run: AutomationV3RunListItemSchema,
}).strict();
export type AutomationV3RunMutationResponse = z.infer<typeof AutomationV3RunMutationResponseSchema>;

export const AutomationV3DeleteResponseSchema = z.object({ ok: z.literal(true) }).strict();
export type AutomationV3DeleteResponse = z.infer<typeof AutomationV3DeleteResponseSchema>;
