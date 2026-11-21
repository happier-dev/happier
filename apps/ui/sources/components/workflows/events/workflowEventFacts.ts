import type { Dispatch, SetStateAction } from 'react';
import type { AutomationSessionLifecycleSubjectV1 } from '@happier-dev/protocol/automations/automationSessionLifecycle';
import type { AutomationTriggerDefinitionInput } from '@happier-dev/protocol/automations/automationTriggerDefinition';
import { deriveAutomationOccurrenceKeyV1, type AutomationTriggerOccurrenceEvidenceV1 } from '@happier-dev/protocol/automations/automationOccurrenceV1';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';

import type { WorkflowActivityFact } from '@/sync/domains/workflows/workflowActivityTypes';
import { t } from '@/text';
import type { WorkflowDefinitionDraftSeed } from '@/sync/domains/workflows/workflowDefinitionDraftSeed';
import type { WorkflowTriggerEventOption } from '@/components/workflows/triggers/workflowTriggerStarts';
import { resolveWorkflowProjectTargetOnMachine } from '@/components/workflows/screens/resolveContextualWorkflowTarget';
import {
  buildTriggerDefinition,
  isSessionLifecycleWhen,
  type SessionLifecycleWhen,
  type TriggerWhenValue,
} from '@/components/workflows/triggers/sessionTriggerForm';
import { formatTriggerSummary, lowerTriggerSentenceStart, readSessionLifecycleKind } from '@/components/workflows/triggers/formatTriggerSummary';
import { prepareWorkflowSentenceEditorEntry } from '@/components/workflows/authoring/workflowSentenceAuthoring';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

/** The Events filter chips, in order: everything, then one chip per kind of fact the feed carries. */
export const WORKFLOW_EVENT_FILTERS = [
  'all',
  'session',
  'machine',
  'run',
] as const;
export type WorkflowEventFilter = (typeof WORKFLOW_EVENT_FILTERS)[number];

export function buildWorkflowEventFilterTabs(counts: Readonly<Record<WorkflowEventFilter, number>>) {
  return WORKFLOW_EVENT_FILTERS.map(id => ({
    id,
    label: t(`workflows.events.filters.${id}`),
    ...(id === 'all' || counts[id] === 0 ? {} : { count: String(counts[id]) }),
  }));
}

export function matchesWorkflowEventFilter(
  fact: WorkflowActivityFact,
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
  fact: WorkflowActivityFact,
  match?: WorkflowEventMatch | null,
): TriggerWhenValue | null {
  if (fact.kind === 'run') return { kind: 'runLifecycle',
    source: fact.coverage === 'retained_cause' ? fact.evidence.source : { kind: 'workflow_run', runId: fact.runId }, condition: fact.event };
  if (fact.kind !== 'session') return null;
  const event = readSessionLifecycleEvent(fact);
  const kind = readSessionLifecycleKind([event]);
  return { kind, ...(kind === 'turnEnds' ? { events: [event] } : {}), ...(match ? { subject: match.subject } : {}) };
}

function readSessionLifecycleEvent(fact: Extract<WorkflowActivityFact, { kind: 'session' }>) {
  return fact.event === 'started' ? 'sessionStarted' : fact.event === 'archived' ? 'sessionArchived' : fact.event;
}

/** The person may narrow one event to one of its declared Session lifecycle subjects. */
export type WorkflowEventMatch = Readonly<{ subject: AutomationSessionLifecycleSubjectV1; label: string }>;
export type WorkflowEventMatchKind = AutomationSessionLifecycleSubjectV1['kind'];
export type WorkflowEventMatchPick = Readonly<{ eventKey: string; kind: WorkflowEventMatchKind }>;
export type WorkflowEventMatchSelection = Readonly<{
  pickedSubject: WorkflowEventMatchPick | null;
  setPickedSubject: Dispatch<SetStateAction<WorkflowEventMatchPick | null>>;
}>;

export function readWorkflowEventTrigger(
  fact: WorkflowActivityFact,
  match?: WorkflowEventMatch | null,
): AutomationTriggerDefinitionInput | null {
  const when = readWorkflowEventWhen(fact, match);
  return when === null
    ? null
    : buildTriggerDefinition({ when, enabled: true, sessionId: null });
}

/** The event sentence shared by rows and seeded triggers. */
export function formatWorkflowMachineEventTitle(fact: Readonly<{ event: 'online' | 'offline' }>, machineName?: string | null): string {
  return t(fact.event === 'online' ? 'workflows.events.machineOnline' : 'workflows.events.machineOffline',
    { machine: machineName ?? t('workflows.events.someMachine') });
}

/**
 * Native facts stay unconfigured until the editor's Runs-on catalog can identify their Event. With `placement`
 * (read on the person's press), a Machine fact's draft starts on that same Machine, so its catalog names the
 * pending When; the place stays editable. Without a listed Machine and folder the draft stays unplaced.
 */
export function readWorkflowEventDraftIntent(
  fact: Parameters<typeof readWorkflowEventTrigger>[0],
  placement?: Omit<Parameters<typeof resolveWorkflowProjectTargetOnMachine>[0], 'machineId'>,
  match?: WorkflowEventMatch | null,
): Pick<WorkflowDefinitionDraftSeed, 'trigger' | 'nativeEvent' | 'project'> | null {
  if (fact.kind === 'machine') {
    const project = placement === undefined ? null
      : resolveWorkflowProjectTargetOnMachine({ ...placement, machineId: fact.machineId });
    return project === null ? { nativeEvent: fact } : { nativeEvent: fact, project };
  }
  const trigger = readWorkflowEventTrigger(fact, match);
  return trigger === null ? null : { trigger };
}

/**
 * "Make a workflow from this": a new workflow in the ordinary editor that already starts on the fact (its trigger, or a
 * Machine fact's native seed on that Machine). The editor owns Save (`workflow.definition.create`).
 */
export function prepareWorkflowEventEditorEntry(
  fact: Parameters<typeof readWorkflowEventTrigger>[0],
  name: string,
  lifetime: ServerAccountScopeLifetime,
  placement?: Parameters<typeof readWorkflowEventDraftIntent>[1],
  match?: WorkflowEventMatch | null,
): ReturnType<typeof prepareWorkflowSentenceEditorEntry> {
  const seed = readWorkflowEventDraftIntent(fact, placement, match);
  return seed === null ? null : prepareWorkflowSentenceEditorEntry({ name, ...seed }, lifetime);
}

/**
 * The start "Add to a workflow…" links to a saved workflow: a Session start, which the trigger editor offers as is.
 * A Run's exact source and a Machine's native setup are authored in the editor (Make a workflow), never linked blind.
 */
export function readWorkflowEventLinkWhen(fact: WorkflowActivityFact, match?: WorkflowEventMatch | null): SessionLifecycleWhen | null {
  const when = readWorkflowEventWhen(fact, match);
  return when !== null && isSessionLifecycleWhen(when) ? when : null;
}

function readWorkflowEventStartClause(fact: WorkflowActivityFact, match: WorkflowEventMatch | null | undefined): string | null {
  const trigger = readWorkflowEventTrigger(fact);
  if (trigger === null || (trigger.kind !== 'sessionLifecycle' && trigger.kind !== 'runLifecycle')) return null;
  const useUnscopedSessionStart = fact.kind === 'session' && fact.event === 'started' && !match;
  return lowerTriggerSentenceStart(useUnscopedSessionStart
    ? t('workflows.events.whenASessionStarts') : formatTriggerSummary(trigger, { form: 'clause' }));
}

export function readWorkflowEventStartsLine(fact: WorkflowActivityFact, match: WorkflowEventMatch | null | undefined): string | null {
  const when = readWorkflowEventStartClause(fact, match);
  if (when === null) return null;
  return fact.kind === 'session' && match
    ? t('workflows.events.wouldStartInSession', { when, session: match.label })
    : t('workflows.events.wouldStart', { when });
}

export function readWorkflowEventAddsLine(fact: WorkflowActivityFact, match: WorkflowEventMatch | null | undefined): string | null {
  const when = readWorkflowEventStartClause(fact, match);
  if (when === null) return null;
  return fact.kind === 'session' && match
    ? t('workflows.events.addsInSession', { when, session: match.label })
    : t('workflows.events.adds', { when });
}

/** Authoring intent only: the ordinary Event setup Action acquires source identity and cursor. */
export function readWorkflowEventDraftSeed(
  fact: Parameters<typeof readWorkflowEventTrigger>[0],
  catalog: Readonly<{ serverId: string | null; events: readonly WorkflowTriggerEventOption[] }>,
): Readonly<{ setupRequired: true; trigger: null;
    eventSeed: NonNullable<WorkflowDefinitionDraftSeed['eventSeed']>; payloadSchema?: WorkflowDefinitionDraftSeed['payloadSchema'] }>
  | Readonly<{ setupRequired: false; trigger: AutomationTriggerDefinitionInput }>
  | null {
  if (fact.kind !== 'machine') {
    const trigger = readWorkflowEventTrigger(fact);
    return trigger === null ? null : { setupRequired: false, trigger };
  }
  if (catalog.serverId === null) return null;
  const matching = catalog.events.filter(event => event.automation?.source.nativeActivity?.kind === 'machinePresence'
    && event.automation.source.nativeActivity.transition === fact.event);
  // A shortcut cannot choose between independently declared Events on the person's behalf.
  if (matching.length !== 1) return null;
  const event = matching[0];
  return { setupRequired: true, trigger: null, payloadSchema: event.payloadSchema,
    eventSeed: { eventRef: event.eventRef,
      setupInput: { v: 1, serverId: catalog.serverId, machineId: fact.machineId } } };
}

/** The occurrence owner decides identity; timestamps are never proximity joins. */
function readWorkflowEventOccurrence(fact: WorkflowActivityFact): AutomationTriggerOccurrenceEvidenceV1 | null {
  if (fact.coverage === 'retained_cause') return fact.evidence;
  const base = { v: 1, occurredAt: fact.occurredAt } as const;
  if (fact.kind === 'run') return { ...base, kind: 'runLifecycle',
    source: { kind: 'workflow_run', runId: fact.runId }, condition: fact.event, sourceRevision: fact.sourceRevision };
  if (fact.kind !== 'session') return null;
  switch (fact.event) {
    case 'started': return { ...base, kind: 'sessionLifecycle', event: 'sessionStarted', sourceSessionId: fact.sessionId };
    case 'archived': return { ...base, kind: 'sessionLifecycle', event: 'sessionArchived', sourceSessionId: fact.sessionId };
    case 'userActionRequired': return { ...base, kind: 'sessionLifecycle', event: fact.event,
      sourceSessionId: fact.sessionId, sourceTurnId: fact.turnId, requestId: fact.requestId, requestKind: fact.requestKind };
    default: return { ...base, kind: 'sessionLifecycle', event: fact.event,
      sourceSessionId: fact.sessionId, sourceTurnId: fact.turnId };
  }
}

/** Selected-detail join over the already demanded Run page; no body reads or feed-wide matching. */
export function readWorkflowEventStartedRuns<T extends Pick<WorkflowRunSummaryV1, 'origin'>>(
  fact: WorkflowActivityFact,
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
