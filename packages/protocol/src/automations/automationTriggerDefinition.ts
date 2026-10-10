import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { PluginMachineMaterializationRefV1Schema } from '../plugins/availability/materializationRefV1.js';
import {
  PluginWebhookEndpointIdV1Schema,
  PluginWebhookEndpointSetupV1Schema,
} from '../plugins/webhooks/endpointV1.js';
import {
  AutomationQualifiedPluginContributionRefV1Schema,
  AutomationSourceSelectorIdV1Schema,
} from './automationEventDeclarationV1.js';
import { AutomationEventPositiveSafeIntegerV1Schema } from './automationColumnBoundsV1.js';
import {
  AutomationEventSourceConfigV1Schema,
  AutomationEventSourceDisplayLabelV1Schema,
  AutomationEventSourceInstanceIdV1Schema,
} from './automationEventJsonBoundsV1.js';
import { AutomationEventFilterV1Schema } from './automationEventFilterV1.js';
import {
  ENCRYPTED_STORED_CONTENT_SCHEMA,
  addAutomationStoredEnvelopeUtf8LimitIssue,
} from './automationStoredContentEnvelopeV1.js';
import { AutomationSessionLifecycleConfigurationSchema } from './automationSessionLifecycle.js';
import { AutomationRunLifecycleTriggerSchema, AutomationRunLifecycleTriggerInputSchema } from './automationRunLifecycle.js';
export * from './automationRunLifecycle.js';

const AutomationScheduleSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
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
]));

export const AutomationScheduleTriggerSchema = lazyZodSchema(() => z.object({
  kind: z.literal('schedule'),
  schedule: AutomationScheduleSchema,
}).strict());
export type AutomationScheduleTrigger = z.infer<typeof AutomationScheduleTriggerSchema>;

export const AutomationScheduleTriggerInputSchema = lazyZodSchema(() => AutomationScheduleTriggerSchema.extend({
  enabled: z.boolean(),
}).strict());
export type AutomationScheduleTriggerInput = z.infer<typeof AutomationScheduleTriggerInputSchema>;

export const AutomationSessionLifecycleTriggerSchema =
  lazyZodSchema(() => AutomationSessionLifecycleConfigurationSchema.extend({
    kind: z.literal('sessionLifecycle'),
  }).strict());
export type AutomationSessionLifecycleTrigger = z.infer<
  typeof AutomationSessionLifecycleTriggerSchema
>;

export const AutomationSessionLifecycleTriggerInputSchema =
  lazyZodSchema(() => AutomationSessionLifecycleTriggerSchema.extend({ enabled: z.boolean() }).strict());
export type AutomationSessionLifecycleTriggerInput = z.infer<
  typeof AutomationSessionLifecycleTriggerInputSchema
>;

/** Stable exact-turn registration refusals derived by the Session owner. */
export const AutomationSessionLifecycleRegistrationErrorCodeSchema = lazyZodSchema(() => z.enum([
  'sourceSessionUnavailable',
  'sourceTurnNotCurrent',
  'sourceTurnUnavailable',
  'sourceTurnNotInProgress',
  'executionTargetInequalityUnproven',
  'sourceMatchesExecutionTarget',
  'session_already_started',
]));
export type AutomationSessionLifecycleRegistrationErrorCode = z.infer<
  typeof AutomationSessionLifecycleRegistrationErrorCodeSchema
>;

export const AutomationPluginEventObservationTransportInputSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
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
]));
export type AutomationPluginEventObservationTransportInput = z.infer<
  typeof AutomationPluginEventObservationTransportInputSchema
>;

export const AutomationPluginEventDefinitionTriggerSchema = lazyZodSchema(() => z.object({
  kind: z.literal('pluginEvent'),
  eventRef: asProtocolZod(AutomationQualifiedPluginContributionRefV1Schema),
  sourceInstanceId: AutomationEventSourceInstanceIdV1Schema,
  sourceContractVersion: AutomationEventPositiveSafeIntegerV1Schema,
  sourceConfig: asProtocolZod(AutomationEventSourceConfigV1Schema),
  displayLabel: AutomationEventSourceDisplayLabelV1Schema,
  observationTransport: AutomationPluginEventObservationTransportInputSchema,
  filter: AutomationEventFilterV1Schema.nullable(),
  maximumObservationAgeMs: z.number().int().nonnegative().safe().nullable(),
}).strict());
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

/** The private PR selector shared by comment and failed-check triggers. */
export const AutomationPullRequestTriggerSchema = lazyZodSchema(() => z.object({
  kind: z.enum(['prComment', 'ciFailed']),
  pullRequest: z.object({
    repository: z.string().min(1),
    number: z.number().int().positive().safe(),
  }).strict(),
}).strict());
export type AutomationPullRequestTrigger = z.infer<typeof AutomationPullRequestTriggerSchema>;

export const AutomationPullRequestEncryptedTriggerSchema = lazyZodSchema(() => z.object({
  kind: z.enum(['prComment', 'ciFailed']),
  triggerDefinitionEnvelope: AutomationEncryptedTriggerDefinitionEnvelopeV1Schema,
}).strict());

export const AutomationPullRequestTriggerInputSchema = lazyZodSchema(() => z.union([
  AutomationPullRequestTriggerSchema.extend({ enabled: z.boolean() }).strict(),
  AutomationPullRequestEncryptedTriggerSchema.extend({ enabled: z.boolean() }).strict(),
]));
export type AutomationPullRequestTriggerInput = z.infer<typeof AutomationPullRequestTriggerInputSchema>;

/**
 * Ciphertext-blind Event authoring arm. Public routing/currentness facts remain
 * on AutomationTrigger; the exact private definition is sealed to the
 * client-chosen Automation/trigger identity and revision in the canonical
 * stored-content envelope.
 */
export const AutomationPluginEventEncryptedDefinitionTriggerSchema = lazyZodSchema(() => z.object({
  kind: z.literal('pluginEvent'),
  eventRef: asProtocolZod(AutomationQualifiedPluginContributionRefV1Schema),
  sourceSelectorId: AutomationSourceSelectorIdV1Schema,
  sourceContractVersion: AutomationEventPositiveSafeIntegerV1Schema,
  observationTransport: AutomationPluginEventObservationTransportInputSchema,
  triggerDefinitionEnvelope: AutomationEncryptedTriggerDefinitionEnvelopeV1Schema,
}).strict());
export type AutomationPluginEventEncryptedDefinitionTrigger = z.infer<
  typeof AutomationPluginEventEncryptedDefinitionTriggerSchema
>;

export const AutomationPluginEventDefinitionTriggerInputSchema =
  lazyZodSchema(() => z.union([
    AutomationPluginEventDefinitionTriggerSchema.extend({ enabled: z.boolean() }).strict(),
    AutomationPluginEventEncryptedDefinitionTriggerSchema.extend({ enabled: z.boolean() }).strict(),
  ]));
export type AutomationPluginEventDefinitionTriggerInput = z.infer<
  typeof AutomationPluginEventDefinitionTriggerInputSchema
>;

export const AutomationTriggerDefinitionSchema = lazyZodSchema(() => z.union([
  AutomationScheduleTriggerSchema,
  AutomationPluginEventDefinitionTriggerSchema,
  AutomationPluginEventEncryptedDefinitionTriggerSchema,
  AutomationSessionLifecycleTriggerSchema,
  AutomationRunLifecycleTriggerSchema,
  AutomationPullRequestTriggerSchema,
  AutomationPullRequestEncryptedTriggerSchema,
]));
export type AutomationTriggerDefinition = z.infer<typeof AutomationTriggerDefinitionSchema>;

export const AutomationTriggerDefinitionInputSchema = lazyZodSchema(() => z.union([
  AutomationScheduleTriggerInputSchema,
  AutomationPluginEventDefinitionTriggerInputSchema,
  AutomationSessionLifecycleTriggerInputSchema,
  AutomationRunLifecycleTriggerInputSchema,
  AutomationPullRequestTriggerInputSchema,
]));
export type AutomationTriggerDefinitionInput = z.infer<
  typeof AutomationTriggerDefinitionInputSchema
>;
