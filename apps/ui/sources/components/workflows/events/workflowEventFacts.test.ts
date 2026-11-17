import { describe, expect, it, vi } from 'vitest';
import { AutomationRunCauseSchema } from '@happier-dev/protocol/automations/automationRunCause';
import { deriveAutomationOccurrenceKeyV1 } from '@happier-dev/protocol/automations/automationOccurrenceV1';
import type { AutomationTriggerOccurrenceEvidenceV1 } from '@happier-dev/protocol/automations/automationOccurrenceV1';
import { WorkflowRunOriginV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});

const {
  matchesWorkflowEventFilter,
  readWorkflowEventTrigger,
  readWorkflowEventWhen,
  readWorkflowEventStartedRuns,
} = await import('./workflowEventFacts');
const { readWorkflowTriggerStartId } =
  await import('../triggers/workflowTriggerStarts');

const base = { occurredAt: 1, coverage: 'live', sourceRevision: 1 } as const;
const started = {
  ...base,
  key: 's:started',
  kind: 'session',
  sessionId: 's1',
  event: 'started',
} as const;
const archived = {
  ...base,
  key: 's:archived',
  kind: 'session',
  sessionId: 's1',
  event: 'archived',
} as const;
const turn = {
  ...base,
  key: 's:turn',
  kind: 'session',
  sessionId: 's1',
  event: 'turn_started',
  turnId: 't1',
} as const;
const machine = {
  ...base,
  key: 'm',
  kind: 'machine',
  machineId: 'm1',
  event: 'offline',
} as const;
const run = {
  ...base,
  key: 'r',
  kind: 'run',
  runId: 'r1',
  event: 'terminal',
  state: 'succeeded',
} as const;

describe('workflowEventFacts', () => {
  it("starts a Session fact from the trigger owner's own start, in any Session", () => {
    expect(readWorkflowTriggerStartId(readWorkflowEventWhen(started)!)).toBe(
      'session:sessionStarts',
    );
    expect(readWorkflowTriggerStartId(readWorkflowEventWhen(turn)!)).toBe(
      'session:turnStarts',
    );
    expect(readWorkflowTriggerStartId(readWorkflowEventWhen(archived)!)).toBe(
      'session:sessionArchived',
    );
    expect(readWorkflowEventTrigger(turn)).toMatchObject({
      kind: 'sessionLifecycle',
      enabled: true,
    });
    expect(readWorkflowEventTrigger(turn)).not.toHaveProperty('subject');
  });

  it('seeds both Run conditions with the exact source Run through the lifecycle trigger owner', () => {
    expect(readWorkflowEventTrigger(run)).toEqual({ kind: 'runLifecycle', enabled: true,
      source: { kind: 'workflow_run', runId: 'r1' }, condition: 'terminal' });
    expect(readWorkflowEventTrigger({ ...run, event: 'needs_attention' })).toEqual({ kind: 'runLifecycle', enabled: true,
      source: { kind: 'workflow_run', runId: 'r1' }, condition: 'needs_attention' });
  });

  it('offers no configured trigger when a Machine fact lacks its declaration-owned setup seed', () => {
    expect(readWorkflowEventTrigger(machine)).toBeNull();
  });

  it('links retained Runs by canonical occurrence identity, excluding neighboring turns, revisions and sources', () => {
    const source = { kind: 'workflow_run', runId: run.runId } as const;
    const runEvidence = { v: 1, kind: 'runLifecycle', source, condition: run.event,
      sourceRevision: run.sourceRevision, occurredAt: run.occurredAt } as const;
    const turnEvidence = { v: 1, kind: 'sessionLifecycle', event: 'parentTurnStarted',
      sourceSessionId: turn.sessionId, sourceTurnId: turn.turnId, occurredAt: turn.occurredAt } as const;
    type FactEvidence = Extract<AutomationTriggerOccurrenceEvidenceV1, { kind: 'runLifecycle' | 'sessionLifecycle' }>;
    const retained = (id: string, evidence: FactEvidence) => ({ id,
      origin: WorkflowRunOriginV1Schema.parse({ kind: 'automation', automationId: 'a1', cause: AutomationRunCauseSchema.parse({
        kind: 'trigger', triggerId: 'trigger-1', triggerRevision: 1, triggerKind: evidence.kind,
        occurredAt: evidence.occurredAt, occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId: 'trigger-1', evidence }),
        evidence: evidence.kind === 'runLifecycle'
          ? { source: evidence.source, condition: evidence.condition, sourceRevision: evidence.sourceRevision }
          : { event: evidence.event, sourceSessionId: evidence.sourceSessionId,
              ...('sourceTurnId' in evidence ? { sourceTurnId: evidence.sourceTurnId } : {}), policy: { kind: 'everyMatch' } },
      }) }) });
    const archiveEvidence = { v: 1, kind: 'sessionLifecycle', event: 'sessionArchived',
      sourceSessionId: archived.sessionId, occurredAt: archived.occurredAt } as const;
    const exactRun = retained('run-exact', runEvidence);
    const exactTurn = retained('turn-exact', turnEvidence);
    const exactArchive = retained('archive-exact', archiveEvidence);
    const exactStart = retained('start-exact', { ...archiveEvidence, event: 'sessionStarted', occurredAt: 200 });
    const rows = [exactRun, exactTurn, exactArchive, exactStart,
      retained('other-revision', { ...runEvidence, sourceRevision: 2 }),
      retained('other-run', { ...runEvidence, source: { ...source, runId: 'r2' } }),
      retained('other-condition', { ...runEvidence, condition: 'needs_attention' }),
      retained('other-turn', { ...turnEvidence, sourceTurnId: 't2' }),
      retained('other-session', { ...turnEvidence, sourceSessionId: 's2' }),
      retained('other-archive', { ...archiveEvidence, occurredAt: 2 }),
      { id: 'direct', origin: WorkflowRunOriginV1Schema.parse({ kind: 'direct' }) }];
    expect(readWorkflowEventStartedRuns(run, rows)).toEqual([exactRun]);
    expect(readWorkflowEventStartedRuns(turn, rows)).toEqual([exactTurn]);
    expect(readWorkflowEventStartedRuns(archived, rows)).toEqual([exactArchive]);
    // Session birth is identified by its Session, independently of observation time.
    expect(readWorkflowEventStartedRuns(started, rows)).toEqual([exactStart]);
    expect(readWorkflowEventStartedRuns(machine, rows)).toEqual([]);
  });

  it('filters by fact kind', () => {
    expect(
      [started, machine].filter((fact) =>
        matchesWorkflowEventFilter(fact, 'machine'),
      ),
    ).toEqual([machine]);
    expect(
      [started, machine].filter((fact) =>
        matchesWorkflowEventFilter(fact, 'all'),
      ),
    ).toHaveLength(2);
  });
});
