import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { AutomationEventSourceStatusV1Schema, AutomationEventSourceCatalogStatusStateV1Schema, UNSIGNED_DECIMAL_BIGINT_SCHEMA } from './automationEventSourceStatusV1.js';
import { AutomationEventPositiveSafeIntegerV1Schema } from './automationColumnBoundsV1.js';
import { AutomationTriggerIdSchema, AutomationTriggerRevisionSchema } from './automationTriggerIdentity.js';
import { AutomationScheduleTriggerSchema } from './automationTriggerDefinition.js';
import { AutomationSessionLifecycleConfigurationSchema } from './automationSessionLifecycle.js';
import { AutomationRunLifecycleTriggerSchema } from './automationRunLifecycle.js';
import { PluginMachineMaterializationRefV1Schema } from '../plugins/availability/materializationRefV1.js';
const TIMESTAMP_SCHEMA = z.number().check(z.int(), z.nonnegative(), z.int());
const IDENTIFIER_SCHEMA = z.string().check(z.minLength(1));

/**
 * List/detail-safe catalog reconciliation facts for the current Event source.
 * Routing, Account, source, and materialization identity remain server-owned.
 */
export const AutomationEventSourceCatalogStatusSchema = lazyZodSchema(() => z.strictObject({
  observedRevision: UNSIGNED_DECIMAL_BIGINT_SCHEMA,
  adoptedRevision: z.nullable(UNSIGNED_DECIMAL_BIGINT_SCHEMA),
  state: AutomationEventSourceCatalogStatusStateV1Schema,
  scanStartedAt: z.nullable(TIMESTAMP_SCHEMA),
  nextRetryAt: z.nullable(TIMESTAMP_SCHEMA),
}));
export type AutomationEventSourceCatalogStatus = z.infer<
  typeof AutomationEventSourceCatalogStatusSchema
>;

export const AutomationPluginEventRefSchema = lazyZodSchema(() => z.strictObject({
  pluginId: IDENTIFIER_SCHEMA,
  localId: IDENTIFIER_SCHEMA,
}));
export type AutomationPluginEventRef = z.infer<typeof AutomationPluginEventRefSchema>;

export const AutomationCheckpointedPullObservationSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('checkpointedPull'),
  watcher: z.nullable(z.strictObject({
    machineId: IDENTIFIER_SCHEMA,
    machineInstallationId: IDENTIFIER_SCHEMA,
    pluginId: IDENTIFIER_SCHEMA,
    materializationId: IDENTIFIER_SCHEMA,
  })),
}));
export type AutomationCheckpointedPullObservation = z.infer<
  typeof AutomationCheckpointedPullObservationSchema
>;

export const AutomationSocketObservationSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('socket'),
  /** Exact materialization hosting the provider's observation session; null when unavailable. */
  watcher: z.nullable(z.strictObject({
    machineId: IDENTIFIER_SCHEMA,
    machineInstallationId: IDENTIFIER_SCHEMA,
    pluginId: IDENTIFIER_SCHEMA,
    materializationId: IDENTIFIER_SCHEMA,
  })),
}));
export type AutomationSocketObservation = z.infer<
  typeof AutomationSocketObservationSchema
>;

export const AutomationDurablePushObservationSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('durablePush'),
  webhookEndpointId: IDENTIFIER_SCHEMA,
  /** Safe current endpoint target; null when that exact endpoint is no longer available. */
  endpointMaterializationRef: z.nullable(PluginMachineMaterializationRefV1Schema),
  observationStartsAt: TIMESTAMP_SCHEMA,
}));
export type AutomationDurablePushObservation = z.infer<
  typeof AutomationDurablePushObservationSchema
>;

export const AutomationPluginEventTriggerSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('pluginEvent'),
  eventRef: AutomationPluginEventRefSchema,
  sourceSelectorId: IDENTIFIER_SCHEMA,
  sourceContractVersion: AutomationEventPositiveSafeIntegerV1Schema,
  observation: z.union([
    AutomationCheckpointedPullObservationSchema,
    AutomationSocketObservationSchema,
    AutomationDurablePushObservationSchema,
  ]),
}));
export type AutomationPluginEventTrigger = z.infer<typeof AutomationPluginEventTriggerSchema>;

const AutomationTriggerProjectionBaseSchema = lazyZodSchema(() => z.strictObject({
  id: AutomationTriggerIdSchema,
  revision: AutomationTriggerRevisionSchema,
  enabled: z.boolean(),
  createdAt: TIMESTAMP_SCHEMA,
  updatedAt: TIMESTAMP_SCHEMA,
}));

export const AutomationScheduleTriggerProjectionSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationTriggerProjectionBaseSchema, {
  ...AutomationScheduleTriggerSchema.shape,
  nextRunAt: z.nullable(TIMESTAMP_SCHEMA),
  remainingOccurrences: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
})));

export const AutomationPluginEventTriggerProjectionSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationTriggerProjectionBaseSchema, {
  ...AutomationPluginEventTriggerSchema.shape,
  sourceStatus: z.nullable(AutomationEventSourceStatusV1Schema),
  sourceCatalogStatus: z.nullable(AutomationEventSourceCatalogStatusSchema),
})));

export const AutomationSessionLifecycleTriggerStatusSchema = lazyZodSchema(() => z.discriminatedUnion('state', [
  z.strictObject({
    state: z.enum(['waiting', 'paused', 'sourceFailed', 'sourceCancelled', 'sourceUnavailable']),
    runId: z.null(),
  }),
  z.strictObject({
    state: z.enum(['triggered', 'running']),
    runId: IDENTIFIER_SCHEMA,
  }),
  z.strictObject({
    state: z.literal('finished'),
    runId: z.nullable(IDENTIFIER_SCHEMA),
  }),
]));
export type AutomationSessionLifecycleTriggerStatus = z.infer<
  typeof AutomationSessionLifecycleTriggerStatusSchema
>;

export const AutomationSessionLifecycleTriggerProjectionSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationTriggerProjectionBaseSchema, {
  kind: z.literal('sessionLifecycle'),
  ...AutomationSessionLifecycleConfigurationSchema.shape,
  remainingOccurrences: z.nullable(z.number().check(z.int(), z.nonnegative(), z.maximum(2_147_483_647))),
  status: AutomationSessionLifecycleTriggerStatusSchema,
})));

export const AutomationTriggerListItemSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationTriggerProjectionBaseSchema, { kind: z.literal('prComment'), sourceSessionId: IDENTIFIER_SCHEMA })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationTriggerProjectionBaseSchema, { kind: z.literal('ciFailed'), sourceSessionId: IDENTIFIER_SCHEMA })),
  AutomationScheduleTriggerProjectionSchema,
  AutomationPluginEventTriggerProjectionSchema,
  AutomationSessionLifecycleTriggerProjectionSchema,
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationTriggerProjectionBaseSchema, { ...AutomationRunLifecycleTriggerSchema.shape,
    remainingOccurrences: z.number().check(z.int(), z.minimum(0), z.maximum(1)), status: AutomationSessionLifecycleTriggerStatusSchema })),
]));
export type AutomationTriggerListItem = z.infer<typeof AutomationTriggerListItemSchema>;

export const AutomationTriggerDetailSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationTriggerProjectionBaseSchema, { kind: z.literal('prComment'), sourceSessionId: IDENTIFIER_SCHEMA,
    triggerDefinitionEnvelope: z.string().check(z.minLength(1)) })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationTriggerProjectionBaseSchema, { kind: z.literal('ciFailed'), sourceSessionId: IDENTIFIER_SCHEMA,
    triggerDefinitionEnvelope: z.string().check(z.minLength(1)) })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationScheduleTriggerProjectionSchema, { triggerDefinitionEnvelope: z.null() })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationPluginEventTriggerProjectionSchema, {
    triggerDefinitionEnvelope: z.string().check(z.minLength(1)),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationSessionLifecycleTriggerProjectionSchema, {
    triggerDefinitionEnvelope: z.null(),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationTriggerProjectionBaseSchema, { ...AutomationRunLifecycleTriggerSchema.shape,
    remainingOccurrences: z.number().check(z.int(), z.minimum(0), z.maximum(1)), status: AutomationSessionLifecycleTriggerStatusSchema,
    triggerDefinitionEnvelope: z.null() })),
]));
export type AutomationTriggerDetail = z.infer<typeof AutomationTriggerDetailSchema>;
