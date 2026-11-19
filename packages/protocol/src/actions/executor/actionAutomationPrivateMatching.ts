import { evaluateAutomationEventFilterV1 } from '../../automations/automationEventV1.js';
import type { AutomationDefinitionDetail } from '../../automations/automationApiV3.js';
import type { AutomationActionTrigger } from '../../automations/automationActionTriggerV1.js';
import { readActionErrorCodeV1 } from '../actionErrorClassV1.js';
import type { ActionAutomationNoticeV1 } from '../actionExecutionResult.js';
import type { ActionAutomationPrepareMatchingV1, ActionAutomationSelectedTriggerV1 } from './actionAutomationAdmission.js';
import type { WorkflowTriggerActionsDependencies } from './workflowTriggerActions.js';
import type { ActionExecutorContext } from './types.js';

/** Selected sources open once per invocation through their Account or shared Workflow owner. */
export function createActionAutomationPrivateMatchingV1(options: Readonly<{
  accountId: string;
  readDefinition(automationId: string, context: ActionExecutorContext): Promise<AutomationDefinitionDetail | null>;
  openTrigger: NonNullable<WorkflowTriggerActionsDependencies['openActionTrigger']>;
  readSharedDefinition?: NonNullable<WorkflowTriggerActionsDependencies['openSharedActionTrigger']>;
}>): ActionAutomationPrepareMatchingV1 {
  return async (selection, context) => {
    type Source = Readonly<{ row: AutomationDefinitionDetail }> | Readonly<{ reason: string }>;
    type Opened = Readonly<{ trigger: AutomationActionTrigger }> | Readonly<{ reason: string }>;
    const key = (row: ActionAutomationSelectedTriggerV1) => JSON.stringify([row.automationId, row.triggerId, row.triggerRevision]);
    const references = [...new Map([...selection.before, ...selection.after].map(row => [key(row), row])).values()];
    const sources = new Map(await Promise.all([...new Set(references
      .filter(row => row.ownerAccountId === options.accountId).map(row => row.automationId))]
      .map(async (automationId): Promise<readonly [string, Source]> => {
        try {
          const row = await options.readDefinition(automationId, context);
          return [automationId, row ? { row } : { reason: 'content_unavailable' }];
        } catch (error) {
          return [automationId, { reason: readActionErrorCodeV1(error) ?? 'action_failed' }];
        }
      })));
    const definitions = new Map(await Promise.all(references.map(async (reference): Promise<readonly [string, Opened]> => {
      if (reference.ownerAccountId !== options.accountId) {
        if (!options.readSharedDefinition) return [key(reference), { reason: 'content_unavailable' }];
        try { return [key(reference), { trigger: await options.readSharedDefinition(reference, context) }]; }
        catch (error) { return [key(reference), { reason: readActionErrorCodeV1(error) ?? 'action_failed' }]; }
      }
      const source = sources.get(reference.automationId)!;
      if ('reason' in source) return [key(reference), source];
      const retained = source.row.enabled ? source.row.triggers.find(trigger => trigger.id === reference.triggerId
        && trigger.revision === reference.triggerRevision && trigger.enabled) : undefined;
      if (!retained || retained.kind !== 'action' || 'consentFor' in retained) return [key(reference), { reason: 'content_unavailable' }];
      try { return [key(reference), { trigger: await options.openTrigger(source.row, retained) }]; }
      catch (error) { return [key(reference), { reason: readActionErrorCodeV1(error) ?? 'action_failed' }]; }
    })));
    return async (evidence, selected) => {
      const matched: ActionAutomationSelectedTriggerV1[] = [];
      const notices: ActionAutomationNoticeV1[] = [];
      for (const row of selected) {
        const value = definitions.get(key(row));
        const trigger = value && 'trigger' in value ? value.trigger : undefined;
        if (!trigger) {
          notices.push({ code: 'action_automation_skipped', reason: value && 'reason' in value ? value.reason : 'content_unavailable',
          automationId: row.automationId, triggerId: row.triggerId, workflowId: row.workflowId });
          continue;
        }
        if (trigger.phase === evidence.phase && trigger.actionIds.includes(evidence.actionId)
          && evaluateAutomationEventFilterV1(trigger.filter ?? null, evidence)) matched.push(row);
      }
      return { matched, notices };
    };
  };
}
