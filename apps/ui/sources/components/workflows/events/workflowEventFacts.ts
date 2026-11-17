import type { AutomationTriggerDefinitionInput } from '@happier-dev/protocol/automations/automationTriggerDefinition';

import type { WorkflowActivityLiveFact } from '@/sync/domains/workflows/workflowActivityTypes';
import {
  buildTriggerDefinition,
  createDefaultWhen,
  type TriggerWhenValue,
} from '@/components/workflows/triggers/sessionTriggerForm';

/** The Events filter chips, in order: everything, then one chip per kind of fact the feed carries. */
export const WORKFLOW_EVENT_FILTERS = [
  'all',
  'session',
  'machine',
  'run',
] as const;
export type WorkflowEventFilter = (typeof WORKFLOW_EVENT_FILTERS)[number];

export function matchesWorkflowEventFilter(
  fact: WorkflowActivityLiveFact,
  filter: WorkflowEventFilter,
): boolean {
  return filter === 'all' || fact.kind === filter;
}

/**
 * The trigger a fact can start: the Sessions start the trigger owner already authors ("A session starts", "A
 * turn starts", "A session is archived"), in any Session. Machine and Run facts have no authorable start yet,
 * so they read as facts only and offer no Automate or Add.
 */
export function readWorkflowEventWhen(
  fact: WorkflowActivityLiveFact,
): TriggerWhenValue | null {
  if (fact.kind !== 'session') return null;
  switch (fact.event) {
    case 'started':
      return createDefaultWhen('sessionStarts');
    case 'turn_started':
      return createDefaultWhen('turnStarts');
    case 'archived':
      return createDefaultWhen('sessionArchived');
  }
}

export function readWorkflowEventTrigger(
  fact: WorkflowActivityLiveFact,
): AutomationTriggerDefinitionInput | null {
  const when = readWorkflowEventWhen(fact);
  return when === null
    ? null
    : buildTriggerDefinition({ when, enabled: true, sessionId: null });
}
