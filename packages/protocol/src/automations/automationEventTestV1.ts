import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { AutomationPluginEventDefinitionTriggerSchema } from './automationTriggerDefinition.js';
import { AutomationEventPayloadV1Schema } from './automationEventJsonBoundsV1.js';
import { AutomationOccurredAtV1Schema } from './automationOccurredAtV1.js';
import { evaluateAutomationEventFilterV1, isAutomationEventObservationFreshV1 } from './automationEventV1.js';

const DiagnosticSourceV1Schema = lazyZodSchema(() => z.pick(AutomationPluginEventDefinitionTriggerSchema, {
  eventRef: true, sourceInstanceId: true, sourceContractVersion: true,
}));
export const AutomationEventTestInputV1Schema = lazyZodSchema(() => z.strictObject({
  trigger: z.nullable((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(DiagnosticSourceV1Schema, {
    filter: AutomationPluginEventDefinitionTriggerSchema.shape.filter,
    maximumObservationAgeMs: AutomationPluginEventDefinitionTriggerSchema.shape.maximumObservationAgeMs,
  }))),
  observation: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(DiagnosticSourceV1Schema, {
    occurredAt: AutomationOccurredAtV1Schema,
    observationReceivedAt: z.number().check(z.int(), z.nonnegative(), z.int()),
    payload: asProtocolZod(AutomationEventPayloadV1Schema),
  })),
}));
export const AutomationEventTestResultV1Schema = lazyZodSchema(() => z.strictObject({
  result: z.enum(['matched', 'noMatch', 'sourceMismatch', 'tooOld', 'invalid']),
}));
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
