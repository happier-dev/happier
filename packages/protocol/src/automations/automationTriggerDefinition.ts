import { z } from 'zod';

import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { PluginMachineMaterializationRefV1Schema } from '../plugins/availability/materializationRefV1.js';
import {
  PluginWebhookEndpointIdV1Schema,
  PluginWebhookEndpointSetupV1Schema,
} from '../plugins/webhooks/endpointV1.js';
import { SessionIdSchema, TurnIdSchema } from '../sessions/idsV1.js';
import {
  AutomationEventPositiveSafeIntegerV1Schema,
  AutomationQualifiedPluginContributionRefV1Schema,
  AutomationSourceSelectorIdV1Schema,
} from './automationEventDeclarationV1.js';
import {
  AutomationEventFilterV1Schema,
  AutomationEventSourceConfigV1Schema,
  AutomationEventSourceDisplayLabelV1Schema,
  AutomationEventSourceInstanceIdV1Schema,
} from './automationEventV1.js';
import {
  ENCRYPTED_STORED_CONTENT_SCHEMA,
  addAutomationStoredEnvelopeUtf8LimitIssue,
} from './automationStoredContentEnvelopeV1.js';

const AutomationScheduleSchema = z.discriminatedUnion('kind', [
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

export const AutomationScheduleTriggerSchema = z.object({
  kind: z.literal('schedule'),
  schedule: AutomationScheduleSchema,
}).strict();
export type AutomationScheduleTrigger = z.infer<typeof AutomationScheduleTriggerSchema>;

export const AutomationScheduleTriggerInputSchema = AutomationScheduleTriggerSchema.extend({
  enabled: z.boolean(),
}).strict();
export type AutomationScheduleTriggerInput = z.infer<typeof AutomationScheduleTriggerInputSchema>;

export const AutomationSessionLifecycleTriggerSchema = z.object({
  kind: z.literal('sessionLifecycle'),
  event: z.literal('parentTurnCompleted'),
  scope: z.object({
    kind: z.literal('exactTurn'),
    sourceSessionId: asProtocolZod(SessionIdSchema),
    sourceTurnId: TurnIdSchema,
  }).strict(),
  consumption: z.literal('once'),
}).strict();
export type AutomationSessionLifecycleTrigger = z.infer<
  typeof AutomationSessionLifecycleTriggerSchema
>;

export const AutomationSessionLifecycleTriggerInputSchema =
  AutomationSessionLifecycleTriggerSchema.extend({ enabled: z.boolean() }).strict();
export type AutomationSessionLifecycleTriggerInput = z.infer<
  typeof AutomationSessionLifecycleTriggerInputSchema
>;

/** Stable exact-turn registration refusals derived by the Session owner. */
export const AutomationSessionLifecycleRegistrationErrorCodeSchema = z.enum([
  'sourceSessionUnavailable',
  'sourceTurnNotCurrent',
  'sourceTurnUnavailable',
  'sourceTurnNotInProgress',
  'executionTargetInequalityUnproven',
  'sourceMatchesExecutionTarget',
]);
export type AutomationSessionLifecycleRegistrationErrorCode = z.infer<
  typeof AutomationSessionLifecycleRegistrationErrorCodeSchema
>;

export const AutomationPluginEventObservationTransportInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('checkpointedPull'),
    watcherMaterializationRef: PluginMachineMaterializationRefV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('socket'),
    /** The exact plugin materialization hosting the provider's observation session. */
    watcherMaterializationRef: PluginMachineMaterializationRefV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('durablePush'),
    webhookEndpointId: PluginWebhookEndpointIdV1Schema,
    endpointMaterializationRef: PluginMachineMaterializationRefV1Schema,
    webhookRoutingSourceInstanceId: AutomationEventSourceInstanceIdV1Schema,
    setup: PluginWebhookEndpointSetupV1Schema,
  }).strict(),
]);
export type AutomationPluginEventObservationTransportInput = z.infer<
  typeof AutomationPluginEventObservationTransportInputSchema
>;

export const AutomationPluginEventDefinitionTriggerSchema = z.object({
  kind: z.literal('pluginEvent'),
  eventRef: asProtocolZod(AutomationQualifiedPluginContributionRefV1Schema),
  sourceInstanceId: AutomationEventSourceInstanceIdV1Schema,
  sourceContractVersion: AutomationEventPositiveSafeIntegerV1Schema,
  sourceConfig: asProtocolZod(AutomationEventSourceConfigV1Schema),
  displayLabel: AutomationEventSourceDisplayLabelV1Schema,
  observationTransport: AutomationPluginEventObservationTransportInputSchema,
  filter: AutomationEventFilterV1Schema.nullable(),
  maximumObservationAgeMs: z.number().int().nonnegative().safe().nullable(),
}).strict();
export type AutomationPluginEventDefinitionTrigger = z.infer<
  typeof AutomationPluginEventDefinitionTriggerSchema
>;

export const AutomationEncryptedTriggerDefinitionEnvelopeV1Schema =
  ENCRYPTED_STORED_CONTENT_SCHEMA.superRefine((value, context) => {
    addAutomationStoredEnvelopeUtf8LimitIssue(
      value,
      context,
      'Stored Automation envelope exceeds its UTF-8 byte limit',
    );
  });
export type AutomationEncryptedTriggerDefinitionEnvelopeV1 = z.infer<
  typeof AutomationEncryptedTriggerDefinitionEnvelopeV1Schema
>;

/**
 * Ciphertext-blind Event authoring arm. Public routing/currentness facts remain
 * on AutomationTrigger; the exact private definition is sealed to the
 * client-chosen Automation/trigger identity and revision in the canonical
 * stored-content envelope.
 */
export const AutomationPluginEventEncryptedDefinitionTriggerSchema = z.object({
  kind: z.literal('pluginEvent'),
  eventRef: asProtocolZod(AutomationQualifiedPluginContributionRefV1Schema),
  sourceSelectorId: AutomationSourceSelectorIdV1Schema,
  sourceContractVersion: AutomationEventPositiveSafeIntegerV1Schema,
  observationTransport: AutomationPluginEventObservationTransportInputSchema,
  triggerDefinitionEnvelope: AutomationEncryptedTriggerDefinitionEnvelopeV1Schema,
}).strict();
export type AutomationPluginEventEncryptedDefinitionTrigger = z.infer<
  typeof AutomationPluginEventEncryptedDefinitionTriggerSchema
>;

export const AutomationPluginEventDefinitionTriggerInputSchema =
  z.union([
    AutomationPluginEventDefinitionTriggerSchema.extend({ enabled: z.boolean() }).strict(),
    AutomationPluginEventEncryptedDefinitionTriggerSchema.extend({ enabled: z.boolean() }).strict(),
  ]);
export type AutomationPluginEventDefinitionTriggerInput = z.infer<
  typeof AutomationPluginEventDefinitionTriggerInputSchema
>;

export const AutomationTriggerDefinitionSchema = z.union([
  AutomationScheduleTriggerSchema,
  AutomationPluginEventDefinitionTriggerSchema,
  AutomationPluginEventEncryptedDefinitionTriggerSchema,
  AutomationSessionLifecycleTriggerSchema,
]);
export type AutomationTriggerDefinition = z.infer<typeof AutomationTriggerDefinitionSchema>;

export const AutomationTriggerDefinitionInputSchema = z.union([
  AutomationScheduleTriggerInputSchema,
  AutomationPluginEventDefinitionTriggerInputSchema,
  AutomationSessionLifecycleTriggerInputSchema,
]);
export type AutomationTriggerDefinitionInput = z.infer<
  typeof AutomationTriggerDefinitionInputSchema
>;
