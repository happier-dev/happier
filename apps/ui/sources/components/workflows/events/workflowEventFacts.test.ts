import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});

const {
  matchesWorkflowEventFilter,
  readWorkflowEventTrigger,
  readWorkflowEventWhen,
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
  state: 'completed',
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

  it('offers no trigger for facts no start authors yet', () => {
    expect(readWorkflowEventTrigger(machine)).toBeNull();
    expect(readWorkflowEventTrigger(run)).toBeNull();
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
