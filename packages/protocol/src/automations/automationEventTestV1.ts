import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { AutomationPluginEventDefinitionTriggerSchema } from './automationTriggerDefinition.js';
import { AutomationEventPayloadV1Schema } from './automationEventJsonBoundsV1.js';
import { AutomationOccurredAtV1Schema } from './automationOccurredAtV1.js';
import { evaluateAutomationEventFilterV1, isAutomationEventObservationFreshV1 } from './automationEventV1.js';

const DiagnosticSourceV1Schema = lazyZodSchema(() => AutomationPluginEventDefinitionTriggerSchema.pick({
  eventRef: true, sourceInstanceId: true, sourceContractVersion: true,
}));
export const AutomationEventTestInputV1Schema = lazyZodSchema(() => z.object({
  trigger: DiagnosticSourceV1Schema.extend({
    filter: AutomationPluginEventDefinitionTriggerSchema.shape.filter,
    maximumObservationAgeMs: AutomationPluginEventDefinitionTriggerSchema.shape.maximumObservationAgeMs,
  }).strict().nullable(),
  observation: DiagnosticSourceV1Schema.extend({
    occurredAt: AutomationOccurredAtV1Schema,
    observationReceivedAt: z.number().int().nonnegative().safe(),
    payload: asProtocolZod(AutomationEventPayloadV1Schema),
  }).strict(),
}).strict());
export const AutomationEventTestResultV1Schema = lazyZodSchema(() => z.object({
  result: z.enum(['matched', 'noMatch', 'sourceMismatch', 'tooOld', 'invalid']),
}).strict());
export type AutomationEventTestInputV1 = z.infer<typeof AutomationEventTestInputV1Schema>;
export type AutomationEventTestResultV1 = z.infer<typeof AutomationEventTestResultV1Schema>;

/** A diagnostic over supplied facts; it grants no occurrence or admission custody. */
export function testAutomationEventV1({ trigger, observation }: AutomationEventTestInputV1): AutomationEventTestResultV1 {
  if (trigger === null) return { result: 'invalid' };
  if (trigger.eventRef.pluginId !== observation.eventRef.pluginId
    || trigger.eventRef.localId !== observation.eventRef.localId
    || trigger.sourceInstanceId !== observation.sourceInstanceId
    || trigger.sourceContractVersion !== observation.sourceContractVersion) return { result: 'sourceMismatch' };
  if (!isAutomationEventObservationFreshV1({ ...observation, maximumObservationAgeMs: trigger.maximumObservationAgeMs })) {
    return { result: 'tooOld' };
  }
  return { result: evaluateAutomationEventFilterV1(trigger.filter, observation.payload) ? 'matched' : 'noMatch' };
}
