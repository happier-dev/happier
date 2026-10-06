import { lazyZodSchema } from '../lazyZodSchema.js';
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
import { AutomationEventPositiveSafeIntegerV1Schema } from './automationColumnBoundsV1.js';
import {
  AutomationEventSourceCatalogStatusStateV1Schema,
  OPAQUE_CURSOR_SCHEMA,
  UNSIGNED_DECIMAL_BIGINT_SCHEMA,
} from './automationActionSpecsV1.js';
import {
  AutomationStoredDefinitionExecutionRecipeV1Schema,
  AutomationStoredDefinitionExecutionRecipeV1ReadSchema,
} from './automationRunExecutionRecipeV1.js';
import { AutomationStoredWorkflowDefinitionRecipeV2Schema, AutomationStoredWorkflowDefinitionRecipeV2ReadSchema } from './automationWorkflowRecipeV2.js';
import { ExecutionRunWaitResultSchema } from '../execution/runs/responseSchemas.js';
import { AUTOMATION_TEMPLATE_CIPHERTEXT_MAX_CHARS } from './automationTemplateEnvelope.js';
import {
  AutomationTriggerIdSchema,
  AutomationTriggerRevisionSchema,
} from './automationTriggerIdentity.js';
import {
  AutomationRunCauseSchema,
  type AutomationRunCause,
  type AutomationRunCauseDeclarationV1,
} from './automationRunCause.js';
import { PluginMachineMaterializationRefV1Schema } from '../plugins/availability/materializationRefV1.js';
export { AutomationRunCauseSchema, type AutomationRunCause, type AutomationRunCauseDeclarationV1 };
import {
  AutomationEncryptedTriggerDefinitionEnvelopeV1Schema,
  AutomationScheduleTriggerSchema,
  AutomationTriggerDefinitionSchema,
  AutomationTriggerDefinitionInputSchema,
} from './automationTriggerDefinition.js';
import { AutomationSessionLifecycleConfigurationSchema } from './automationSessionLifecycle.js';
export * from './automationRunLifecycle.js';
import type { AutomationTriggerDetail, AutomationTriggerListItem } from './automationTriggerProjectionV1.js';
import { WorkflowDefinitionRefV1StringSchema } from '../workflows/workflowDefinitionRefV1.js';

export {
  AutomationEncryptedTriggerDefinitionEnvelopeV1Schema,
  AutomationPluginEventDefinitionTriggerInputSchema,
  AutomationPluginEventEncryptedDefinitionTriggerSchema,
  AutomationPluginEventDefinitionTriggerSchema,
  AutomationPluginEventObservationTransportInputSchema,
  AutomationPullRequestTriggerSchema,
  AutomationPullRequestEncryptedTriggerSchema,
  AutomationPullRequestTriggerInputSchema,
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
  AutomationPullRequestTrigger,
  AutomationPullRequestTriggerInput,
  AutomationScheduleTrigger,
  AutomationScheduleTriggerInput,
  AutomationSessionLifecycleRegistrationErrorCode,
  AutomationSessionLifecycleTrigger,
  AutomationSessionLifecycleTriggerInput,
  AutomationTriggerDefinition,
  AutomationTriggerDefinitionInput,
} from './automationTriggerDefinition.js';

const TIMESTAMP_SCHEMA = z.number().int().nonnegative().safe();
const IDENTIFIER_SCHEMA = z.string().min(1);
const UTF8_ENCODER = new TextEncoder();

import { AutomationEventSourceCatalogStatusSchema, AutomationPluginEventRefSchema, AutomationCheckpointedPullObservationSchema, AutomationSocketObservationSchema, AutomationDurablePushObservationSchema, AutomationPluginEventTriggerSchema, AutomationScheduleTriggerProjectionSchema, AutomationPluginEventTriggerProjectionSchema, AutomationSessionLifecycleTriggerStatusSchema, AutomationSessionLifecycleTriggerProjectionSchema, AutomationTriggerListItemSchema, AutomationTriggerDetailSchema } from './automationTriggerProjectionV1.js';
export { AutomationEventSourceCatalogStatusSchema, AutomationPluginEventRefSchema, AutomationCheckpointedPullObservationSchema, AutomationSocketObservationSchema, AutomationDurablePushObservationSchema, AutomationPluginEventTriggerSchema, AutomationScheduleTriggerProjectionSchema, AutomationPluginEventTriggerProjectionSchema, AutomationSessionLifecycleTriggerStatusSchema, AutomationSessionLifecycleTriggerProjectionSchema, AutomationTriggerListItemSchema, AutomationTriggerDetailSchema } from './automationTriggerProjectionV1.js';
export type { AutomationEventSourceCatalogStatus, AutomationPluginEventRef, AutomationCheckpointedPullObservation, AutomationSocketObservation, AutomationDurablePushObservation, AutomationPluginEventTrigger, AutomationSessionLifecycleTriggerStatus, AutomationTriggerListItem, AutomationTriggerDetail } from './automationTriggerProjectionV1.js';

/** Target vocabulary retained for 0.2-created frozen execution-input data. */
export const AutomationTargetTypeV2Schema = lazyZodSchema(() => z.enum(['new_session', 'existing_session']));
export type AutomationTargetTypeV2 = z.infer<typeof AutomationTargetTypeV2Schema>;

export const AutomationTargetTypeV3Schema = lazyZodSchema(() => z.enum([
  'newSession',
  'existingSession',
  'executionRun',
]));
export type AutomationTargetTypeV3 = z.infer<typeof AutomationTargetTypeV3Schema>;

/**
 * The currently published V3 state vocabulary. The additional terminal states
 * are intentionally accepted by the reader before their producer migration so
 * new clients can represent a current server without reinterpreting it.
 */
export {
  AutomationRunStateV3Schema,
  type AutomationRunStateV3,
  AUTOMATION_RUN_TERMINAL_STATES_V3,
  isTerminalAutomationRunStateV3,
  type AutomationRunTerminalStateV3,
} from './automationRunStateV3.js';

export const AutomationAssignmentSchema = lazyZodSchema(() => z.object({
  machineId: IDENTIFIER_SCHEMA,
  enabled: z.boolean(),
  priority: z.number().int(),
  updatedAt: TIMESTAMP_SCHEMA.nullable(),
}).strict());
export type AutomationAssignment = z.infer<typeof AutomationAssignmentSchema>;

/** Input form for the one existing Automation-assignment owner. */
export const AutomationAssignmentInputSchema = lazyZodSchema(() => z.object({
  machineId: IDENTIFIER_SCHEMA,
  enabled: z.boolean().optional(),
  priority: z.number().int().min(-100).max(100).optional(),
}).strict());
export type AutomationAssignmentInput = z.infer<typeof AutomationAssignmentInputSchema>;

export const AutomationAssignmentUpdateRequestSchema = lazyZodSchema(() => z.object({
  assignments: z.array(AutomationAssignmentInputSchema),
}).strict());
export type AutomationAssignmentUpdateRequest = z.infer<typeof AutomationAssignmentUpdateRequestSchema>;

/**
 * A mutable definition has no immutable occurrence evidence. Canonical
 * admission freezes the current recipe and enabled assignments onto each Run,
 * adding kind-owned evidence only when the cause has private input. The rule
 * belongs to the recipe owner so every authoring surface shares it.
 */
const AutomationDefinitionExecutionRecipeSchema = lazyZodSchema(() => z.union([
  AutomationStoredDefinitionExecutionRecipeV1Schema,
  AutomationStoredWorkflowDefinitionRecipeV2Schema,
]));

export const AutomationTriggerCreateRequestSchema = lazyZodSchema(() => z.object({
  triggerId: AutomationTriggerIdSchema,
  trigger: AutomationTriggerDefinitionInputSchema,
}).strict());
export type AutomationTriggerCreateRequest = z.infer<
  typeof AutomationTriggerCreateRequestSchema
>;

export const AutomationDefinitionCreateRequestSchema = lazyZodSchema(() => z.object({
  automationId: asProtocolZod(AutomationIdV1Schema),
  name: z.string().trim().min(1).max(128),
  description: z.string().max(2_000).nullable().optional(),
  enabled: z.boolean(),
  workflowDefinitionId: WorkflowDefinitionRefV1StringSchema.nullable().optional(),
  scopeSessionId: IDENTIFIER_SCHEMA.nullable().optional(),
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
}));
export type AutomationDefinitionCreateRequest = z.infer<
  typeof AutomationDefinitionCreateRequestSchema
>;

export const AutomationDefinitionPatchRequestSchema = lazyZodSchema(() => z.object({
  expectedTemplateVersion: z.number().int().nonnegative().safe(),
  name: z.string().trim().min(1).max(128).optional(),
  description: z.string().max(2_000).nullable().optional(),
  enabled: z.boolean().optional(),
  workflowDefinitionId: WorkflowDefinitionRefV1StringSchema.nullable().optional(),
  scopeSessionId: IDENTIFIER_SCHEMA.nullable().optional(),
  executionRecipe: AutomationDefinitionExecutionRecipeSchema.optional(),
  /** CAS recovery of an already-stored predecessor template; never a current recipe writer. */
  templateCiphertext: z.string().min(1).max(AUTOMATION_TEMPLATE_CIPHERTEXT_MAX_CHARS).optional(),
  assignments: z.array(AutomationAssignmentInputSchema).optional(),
}).strict().superRefine((value, context) => {
  if (value.executionRecipe !== undefined && value.templateCiphertext !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Choose a current recipe or retained template recovery, not both' });
  }
}));
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

export const AutomationTriggerReconcileNewItemSchema = lazyZodSchema(() => z.object({
  kind: z.literal('new'),
  triggerId: AutomationTriggerIdSchema,
  trigger: AutomationTriggerDefinitionInputSchema,
}).strict());
export type AutomationTriggerReconcileNewItem = z.infer<
  typeof AutomationTriggerReconcileNewItemSchema
>;

/**
 * The one whole-editor mutation contract. The complete retained/new/removed
 * trigger census lets the server reject stale membership and commit the
 * definition, recipe, assignments, and trigger set in one transaction.
 */
export const AutomationDefinitionReconcileRequestSchema = lazyZodSchema(() => z.object({
  expectedTemplateVersion: z.number().int().nonnegative().safe(),
  name: z.string().trim().min(1).max(128),
  description: z.string().max(2_000).nullable(),
  enabled: z.boolean(),
  workflowDefinitionId: WorkflowDefinitionRefV1StringSchema.nullable().optional(),
  scopeSessionId: IDENTIFIER_SCHEMA.nullable().optional(),
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
}));
export type AutomationDefinitionReconcileRequest = z.infer<
  typeof AutomationDefinitionReconcileRequestSchema
>;

export const AutomationTriggerPatchRequestSchema = lazyZodSchema(() => z.object({
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
}));
export type AutomationTriggerPatchRequest = z.infer<
  typeof AutomationTriggerPatchRequestSchema
>;

export const AutomationTriggerDeleteRequestSchema = lazyZodSchema(() => z.object({
  triggerId: AutomationTriggerIdSchema,
  expectedRevision: AutomationTriggerRevisionSchema,
}).strict());
export type AutomationTriggerDeleteRequest = z.infer<
  typeof AutomationTriggerDeleteRequestSchema
>;


const AutomationDefinitionBaseSchema = lazyZodSchema(() => z.object({
  id: IDENTIFIER_SCHEMA,
  name: z.string(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  workflowDefinitionId: WorkflowDefinitionRefV1StringSchema.nullable().optional(),
  scopeSessionId: IDENTIFIER_SCHEMA.nullable().optional(),
  /** Null only for a strict V2 managed-workflow recipe, which has no single legacy target. */
  targetType: AutomationTargetTypeV3Schema.nullable(),
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
}).strict());

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
  /** Predecessor bytes for direct reads and narrow retained-template recovery; ordinary writes use executionRecipe. */
  templateCiphertext: z.string().min(1).optional(),
  /** Direct-reader-only current recipe; definition lists never disclose it. */
  executionRecipe: z.union([AutomationStoredDefinitionExecutionRecipeV1ReadSchema, AutomationStoredWorkflowDefinitionRecipeV2ReadSchema]).optional(),
};

/** Bounded definition list item; no private source/configuration envelope. */
export const AutomationDefinitionListItemSchema = lazyZodSchema(() => AutomationDefinitionBaseSchema.extend({
  triggers: z.array(AutomationTriggerListItemSchema),
}).strict());
export type AutomationDefinitionListItem = z.infer<typeof AutomationDefinitionListItemSchema>;

/**
 * Direct authenticated definition detail. The private trigger envelope is
 * never returned from list/status/source projections.
 */
export const AutomationDefinitionDetailSchema = lazyZodSchema(() => AutomationDefinitionBaseSchema.extend({
  triggers: z.array(AutomationTriggerDetailSchema),
  ...AutomationDefinitionDetailContentShape,
}).strict().superRefine(requireExactlyOneDefinitionContent));
export type AutomationDefinitionDetail = z.infer<typeof AutomationDefinitionDetailSchema>;

/**
 * A definition page is a transport/storage bound, never an Account-level
 * Automation ceiling. The opaque cursor is owned by the server's canonical
 * `(updatedAt DESC, id ASC)` definition ordering.
 */
export const AUTOMATION_V3_DEFINITION_LIST_MAX_ITEMS = 100;

export const AutomationDefinitionListRequestSchema = lazyZodSchema(() => z.object({
  limit: z.coerce.number().int().min(1).max(AUTOMATION_V3_DEFINITION_LIST_MAX_ITEMS)
    .default(AUTOMATION_V3_DEFINITION_LIST_MAX_ITEMS),
  cursor: OPAQUE_CURSOR_SCHEMA.optional(),
  workflowDefinitionId: WorkflowDefinitionRefV1StringSchema.optional(),
  scopeSessionId: IDENTIFIER_SCHEMA.optional(),
  scope: z.literal('account_inline').optional(),
}).strict().superRefine((value, context) => {
  if (value.scope !== undefined && (value.workflowDefinitionId !== undefined || value.scopeSessionId !== undefined)) {
    context.addIssue({ code: 'custom', path: ['scope'], message: 'Account inline scope cannot be combined with a workflow or Session filter' });
  }
}));
export type AutomationDefinitionListRequest = z.infer<typeof AutomationDefinitionListRequestSchema>;

export const AutomationDefinitionListResponseSchema = lazyZodSchema(() => z.object({
  automations: z.array(AutomationDefinitionListItemSchema)
    .max(AUTOMATION_V3_DEFINITION_LIST_MAX_ITEMS),
  nextCursor: OPAQUE_CURSOR_SCHEMA.nullable(),
}).strict());
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
export const AutomationV3MaxActiveRunsPerMachineSchema = lazyZodSchema(() => z.number()
  .int()
  .min(1)
  .max(2_147_483_647));
export type AutomationV3MaxActiveRunsPerMachine = z.infer<
  typeof AutomationV3MaxActiveRunsPerMachineSchema
>;

export const AutomationV3RunRetentionSchema = lazyZodSchema(() => z.enum([
  'thirtyDays',
  'keepForever',
]));
export type AutomationV3RunRetention = z.infer<typeof AutomationV3RunRetentionSchema>;

export const AutomationV3SettingsSchema = lazyZodSchema(() => z.object({
  maxActiveRunsPerMachine: AutomationV3MaxActiveRunsPerMachineSchema,
  runRetention: AutomationV3RunRetentionSchema,
}).strict());
export type AutomationV3Settings = z.infer<typeof AutomationV3SettingsSchema>;

/** A PUT replaces the complete bounded Automation preference record. */
export const AutomationV3SettingsUpdateRequestSchema = AutomationV3SettingsSchema;
export type AutomationV3SettingsUpdateRequest = z.infer<
  typeof AutomationV3SettingsUpdateRequestSchema
>;

/** The worker consumes only the per-machine claim cap, never retention policy. */
export const AutomationV3WorkerSettingsSchema = lazyZodSchema(() => z.object({
  maxActiveRunsPerMachine: AutomationV3MaxActiveRunsPerMachineSchema,
}).strict());
export type AutomationV3WorkerSettings = z.infer<typeof AutomationV3WorkerSettingsSchema>;

/**
 * Worker wake projection. It deliberately carries no definition/private
 * envelope: the durable claim endpoint remains the work authority.
 */
export const AutomationV3WorkerAssignmentSchema = lazyZodSchema(() => z.object({
  machineId: IDENTIFIER_SCHEMA,
  automationId: IDENTIFIER_SCHEMA,
  nextClaimAt: TIMESTAMP_SCHEMA.nullable(),
}).strict());
export type AutomationV3WorkerAssignment = z.infer<typeof AutomationV3WorkerAssignmentSchema>;

export const AutomationV3WorkerAssignmentsResponseSchema = lazyZodSchema(() => z.object({
  assignments: z.array(AutomationV3WorkerAssignmentSchema),
  settings: AutomationV3WorkerSettingsSchema,
}).strict());
export type AutomationV3WorkerAssignmentsResponse = z.infer<
  typeof AutomationV3WorkerAssignmentsResponseSchema
>;

const AutomationV3WorkerMachineAttemptSchema = lazyZodSchema(() => z.object({
  machineId: IDENTIFIER_SCHEMA,
  attempt: z.number().int().positive().safe(),
}).strict());

export const AutomationV3WorkerClaimRequestSchema = lazyZodSchema(() => z.object({
  machineId: IDENTIFIER_SCHEMA,
  leaseDurationMs: z.number().int().min(5_000).max(15 * 60_000).optional(),
  /** At ordinary worker capacity, admit only session-scoped trigger runs. */
  scope: z.literal('session_scoped').optional(),
}).strict());
export type AutomationV3WorkerClaimRequest = z.infer<typeof AutomationV3WorkerClaimRequestSchema>;

const AutomationRunExecutionInputEnvelopeSchema = lazyZodSchema(() => z.string().min(1)
  .max(MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES)
  .superRefine((value, context) => {
    if (UTF8_ENCODER.encode(value).byteLength > MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Execution input exceeds its UTF-8 byte limit',
      });
    }
  }));

/** Exact physical provenance shape retained only inside the released V2 frozen-input adapter. */
const AutomationRunExecutionInputV1OriginSchema = lazyZodSchema(() => z.union([
  z.object({
    kind: z.literal('scheduled'),
    scheduledFor: TIMESTAMP_SCHEMA,
  }).strict(),
  z.object({
    kind: z.literal('manual'),
    invokedAt: TIMESTAMP_SCHEMA,
  }).strict(),
]));

/**
 * Physical frozen-input adapter for released V2 Definition bytes. Its
 * predecessor `origin` field is deliberately isolated here and gains no
 * current cause fields. Current Definitions, Runs, claims, and projections use
 * the canonical stored/run recipe and AutomationRunCause models instead.
 */
export const AutomationRunExecutionInputV1Schema = lazyZodSchema(() => z.object({
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
}));
export type AutomationRunExecutionInputV1 = z.infer<typeof AutomationRunExecutionInputV1Schema>;

/**
 * Project a current cause into the retained frozen-input data carrier.
 * `null` means the cause has no legacy stored representation.
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
export const AutomationV3WorkerResultDeliverySchema = lazyZodSchema(() => z.object({
  kind: z.literal('finalResult'),
  accountId: IDENTIFIER_SCHEMA,
  handoffId: IDENTIFIER_SCHEMA,
}).strict());
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
    : value.cause.kind === 'conversation' && value.cause.triggerId !== undefined
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

const AutomationV3WorkerClaimedAutomationRunBaseSchema = lazyZodSchema(() => z.object({
  id: IDENTIFIER_SCHEMA,
  automationId: IDENTIFIER_SCHEMA,
  attempt: z.number().int().positive().safe(),
  /** Exact post-claim parent CAS revision for workflow snapshot finalization. */
  revision: z.number().int().nonnegative().safe(),
  /** Boundary Resume request consumed by this claim; absent on unrelated claims. */
  workflowResumeRequestedRevision: z.number().int().nonnegative().safe().optional(),
  /** Explicit program epoch; workers never infer execution semantics from optional envelopes. */
  recipeKind: z.enum(['legacy', 'workflow-v2']),
  // Retained predecessor Runs may lack a recipe. A V3 worker must fail those
  // closed rather than consulting the mutable Automation definition.
  executionInputEnvelope: AutomationRunExecutionInputEnvelopeSchema.nullable(),
  /** Automation-origin workflow input evidence, kept separate from the immutable accepted definition. */
  automationEvidenceEnvelope: AutomationRunExecutionInputEnvelopeSchema.nullable().optional(),
  /** Absent before daemon materialization; subsequent claims reuse the admitted Run snapshot. */
  workflowAcceptedSnapshotEnvelope: AutomationRunExecutionInputEnvelopeSchema.optional(),
  triggerId: AutomationTriggerIdSchema.nullable(),
  triggerRetired: z.boolean(),
  /** Immutable Run-owned cause consumed by the strict recipe materializer. */
  cause: AutomationRunCauseSchema,
  /** Host-stamped firing cause depth; captured in the claim receipt, never caller input. */
  causeWorkDepth: z.number().int().nonnegative().safe().optional(),
  /** Scoped trigger only: the last succeeded run's final review checkpoint. */
  lastSucceededRun: z.object({
    runId: IDENTIFIER_SCHEMA,
    checkpointEnvelope: AutomationRunExecutionInputEnvelopeSchema,
  }).strict().optional(),
  /** Omitted for ordinary claims. */
  resultDelivery: AutomationV3WorkerResultDeliverySchema.optional(),
}).strict());

function validateAutomationV3WorkerClaimedAutomationRun(
  value: Pick<z.infer<typeof AutomationV3WorkerClaimedAutomationRunBaseSchema>,
    'triggerId' | 'triggerRetired' | 'cause' | 'recipeKind' | 'executionInputEnvelope' | 'automationEvidenceEnvelope'>,
  context: z.RefinementCtx,
) {
  addRunTriggerCauseCorrespondenceIssue(value, context);
  if (value.recipeKind === 'workflow-v2') {
    if (value.executionInputEnvelope === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['executionInputEnvelope'],
        message: 'A workflow-v2 claim requires its frozen workflow definition envelope',
      });
    }
    if (!Object.hasOwn(value, 'automationEvidenceEnvelope')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['automationEvidenceEnvelope'],
        message: 'A workflow-v2 claim requires explicit frozen trigger evidence, including null',
      });
    }
  } else if (Object.hasOwn(value, 'automationEvidenceEnvelope')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['automationEvidenceEnvelope'],
      message: 'A legacy claim cannot carry workflow trigger evidence',
    });
  }
}

const AutomationV3WorkerClaimedAutomationRunSchema = lazyZodSchema(() => AutomationV3WorkerClaimedAutomationRunBaseSchema
  .superRefine(validateAutomationV3WorkerClaimedAutomationRun));

const AutomationV3WorkerClaimedDirectWorkflowRunSchema = lazyZodSchema(() => z.object({
  id: IDENTIFIER_SCHEMA,
  automationId: z.null(),
  attempt: z.number().int().positive().safe(),
  revision: z.number().int().nonnegative().safe(),
  /** Boundary Resume request consumed by this claim; absent on unrelated claims. */
  workflowResumeRequestedRevision: z.number().int().nonnegative().safe().optional(),
  recipeKind: z.literal('workflow-v2'),
  origin: z.object({
    kind: z.literal('direct'),
    originSessionId: IDENTIFIER_SCHEMA.optional(),
  }).strict(),
  workflowAcceptedSnapshotEnvelope: AutomationRunExecutionInputEnvelopeSchema,
  triggerId: z.null(),
  triggerRetired: z.literal(false),
}).strict());

/**
 * Receipt-safe claim projection. Private Run envelopes remain null in the
 * receipt and are re-read from their transition-censused Run row on replay.
 */
export const AutomationV3WorkerClaimReceiptRunSchema = lazyZodSchema(() => z.union([
  // A receipt carries correspondence, not private workflow definition/evidence.
  // The claim owner reopens those bytes from the canonical Run on replay.
  AutomationV3WorkerClaimedAutomationRunBaseSchema.omit({ workflowAcceptedSnapshotEnvelope: true }).extend({
    lastSucceededRun: z.object({
      runId: IDENTIFIER_SCHEMA,
      checkpointEnvelope: z.null(),
    }).strict().optional(),
  }).superRefine(addRunTriggerCauseCorrespondenceIssue),
  AutomationV3WorkerClaimedDirectWorkflowRunSchema.extend({
    workflowAcceptedSnapshotEnvelope: AutomationRunExecutionInputEnvelopeSchema.nullable(),
  }).strict(),
]));
export type AutomationV3WorkerClaimReceiptRun = z.infer<typeof AutomationV3WorkerClaimReceiptRunSchema>;

/** Private worker payload; public Run reads remain bounded separately. */
export const AutomationV3WorkerClaimedRunSchema = lazyZodSchema(() => z.union([
  AutomationV3WorkerClaimedAutomationRunSchema,
  AutomationV3WorkerClaimedDirectWorkflowRunSchema,
]));
export type AutomationV3WorkerClaimedRun = z.infer<typeof AutomationV3WorkerClaimedRunSchema>;

export const AutomationV3WorkerClaimedAutomationSchema = lazyZodSchema(() => z.object({
  id: IDENTIFIER_SCHEMA,
  name: z.string(),
  enabled: z.boolean(),
  workflowDefinitionId: WorkflowDefinitionRefV1StringSchema.nullable().optional(),
  scopeSessionId: IDENTIFIER_SCHEMA.nullable().optional(),
}).strict());
export type AutomationV3WorkerClaimedAutomation = z.infer<
  typeof AutomationV3WorkerClaimedAutomationSchema
>;

export const AutomationV3WorkerClaimResponseSchema = lazyZodSchema(() => z.object({
  run: AutomationV3WorkerClaimedRunSchema.nullable(),
  automation: AutomationV3WorkerClaimedAutomationSchema.nullable(),
  /** C: exact Account witness observed atomically with the successful claim. */
  accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema.nullable(),
}).strict().superRefine((value, context) => {
  const runNeedsAutomation = value.run?.automationId !== null;
  if ((value.run === null) !== (value.accountCurrentness === null)
    || (value.run !== null && runNeedsAutomation !== (value.automation !== null))
    || (value.run === null && value.automation !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['accountCurrentness'],
      message: 'A worker claim contains Account currentness with its Run and an Automation only for Automation origin',
    });
  }
}));
export type AutomationV3WorkerClaimResponse = z.infer<typeof AutomationV3WorkerClaimResponseSchema>;

export const AutomationV3WorkerHeartbeatRequestSchema = lazyZodSchema(() => AutomationV3WorkerMachineAttemptSchema.extend({
  leaseDurationMs: z.number().int().min(5_000).max(15 * 60_000).optional(),
}).strict());
export type AutomationV3WorkerHeartbeatRequest = z.infer<typeof AutomationV3WorkerHeartbeatRequestSchema>;

export const AutomationV3WorkerHeartbeatResponseSchema = lazyZodSchema(() => z.object({
  ok: z.literal(true),
  leaseExpiresAt: TIMESTAMP_SCHEMA.nullable(),
}).strict());
export type AutomationV3WorkerHeartbeatResponse = z.infer<typeof AutomationV3WorkerHeartbeatResponseSchema>;

/** C must be echoed before a worker may transition a claimed Run to running. */
export const AutomationV3WorkerStartRequestSchema = lazyZodSchema(() => AutomationV3WorkerMachineAttemptSchema.extend({
  accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema,
}).strict());
export type AutomationV3WorkerStartRequest = z.infer<typeof AutomationV3WorkerStartRequestSchema>;

/** Current writers carry a result envelope; predecessor summary bytes stay V2-only. */
export const AutomationV3WorkerSucceedRequestSchema = lazyZodSchema(() => AutomationV3WorkerMachineAttemptSchema.extend({
  /** S: the post-start Account witness, echoed unchanged from the successful start. */
  accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema,
  producedSessionId: IDENTIFIER_SCHEMA.nullable().optional(),
  resultEnvelope: z.string().min(1).nullable().optional(),
}).strict());
export type AutomationV3WorkerSucceedRequest = z.infer<typeof AutomationV3WorkerSucceedRequestSchema>;

export const AutomationV3WorkerFailRequestSchema = lazyZodSchema(() => AutomationV3WorkerMachineAttemptSchema.extend({
  /** S: the post-start Account witness, echoed unchanged from the successful start. */
  accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema,
  /** A known canonical new-Session id survives input failure/cancellation settlement. */
  producedSessionId: IDENTIFIER_SCHEMA.nullable().optional(),
  errorCode: z.string().min(1).max(128).nullable().optional(),
  /** Claimed-only trigger admission refusal; ordinary failures remain failed. */
  terminalState: z.literal('skipped').optional(),
  /** Private Account-mode-correct detail; errorCode remains the structural outcome. */
  errorDetailEnvelope: z.string().min(1).max(MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES).nullable().optional(),
}).strict());
export type AutomationV3WorkerFailRequest = z.infer<typeof AutomationV3WorkerFailRequestSchema>;

export const AutomationV3WorkerExecutionDispatchOutcomeSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
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
]));
export type AutomationV3WorkerExecutionDispatchOutcome = z.infer<
  typeof AutomationV3WorkerExecutionDispatchOutcomeSchema
>;

export const AutomationV3WorkerExecutionDispatchSettlementRequestSchema =
  lazyZodSchema(() => AutomationV3WorkerMachineAttemptSchema.extend({
    accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema,
    outcome: AutomationV3WorkerExecutionDispatchOutcomeSchema,
  }).strict());
export type AutomationV3WorkerExecutionDispatchSettlementRequest = z.infer<
  typeof AutomationV3WorkerExecutionDispatchSettlementRequestSchema
>;

export const AutomationExecutionDispatchStateV3Schema = lazyZodSchema(() => z.enum([
  'notStarted',
  'dispatchPermitted',
  'retryWaiting',
  'started',
  'settled',
  'outcomeUnknown',
]));
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
export const AutomationV3RunListItemSchema = lazyZodSchema(() => z.object(AutomationV3RunListItemShape)
  .strict()
  .superRefine(addRunTriggerCauseCorrespondenceIssue));
export type AutomationV3RunListItem = z.infer<typeof AutomationV3RunListItemSchema>;

/** S: returned atomically with a successful start and required for settlement. */
export const AutomationV3WorkerStartResponseSchema = lazyZodSchema(() => z.object({
  run: AutomationV3RunListItemSchema,
  accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema,
}).strict());
export type AutomationV3WorkerStartResponse = z.infer<typeof AutomationV3WorkerStartResponseSchema>;

/**
 * One committed Run lifecycle transition, as the user can read it. Every field
 * is a server-authored, bounded, non-secret fact: no envelope bytes, prompt
 * text, provider payload, or free-form message ever reaches this projection.
 */
export const AutomationV3RunEventSchema = lazyZodSchema(() => z.object({
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
}).strict());
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
export const AutomationV3RunDetailSchema = lazyZodSchema(() => z.object({
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
  /**
   * Whether a present user can still act on a `blocked` Conversation reply
   * handoff. `false` means the handoff facts frozen at admission are themselves
   * invalid, so no retry, machine change, or plugin update can ever dispatch
   * it and the product must not offer one. `null` on every non-blocked state,
   * and absent from a supported older server that does not classify it — a
   * client must then keep its previous behaviour rather than assume either
   * answer.
   */
  replyHandoffRecoverable: z.boolean().nullable().optional(),
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
}));
export type AutomationV3RunDetail = z.infer<typeof AutomationV3RunDetailSchema>;

/** Canonical public Run-list/API page bound. */
export const AUTOMATION_V3_RUN_LIST_MAX_ITEMS = 100;

export const AutomationV3RunListResponseSchema = lazyZodSchema(() => z.object({
  runs: z.array(AutomationV3RunListItemSchema).max(AUTOMATION_V3_RUN_LIST_MAX_ITEMS),
  nextCursor: z.string().nullable(),
}).strict());
export type AutomationV3RunListResponse = z.infer<typeof AutomationV3RunListResponseSchema>;

/** Result of removing eligible terminal history for one Automation. */
export const AutomationV3ClearRunHistoryResponseSchema = lazyZodSchema(() => z.object({
  clearedRuns: z.number().int().nonnegative().safe(),
}).strict());
export type AutomationV3ClearRunHistoryResponse = z.infer<
  typeof AutomationV3ClearRunHistoryResponseSchema
>;

/**
 * A present user's conscious authorization to deliver an accepted Conversation
 * result again after its external outcome stayed ambiguous. The exact Run
 * revision the user acted on is required: it is what makes a replayed
 * authorization lose its compare-and-swap instead of creating a second
 * delivery, so it is part of the request rather than a server-side guess.
 */
export const AutomationV3RunReplyHandoffRedeliverRequestSchema = lazyZodSchema(() => z.object({
  expectedRevision: z.number().int().nonnegative().safe(),
}).strict());
export type AutomationV3RunReplyHandoffRedeliverRequest = z.infer<
  typeof AutomationV3RunReplyHandoffRedeliverRequestSchema
>;

export const AutomationV3RunMutationResponseSchema = lazyZodSchema(() => z.object({
  run: AutomationV3RunListItemSchema,
  workflowRun: z.object({
    recipeKind: z.literal('workflow-v2'),
    workflowRunId: IDENTIFIER_SCHEMA,
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.workflowRun && value.workflowRun.workflowRunId !== value.run.id) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['workflowRun', 'workflowRunId'],
      message: 'Workflow Run correspondence must identify the returned Run',
    });
  }
}));
export type AutomationV3RunMutationResponse = z.infer<typeof AutomationV3RunMutationResponseSchema>;

export const AutomationDeleteResponseSchema = lazyZodSchema(() => z.object({ ok: z.literal(true) }).strict());
export type AutomationDeleteResponse = z.infer<typeof AutomationDeleteResponseSchema>;
