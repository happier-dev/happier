import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { AutomationEventSourceStatusV1Schema, AutomationEventSourceCatalogStatusStateV1Schema, UNSIGNED_DECIMAL_BIGINT_SCHEMA } from './automationEventSourceStatusV1.js';
import { AutomationEventPositiveSafeIntegerV1Schema } from './automationColumnBoundsV1.js';
import { AutomationTriggerIdSchema, AutomationTriggerRevisionSchema } from './automationTriggerIdentity.js';
import { AutomationScheduleTriggerSchema } from './automationTriggerDefinition.js';
import { AutomationSessionLifecycleConfigurationSchema } from './automationSessionLifecycle.js';
import { AutomationRunLifecycleTriggerSchema } from './automationRunLifecycle.js';
import { PluginMachineMaterializationRefV1Schema } from '../plugins/availability/materializationRefV1.js';
const TIMESTAMP_SCHEMA = z.number().int().nonnegative().safe();
const IDENTIFIER_SCHEMA = z.string().min(1);

/**
 * List/detail-safe catalog reconciliation facts for the current Event source.
 * Routing, Account, source, and materialization identity remain server-owned.
 */
export const AutomationEventSourceCatalogStatusSchema = lazyZodSchema(() => z.object({
  observedRevision: UNSIGNED_DECIMAL_BIGINT_SCHEMA,
  adoptedRevision: UNSIGNED_DECIMAL_BIGINT_SCHEMA.nullable(),
  state: AutomationEventSourceCatalogStatusStateV1Schema,
  scanStartedAt: TIMESTAMP_SCHEMA.nullable(),
  nextRetryAt: TIMESTAMP_SCHEMA.nullable(),
}).strict());
export type AutomationEventSourceCatalogStatus = z.infer<
  typeof AutomationEventSourceCatalogStatusSchema
>;

export const AutomationPluginEventRefSchema = lazyZodSchema(() => z.object({
  pluginId: IDENTIFIER_SCHEMA,
  localId: IDENTIFIER_SCHEMA,
}).strict());
export type AutomationPluginEventRef = z.infer<typeof AutomationPluginEventRefSchema>;

export const AutomationCheckpointedPullObservationSchema = lazyZodSchema(() => z.object({
  kind: z.literal('checkpointedPull'),
  watcher: z.object({
    machineId: IDENTIFIER_SCHEMA,
    machineInstallationId: IDENTIFIER_SCHEMA,
    pluginId: IDENTIFIER_SCHEMA,
    materializationId: IDENTIFIER_SCHEMA,
  }).strict().nullable(),
}).strict());
export type AutomationCheckpointedPullObservation = z.infer<
  typeof AutomationCheckpointedPullObservationSchema
>;

export const AutomationSocketObservationSchema = lazyZodSchema(() => z.object({
  kind: z.literal('socket'),
  /** Exact materialization hosting the provider's observation session; null when unavailable. */
  watcher: z.object({
    machineId: IDENTIFIER_SCHEMA,
    machineInstallationId: IDENTIFIER_SCHEMA,
    pluginId: IDENTIFIER_SCHEMA,
    materializationId: IDENTIFIER_SCHEMA,
  }).strict().nullable(),
}).strict());
export type AutomationSocketObservation = z.infer<
  typeof AutomationSocketObservationSchema
>;

export const AutomationDurablePushObservationSchema = lazyZodSchema(() => z.object({
  kind: z.literal('durablePush'),
  webhookEndpointId: IDENTIFIER_SCHEMA,
  /** Safe current endpoint target; null when that exact endpoint is no longer available. */
  endpointMaterializationRef: PluginMachineMaterializationRefV1Schema.nullable(),
  observationStartsAt: TIMESTAMP_SCHEMA,
}).strict());
export type AutomationDurablePushObservation = z.infer<
  typeof AutomationDurablePushObservationSchema
>;

export const AutomationPluginEventTriggerSchema = lazyZodSchema(() => z.object({
  kind: z.literal('pluginEvent'),
  eventRef: AutomationPluginEventRefSchema,
  sourceSelectorId: IDENTIFIER_SCHEMA,
  sourceContractVersion: AutomationEventPositiveSafeIntegerV1Schema,
  observation: z.union([
    AutomationCheckpointedPullObservationSchema,
    AutomationSocketObservationSchema,
    AutomationDurablePushObservationSchema,
  ]),
}).strict());
export type AutomationPluginEventTrigger = z.infer<typeof AutomationPluginEventTriggerSchema>;

const AutomationTriggerProjectionBaseSchema = lazyZodSchema(() => z.object({
  id: AutomationTriggerIdSchema,
  revision: AutomationTriggerRevisionSchema,
  enabled: z.boolean(),
  createdAt: TIMESTAMP_SCHEMA,
  updatedAt: TIMESTAMP_SCHEMA,
}).strict());

export const AutomationScheduleTriggerProjectionSchema = lazyZodSchema(() => AutomationTriggerProjectionBaseSchema.extend({
  ...AutomationScheduleTriggerSchema.shape,
  nextRunAt: TIMESTAMP_SCHEMA.nullable(),
}).strict());

export const AutomationPluginEventTriggerProjectionSchema = lazyZodSchema(() => AutomationTriggerProjectionBaseSchema.extend({
  ...AutomationPluginEventTriggerSchema.shape,
  sourceStatus: AutomationEventSourceStatusV1Schema.nullable(),
  sourceCatalogStatus: AutomationEventSourceCatalogStatusSchema.nullable(),
}).strict());

export const AutomationSessionLifecycleTriggerStatusSchema = lazyZodSchema(() => z.discriminatedUnion('state', [
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
]));
export type AutomationSessionLifecycleTriggerStatus = z.infer<
  typeof AutomationSessionLifecycleTriggerStatusSchema
>;

export const AutomationSessionLifecycleTriggerProjectionSchema = lazyZodSchema(() => AutomationTriggerProjectionBaseSchema.extend({
  kind: z.literal('sessionLifecycle'),
  ...AutomationSessionLifecycleConfigurationSchema.shape,
  remainingOccurrences: z.number().int().nonnegative().max(2_147_483_647).nullable(),
  status: AutomationSessionLifecycleTriggerStatusSchema,
}).strict());

export const AutomationTriggerListItemSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  AutomationTriggerProjectionBaseSchema.extend({ kind: z.literal('prComment'), sourceSessionId: IDENTIFIER_SCHEMA }).strict(),
  AutomationTriggerProjectionBaseSchema.extend({ kind: z.literal('ciFailed'), sourceSessionId: IDENTIFIER_SCHEMA }).strict(),
  AutomationScheduleTriggerProjectionSchema,
  AutomationPluginEventTriggerProjectionSchema,
  AutomationSessionLifecycleTriggerProjectionSchema,
  AutomationTriggerProjectionBaseSchema.extend({ ...AutomationRunLifecycleTriggerSchema.shape,
    remainingOccurrences: z.number().int().min(0).max(1), status: AutomationSessionLifecycleTriggerStatusSchema }).strict(),
]));
export type AutomationTriggerListItem = z.infer<typeof AutomationTriggerListItemSchema>;

export const AutomationTriggerDetailSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  AutomationTriggerProjectionBaseSchema.extend({ kind: z.literal('prComment'), sourceSessionId: IDENTIFIER_SCHEMA,
    triggerDefinitionEnvelope: z.string().min(1) }).strict(),
  AutomationTriggerProjectionBaseSchema.extend({ kind: z.literal('ciFailed'), sourceSessionId: IDENTIFIER_SCHEMA,
    triggerDefinitionEnvelope: z.string().min(1) }).strict(),
  AutomationScheduleTriggerProjectionSchema.extend({ triggerDefinitionEnvelope: z.null() }).strict(),
  AutomationPluginEventTriggerProjectionSchema.extend({
    triggerDefinitionEnvelope: z.string().min(1),
  }).strict(),
  AutomationSessionLifecycleTriggerProjectionSchema.extend({
    triggerDefinitionEnvelope: z.null(),
  }).strict(),
  AutomationTriggerProjectionBaseSchema.extend({ ...AutomationRunLifecycleTriggerSchema.shape,
    remainingOccurrences: z.number().int().min(0).max(1), status: AutomationSessionLifecycleTriggerStatusSchema,
    triggerDefinitionEnvelope: z.null() }).strict(),
]));
export type AutomationTriggerDetail = z.infer<typeof AutomationTriggerDetailSchema>;
