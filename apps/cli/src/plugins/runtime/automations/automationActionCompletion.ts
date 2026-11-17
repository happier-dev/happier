import type { ActionAutomationPortV1 } from '@happier-dev/protocol/actions/executor/actionAutomationAdmission';
import { matchActionAutomationCompletionV1, type ActionAutomationCompletionObservationV1 } from '@happier-dev/protocol/actions/executor/actionAutomationCompletion';
import { readAccountStoredActionTriggerV1 } from '@happier-dev/protocol/actions/executor/workflowTriggerAccountHost';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { PluginEventAutomationDeclarationV1 } from '@happier-dev/protocol/automations/automationEventDeclarationV1';

export type NativeActionCompletionHost = Readonly<{
  port: ActionAutomationPortV1;
  resolveDeclaration(eventRef: ActionAutomationCompletionObservationV1['eventRef']): Promise<Pick<PluginEventAutomationDeclarationV1, 'completesActionIds' | 'completionOutcome'> | null>;
  readDefinition(automationId: string): Promise<Parameters<typeof readAccountStoredActionTriggerV1>[0] | null>;
  resolveEncryption(): Promise<Parameters<typeof readAccountStoredActionTriggerV1>[2]>;
}>;

/** Private matching extends the existing Action index and occurrence admission owners. */
export async function admitNativeActionCompletion(host: NativeActionCompletionHost,
  observation: ActionAutomationCompletionObservationV1, context: ActionExecutorContext): Promise<void> {
  const declaration = await host.resolveDeclaration(observation.eventRef);
  if (!declaration?.completionOutcome || !declaration.completesActionIds?.length) return;
  const admit = host.port.admitOccurrence;
  if (!admit) throw new Error('automation_action_admission_unavailable');
  let encryption: Awaited<ReturnType<NativeActionCompletionHost['resolveEncryption']>> | undefined;
  const definitions = new Map<string, Awaited<ReturnType<NativeActionCompletionHost['readDefinition']>>>();
  for (const actionId of new Set(declaration.completesActionIds)) {
    const selection = await host.port.select({ actionId, input: {}, context,
      subjects: observation.subjectContexts, signal: context.signal });
    if (selection.status !== 'ready') throw new Error('automation_action_index_unavailable');
    for (const selected of selection.after) {
      // Shared checks use the actor's existing consent row, as ordinary Action admission does.
      const reference = selected.consent ? selected.consent.status === 'current' ? selected.consent.row : undefined : selected;
      if (!reference) continue;
      if (!definitions.has(selected.automationId)) definitions.set(selected.automationId, await host.readDefinition(selected.automationId));
      const row = definitions.get(selected.automationId);
      if (!row) throw new Error('automation_action_definition_unavailable');
      encryption ??= await host.resolveEncryption();
      const opened = readAccountStoredActionTriggerV1(row, selected.triggerId, encryption);
      if (opened.trigger.revision !== selected.triggerRevision) continue;
      for (const evidence of matchActionAutomationCompletionV1({ trigger: opened.definition,
        declaration: { ...declaration, completesActionIds: [actionId] }, observation })) {
        await admit({ evidence, triggers: [{ automationId: reference.automationId,
          triggerId: reference.triggerId, triggerRevision: reference.triggerRevision }] }, context);
      }
    }
  }
}
