import { z } from 'zod';

import {
  AutomationReplyHandoffStateV1Schema,
  type AutomationReplyHandoffStateV1,
} from './automationReplyHandoffStateV1.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';

import { AutomationRunStateV3Schema } from './automationRunStateV3.js';
import { AutomationIdV1Schema } from './automationIdV1.js';
import {
  AutomationAccountCurrentnessWitnessV1Schema,
  AutomationEventPayloadV1Schema,
  AutomationEventSourceStatusV1Schema,
  MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES,
} from './automationEventV1.js';
import { AutomationEventPositiveSafeIntegerV1Schema } from './automationEventDeclarationV1.js';
import {
  AutomationEventSourceCatalogStatusStateV1Schema,
  UNSIGNED_DECIMAL_BIGINT_SCHEMA,
} from './automationActionSpecsV1.js';
import {
  AutomationStoredDefinitionExecutionRecipeV1Schema,
} from './automationRunExecutionRecipeV1.js';
import { ExecutionRunWaitResultSchema } from '../execution/runs/index.js';
import { AUTOMATION_TEMPLATE_CIPHERTEXT_MAX_CHARS } from './automationTemplateEnvelope.js';
import {
  AutomationTriggerIdSchema,
  AutomationTriggerRevisionSchema,
} from './automationTriggerIdentity.js';
import {
  AutomationRunCauseSchema,
  type AutomationRunCause,
} from './automationRunCause.js';
import { PluginMachineMaterializationRefV1Schema } from '../plugins/availability/materializationRefV1.js';
export { AutomationRunCauseSchema, type AutomationRunCause };
import {
  AutomationEncryptedTriggerDefinitionEnvelopeV1Schema,
  AutomationScheduleTriggerSchema,
  AutomationTriggerDefinitionSchema,
  AutomationTriggerDefinitionInputSchema,
} from './automationTriggerDefinition.js';

export {
  AutomationEncryptedTriggerDefinitionEnvelopeV1Schema,
  AutomationPluginEventDefinitionTriggerInputSchema,
  AutomationPluginEventEncryptedDefinitionTriggerSchema,
  AutomationPluginEventDefinitionTriggerSchema,
  AutomationPluginEventObservationTransportInputSchema,
  AutomationScheduleTriggerInputSchema,
  AutomationScheduleTriggerSchema,
  AutomationSessionLifecycleRegistrationErrorCodeSchema,
  AutomationSessionLifecycleTriggerInputSchema,
  AutomationSessionLifecycleTriggerSchema,
  AutomationTriggerDefinitionInputSchema,
  AutomationTriggerDefinitionSchema,
} from './automationTriggerDefinition.js';
export type {
  AutomationEncryptedTriggerDefinitionEnvelopeV1,
  AutomationPluginEventDefinitionTrigger,
  AutomationPluginEventDefinitionTriggerInput,
  AutomationPluginEventEncryptedDefinitionTrigger,
  AutomationPluginEventObservationTransportInput,
  AutomationScheduleTrigger,
  AutomationScheduleTriggerInput,
  AutomationSessionLifecycleRegistrationErrorCode,
  AutomationSessionLifecycleTrigger,
  AutomationSessionLifecycleTriggerInput,
  AutomationTriggerDefinition,
  AutomationTriggerDefinitionInput,
} from './automationTriggerDefinition.js';

const PREDECESSOR_TIMESTAMP_SCHEMA = z.number().int();
const TIMESTAMP_SCHEMA = z.number().int().nonnegative().safe();
const IDENTIFIER_SCHEMA = z.string().min(1);
const UTF8_ENCODER = new TextEncoder();

/**
 * List/detail-safe catalog reconciliation facts for the current Event source.
 * Routing, Account, source, and materialization identity remain server-owned.
 */
export const AutomationEventSourceCatalogStatusSchema = z.object({
  observedRevision: UNSIGNED_DECIMAL_BIGINT_SCHEMA,
  adoptedRevision: UNSIGNED_DECIMAL_BIGINT_SCHEMA.nullable(),
  state: AutomationEventSourceCatalogStatusStateV1Schema,
  scanStartedAt: TIMESTAMP_SCHEMA.nullable(),
  nextRetryAt: TIMESTAMP_SCHEMA.nullable(),
}).strict();
export type AutomationEventSourceCatalogStatus = z.infer<
  typeof AutomationEventSourceCatalogStatusSchema
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

/** Exact released V2 Run wire shape. Do not add cause or private-envelope fields. */
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

export const AutomationAssignmentSchema = z.object({
  machineId: IDENTIFIER_SCHEMA,
  enabled: z.boolean(),
  priority: z.number().int(),
  updatedAt: TIMESTAMP_SCHEMA.nullable(),
}).strict();
export type AutomationAssignment = z.infer<typeof AutomationAssignmentSchema>;

/** Input form for the one existing Automation-assignment owner. */
export const AutomationAssignmentInputSchema = z.object({
  machineId: IDENTIFIER_SCHEMA,
  enabled: z.boolean().optional(),
  priority: z.number().int().min(-100).max(100).optional(),
}).strict();
export type AutomationAssignmentInput = z.infer<typeof AutomationAssignmentInputSchema>;

export const AutomationAssignmentUpdateRequestSchema = z.object({
  assignments: z.array(AutomationAssignmentInputSchema),
}).strict();
export type AutomationAssignmentUpdateRequest = z.infer<typeof AutomationAssignmentUpdateRequestSchema>;

/**
 * A mutable definition has no immutable occurrence evidence. Canonical
 * admission freezes the current recipe and enabled assignments onto each Run,
 * adding kind-owned evidence only when the cause has private input. The rule
 * belongs to the recipe owner so every authoring surface shares it.
 */
const AutomationDefinitionExecutionRecipeSchema =
  AutomationStoredDefinitionExecutionRecipeV1Schema;

export const AutomationTriggerCreateRequestSchema = z.object({
  triggerId: AutomationTriggerIdSchema,
  trigger: AutomationTriggerDefinitionInputSchema,
}).strict();
export type AutomationTriggerCreateRequest = z.infer<
  typeof AutomationTriggerCreateRequestSchema
>;

export const AutomationDefinitionCreateRequestSchema = z.object({
  automationId: asProtocolZod(AutomationIdV1Schema),
  name: z.string().trim().min(1).max(128),
  description: z.string().max(2_000).nullable().optional(),
  enabled: z.boolean(),
  executionRecipe: AutomationDefinitionExecutionRecipeSchema,
  assignments: z.array(AutomationAssignmentInputSchema).optional(),
  triggers: z.array(AutomationTriggerCreateRequestSchema),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  value.triggers.forEach((item, index) => {
    if (seen.has(item.triggerId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['triggers', index, 'triggerId'],
        message: 'Automation trigger identities must be unique',
      });
    }
    seen.add(item.triggerId);
  });
});
export type AutomationDefinitionCreateRequest = z.infer<
  typeof AutomationDefinitionCreateRequestSchema
>;

export const AutomationDefinitionPatchRequestSchema = z.object({
  expectedTemplateVersion: z.number().int().nonnegative().safe(),
  name: z.string().trim().min(1).max(128).optional(),
  description: z.string().max(2_000).nullable().optional(),
  enabled: z.boolean().optional(),
  executionRecipe: AutomationDefinitionExecutionRecipeSchema.optional(),
  assignments: z.array(AutomationAssignmentInputSchema).optional(),
}).strict();
export type AutomationDefinitionPatchRequest = z.infer<
  typeof AutomationDefinitionPatchRequestSchema
>;

/**
 * One retained row in a full-editor save. Omitting both mutation fields keeps
 * the row byte-for-byte unchanged while still supplying its exact CAS witness.
 */
export const AutomationTriggerReconcileExistingItemSchema = z.object({
  kind: z.literal('existing'),
  triggerId: AutomationTriggerIdSchema,
  expectedRevision: AutomationTriggerRevisionSchema,
  enabled: z.boolean().optional(),
  trigger: AutomationTriggerDefinitionSchema.optional(),
  triggerDefinitionEnvelope: AutomationEncryptedTriggerDefinitionEnvelopeV1Schema.optional(),
}).strict().superRefine((value, context) => {
  if (
    value.triggerDefinitionEnvelope !== undefined
    && (value.enabled === undefined || value.trigger !== undefined)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['triggerDefinitionEnvelope'],
      message: 'A resealed trigger definition accompanies only an enable-only patch',
    });
  }
});
export type AutomationTriggerReconcileExistingItem = z.infer<
  typeof AutomationTriggerReconcileExistingItemSchema
>;

export const AutomationTriggerReconcileNewItemSchema = z.object({
  kind: z.literal('new'),
  triggerId: AutomationTriggerIdSchema,
  trigger: AutomationTriggerDefinitionInputSchema,
}).strict();
export type AutomationTriggerReconcileNewItem = z.infer<
  typeof AutomationTriggerReconcileNewItemSchema
>;

/**
 * The one whole-editor mutation contract. The complete retained/new/removed
 * trigger census lets the server reject stale membership and commit the
 * definition, recipe, assignments, and trigger set in one transaction.
 */
export const AutomationDefinitionReconcileRequestSchema = z.object({
  expectedTemplateVersion: z.number().int().nonnegative().safe(),
  name: z.string().trim().min(1).max(128),
  description: z.string().max(2_000).nullable(),
  enabled: z.boolean(),
  executionRecipe: AutomationDefinitionExecutionRecipeSchema.optional(),
  assignments: z.array(AutomationAssignmentInputSchema),
  triggers: z.array(z.union([
    AutomationTriggerReconcileExistingItemSchema,
    AutomationTriggerReconcileNewItemSchema,
  ])),
  removedTriggers: z.array(z.object({
    triggerId: AutomationTriggerIdSchema,
    expectedRevision: AutomationTriggerRevisionSchema,
  }).strict()),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  const visit = (triggerId: string, path: ReadonlyArray<string | number>) => {
    if (seen.has(triggerId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path],
        message: 'Automation trigger identities must be unique across the editor census',
      });
    }
    seen.add(triggerId);
  };
  value.triggers.forEach((item, index) => visit(item.triggerId, ['triggers', index, 'triggerId']));
  value.removedTriggers.forEach((item, index) => visit(
    item.triggerId,
    ['removedTriggers', index, 'triggerId'],
  ));
});
export type AutomationDefinitionReconcileRequest = z.infer<
  typeof AutomationDefinitionReconcileRequestSchema
>;

export const AutomationTriggerPatchRequestSchema = z.object({
  triggerId: AutomationTriggerIdSchema,
  expectedRevision: AutomationTriggerRevisionSchema,
  enabled: z.boolean().optional(),
  trigger: AutomationTriggerDefinitionSchema.optional(),
  /**
   * Exact next-revision reseal for an enable-only encrypted Event patch. The
   * server validates it against the unchanged public row binding and current
   * Account mode; semantic edits carry their envelope in `trigger` instead.
   */
  triggerDefinitionEnvelope: AutomationEncryptedTriggerDefinitionEnvelopeV1Schema.optional(),
}).strict().superRefine((value, context) => {
  if (value.enabled === undefined && value.trigger === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'A trigger patch must change enablement or definition' });
  }
  if (
    value.triggerDefinitionEnvelope !== undefined
    && (value.enabled === undefined || value.trigger !== undefined)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['triggerDefinitionEnvelope'],
      message: 'A resealed trigger definition accompanies only an enable-only patch',
    });
  }
});
export type AutomationTriggerPatchRequest = z.infer<
  typeof AutomationTriggerPatchRequestSchema
>;

export const AutomationTriggerDeleteRequestSchema = z.object({
  triggerId: AutomationTriggerIdSchema,
  expectedRevision: AutomationTriggerRevisionSchema,
}).strict();
export type AutomationTriggerDeleteRequest = z.infer<
  typeof AutomationTriggerDeleteRequestSchema
>;

export const AutomationPluginEventRefSchema = z.object({
  pluginId: IDENTIFIER_SCHEMA,
  localId: IDENTIFIER_SCHEMA,
}).strict();
export type AutomationPluginEventRef = z.infer<typeof AutomationPluginEventRefSchema>;

export const AutomationCheckpointedPullObservationSchema = z.object({
  kind: z.literal('checkpointedPull'),
  watcher: z.object({
    machineId: IDENTIFIER_SCHEMA,
    machineInstallationId: IDENTIFIER_SCHEMA,
    pluginId: IDENTIFIER_SCHEMA,
    materializationId: IDENTIFIER_SCHEMA,
  }).strict().nullable(),
}).strict();
export type AutomationCheckpointedPullObservation = z.infer<
  typeof AutomationCheckpointedPullObservationSchema
>;

export const AutomationDurablePushObservationSchema = z.object({
  kind: z.literal('durablePush'),
  webhookEndpointId: IDENTIFIER_SCHEMA,
  /** Safe current endpoint target; null when that exact endpoint is no longer available. */
  endpointMaterializationRef: PluginMachineMaterializationRefV1Schema.nullable(),
  observationStartsAt: TIMESTAMP_SCHEMA,
}).strict();
export type AutomationDurablePushObservation = z.infer<
  typeof AutomationDurablePushObservationSchema
>;

export const AutomationPluginEventTriggerSchema = z.object({
  kind: z.literal('pluginEvent'),
  eventRef: AutomationPluginEventRefSchema,
  sourceSelectorId: IDENTIFIER_SCHEMA,
  sourceContractVersion: AutomationEventPositiveSafeIntegerV1Schema,
  observation: z.union([
    AutomationCheckpointedPullObservationSchema,
    AutomationDurablePushObservationSchema,
  ]),
}).strict();
export type AutomationPluginEventTrigger = z.infer<typeof AutomationPluginEventTriggerSchema>;

const AutomationTriggerProjectionBaseSchema = z.object({
  id: AutomationTriggerIdSchema,
  revision: AutomationTriggerRevisionSchema,
  enabled: z.boolean(),
  createdAt: TIMESTAMP_SCHEMA,
  updatedAt: TIMESTAMP_SCHEMA,
}).strict();

export const AutomationScheduleTriggerProjectionSchema = AutomationTriggerProjectionBaseSchema.extend({
  ...AutomationScheduleTriggerSchema.shape,
  nextRunAt: TIMESTAMP_SCHEMA.nullable(),
}).strict();

export const AutomationPluginEventTriggerProjectionSchema = AutomationTriggerProjectionBaseSchema.extend({
  ...AutomationPluginEventTriggerSchema.shape,
  sourceStatus: AutomationEventSourceStatusV1Schema.nullable(),
  sourceCatalogStatus: AutomationEventSourceCatalogStatusSchema.nullable(),
}).strict();

export const AutomationSessionLifecycleTriggerStatusSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.enum(['waiting', 'paused', 'sourceFailed', 'sourceCancelled', 'sourceUnavailable']),
    runId: z.null(),
  }).strict(),
  z.object({
    state: z.enum(['triggered', 'running']),
    runId: IDENTIFIER_SCHEMA,
  }).strict(),
  z.object({
    state: z.literal('finished'),
    runId: IDENTIFIER_SCHEMA.nullable(),
  }).strict(),
]);
export type AutomationSessionLifecycleTriggerStatus = z.infer<
  typeof AutomationSessionLifecycleTriggerStatusSchema
>;

export const AutomationSessionLifecycleTriggerProjectionSchema = AutomationTriggerProjectionBaseSchema.extend({
  kind: z.literal('sessionLifecycle'),
  event: z.literal('parentTurnCompleted'),
  scope: z.object({
    kind: z.literal('exactTurn'),
    sourceSessionId: IDENTIFIER_SCHEMA,
    sourceTurnId: IDENTIFIER_SCHEMA,
  }).strict(),
  consumption: z.literal('once'),
  status: AutomationSessionLifecycleTriggerStatusSchema,
}).strict();

export const AutomationTriggerListItemSchema = z.discriminatedUnion('kind', [
  AutomationScheduleTriggerProjectionSchema,
  AutomationPluginEventTriggerProjectionSchema,
  AutomationSessionLifecycleTriggerProjectionSchema,
]);
export type AutomationTriggerListItem = z.infer<typeof AutomationTriggerListItemSchema>;

export const AutomationTriggerDetailSchema = z.discriminatedUnion('kind', [
  AutomationScheduleTriggerProjectionSchema.extend({ triggerDefinitionEnvelope: z.null() }).strict(),
  AutomationPluginEventTriggerProjectionSchema.extend({
    triggerDefinitionEnvelope: z.string().min(1),
  }).strict(),
  AutomationSessionLifecycleTriggerProjectionSchema.extend({
    triggerDefinitionEnvelope: z.null(),
  }).strict(),
]);
export type AutomationTriggerDetail = z.infer<typeof AutomationTriggerDetailSchema>;

/**
 * Read-only tombstone facts for an automatic trigger removed from the mutable
 * definition. Retired rows never re-enter `triggers[]`; immutable Runs remain
 * the owner of historical cause details.
 */
export const AutomationRetiredTriggerProjectionSchema = z.object({
  id: AutomationTriggerIdSchema,
  kind: z.enum(['schedule', 'pluginEvent', 'sessionLifecycle']),
  revision: AutomationTriggerRevisionSchema,
  retiredAt: TIMESTAMP_SCHEMA,
}).strict();
export type AutomationRetiredTriggerProjection = z.infer<
  typeof AutomationRetiredTriggerProjectionSchema
>;

const AutomationDefinitionBaseSchema = z.object({
  id: IDENTIFIER_SCHEMA,
  name: z.string(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  targetType: AutomationTargetTypeV3Schema,
  /**
   * Bounded existing-Session association projected by the definition owner
   * from the current strict recipe. It is `null` for every other target and
   * for a retained predecessor template, whose association is only readable
   * by a client that can open the template.
   */
  existingSessionId: IDENTIFIER_SCHEMA.nullable(),
  templateVersion: z.number().int().nonnegative().safe(),
  lastRunAt: TIMESTAMP_SCHEMA.nullable(),
  createdAt: TIMESTAMP_SCHEMA,
  updatedAt: TIMESTAMP_SCHEMA,
  assignments: z.array(AutomationAssignmentSchema),
  retiredTriggers: z.array(AutomationRetiredTriggerProjectionSchema),
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

const AutomationDefinitionDetailContentShape = {
  /** Direct-reader-only predecessor bytes. Current writers never send this field. */
  templateCiphertext: z.string().min(1).optional(),
  /** Direct-reader-only current recipe; definition lists never disclose it. */
  executionRecipe: AutomationStoredDefinitionExecutionRecipeV1Schema.optional(),
};

/** Bounded definition list item; no private source/configuration envelope. */
export const AutomationDefinitionListItemSchema = AutomationDefinitionBaseSchema.extend({
  triggers: z.array(AutomationTriggerListItemSchema),
}).strict();
export type AutomationDefinitionListItem = z.infer<typeof AutomationDefinitionListItemSchema>;

/**
 * Direct authenticated definition detail. The private trigger envelope is
 * never returned from list/status/source projections.
 */
export const AutomationDefinitionDetailSchema = AutomationDefinitionBaseSchema.extend({
  triggers: z.array(AutomationTriggerDetailSchema),
  ...AutomationDefinitionDetailContentShape,
}).strict().superRefine(requireExactlyOneDefinitionContent);
export type AutomationDefinitionDetail = z.infer<typeof AutomationDefinitionDetailSchema>;

export const AutomationDefinitionListResponseSchema = z.object({
  automations: z.array(AutomationDefinitionListItemSchema),
}).strict();
export type AutomationDefinitionListResponse = z.infer<typeof AutomationDefinitionListResponseSchema>;

export const DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE = 4;
export const DEFAULT_AUTOMATION_V3_RUN_RETENTION = 'thirtyDays';

/**
 * Account-scoped Automation preferences are server-readable operational
 * policy, not Account private-settings content: the assignment and retention
 * owners must apply them while an Account is E2EE.
 *
 * Prisma `Int` is signed 32-bit on the portable PostgreSQL/MySQL schema, so
 * this upper bound is a persistence contract rather than a product ceiling.
 */
export const AutomationV3MaxActiveRunsPerMachineSchema = z.number()
  .int()
  .min(1)
  .max(2_147_483_647);
export type AutomationV3MaxActiveRunsPerMachine = z.infer<
  typeof AutomationV3MaxActiveRunsPerMachineSchema
>;

export const AutomationV3RunRetentionSchema = z.enum([
  'thirtyDays',
  'keepForever',
]);
export type AutomationV3RunRetention = z.infer<typeof AutomationV3RunRetentionSchema>;

export const AutomationV3SettingsSchema = z.object({
  maxActiveRunsPerMachine: AutomationV3MaxActiveRunsPerMachineSchema,
  runRetention: AutomationV3RunRetentionSchema,
}).strict();
export type AutomationV3Settings = z.infer<typeof AutomationV3SettingsSchema>;

/** A PUT replaces the complete bounded Automation preference record. */
export const AutomationV3SettingsUpdateRequestSchema = AutomationV3SettingsSchema;
export type AutomationV3SettingsUpdateRequest = z.infer<
  typeof AutomationV3SettingsUpdateRequestSchema
>;

/** The worker consumes only the per-machine claim cap, never retention policy. */
export const AutomationV3WorkerSettingsSchema = z.object({
  maxActiveRunsPerMachine: AutomationV3MaxActiveRunsPerMachineSchema,
}).strict();
export type AutomationV3WorkerSettings = z.infer<typeof AutomationV3WorkerSettingsSchema>;

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
  settings: AutomationV3WorkerSettingsSchema,
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

/** Exact physical provenance shape retained only inside the released V2 frozen-input adapter. */
const AutomationRunExecutionInputV1OriginSchema = z.union([
  z.object({
    kind: z.literal('scheduled'),
    scheduledFor: TIMESTAMP_SCHEMA,
  }).strict(),
  z.object({
    kind: z.literal('manual'),
    invokedAt: TIMESTAMP_SCHEMA,
  }).strict(),
]);

/**
 * Physical frozen-input adapter for released V2 Definition bytes. Its
 * predecessor `origin` field is deliberately isolated here and gains no
 * current cause fields. Current Definitions, Runs, claims, and projections use
 * the canonical stored/run recipe and AutomationRunCause models instead.
 */
export const AutomationRunExecutionInputV1Schema = z.object({
  kind: z.literal('happier_automation_run_execution_input_v1'),
  targetType: AutomationTargetTypeV2Schema,
  templateVersion: z.number().int().nonnegative().safe(),
  templateCiphertext: z.string().min(1).max(AUTOMATION_TEMPLATE_CIPHERTEXT_MAX_CHARS),
  origin: AutomationRunExecutionInputV1OriginSchema,
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
 * The one current-cause to released-V2 frozen-input adapter. `null` means the
 * Run cause cannot be represented on the released schedule/manual wire.
 */
export function toAutomationRunExecutionInputV1Origin(
  cause: AutomationRunCause,
): AutomationRunExecutionInputV1['origin'] | null {
  if (cause.kind === 'manual') {
    return { kind: 'manual', invokedAt: cause.invokedAt };
  }
  if (cause.kind === 'trigger' && cause.triggerKind === 'schedule') {
    return { kind: 'scheduled', scheduledFor: cause.evidence.scheduledFor };
  }
  return null;
}

/**
 * Private worker-only correspondence for the one Conversation handoff that
 * awaits a final Session result. It is omitted for ordinary claims.
 */
export const AutomationV3WorkerResultDeliverySchema = z.object({
  kind: z.literal('finalResult'),
  accountId: IDENTIFIER_SCHEMA,
  handoffId: IDENTIFIER_SCHEMA,
}).strict();
export type AutomationV3WorkerResultDelivery = z.infer<
  typeof AutomationV3WorkerResultDeliverySchema
>;

function addRunTriggerCauseCorrespondenceIssue(
  value: Readonly<{
    triggerId: string | null;
    triggerRetired: boolean;
    cause: z.infer<typeof AutomationRunCauseSchema>;
  }>,
  context: z.RefinementCtx,
): void {
  const corresponds = value.cause.kind === 'trigger'
    ? value.triggerId === value.cause.triggerId
    : value.triggerId === null && value.triggerRetired === false;
  if (!corresponds) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['triggerId'],
      message: 'Run trigger relation must correspond to its immutable cause',
    });
  }
}

/** Private worker payload; public Run reads remain bounded separately. */
export const AutomationV3WorkerClaimedRunSchema = z.object({
  id: IDENTIFIER_SCHEMA,
  automationId: IDENTIFIER_SCHEMA,
  attempt: z.number().int().positive().safe(),
  // Retained predecessor Runs may lack a recipe. A V3 worker must fail those
  // closed rather than consulting the mutable Automation definition.
  executionInputEnvelope: AutomationRunExecutionInputEnvelopeSchema.nullable(),
  triggerId: AutomationTriggerIdSchema.nullable(),
  triggerRetired: z.boolean(),
  /** Immutable Run-owned cause consumed by the strict recipe materializer. */
  cause: AutomationRunCauseSchema,
  /** Omitted for ordinary claims. */
  resultDelivery: AutomationV3WorkerResultDeliverySchema.optional(),
}).strict().superRefine(addRunTriggerCauseCorrespondenceIssue);
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
  /** S: the post-start Account witness, echoed unchanged from the successful start. */
  accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema,
  producedSessionId: IDENTIFIER_SCHEMA.nullable().optional(),
  resultEnvelope: z.string().min(1).nullable().optional(),
}).strict();
export type AutomationV3WorkerSucceedRequest = z.infer<typeof AutomationV3WorkerSucceedRequestSchema>;

export const AutomationV3WorkerFailRequestSchema = AutomationV3WorkerMachineAttemptSchema.extend({
  /** S: the post-start Account witness, echoed unchanged from the successful start. */
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

export const AutomationReplyHandoffStateV3Schema = AutomationReplyHandoffStateV1Schema;
export type AutomationReplyHandoffStateV3 = AutomationReplyHandoffStateV1;

/**
 * Bounded, non-secret Run list item. It intentionally omits equality tags,
 * error text, legacy summaries, request/result envelopes, reply context, and
 * receipt bytes.
 */
const AutomationV3RunListItemShape = {
  id: IDENTIFIER_SCHEMA,
  automationId: IDENTIFIER_SCHEMA,
  /** Exact persisted Run revision used by user-authorized lifecycle mutations. */
  revision: z.number().int().nonnegative().safe(),
  triggerId: AutomationTriggerIdSchema.nullable(),
  triggerRetired: z.boolean(),
  state: AutomationRunStateV3Schema,
  cause: AutomationRunCauseSchema,
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
} as const;
export const AutomationV3RunListItemSchema = z.object(AutomationV3RunListItemShape)
  .strict()
  .superRefine(addRunTriggerCauseCorrespondenceIssue);
export type AutomationV3RunListItem = z.infer<typeof AutomationV3RunListItemSchema>;

/** S: returned atomically with a successful start and required for settlement. */
export const AutomationV3WorkerStartResponseSchema = z.object({
  run: AutomationV3RunListItemSchema,
  accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema,
}).strict();
export type AutomationV3WorkerStartResponse = z.infer<typeof AutomationV3WorkerStartResponseSchema>;

/**
 * One committed Run lifecycle transition, as the user can read it. Every field
 * is a server-authored, bounded, non-secret fact: no envelope bytes, prompt
 * text, provider payload, or free-form message ever reaches this projection.
 */
export const AutomationV3RunEventSchema = z.object({
  at: TIMESTAMP_SCHEMA,
  /** Server-authored transition name, e.g. `run_started`, `run_outcome_uncertain`. */
  type: z.string().min(1).max(64),
  machineId: IDENTIFIER_SCHEMA.nullable(),
  /** Bounded rejection/outcome code exactly as the Run recorded it. */
  errorCode: z.string().min(1).max(128).nullable(),
  /** Dispatch attempt this transition belongs to; the Run's own claim attempt stays on the Run. */
  executionAttempt: z.number().int().nonnegative().safe().nullable(),
  /** Which dispatch result the settlement owner committed. */
  outcome: z.string().min(1).max(64).nullable(),
  /** Why a lifecycle owner other than the worker terminalized the Run. */
  reason: z.string().min(1).max(128).nullable(),
}).strict();
export type AutomationV3RunEvent = z.infer<typeof AutomationV3RunEventSchema>;

/**
 * How much ordered transition history one Run detail carries. Claim attempts
 * are not themselves bounded — lease recovery may requeue a Run indefinitely —
 * so the detail keeps the most recent transitions rather than an unbounded
 * history, which holds this array under ~20 KB at the ~200-byte ceiling each
 * projected event above can reach.
 */
export const AUTOMATION_V3_RUN_DETAIL_MAX_EVENTS = 100;

/**
 * Exact Run detail deliberately permits only direct user request/result and
 * private failure-detail envelopes. Opaque reply routing/receipt content
 * remains Channels-owned.
 */
export const AutomationV3RunDetailSchema = z.object({
  ...AutomationV3RunListItemShape,
  triggerEvidenceEnvelope: z.string().min(1).nullable(),
  executionInputEnvelope: z.string().min(1).nullable(),
  resultEnvelope: z.string().min(1).nullable(),
  legacySummaryCiphertext: z.string().min(1).nullable(),
  /**
   * The native execution this Run started. It is the only pointer back to work
   * that may still be running when the Run itself is uncertain, so the detail
   * shows it instead of leaving the user with an unexplained outcome.
   */
  executionNativeRunId: IDENTIFIER_SCHEMA.nullable(),
  executionNativeCallId: IDENTIFIER_SCHEMA.nullable(),
  executionNativeSidechainId: IDENTIFIER_SCHEMA.nullable(),
  /** Committed lifecycle transitions in ascending time order. */
  events: z.array(AutomationV3RunEventSchema).max(AUTOMATION_V3_RUN_DETAIL_MAX_EVENTS),
  /** Exact private Run failure detail; never emitted by list or mutation projections. */
  errorDetailEnvelope: z.string().min(1).max(MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES).nullable().optional(),
}).strict().superRefine((value, context) => {
  addRunTriggerCauseCorrespondenceIssue(value, context);
  if (value.resultEnvelope !== null && value.legacySummaryCiphertext !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['resultEnvelope'],
      message: 'A Run detail has either a current result envelope or a predecessor summary, not both',
    });
  }
});
export type AutomationV3RunDetail = z.infer<typeof AutomationV3RunDetailSchema>;

/** Canonical public Run-list/API page bound. */
export const AUTOMATION_V3_RUN_LIST_MAX_ITEMS = 100;

export const AutomationV3RunListResponseSchema = z.object({
  runs: z.array(AutomationV3RunListItemSchema).max(AUTOMATION_V3_RUN_LIST_MAX_ITEMS),
  nextCursor: z.string().nullable(),
}).strict();
export type AutomationV3RunListResponse = z.infer<typeof AutomationV3RunListResponseSchema>;

/** Result of removing eligible terminal history for one Automation. */
export const AutomationV3ClearRunHistoryResponseSchema = z.object({
  clearedRuns: z.number().int().nonnegative().safe(),
}).strict();
export type AutomationV3ClearRunHistoryResponse = z.infer<
  typeof AutomationV3ClearRunHistoryResponseSchema
>;

export const AutomationV3RunMutationResponseSchema = z.object({
  run: AutomationV3RunListItemSchema,
}).strict();
export type AutomationV3RunMutationResponse = z.infer<typeof AutomationV3RunMutationResponseSchema>;

export const AutomationDeleteResponseSchema = z.object({ ok: z.literal(true) }).strict();
export type AutomationDeleteResponse = z.infer<typeof AutomationDeleteResponseSchema>;
