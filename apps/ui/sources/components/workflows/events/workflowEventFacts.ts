import type { AutomationTriggerDefinitionInput } from '@happier-dev/protocol/automations/automationTriggerDefinition';
import { deriveAutomationOccurrenceKeyV1, type AutomationTriggerOccurrenceEvidenceV1 } from '@happier-dev/protocol/automations/automationOccurrenceV1';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';

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
 * turn starts", "A session is archived"), in any Session. Run facts use the existing exact-source lifecycle
 * trigger. Machine facts need declaration-owned setup before they can become a configured trigger.
 */
export function readWorkflowEventWhen(
  fact: WorkflowActivityLiveFact,
): TriggerWhenValue | null {
  if (fact.kind === 'run') return { kind: 'runLifecycle',
    source: { kind: 'workflow_run', runId: fact.runId }, condition: fact.event };
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

/** The occurrence owner decides identity; timestamps are never proximity joins. */
function readWorkflowEventOccurrence(fact: WorkflowActivityLiveFact): AutomationTriggerOccurrenceEvidenceV1 | null {
  const base = { v: 1, occurredAt: fact.occurredAt } as const;
  if (fact.kind === 'run') return { ...base, kind: 'runLifecycle',
    source: { kind: 'workflow_run', runId: fact.runId }, condition: fact.event, sourceRevision: fact.sourceRevision };
  if (fact.kind !== 'session') return null;
  switch (fact.event) {
    case 'started': return { ...base, kind: 'sessionLifecycle', event: 'sessionStarted', sourceSessionId: fact.sessionId };
    case 'archived': return { ...base, kind: 'sessionLifecycle', event: 'sessionArchived', sourceSessionId: fact.sessionId };
    case 'turn_started': return { ...base, kind: 'sessionLifecycle', event: 'parentTurnStarted',
      sourceSessionId: fact.sessionId, sourceTurnId: fact.turnId };
  }
}

/** Selected-detail join over the already demanded Run page; no body reads or feed-wide matching. */
export function readWorkflowEventStartedRuns<T extends Pick<WorkflowRunSummaryV1, 'origin'>>(
  fact: WorkflowActivityLiveFact,
  runs: readonly T[],
): readonly T[] {
  const evidence = readWorkflowEventOccurrence(fact);
  if (evidence === null) return [];
  return runs.filter(run => {
    const cause = run.origin.kind === 'automation' ? run.origin.cause : undefined;
    return cause?.kind === 'trigger' && cause.occurrenceKey === deriveAutomationOccurrenceKeyV1({
      triggerId: cause.triggerId, evidence,
    });
  });
}
