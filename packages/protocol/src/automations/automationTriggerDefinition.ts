import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { AutomationPullRequestTriggerSchema } from './pullRequestTrigger.js';
export { AutomationPullRequestTriggerSchema } from './pullRequestTrigger.js';
export type { AutomationPullRequestTrigger } from './pullRequestTrigger.js';

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
import { AutomationDefinitionDisplayV1Schema } from './automationDefinitionDisplayV1.js';
import {
  ENCRYPTED_STORED_CONTENT_SCHEMA,
  addAutomationStoredEnvelopeUtf8LimitIssue,
} from './automationStoredContentEnvelopeV1.js';
import { AUTOMATION_SESSION_LIFECYCLE_EVENT_GROUPS_V1, AutomationSessionLifecycleConfigurationSchema, AutomationSessionLifecycleEventSchema, type AutomationSessionLifecycleEvent } from './automationSessionLifecycle.js';
import { FOLLOW_EVENT_KINDS_V1, type FollowEventKindV1 } from '../sessions/follow/sessionFollowPolicyV1.js';
import { SessionPersonalEventKindV1Schema, resolveSessionPersonalFollowEventV1, type SessionPersonalEventKindV1 } from '../sessions/personal/eventEligibility.js';
import { AutomationRunLifecycleTriggerSchema, AutomationRunLifecycleTriggerInputSchema } from './automationRunLifecycle.js';
import { AutomationActionTriggerSchema, AutomationActionEncryptedTriggerSchema, AutomationActionConsentTriggerSchema, AutomationActionTriggerInputSchema } from './automationActionTriggerV1.js';
export * from './automationActionTriggerV1.js';
export * from './automationRunLifecycle.js';

import { AutomationScheduleSchema } from './automationSchedule.js';
export { AutomationOnceScheduleSchema } from './automationSchedule.js';

export const AutomationScheduleTriggerSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('schedule'),
  schedule: AutomationScheduleSchema,
}));
export type AutomationScheduleTrigger = z.infer<typeof AutomationScheduleTriggerSchema>;

export const AutomationScheduleTriggerInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationScheduleTriggerSchema, {
  enabled: z.boolean(),
})));
export type AutomationScheduleTriggerInput = z.infer<typeof AutomationScheduleTriggerInputSchema>;

export const AutomationSessionLifecycleTriggerSchema =
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationSessionLifecycleConfigurationSchema, {
    kind: z.literal('sessionLifecycle'),
  })));
export type AutomationSessionLifecycleTrigger = z.infer<
  typeof AutomationSessionLifecycleTriggerSchema
>;

export const AutomationSessionLifecycleTriggerInputSchema =
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationSessionLifecycleTriggerSchema, { enabled: z.boolean() })));
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
  z.strictObject({
    kind: z.literal('checkpointedPull'),
    watcherMaterializationRef: PluginMachineMaterializationRefV1Schema,
  }),
  z.strictObject({
    kind: z.literal('socket'),
    /** The exact plugin materialization hosting the provider's observation session. */
    watcherMaterializationRef: PluginMachineMaterializationRefV1Schema,
  }),
  z.strictObject({
    kind: z.literal('durablePush'),
    webhookEndpointId: PluginWebhookEndpointIdV1Schema,
    endpointMaterializationRef: PluginMachineMaterializationRefV1Schema,
    webhookRoutingSourceInstanceId: AutomationEventSourceInstanceIdV1Schema,
    setup: PluginWebhookEndpointSetupV1Schema,
  }),
]));
export type AutomationPluginEventObservationTransportInput = z.infer<
  typeof AutomationPluginEventObservationTransportInputSchema
>;

export const AutomationPluginEventDefinitionTriggerSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('pluginEvent'),
  /** Account-private Automation label carried by the incumbent Event definition envelope. */
  automationDisplay: z.optional(AutomationDefinitionDisplayV1Schema),
  eventRef: asProtocolZod(AutomationQualifiedPluginContributionRefV1Schema),
  sourceInstanceId: AutomationEventSourceInstanceIdV1Schema,
  sourceContractVersion: AutomationEventPositiveSafeIntegerV1Schema,
  sourceConfig: asProtocolZod(AutomationEventSourceConfigV1Schema),
  displayLabel: AutomationEventSourceDisplayLabelV1Schema,
  observationTransport: AutomationPluginEventObservationTransportInputSchema,
  filter: z.nullable(AutomationEventFilterV1Schema),
  maximumObservationAgeMs: z.nullable(z.number().check(z.int(), z.nonnegative(), z.int())),
}));
export type AutomationPluginEventDefinitionTrigger = z.infer<
  typeof AutomationPluginEventDefinitionTriggerSchema
>;

export const AutomationEncryptedTriggerDefinitionEnvelopeV1Schema =
  ENCRYPTED_STORED_CONTENT_SCHEMA.check(z.superRefine((value, context) => {
    addAutomationStoredEnvelopeUtf8LimitIssue(
      value,
      context,
      'Stored Automation envelope exceeds its UTF-8 byte limit',
    );
  }));
export type AutomationEncryptedTriggerDefinitionEnvelopeV1 = z.infer<
  typeof AutomationEncryptedTriggerDefinitionEnvelopeV1Schema
>;

export const AutomationPullRequestEncryptedTriggerSchema = lazyZodSchema(() => z.strictObject({
  kind: z.enum(['prComment', 'ciFailed']),
  triggerDefinitionEnvelope: AutomationEncryptedTriggerDefinitionEnvelopeV1Schema,
}));

export const AutomationPullRequestTriggerInputSchema = lazyZodSchema(() => z.union([
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationPullRequestTriggerSchema, { enabled: z.boolean() })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationPullRequestEncryptedTriggerSchema, { enabled: z.boolean() })),
]));
export type AutomationPullRequestTriggerInput = z.infer<typeof AutomationPullRequestTriggerInputSchema>;

/**
 * Ciphertext-blind Event authoring arm. Public routing/currentness facts remain
 * on AutomationTrigger; the exact private definition is sealed to the
 * client-chosen Automation/trigger identity and revision in the canonical
 * stored-content envelope.
 */
export const AutomationPluginEventEncryptedDefinitionTriggerSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('pluginEvent'),
  eventRef: asProtocolZod(AutomationQualifiedPluginContributionRefV1Schema),
  sourceSelectorId: AutomationSourceSelectorIdV1Schema,
  sourceContractVersion: AutomationEventPositiveSafeIntegerV1Schema,
  observationTransport: AutomationPluginEventObservationTransportInputSchema,
  triggerDefinitionEnvelope: AutomationEncryptedTriggerDefinitionEnvelopeV1Schema,
}));
export type AutomationPluginEventEncryptedDefinitionTrigger = z.infer<
  typeof AutomationPluginEventEncryptedDefinitionTriggerSchema
>;

export const AutomationPluginEventDefinitionTriggerInputSchema =
  lazyZodSchema(() => z.union([
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationPluginEventDefinitionTriggerSchema, { enabled: z.boolean() })),
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationPluginEventEncryptedDefinitionTriggerSchema, { enabled: z.boolean() })),
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
  AutomationActionTriggerSchema,
  AutomationActionEncryptedTriggerSchema,
  AutomationActionConsentTriggerSchema,
]));
export type AutomationTriggerDefinition = z.infer<typeof AutomationTriggerDefinitionSchema>;

export const AutomationTriggerDefinitionInputSchema = lazyZodSchema(() => z.union([
  AutomationScheduleTriggerInputSchema,
  AutomationPluginEventDefinitionTriggerInputSchema,
  AutomationSessionLifecycleTriggerInputSchema,
  AutomationRunLifecycleTriggerInputSchema,
  AutomationPullRequestTriggerInputSchema,
  AutomationActionTriggerInputSchema,
]));
export type AutomationTriggerDefinitionInput = z.infer<
  typeof AutomationTriggerDefinitionInputSchema
>;

/** Picker vocabulary only. Execution remains with each existing source schema. */
export type FollowEventConditionV1 = Readonly<{
  kind: FollowEventKindV1 | Extract<AutomationSessionLifecycleEvent, 'sessionStarted' | 'sessionArchived'>
    | Exclude<AutomationTriggerDefinition['kind'], 'sessionLifecycle'>;
}>;
export type FollowEventConditionChoiceV1 = Readonly<{
  condition: FollowEventConditionV1;
  followEligible: boolean;
  lifecycleEvents?: readonly AutomationSessionLifecycleEvent[];
  personalEvents?: readonly SessionPersonalEventKindV1[];
}>;

/** Shared Follow/Custom/rule/Habit choices, filtered by the actual caller/source. */
export function projectFollowEventConditionPickerV1(input: Readonly<{
  usage: 'follow' | 'habit';
  supportedFollowEvents?: readonly FollowEventKindV1[];
  supportedTriggerKinds?: readonly AutomationTriggerDefinition['kind'][];
}>): readonly FollowEventConditionChoiceV1[] {
  const lifecycle: Partial<Record<FollowEventKindV1, readonly AutomationSessionLifecycleEvent[]>> = {
    needs_you: AUTOMATION_SESSION_LIFECYCLE_EVENT_GROUPS_V1.needsYou,
    finished: [AUTOMATION_SESSION_LIFECYCLE_EVENT_GROUPS_V1.turnEnds[0]],
    failed_or_stopped: AUTOMATION_SESSION_LIFECYCLE_EVENT_GROUPS_V1.turnEnds.slice(1),
  };
  const follows = FOLLOW_EVENT_KINDS_V1.filter(kind => !input.supportedFollowEvents || input.supportedFollowEvents.includes(kind))
    .flatMap((kind): FollowEventConditionChoiceV1[] => {
      const events = lifecycle[kind];
      if (input.usage === 'habit' && (!events || input.supportedTriggerKinds && !input.supportedTriggerKinds.includes('sessionLifecycle'))) return [];
      const personalEvents = SessionPersonalEventKindV1Schema.options.filter(event => resolveSessionPersonalFollowEventV1(event)?.kind === kind);
      return [{ condition: { kind }, followEligible: true, ...(events ? { lifecycleEvents: events } : {}),
        ...(personalEvents.length ? { personalEvents } : {}) }];
    });
  if (input.usage === 'follow') return follows;
  const lifecycleOnly = AutomationSessionLifecycleEventSchema.options
    .filter(event => event === 'sessionStarted' || event === 'sessionArchived')
    .flatMap((event): FollowEventConditionChoiceV1[] => input.supportedTriggerKinds && !input.supportedTriggerKinds.includes('sessionLifecycle')
      ? [] : [{ condition: { kind: event }, followEligible: false, lifecycleEvents: [event] }]);
  const otherKinds = ['schedule', 'pluginEvent', 'prComment', 'ciFailed', 'runLifecycle'] as const satisfies readonly AutomationTriggerDefinition['kind'][];
  return [...follows, ...lifecycleOnly, ...otherKinds.filter(kind => !input.supportedTriggerKinds || input.supportedTriggerKinds.includes(kind))
    .map(kind => ({ condition: { kind }, followEligible: false }))];
}
