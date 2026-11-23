import { matchActionAutomationTriggersV1, projectActionAutomationAdmitOutcomesV1, type ActionAutomationPortV1,
  type ActionAutomationSelectionV1, type ActionAutomationSelectedTriggerV1,
  type ActionAutomationTriggerReferenceV1 } from '@happier-dev/protocol/actions/executor/actionAutomationAdmission';
import { matchActionAutomationCompletionV1, type ActionAutomationCompletionObservationV1 } from '@happier-dev/protocol/actions/executor/actionAutomationCompletion';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { AutomationActionOccurrenceEvidenceV1 } from '@happier-dev/protocol/automations/automationActionOccurrenceV1';
import type { PluginEventAutomationDeclarationV1 } from '@happier-dev/protocol/automations/automationEventDeclarationV1';
import type { ActionAutomationNoticeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

export type NativeActionCompletionHost = Readonly<{
  port: ActionAutomationPortV1;
  resolveDeclaration(eventRef: ActionAutomationCompletionObservationV1['eventRef']): Promise<Pick<PluginEventAutomationDeclarationV1, 'completesActionIds' | 'completionOutcome'> | null>;
}>;

/** Private matching extends the existing Action index and occurrence admission owners. */
export async function admitNativeActionCompletion(host: NativeActionCompletionHost,
  observation: ActionAutomationCompletionObservationV1, context: ActionExecutorContext): Promise<readonly ActionAutomationNoticeV1[]> {
  const declaration = await host.resolveDeclaration(observation.eventRef);
  if (!declaration?.completionOutcome || !declaration.completesActionIds?.length) return [];
  const admit = host.port.admitOccurrence;
  if (!admit) throw new Error('automation_action_admission_unavailable');
  const selections = new Map<string, ActionAutomationSelectionV1>();
  const notices: ActionAutomationNoticeV1[] = [];
  for (const actionId of new Set(declaration.completesActionIds)) {
    const selection = await host.port.select({ actionId, input: {}, context,
      subjects: observation.subjectContexts, signal: context.signal, deferPrivateMatching: true, includeBefore: false });
    if (selection.status !== 'ready') throw new Error('automation_action_index_unavailable');
    notices.push(...selection.notices ?? []);
    selections.set(actionId, selection);
  }
  const combined: ActionAutomationSelectionV1 = { status: 'ready', subjects: observation.subjectContexts ?? [], before: [],
    after: [...selections.values()].flatMap(selection => selection.after) };
  const privateMatching = combined.after.length ? await host.port.prepareMatching?.(combined, context) : undefined;
  const admitted: { row: ActionAutomationSelectedTriggerV1; trigger: ActionAutomationTriggerReferenceV1;
    evidence: AutomationActionOccurrenceEvidenceV1 }[] = [];
  for (const [actionId, selection] of selections) {
    for (const selected of selection.after) {
      // Shared checks use the actor's existing consent row, as ordinary Action admission does.
      const reference = selected.consent ? selected.consent.status === 'current' ? selected.consent.row : undefined : selected;
      if (!reference) continue;
      const [completion] = matchActionAutomationCompletionV1({ trigger: { kind: 'action', phase: 'after',
        actionIds: selected.actionIds, ...(selected.subject ? { subject: selected.subject } : {}) },
        declaration: { ...declaration, completesActionIds: [actionId] }, observation });
      if (!completion) continue;
      const privateMatch = await matchActionAutomationTriggersV1({ ...selection, privateMatching }, completion, [selected]);
      notices.push(...privateMatch.notices);
      if (!privateMatch.matched.length) continue;
      admitted.push({ row: selected, trigger: reference, evidence: completion });
    }
  }
  const evidence = admitted[0]?.evidence;
  if (evidence) {
    const response = await admit({ evidence, triggers: admitted.map(({ trigger, evidence: match }) => ({
      automationId: trigger.automationId, triggerId: trigger.triggerId, triggerRevision: trigger.triggerRevision,
      ...(match.actionId === evidence.actionId ? {} : { actionId: match.actionId }),
    })) }, context);
    notices.push(...projectActionAutomationAdmitOutcomesV1(response, admitted).notices);
  }
  return notices;
}
