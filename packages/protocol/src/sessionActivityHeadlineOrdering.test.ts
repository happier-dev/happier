import { describe, expect, it } from 'vitest';

import {
  boundRecentActivityHeadlineEntries,
  partitionActivityHeadlineEntries,
  sortActiveActivityHeadlineEntries,
} from './sessionActivityHeadlineOrdering.js';
import {
  buildSessionAgentActivityHeadline,
  type SessionAgentActivityEntryV1,
} from './sessionAgentActivity/index.js';
import {
  buildSessionWorkflowActivityHeadline,
  type SessionWorkflowRunHeadlineV1,
  type SessionWorkflowRunStatusV1,
} from './sessionWorkflowActivity/index.js';

type TestEntry = Readonly<{
  id: string;
  priority: number;
  updatedAt: number;
  terminal: boolean;
  detail?: string;
}>;

const accessors = {
  id: (entry: TestEntry) => entry.id,
  activePriority: (entry: TestEntry) => entry.priority,
  updatedAt: (entry: TestEntry) => entry.updatedAt,
};

function entry(overrides: Partial<TestEntry> & { id: string }): TestEntry {
  return { priority: 1, updatedAt: 1000, terminal: false, ...overrides };
}

describe('sortActiveActivityHeadlineEntries', () => {
  it('orders by ascending priority and breaks ties on id, never on a progress timestamp', () => {
    // The updatedAt values contradict both the priority order and the id order, so an
    // implementation that reaches for a progress timestamp produces a different sequence.
    const entries = [
      entry({ id: 'c', priority: 2, updatedAt: 9000 }),
      entry({ id: 'b', priority: 0, updatedAt: 1 }),
      entry({ id: 'a', priority: 2, updatedAt: 8000 }),
    ];
    expect(sortActiveActivityHeadlineEntries(entries, accessors).map((item) => item.id)).toEqual(['b', 'a', 'c']);
  });

  it('does not reorder equal-priority entries when only updatedAt changes', () => {
    const before = [entry({ id: 'a', updatedAt: 1 }), entry({ id: 'b', updatedAt: 2 })];
    const after = [entry({ id: 'a', updatedAt: 5000 }), entry({ id: 'b', updatedAt: 2 })];
    expect(sortActiveActivityHeadlineEntries(before, accessors).map((item) => item.id)).toEqual(['a', 'b']);
    expect(sortActiveActivityHeadlineEntries(after, accessors).map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('does not mutate its input', () => {
    const entries = [entry({ id: 'z', priority: 3 }), entry({ id: 'a', priority: 0 })];
    sortActiveActivityHeadlineEntries(entries, accessors);
    expect(entries.map((item) => item.id)).toEqual(['z', 'a']);
  });
});

describe('boundRecentActivityHeadlineEntries', () => {
  it('keeps the newest entries, orders them updatedAt-descending, and reports the omitted count', () => {
    const entries = Array.from({ length: 8 }, (_, index) => entry({
      id: `t_${index}`,
      updatedAt: 1000 + index,
      terminal: true,
    }));
    const bounded = boundRecentActivityHeadlineEntries(entries, accessors, 3);
    expect(bounded.recent.map((item) => item.id)).toEqual(['t_7', 't_6', 't_5']);
    expect(bounded.omittedCount).toBe(5);
  });

  it('breaks updatedAt ties on ascending id so every client agrees', () => {
    const entries = [
      entry({ id: 'b', updatedAt: 500, terminal: true }),
      entry({ id: 'a', updatedAt: 500, terminal: true }),
    ];
    expect(boundRecentActivityHeadlineEntries(entries, accessors, 5).recent.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('reports no omission when the history fits', () => {
    const bounded = boundRecentActivityHeadlineEntries([entry({ id: 'a', terminal: true })], accessors, 5);
    expect(bounded.recent).toHaveLength(1);
    expect(bounded.omittedCount).toBe(0);
  });

  it('treats a negative limit as zero rather than slicing from the end', () => {
    const entries = [entry({ id: 'a', terminal: true }), entry({ id: 'b', terminal: true })];
    const bounded = boundRecentActivityHeadlineEntries(entries, accessors, -3);
    expect(bounded.recent).toEqual([]);
    expect(bounded.omittedCount).toBe(2);
  });
});

describe('partitionActivityHeadlineEntries', () => {
  it('never bounds the active side and bounds only terminal history', () => {
    const active = Array.from({ length: 12 }, (_, index) => entry({ id: `a_${index}`, priority: 1 }));
    const terminal = Array.from({ length: 9 }, (_, index) => entry({
      id: `t_${index}`,
      updatedAt: 2000 + index,
      terminal: true,
    }));
    const partition = partitionActivityHeadlineEntries({
      entries: [...active, ...terminal],
      accessors,
      isTerminal: (item) => item.terminal,
      project: (item) => item,
      recentLimit: 4,
    });
    expect(partition.active).toHaveLength(12);
    expect(partition.recent).toHaveLength(4);
    expect(partition.omittedCount).toBe(5);
  });

  it('projects every entry, on both sides of the partition, before ordering', () => {
    const partition = partitionActivityHeadlineEntries({
      entries: [entry({ id: 'live', detail: 'leak' }), entry({ id: 'done', detail: 'leak', terminal: true })],
      accessors,
      isTerminal: (item) => item.terminal,
      project: (item) => ({ id: item.id, priority: item.priority, updatedAt: item.updatedAt, terminal: item.terminal }),
      recentLimit: 5,
    });
    expect(partition.active[0]).not.toHaveProperty('detail');
    expect(partition.recent[0]).not.toHaveProperty('detail');
  });
});

/**
 * The anti-drift lock for PLAN §3.1 / §8.4: the agent-activity headline is DERIVED from the
 * workflow headline's ordering and bounding semantics, not a parallel implementation. Equivalent
 * inputs must therefore come out in the same sequence with the same truncation arithmetic. If one
 * builder ever grows its own comparator or its own cap, this fails while both builders' own suites
 * stay green.
 */
describe('workflow and agent headlines share one ordering and bounding owner', () => {
  const RECENT_LIMIT = 3;

  function workflowRun(runId: string, status: SessionWorkflowRunStatusV1, updatedAt: number): SessionWorkflowRunHeadlineV1 {
    return {
      runId,
      title: `run ${runId}`,
      status,
      updatedAt,
      recordRevision: '1',
      recordUpdatedAt: updatedAt,
      totalAgents: 1,
      completedAgents: 0,
    };
  }

  function agentEntry(entryId: string, status: SessionAgentActivityEntryV1['status'], updatedAt: number): SessionAgentActivityEntryV1 {
    return { entryId, kind: 'workflow_run', title: `run ${entryId}`, status, updatedAt };
  }

  it('produces the same id order and the same omitted count for equivalent inputs', () => {
    // Relative priority is what must agree: workflow blocked < active < unknown maps onto
    // agent blocked < running < unknown. updatedAt deliberately contradicts the expected order.
    const workflow = buildSessionWorkflowActivityHeadline({
      backendId: 'claude',
      updatedAt: 9999,
      recentRunsLimit: RECENT_LIMIT,
      runs: [
        workflowRun('w_unknown', 'unknown', 8000),
        workflowRun('w_active_b', 'active', 10),
        workflowRun('w_active_a', 'active', 7000),
        workflowRun('w_blocked', 'blocked', 1),
        ...Array.from({ length: 6 }, (_, index) => workflowRun(`w_done_${index}`, 'complete', 100 + index)),
      ],
    });
    const agent = buildSessionAgentActivityHeadline({
      backendId: 'claude',
      updatedAt: 9999,
      recentEntriesLimit: RECENT_LIMIT,
      entries: [
        agentEntry('w_unknown', 'unknown', 8000),
        agentEntry('w_active_b', 'running', 10),
        agentEntry('w_active_a', 'running', 7000),
        agentEntry('w_blocked', 'blocked', 1),
        ...Array.from({ length: 6 }, (_, index) => agentEntry(`w_done_${index}`, 'succeeded', 100 + index)),
      ],
    });

    expect(agent.activeEntries.map((item) => item.entryId)).toEqual(workflow.activeRuns.map((run) => run.runId));
    expect(agent.recentEntries?.map((item) => item.entryId)).toEqual(workflow.recentRuns?.map((run) => run.runId));
    expect(agent.primaryEntryId).toBe(workflow.primaryRunId);
    expect(agent.truncated?.omittedCount).toBe(workflow.truncated?.omittedCount);
  });
});
