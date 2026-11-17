import { findActionSpec, isActionEffectHookableV1 } from '../actionSpecs.js';
import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { evaluateAutomationEventFilterV1 } from '../../automations/automationEventV1.js';
import { automationSubjectKeyV1, automationSubjectMatchesV1,
  type AutomationSubjectContextV1 } from '../../automations/automationSubjectV1.js';
import { AutomationActionOccurrenceEvidenceV1Schema,
  type AutomationActionOccurrenceEvidenceV1 } from '../../automations/automationActionOccurrenceV1.js';
import type { AutomationActionTrigger } from '../../automations/automationActionTriggerV1.js';
import type { PluginEventAutomationDeclarationV1 } from '../../automations/automationEventDeclarationV1.js';

export type ActionAutomationCompletionObservationV1 = Readonly<{
  eventRef: Readonly<{ pluginId: string; localId: string }>;
  sourceInstanceId: string;
  occurrenceId: string;
  occurredAt: number;
  subjectContexts?: readonly AutomationSubjectContextV1[];
  machineId?: string;
  originRunId?: string;
}>;

/** R25: one Action row consumes the producer's terminal Events, without creating another Event. */
export function matchActionAutomationCompletionV1(input: Readonly<{
  trigger: AutomationActionTrigger;
  declaration: Pick<PluginEventAutomationDeclarationV1, 'completesActionIds' | 'completionOutcome'>;
  observation: ActionAutomationCompletionObservationV1;
}>): readonly AutomationActionOccurrenceEvidenceV1[] {
  const { trigger, declaration, observation } = input;
  const subjects = observation.subjectContexts ?? [];
  if (trigger.phase !== 'after' || declaration.completionOutcome === undefined
    || !automationSubjectMatchesV1(trigger.subject, subjects)) return [];
  const outcome = declaration.completionOutcome;
  // The producer occurrence remains the identity. Receipt timestamps can change on replay.
  const requestId = createCanonicalJsonSigningInput([
    observation.eventRef, observation.sourceInstanceId, observation.occurrenceId,
  ]);
  return [...new Set(declaration.completesActionIds ?? [])].flatMap(actionId => {
    if (!trigger.actionIds.includes(actionId)) return [];
    const spec = findActionSpec(actionId);
    if (!spec?.completion || !isActionEffectHookableV1(spec.sideEffectClass)) return [];
    const evidence = AutomationActionOccurrenceEvidenceV1Schema.parse({
      v: 1, kind: 'action', actionId, requestId, phase: 'after', outcome,
      status: outcome === 'succeeded' ? 'succeeded' : 'failed', occurredAt: observation.occurredAt,
      ...(observation.machineId === undefined ? {} : { machineId: observation.machineId }),
      ...(observation.originRunId === undefined ? {} : { originRunId: observation.originRunId }),
      subjects: subjects.map(({ role, subject }) => ({ role, kind: subject.kind, key: automationSubjectKeyV1(subject) })),
    });
    return evaluateAutomationEventFilterV1(trigger.filter ?? null, evidence) ? [evidence] : [];
  });
}
