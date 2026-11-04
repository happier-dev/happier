import { maxCodeUnits } from '../strings/maxCodeUnits.js';
import * as zMini from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

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
  AutomationStoredDefinitionExecutionRecipeV1ReadSchema,
} from './automationRunExecutionRecipeV1.js';
import { AutomationManagedTargetV1Schema, AutomationObservationOnlyDefinitionV1Schema, AutomationStoredWorkflowDefinitionRecipeV2Schema, AutomationStoredWorkflowDefinitionRecipeV2ReadSchema } from './automationWorkflowRecipeV2.js';
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
import { ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 } from '../artifacts/artifactListSelectionV1.js';

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

const TIMESTAMP_SCHEMA = z.number().check(z.int(), z.nonnegative(), z.int());
const IDENTIFIER_SCHEMA = z.string().check(z.minLength(1));
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

export const AutomationAssignmentSchema = lazyZodSchema(() => z.strictObject({
  machineId: IDENTIFIER_SCHEMA,
  enabled: z.boolean(),
  priority: z.number().check(z.int()),
  updatedAt: z.nullable(TIMESTAMP_SCHEMA),
}));
export type AutomationAssignment = z.infer<typeof AutomationAssignmentSchema>;

/** Input form for the one existing Automation-assignment owner. */
export const AutomationAssignmentInputSchema = lazyZodSchema(() => z.strictObject({
  machineId: IDENTIFIER_SCHEMA,
  enabled: z.optional(z.boolean()),
  priority: z.optional(z.number().check(z.int(), z.minimum(-100), z.maximum(100))),
}));
export type AutomationAssignmentInput = z.infer<typeof AutomationAssignmentInputSchema>;

export const AutomationAssignmentUpdateRequestSchema = lazyZodSchema(() => z.strictObject({
  assignments: z.array(AutomationAssignmentInputSchema),
}));
export type AutomationAssignmentUpdateRequest = z.infer<typeof AutomationAssignmentUpdateRequestSchema>;

/**
 * A mutable definition has no immutable occurrence evidence. Canonical
 * admission freezes the current recipe and enabled assignments onto each Run,
 * adding kind-owned evidence only when the cause has private input. The rule
 * belongs to the recipe owner so every authoring surface shares it.
 */
const AutomationDefinitionExecutionRecipeSchema = AutomationStoredWorkflowDefinitionRecipeV2Schema;

export const AutomationTriggerCreateRequestSchema = lazyZodSchema(() => z.strictObject({
  triggerId: AutomationTriggerIdSchema,
  trigger: AutomationTriggerDefinitionInputSchema,
}));
export type AutomationTriggerCreateRequest = z.infer<
  typeof AutomationTriggerCreateRequestSchema
>;

const AutomationDefinitionCreateRequestBaseSchema = lazyZodSchema(() => z.strictObject({
  automationId: asProtocolZod(AutomationIdV1Schema),
  name: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  description: z.optional(z.nullable(z.string().check(z.maxLength(2_000)))),
  enabled: z.boolean(),
  workflowDefinitionId: zMini.optional(zMini.nullable(WorkflowDefinitionRefV1StringSchema)),
  scopeSessionId: z.optional(z.nullable(IDENTIFIER_SCHEMA)),
  assignments: z.optional(z.array(AutomationAssignmentInputSchema)),
  triggers: z.array(AutomationTriggerCreateRequestSchema),
}));
export const AutomationExecutionDefinitionCreateRequestSchema = lazyZodSchema(() => z.extend(AutomationDefinitionCreateRequestBaseSchema, {
    executionRecipe: AutomationDefinitionExecutionRecipeSchema,
    observationOnly: z.optional(z.never()),
}));
export const AutomationDefinitionCreateRequestSchema = lazyZodSchema(() => z.union([
  AutomationExecutionDefinitionCreateRequestSchema,
  z.extend(AutomationDefinitionCreateRequestBaseSchema, {
    observationOnly: AutomationObservationOnlyDefinitionV1Schema,
    executionRecipe: z.optional(z.never()),
    assignments: z.optional(z.array(AutomationAssignmentInputSchema).check(z.length(0))),
    workflowDefinitionId: z.optional(z.null()),
    scopeSessionId: z.optional(z.null()),
  }).check(z.superRefine((value, context) => {
    if (value.triggers.length === 0 || value.triggers.some(item => item.trigger.kind !== 'pluginEvent')) {
      context.addIssue({ code: 'custom', path: ['triggers'], message: 'Observation-only definitions require plugin Event sources' });
    }
  })),
]).check(z.superRefine((value, context) => {
  const seen = new Set<string>();
  value.triggers.forEach((item, index) => {
    if (seen.has(item.triggerId)) {
      context.addIssue({
        code: "custom",
        path: ['triggers', index, 'triggerId'],
        message: 'Automation trigger identities must be unique',
      });
    }
    seen.add(item.triggerId);
  });
})));
export type AutomationDefinitionCreateRequest = z.infer<
  typeof AutomationDefinitionCreateRequestSchema
>;

export const AutomationDefinitionPatchRequestSchema = lazyZodSchema(() => z.strictObject({
  expectedTemplateVersion: z.number().check(z.int(), z.nonnegative(), z.int()),
  name: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(128))),
  description: z.optional(z.nullable(z.string().check(z.maxLength(2_000)))),
  enabled: z.optional(z.boolean()),
  workflowDefinitionId: zMini.optional(zMini.nullable(WorkflowDefinitionRefV1StringSchema)),
  scopeSessionId: z.optional(z.nullable(IDENTIFIER_SCHEMA)),
  executionRecipe: zMini.optional(AutomationDefinitionExecutionRecipeSchema),
  observationOnly: z.optional(AutomationObservationOnlyDefinitionV1Schema),
  /** CAS recovery of an already-stored predecessor template; never a current recipe writer. */
  templateCiphertext: z.optional(z.string().check(z.minLength(1), z.maxLength(AUTOMATION_TEMPLATE_CIPHERTEXT_MAX_CHARS))),
  assignments: z.optional(z.array(AutomationAssignmentInputSchema)),
}).check(z.superRefine((value, context) => {
  if ([value.executionRecipe, value.observationOnly, value.templateCiphertext].filter(item => item !== undefined).length > 1) {
    context.addIssue({ code: "custom", message: 'Choose a current recipe or retained template recovery, not both' });
  }
})));
export type AutomationDefinitionPatchRequest = z.infer<
  typeof AutomationDefinitionPatchRequestSchema
>;

/**
 * One retained row in a full-editor save. Omitting both mutation fields keeps
 * the row byte-for-byte unchanged while still supplying its exact CAS witness.
 */
export const AutomationTriggerReconcileExistingItemSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('existing'),
  triggerId: AutomationTriggerIdSchema,
  expectedRevision: AutomationTriggerRevisionSchema,
  enabled: z.optional(z.boolean()),
  trigger: zMini.optional(AutomationTriggerDefinitionSchema),
  triggerDefinitionEnvelope: zMini.optional(AutomationEncryptedTriggerDefinitionEnvelopeV1Schema),
}).check(z.superRefine((value, context) => {
  if (
    value.triggerDefinitionEnvelope !== undefined
    && (value.enabled === undefined || value.trigger !== undefined)
  ) {
    context.addIssue({
      code: "custom",
      path: ['triggerDefinitionEnvelope'],
      message: 'A resealed trigger definition accompanies only an enable-only patch',
    });
  }
})));
export type AutomationTriggerReconcileExistingItem = z.infer<
  typeof AutomationTriggerReconcileExistingItemSchema
>;

export const AutomationTriggerReconcileNewItemSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('new'),
  triggerId: AutomationTriggerIdSchema,
  trigger: AutomationTriggerDefinitionInputSchema,
}));
export type AutomationTriggerReconcileNewItem = z.infer<
  typeof AutomationTriggerReconcileNewItemSchema
>;

/**
 * The one whole-editor mutation contract. The complete retained/new/removed
 * trigger census lets the server reject stale membership and commit the
 * definition, recipe, assignments, and trigger set in one transaction.
 */
export const AutomationDefinitionReconcileRequestSchema = lazyZodSchema(() => z.strictObject({
  expectedTemplateVersion: z.number().check(z.int(), z.nonnegative(), z.int()),
  name: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  description: z.nullable(z.string().check(z.maxLength(2_000))),
  enabled: z.boolean(),
  workflowDefinitionId: zMini.optional(zMini.nullable(WorkflowDefinitionRefV1StringSchema)),
  scopeSessionId: z.optional(z.nullable(IDENTIFIER_SCHEMA)),
  executionRecipe: zMini.optional(AutomationDefinitionExecutionRecipeSchema),
  observationOnly: z.optional(AutomationObservationOnlyDefinitionV1Schema),
  assignments: z.array(AutomationAssignmentInputSchema),
  triggers: z.array(z.union([
    AutomationTriggerReconcileExistingItemSchema,
    AutomationTriggerReconcileNewItemSchema,
  ])),
  removedTriggers: z.array(z.strictObject({
    triggerId: AutomationTriggerIdSchema,
    expectedRevision: AutomationTriggerRevisionSchema,
  })),
}).check(z.superRefine((value, context) => {
  if (value.executionRecipe !== undefined && value.observationOnly !== undefined) {
    context.addIssue({ code: 'custom', message: 'Choose one Automation definition arm' });
  }
  const seen = new Set<string>();
  const visit = (triggerId: string, path: ReadonlyArray<string | number>) => {
    if (seen.has(triggerId)) {
      context.addIssue({
        code: "custom",
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
})));
export type AutomationDefinitionReconcileRequest = z.infer<
  typeof AutomationDefinitionReconcileRequestSchema
>;

export const AutomationTriggerPatchRequestSchema = lazyZodSchema(() => z.strictObject({
  triggerId: AutomationTriggerIdSchema,
  expectedRevision: AutomationTriggerRevisionSchema,
  enabled: z.optional(z.boolean()),
  trigger: zMini.optional(AutomationTriggerDefinitionSchema),
  /**
   * Exact next-revision reseal for an enable-only encrypted Event patch. The
   * server validates it against the unchanged public row binding and current
   * Account mode; semantic edits carry their envelope in `trigger` instead.
   */
  triggerDefinitionEnvelope: zMini.optional(AutomationEncryptedTriggerDefinitionEnvelopeV1Schema),
}).check(z.superRefine((value, context) => {
  if (value.enabled === undefined && value.trigger === undefined) {
    context.addIssue({ code: "custom", message: 'A trigger patch must change enablement or definition' });
  }
  if (
    value.triggerDefinitionEnvelope !== undefined
    && (value.enabled === undefined || value.trigger !== undefined)
  ) {
    context.addIssue({
      code: "custom",
      path: ['triggerDefinitionEnvelope'],
      message: 'A resealed trigger definition accompanies only an enable-only patch',
    });
  }
})));
export type AutomationTriggerPatchRequest = z.infer<
  typeof AutomationTriggerPatchRequestSchema
>;

export const AutomationTriggerDeleteRequestSchema = lazyZodSchema(() => z.strictObject({
  triggerId: AutomationTriggerIdSchema,
  expectedRevision: AutomationTriggerRevisionSchema,
}));
export type AutomationTriggerDeleteRequest = z.infer<
  typeof AutomationTriggerDeleteRequestSchema
>;


const AutomationDefinitionBaseSchema = lazyZodSchema(() => z.strictObject({
  id: IDENTIFIER_SCHEMA,
  name: z.string(),
  description: z.nullable(z.string()),
  enabled: z.boolean(),
  workflowDefinitionId: zMini.optional(zMini.nullable(WorkflowDefinitionRefV1StringSchema)),
  scopeSessionId: z.optional(z.nullable(IDENTIFIER_SCHEMA)),
  /** Omitted for unknown legacy indexing; null is an admitted unrelated definition. */
  managedTarget: z.optional(z.nullable(AutomationManagedTargetV1Schema)),
  /** Null only for a strict V2 managed-workflow recipe, which has no single legacy target. */
  targetType: z.nullable(AutomationTargetTypeV3Schema),
  /**
   * Bounded existing-Session association projected by the definition owner
   * from the current strict recipe. It is `null` for every other target and
   * for a retained predecessor template, whose association is only readable
   * by a client that can open the template.
   */
  existingSessionId: z.nullable(IDENTIFIER_SCHEMA),
  templateVersion: z.number().check(z.int(), z.nonnegative(), z.int()),
  lastRunAt: z.nullable(TIMESTAMP_SCHEMA),
  createdAt: TIMESTAMP_SCHEMA,
  updatedAt: TIMESTAMP_SCHEMA,
  assignments: z.array(AutomationAssignmentSchema),
  observationOnly: z.optional(AutomationObservationOnlyDefinitionV1Schema),
}));

function requireExactlyOneDefinitionContent(
  value: Readonly<{ templateCiphertext?: string; executionRecipe?: unknown; observationOnly?: unknown }> ,
  context: z.core.$RefinementCtx,
): void {
  if ([value.templateCiphertext, value.executionRecipe, value.observationOnly].filter(item => item !== undefined).length !== 1) {
    context.addIssue({
      code: "custom",
      message: 'Definition detail requires exactly one observation-only arm, current recipe or retained legacy template',
    });
  }
}

/** Bounded definition list item; no private source/configuration envelope. */
export const AutomationDefinitionListItemSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationDefinitionBaseSchema, {
  triggers: z.array(AutomationTriggerListItemSchema),
})));
export type AutomationDefinitionListItem = z.infer<typeof AutomationDefinitionListItemSchema>;

/**
 * Direct authenticated definition detail. The private trigger envelope is
 * never returned from list/status/source projections.
 */
export const AutomationDefinitionDetailSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationDefinitionBaseSchema, {
  triggers: z.array(AutomationTriggerDetailSchema),
  /** Predecessor bytes for direct reads and narrow retained-template recovery; ordinary writes use executionRecipe. */
  templateCiphertext: z.optional(z.string().check(z.minLength(1))),
  /** Direct-reader-only current recipe; definition lists never disclose it. */
  executionRecipe: z.optional(z.union([AutomationStoredDefinitionExecutionRecipeV1ReadSchema, AutomationStoredWorkflowDefinitionRecipeV2ReadSchema])),
})).check(z.superRefine(requireExactlyOneDefinitionContent)));
export type AutomationDefinitionDetail = z.infer<typeof AutomationDefinitionDetailSchema>;

/**
 * A definition page is a transport/storage bound, never an Account-level
 * Automation ceiling. The opaque cursor is owned by the server's canonical
 * `(updatedAt DESC, id ASC)` definition ordering.
 */
export const AUTOMATION_V3_DEFINITION_LIST_MAX_ITEMS = 100;

export const AutomationDefinitionListRequestSchema = lazyZodSchema(() => z.strictObject({
  limit: z._default(z.coerce.number().check(z.int(), z.minimum(1), z.maximum(AUTOMATION_V3_DEFINITION_LIST_MAX_ITEMS)), AUTOMATION_V3_DEFINITION_LIST_MAX_ITEMS),
  cursor: zMini.optional(OPAQUE_CURSOR_SCHEMA),
  workflowDefinitionId: zMini.optional(WorkflowDefinitionRefV1StringSchema),
  /** Body-bearing list selection for the definitions in one demanded library page. */
  workflowDefinitionIds: z.optional(z.array(WorkflowDefinitionRefV1StringSchema).check(z.maxLength(ARTIFACT_LIST_PAGE_MAX_ITEMS_V1))),
  scopeSessionId: z.optional(IDENTIFIER_SCHEMA),
  scope: z.optional(z.literal('account_inline')),
  managedTarget: z.optional(AutomationManagedTargetV1Schema),
  includeUnindexedManagedTargets: z.optional(z.literal(true)),
  managedTargetUnindexed: z.optional(z.literal(true)),
}).check(z.superRefine((value, context) => {
  const managedSelection = value.managedTarget !== undefined || value.managedTargetUnindexed !== undefined;
  if (value.includeUnindexedManagedTargets !== undefined && value.managedTarget === undefined) {
    context.addIssue({ code: 'custom', path: ['includeUnindexedManagedTargets'], message: 'Unknown fallback requires a managed target' });
  }
  if (value.managedTarget !== undefined && value.managedTargetUnindexed !== undefined) {
    context.addIssue({ code: 'custom', path: ['managedTargetUnindexed'], message: 'Choose one managed target selection' });
  }
  if (managedSelection && (value.workflowDefinitionId !== undefined || value.workflowDefinitionIds !== undefined
    || value.scopeSessionId !== undefined || value.scope !== undefined)) {
    context.addIssue({ code: 'custom', path: ['managedTarget'], message: 'Managed target selection cannot be combined with workflow or Session selection' });
  }
  if (value.workflowDefinitionId !== undefined && value.workflowDefinitionIds !== undefined) {
    context.addIssue({ code: 'custom', path: ['workflowDefinitionIds'], message: 'Choose one workflow selection' });
  }
  if (value.scope !== undefined && (value.workflowDefinitionId !== undefined || value.workflowDefinitionIds !== undefined || value.scopeSessionId !== undefined)) {
    context.addIssue({ code: 'custom', path: ['scope'], message: 'Account inline scope cannot be combined with a workflow or Session filter' });
  }
})));
export type AutomationDefinitionListRequest = z.infer<typeof AutomationDefinitionListRequestSchema>;

export const AutomationDefinitionDetailsRequestSchema = lazyZodSchema(() => z.safeExtend(AutomationDefinitionListRequestSchema, {
  details: z.literal(true),
}));
export type AutomationDefinitionDetailsRequest = z.infer<typeof AutomationDefinitionDetailsRequestSchema>;

export const AutomationDefinitionDetailsResponseSchema = lazyZodSchema(() => z.strictObject({
  automations: z.array(AutomationDefinitionDetailSchema).check(z.maxLength(AUTOMATION_V3_DEFINITION_LIST_MAX_ITEMS)),
  nextCursor: z.nullable(OPAQUE_CURSOR_SCHEMA),
}));
export type AutomationDefinitionDetailsResponse = z.infer<typeof AutomationDefinitionDetailsResponseSchema>;

export const AutomationDefinitionListResponseSchema = lazyZodSchema(() => z.strictObject({
  automations: z.array(AutomationDefinitionListItemSchema).check(z.maxLength(AUTOMATION_V3_DEFINITION_LIST_MAX_ITEMS)),
  nextCursor: zMini.nullable(OPAQUE_CURSOR_SCHEMA),
}));
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
export const AutomationV3MaxActiveRunsPerMachineSchema = lazyZodSchema(() => z.number().check(z.int(), z.minimum(1), z.maximum(2_147_483_647)));
export type AutomationV3MaxActiveRunsPerMachine = z.infer<
  typeof AutomationV3MaxActiveRunsPerMachineSchema
>;

export const AutomationV3RunRetentionSchema = lazyZodSchema(() => z.enum([
  'thirtyDays',
  'keepForever',
]));
export type AutomationV3RunRetention = z.infer<typeof AutomationV3RunRetentionSchema>;

export const AutomationV3SettingsSchema = lazyZodSchema(() => z.strictObject({
  maxActiveRunsPerMachine: AutomationV3MaxActiveRunsPerMachineSchema,
  runRetention: AutomationV3RunRetentionSchema,
}));
export type AutomationV3Settings = z.infer<typeof AutomationV3SettingsSchema>;

/** A PUT replaces the complete bounded Automation preference record. */
export const AutomationV3SettingsUpdateRequestSchema = AutomationV3SettingsSchema;
export type AutomationV3SettingsUpdateRequest = z.infer<
  typeof AutomationV3SettingsUpdateRequestSchema
>;

/** The worker consumes only the per-machine claim cap, never retention policy. */
export const AutomationV3WorkerSettingsSchema = lazyZodSchema(() => z.strictObject({
  maxActiveRunsPerMachine: AutomationV3MaxActiveRunsPerMachineSchema,
}));
export type AutomationV3WorkerSettings = z.infer<typeof AutomationV3WorkerSettingsSchema>;

/**
 * Worker wake projection. It deliberately carries no definition/private
 * envelope: the durable claim endpoint remains the work authority.
 */
export const AutomationV3WorkerAssignmentSchema = lazyZodSchema(() => z.strictObject({
  machineId: IDENTIFIER_SCHEMA,
  automationId: IDENTIFIER_SCHEMA,
  nextClaimAt: z.nullable(TIMESTAMP_SCHEMA),
  /** Current V3 projection; null or an older omitted field needs canonical reconciliation. */
  executionRecipeVersion: z.optional(z.nullable(z.literal(2))),
}));
export type AutomationV3WorkerAssignment = z.infer<typeof AutomationV3WorkerAssignmentSchema>;

export const AutomationV3WorkerAssignmentsResponseSchema = lazyZodSchema(() => z.strictObject({
  assignments: z.array(AutomationV3WorkerAssignmentSchema),
  settings: AutomationV3WorkerSettingsSchema,
}));
export type AutomationV3WorkerAssignmentsResponse = z.infer<
  typeof AutomationV3WorkerAssignmentsResponseSchema
>;

const AutomationV3WorkerMachineAttemptSchema = lazyZodSchema(() => z.strictObject({
  machineId: IDENTIFIER_SCHEMA,
  attempt: z.number().check(z.int(), z.positive(), z.int()),
}));

export const AutomationV3WorkerClaimRequestSchema = lazyZodSchema(() => z.strictObject({
  machineId: IDENTIFIER_SCHEMA,
  leaseDurationMs: z.optional(z.number().check(z.int(), z.minimum(5_000), z.maximum(15 * 60_000))),
  /** At ordinary worker capacity, admit only session-scoped trigger runs. */
  scope: z.optional(z.enum(['session_scoped', 'workflow'])),
}));
export type AutomationV3WorkerClaimRequest = z.infer<typeof AutomationV3WorkerClaimRequestSchema>;

const AutomationRunExecutionInputEnvelopeSchema = lazyZodSchema(() => z.string().check(z.minLength(1), maxCodeUnits(MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES), z.superRefine((value, context) => {
    if (UTF8_ENCODER.encode(value).byteLength > MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES) {
      context.addIssue({
        code: "custom",
        message: 'Execution input exceeds its UTF-8 byte limit',
      });
    }
  })));

/** Exact physical provenance shape retained only inside the released V2 frozen-input adapter. */
const AutomationRunExecutionInputV1OriginSchema = lazyZodSchema(() => z.union([
  z.strictObject({
    kind: z.literal('scheduled'),
    scheduledFor: TIMESTAMP_SCHEMA,
  }),
  z.strictObject({
    kind: z.literal('manual'),
    invokedAt: TIMESTAMP_SCHEMA,
  }),
]));

/**
 * Physical frozen-input adapter for released V2 Definition bytes. Its
 * predecessor `origin` field is deliberately isolated here and gains no
 * current cause fields. Current Definitions, Runs, claims, and projections use
 * the canonical stored/run recipe and AutomationRunCause models instead.
 */
export const AutomationRunExecutionInputV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('happier_automation_run_execution_input_v1'),
  targetType: AutomationTargetTypeV2Schema,
  templateVersion: z.number().check(z.int(), z.nonnegative(), z.int()),
  templateCiphertext: z.string().check(z.minLength(1), z.maxLength(AUTOMATION_TEMPLATE_CIPHERTEXT_MAX_CHARS)),
  origin: AutomationRunExecutionInputV1OriginSchema,
}).check(z.superRefine((value, context) => {
  if (
    UTF8_ENCODER.encode(JSON.stringify(value)).byteLength
    > MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES
  ) {
    context.addIssue({
      code: "custom",
      message: 'Execution input exceeds its UTF-8 byte limit',
    });
  }
})));
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
export const AutomationV3WorkerResultDeliverySchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('finalResult'),
  accountId: IDENTIFIER_SCHEMA,
  handoffId: IDENTIFIER_SCHEMA,
}));
export type AutomationV3WorkerResultDelivery = z.infer<
  typeof AutomationV3WorkerResultDeliverySchema
>;

function addRunTriggerCauseCorrespondenceIssue(
  value: Readonly<{
    triggerId: string | null;
    triggerRetired: boolean;
    cause: z.infer<typeof AutomationRunCauseSchema>;
  }>,
  context: z.core.$RefinementCtx,
): void {
  const corresponds = value.cause.kind === 'trigger'
    ? value.triggerId === value.cause.triggerId
    : value.cause.kind === 'conversation' && value.cause.triggerId !== undefined
      ? value.triggerId === value.cause.triggerId
      : value.triggerId === null && value.triggerRetired === false;
  if (!corresponds) {
    context.addIssue({
      code: "custom",
      path: ['triggerId'],
      message: 'Run trigger relation must correspond to its immutable cause',
    });
  }
}

const AutomationV3WorkerClaimedAutomationRunBaseSchema = lazyZodSchema(() => z.strictObject({
  id: IDENTIFIER_SCHEMA,
  automationId: IDENTIFIER_SCHEMA,
  /** Exact server-granted expiry, retained unchanged by claim receipt replay. */
  leaseExpiresAt: TIMESTAMP_SCHEMA,
  attempt: z.number().check(z.int(), z.positive(), z.int()),
  /** Exact post-claim parent CAS revision for workflow snapshot finalization. */
  revision: z.number().check(z.int(), z.nonnegative(), z.int()),
  /** Boundary Resume request consumed by this claim; absent on unrelated claims. */
  workflowResumeRequestedRevision: z.optional(z.number().check(z.int(), z.nonnegative(), z.int())),
  /** Explicit program epoch; workers never infer execution semantics from optional envelopes. */
  recipeKind: z.enum(['legacy', 'workflow-v2']),
  // Retained predecessor Runs may lack a recipe. A V3 worker must fail those
  // closed rather than consulting the mutable Automation definition.
  executionInputEnvelope: z.nullable(AutomationRunExecutionInputEnvelopeSchema),
  /** Automation-origin workflow input evidence, kept separate from the immutable accepted definition. */
  automationEvidenceEnvelope: z.optional(z.nullable(AutomationRunExecutionInputEnvelopeSchema)),
  /** Absent before daemon materialization; subsequent claims reuse the admitted Run snapshot. */
  workflowAcceptedSnapshotEnvelope: z.optional(AutomationRunExecutionInputEnvelopeSchema),
  triggerId: zMini.nullable(AutomationTriggerIdSchema),
  triggerRetired: z.boolean(),
  /** Immutable Run-owned cause consumed by the strict recipe materializer. */
  cause: AutomationRunCauseSchema,
  /** Host-stamped firing cause depth; captured in the claim receipt, never caller input. */
  causeWorkDepth: z.optional(z.number().check(z.int(), z.nonnegative(), z.int())),
  /** Scoped trigger only: the last succeeded run's final review checkpoint. */
  lastSucceededRun: z.optional(z.strictObject({
    runId: IDENTIFIER_SCHEMA,
    checkpointEnvelope: AutomationRunExecutionInputEnvelopeSchema,
  })),
  /** Omitted for ordinary claims. */
  resultDelivery: z.optional(AutomationV3WorkerResultDeliverySchema),
}));

function validateAutomationV3WorkerClaimedAutomationRun(
  value: Pick<z.infer<typeof AutomationV3WorkerClaimedAutomationRunBaseSchema>,
    'triggerId' | 'triggerRetired' | 'cause' | 'recipeKind' | 'executionInputEnvelope' | 'automationEvidenceEnvelope'>,
  context: z.core.$RefinementCtx,
) {
  addRunTriggerCauseCorrespondenceIssue(value, context);
  if (value.recipeKind === 'workflow-v2') {
    if (value.executionInputEnvelope === null) {
      context.addIssue({
        code: "custom",
        path: ['executionInputEnvelope'],
        message: 'A workflow-v2 claim requires its frozen workflow definition envelope',
      });
    }
    if (!Object.hasOwn(value, 'automationEvidenceEnvelope')) {
      context.addIssue({
        code: "custom",
        path: ['automationEvidenceEnvelope'],
        message: 'A workflow-v2 claim requires explicit frozen trigger evidence, including null',
      });
    }
  } else if (Object.hasOwn(value, 'automationEvidenceEnvelope')) {
    context.addIssue({
      code: "custom",
      path: ['automationEvidenceEnvelope'],
      message: 'A legacy claim cannot carry workflow trigger evidence',
    });
  }
}

const AutomationV3WorkerClaimedAutomationRunSchema = lazyZodSchema(() => AutomationV3WorkerClaimedAutomationRunBaseSchema.check(z.superRefine(validateAutomationV3WorkerClaimedAutomationRun)));

const AutomationV3WorkerClaimedDirectWorkflowRunSchema = lazyZodSchema(() => z.strictObject({
  id: IDENTIFIER_SCHEMA,
  automationId: z.null(),
  /** Exact server-granted expiry, retained unchanged by claim receipt replay. */
  leaseExpiresAt: TIMESTAMP_SCHEMA,
  attempt: z.number().check(z.int(), z.positive(), z.int()),
  revision: z.number().check(z.int(), z.nonnegative(), z.int()),
  /** Boundary Resume request consumed by this claim; absent on unrelated claims. */
  workflowResumeRequestedRevision: z.optional(z.number().check(z.int(), z.nonnegative(), z.int())),
  recipeKind: z.literal('workflow-v2'),
  origin: z.strictObject({
    kind: z.literal('direct'),
    originSessionId: z.optional(IDENTIFIER_SCHEMA),
  }),
  workflowAcceptedSnapshotEnvelope: AutomationRunExecutionInputEnvelopeSchema,
  triggerId: z.null(),
  triggerRetired: z.literal(false),
}));

/**
 * Receipt-safe claim projection. Private Run envelopes remain null in the
 * receipt and are re-read from their transition-censused Run row on replay.
 */
export const AutomationV3WorkerClaimReceiptRunSchema = lazyZodSchema(() => z.union([
  // A receipt carries correspondence, not private workflow definition/evidence.
  // The claim owner reopens those bytes from the canonical Run on replay.
  z.extend(z.omit(AutomationV3WorkerClaimedAutomationRunBaseSchema, { workflowAcceptedSnapshotEnvelope: true }), {
    lastSucceededRun: z.optional(z.strictObject({
      runId: IDENTIFIER_SCHEMA,
      checkpointEnvelope: z.null(),
    })),
  }).check(z.superRefine(addRunTriggerCauseCorrespondenceIssue)),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationV3WorkerClaimedDirectWorkflowRunSchema, {
    workflowAcceptedSnapshotEnvelope: z.nullable(AutomationRunExecutionInputEnvelopeSchema),
  })),
]));
export type AutomationV3WorkerClaimReceiptRun = z.infer<typeof AutomationV3WorkerClaimReceiptRunSchema>;

/** Private worker payload; public Run reads remain bounded separately. */
export const AutomationV3WorkerClaimedRunSchema = lazyZodSchema(() => z.union([
  AutomationV3WorkerClaimedAutomationRunSchema,
  AutomationV3WorkerClaimedDirectWorkflowRunSchema,
]));
export type AutomationV3WorkerClaimedRun = z.infer<typeof AutomationV3WorkerClaimedRunSchema>;

export const AutomationV3WorkerClaimedAutomationSchema = lazyZodSchema(() => z.strictObject({
  id: IDENTIFIER_SCHEMA,
  name: z.string(),
  enabled: z.boolean(),
  workflowDefinitionId: zMini.optional(zMini.nullable(WorkflowDefinitionRefV1StringSchema)),
  scopeSessionId: z.optional(z.nullable(IDENTIFIER_SCHEMA)),
}));
export type AutomationV3WorkerClaimedAutomation = z.infer<
  typeof AutomationV3WorkerClaimedAutomationSchema
>;

export const AutomationV3WorkerClaimResponseSchema = lazyZodSchema(() => z.strictObject({
  run: z.nullable(AutomationV3WorkerClaimedRunSchema),
  automation: z.nullable(AutomationV3WorkerClaimedAutomationSchema),
  /** C: exact Account witness observed atomically with the successful claim. */
  accountCurrentness: zMini.nullable(AutomationAccountCurrentnessWitnessV1Schema),
}).check(z.superRefine((value, context) => {
  const runNeedsAutomation = value.run?.automationId !== null;
  if ((value.run === null) !== (value.accountCurrentness === null)
    || (value.run !== null && runNeedsAutomation !== (value.automation !== null))
    || (value.run === null && value.automation !== null)) {
    context.addIssue({
      code: "custom",
      path: ['accountCurrentness'],
      message: 'A worker claim contains Account currentness with its Run and an Automation only for Automation origin',
    });
  }
})));
export type AutomationV3WorkerClaimResponse = z.infer<typeof AutomationV3WorkerClaimResponseSchema>;

export const AutomationV3WorkerHeartbeatRequestSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationV3WorkerMachineAttemptSchema, {
  leaseDurationMs: z.optional(z.number().check(z.int(), z.minimum(5_000), z.maximum(15 * 60_000))),
})));
export type AutomationV3WorkerHeartbeatRequest = z.infer<typeof AutomationV3WorkerHeartbeatRequestSchema>;

export const AutomationV3WorkerHeartbeatResponseSchema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true),
  leaseExpiresAt: z.nullable(TIMESTAMP_SCHEMA),
}));
export type AutomationV3WorkerHeartbeatResponse = z.infer<typeof AutomationV3WorkerHeartbeatResponseSchema>;

/** C must be echoed before a worker may transition a claimed Run to running. */
export const AutomationV3WorkerStartRequestSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationV3WorkerMachineAttemptSchema, {
  accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema,
})));
export type AutomationV3WorkerStartRequest = z.infer<typeof AutomationV3WorkerStartRequestSchema>;

/** Current writers carry a result envelope; predecessor summary bytes stay V2-only. */
export const AutomationV3WorkerSucceedRequestSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationV3WorkerMachineAttemptSchema, {
  /** S: the post-start Account witness, echoed unchanged from the successful start. */
  accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema,
  producedSessionId: z.optional(z.nullable(IDENTIFIER_SCHEMA)),
  resultEnvelope: z.optional(z.nullable(z.string().check(z.minLength(1)))),
})));
export type AutomationV3WorkerSucceedRequest = z.infer<typeof AutomationV3WorkerSucceedRequestSchema>;

export const AutomationV3WorkerFailRequestSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationV3WorkerMachineAttemptSchema, {
  /** S: the post-start Account witness, echoed unchanged from the successful start. */
  accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema,
  /** A known canonical new-Session id survives input failure/cancellation settlement. */
  producedSessionId: z.optional(z.nullable(IDENTIFIER_SCHEMA)),
  errorCode: z.optional(z.nullable(z.string().check(z.minLength(1), z.maxLength(128)))),
  /** Claimed-only trigger admission refusal; ordinary failures remain failed. */
  terminalState: z.optional(z.literal('skipped')),
  /** Private Account-mode-correct detail; errorCode remains the structural outcome. */
  errorDetailEnvelope: z.optional(z.nullable(z.string().check(z.minLength(1), maxCodeUnits(MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES)))),
})));
export type AutomationV3WorkerFailRequest = z.infer<typeof AutomationV3WorkerFailRequestSchema>;

export const AutomationV3WorkerExecutionDispatchOutcomeSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('noRunCreated'),
    errorCode: z.string().check(z.minLength(1), z.maxLength(128)),
  }),
  z.strictObject({
    kind: z.literal('outcomeUnknown'),
    errorCode: z.string().check(z.minLength(1), z.maxLength(128)),
  }),
  z.strictObject({
    kind: z.literal('started'),
    runId: IDENTIFIER_SCHEMA,
    callId: IDENTIFIER_SCHEMA,
    sidechainId: IDENTIFIER_SCHEMA,
    wait: zMini.optional(ExecutionRunWaitResultSchema),
  }),
]));
export type AutomationV3WorkerExecutionDispatchOutcome = z.infer<
  typeof AutomationV3WorkerExecutionDispatchOutcomeSchema
>;

export const AutomationV3WorkerExecutionDispatchSettlementRequestSchema =
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationV3WorkerMachineAttemptSchema, {
    accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema,
    outcome: AutomationV3WorkerExecutionDispatchOutcomeSchema,
  })));
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
  revision: z.number().check(z.int(), z.nonnegative(), z.int()),
  triggerId: zMini.nullable(AutomationTriggerIdSchema),
  triggerRetired: z.boolean(),
  state: AutomationRunStateV3Schema,
  cause: AutomationRunCauseSchema,
  dueAt: TIMESTAMP_SCHEMA,
  claimedAt: z.nullable(TIMESTAMP_SCHEMA),
  startedAt: z.nullable(TIMESTAMP_SCHEMA),
  finishedAt: z.nullable(TIMESTAMP_SCHEMA),
  claimedByMachineId: z.nullable(IDENTIFIER_SCHEMA),
  leaseExpiresAt: z.nullable(TIMESTAMP_SCHEMA),
  attempt: z.number().check(z.int(), z.nonnegative(), z.int()),
  errorCode: z.nullable(z.string()),
  producedSessionId: z.nullable(IDENTIFIER_SCHEMA),
  executionDispatchState: z.nullable(AutomationExecutionDispatchStateV3Schema),
  executionAttempt: z.number().check(z.int(), z.nonnegative(), z.int()),
  replyHandoffState: AutomationReplyHandoffStateV3Schema,
  replyHandoffAttempt: z.number().check(z.int(), z.nonnegative(), z.int()),
  replyHandoffDueAt: z.nullable(TIMESTAMP_SCHEMA),
  createdAt: TIMESTAMP_SCHEMA,
  updatedAt: TIMESTAMP_SCHEMA,
} as const;
export const AutomationV3RunListItemSchema = lazyZodSchema(() => z.strictObject(AutomationV3RunListItemShape).check(z.superRefine(addRunTriggerCauseCorrespondenceIssue)));
export type AutomationV3RunListItem = z.infer<typeof AutomationV3RunListItemSchema>;

/** S: returned atomically with a successful start and required for settlement. */
export const AutomationV3WorkerStartResponseSchema = lazyZodSchema(() => z.strictObject({
  run: AutomationV3RunListItemSchema,
  accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema,
}));
export type AutomationV3WorkerStartResponse = z.infer<typeof AutomationV3WorkerStartResponseSchema>;

/**
 * One committed Run lifecycle transition, as the user can read it. Every field
 * is a server-authored, bounded, non-secret fact: no envelope bytes, prompt
 * text, provider payload, or free-form message ever reaches this projection.
 */
export const AutomationV3RunEventSchema = lazyZodSchema(() => z.strictObject({
  at: TIMESTAMP_SCHEMA,
  /** Server-authored transition name, e.g. `run_started`, `run_outcome_uncertain`. */
  type: z.string().check(z.minLength(1), z.maxLength(64)),
  machineId: z.nullable(IDENTIFIER_SCHEMA),
  /** Bounded rejection/outcome code exactly as the Run recorded it. */
  errorCode: z.nullable(z.string().check(z.minLength(1), z.maxLength(128))),
  /** Dispatch attempt this transition belongs to; the Run's own claim attempt stays on the Run. */
  executionAttempt: z.nullable(z.number().check(z.int(), z.nonnegative(), z.int())),
  /** Which dispatch result the settlement owner committed. */
  outcome: z.nullable(z.string().check(z.minLength(1), z.maxLength(64))),
  /** Why a lifecycle owner other than the worker terminalized the Run. */
  reason: z.nullable(z.string().check(z.minLength(1), z.maxLength(128))),
}));
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
const AutomationWorkflowRunCorrespondenceSchema = lazyZodSchema(() => z.strictObject({
  recipeKind: z.literal('workflow-v2'),
  workflowRunId: IDENTIFIER_SCHEMA,
}));

function addWorkflowRunCorrespondenceIssue(value: Readonly<{ id: string; workflowRun?: Readonly<{ workflowRunId: string }> }>, context: z.core.$RefinementCtx): void {
  if (value.workflowRun && value.workflowRun.workflowRunId !== value.id) {
    context.addIssue({ code: "custom", path: ['workflowRun', 'workflowRunId'],
      message: 'Workflow correspondence must identify the same Run' });
  }
}

export const AutomationV3RunDetailSchema = lazyZodSchema(() => z.strictObject({
  ...AutomationV3RunListItemShape,
  triggerEvidenceEnvelope: z.nullable(z.string().check(z.minLength(1))),
  executionInputEnvelope: z.nullable(z.string().check(z.minLength(1))),
  resultEnvelope: z.nullable(z.string().check(z.minLength(1))),
  /** Full accepted snapshot/progress belongs to the canonical Workflow Run reader. */
  workflowRun: z.optional(AutomationWorkflowRunCorrespondenceSchema),
  legacySummaryCiphertext: z.nullable(z.string().check(z.minLength(1))),
  /**
   * The native execution this Run started. It is the only pointer back to work
   * that may still be running when the Run itself is uncertain, so the detail
   * shows it instead of leaving the user with an unexplained outcome.
   */
  executionNativeRunId: z.nullable(IDENTIFIER_SCHEMA),
  executionNativeCallId: z.nullable(IDENTIFIER_SCHEMA),
  executionNativeSidechainId: z.nullable(IDENTIFIER_SCHEMA),
  /**
   * Whether a present user can still act on a `blocked` Conversation reply
   * handoff. `false` means the handoff facts frozen at admission are themselves
   * invalid, so no retry, machine change, or plugin update can ever dispatch
   * it and the product must not offer one. `null` on every non-blocked state,
   * and absent from a supported older server that does not classify it — a
   * client must then keep its previous behaviour rather than assume either
   * answer.
   */
  replyHandoffRecoverable: z.optional(z.nullable(z.boolean())),
  /** Committed lifecycle transitions in ascending time order. */
  events: z.array(AutomationV3RunEventSchema).check(z.maxLength(AUTOMATION_V3_RUN_DETAIL_MAX_EVENTS)),
  /** Exact private Run failure detail; never emitted by list or mutation projections. */
  errorDetailEnvelope: z.optional(z.nullable(z.string().check(z.minLength(1), maxCodeUnits(MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES)))),
}).check(z.superRefine((value, context) => {
  addRunTriggerCauseCorrespondenceIssue(value, context);
  addWorkflowRunCorrespondenceIssue(value, context);
  if (value.resultEnvelope !== null && value.legacySummaryCiphertext !== null) {
    context.addIssue({
      code: "custom",
      path: ['resultEnvelope'],
      message: 'A Run detail has either a current result envelope or a predecessor summary, not both',
    });
  }
})));
export type AutomationV3RunDetail = z.infer<typeof AutomationV3RunDetailSchema>;

/** Canonical public Run-list/API page bound. */
export const AUTOMATION_V3_RUN_LIST_MAX_ITEMS = 100;

export const AutomationV3RunListResponseSchema = lazyZodSchema(() => z.strictObject({
  runs: z.array(AutomationV3RunListItemSchema).check(z.maxLength(AUTOMATION_V3_RUN_LIST_MAX_ITEMS)),
  nextCursor: z.nullable(z.string()),
}));
export type AutomationV3RunListResponse = z.infer<typeof AutomationV3RunListResponseSchema>;

/** Result of removing eligible terminal history for one Automation. */
export const AutomationV3ClearRunHistoryResponseSchema = lazyZodSchema(() => z.strictObject({
  clearedRuns: z.number().check(z.int(), z.nonnegative(), z.int()),
}));
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
export const AutomationV3RunReplyHandoffRedeliverRequestSchema = lazyZodSchema(() => z.strictObject({
  expectedRevision: z.number().check(z.int(), z.nonnegative(), z.int()),
}));
export type AutomationV3RunReplyHandoffRedeliverRequest = z.infer<
  typeof AutomationV3RunReplyHandoffRedeliverRequestSchema
>;

export const AutomationV3RunMutationResponseSchema = lazyZodSchema(() => z.strictObject({
  run: AutomationV3RunListItemSchema,
  workflowRun: z.optional(AutomationWorkflowRunCorrespondenceSchema),
}).check(z.superRefine((value, context) => {
  addWorkflowRunCorrespondenceIssue({ id: value.run.id, workflowRun: value.workflowRun }, context);
})));
export type AutomationV3RunMutationResponse = z.infer<typeof AutomationV3RunMutationResponseSchema>;

export const AutomationDeleteResponseSchema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true),
  /** The live templateVersion removed by deletion; older servers omit this evidence. */
  removedRevision: z.optional(z.number().check(z.int(), z.nonnegative(), z.int())),
}));
export type AutomationDeleteResponse = z.infer<typeof AutomationDeleteResponseSchema>;
