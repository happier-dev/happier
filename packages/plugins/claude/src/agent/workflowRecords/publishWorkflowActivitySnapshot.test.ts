import { describe, expect, it, vi } from 'vitest';

import {
  SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
  type SessionActivityHeadlineBundleV1,
  type SessionWorkflowAgentSnapshotV1,
  type SessionWorkflowRunSnapshotV1,
} from '@happier-dev/plugin-sdk/sessions/work-state';

import { createWorkflowActivityPublisher } from './publishWorkflowActivitySnapshot.js';

type CommitRecord = (snapshot: SessionWorkflowRunSnapshotV1) => Promise<void>;
type WriteHeadlines = (bundle: SessionActivityHeadlineBundleV1) => Promise<void>;

function runSnapshot(params: Readonly<{
  runId: string;
  status?: SessionWorkflowRunSnapshotV1['status'];
  recordRevision?: string;
  updatedAt?: number;
  completedAgents?: number;
  startedAt?: number;
  agents?: readonly SessionWorkflowAgentSnapshotV1[];
}>): SessionWorkflowRunSnapshotV1 {
  return {
    v: 1,
    projectionVersion: SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
    runId: params.runId,
    backendId: 'claude',
    title: `Run ${params.runId}`,
    status: params.status ?? 'active',
    recordRevision: params.recordRevision ?? '1',
    ...(params.startedAt !== undefined ? { startedAt: params.startedAt } : {}),
    updatedAt: params.updatedAt ?? 1000,
    totalAgents: 1,
    completedAgents: params.completedAgents ?? 0,
    phases: [],
    agents: [...(params.agents ?? [])],
  };
}

function agentSnapshot(params: Readonly<{
  id: string;
  status?: SessionWorkflowAgentSnapshotV1['status'];
  updatedAt?: number;
  startedAt?: number;
}>): SessionWorkflowAgentSnapshotV1 {
  return {
    id: params.id,
    title: `Agent ${params.id}`,
    status: params.status ?? 'active',
    ...(params.startedAt !== undefined ? { startedAt: params.startedAt } : {}),
    updatedAt: params.updatedAt ?? 1000,
  };
}

describe('createWorkflowActivityPublisher', () => {
  it('writes the durable record first, then the headline', async () => {
    const order: string[] = [];
    const commitRecord = vi.fn<CommitRecord>(async () => { order.push('record'); });
    const writeHeadlines = vi.fn<WriteHeadlines>(async () => { order.push('headlines'); });
    const publisher = createWorkflowActivityPublisher({ commitRecord, writeHeadlines, backendId: 'claude' });

    await publisher.publish({
      snapshots: new Map([['a', runSnapshot({ runId: 'a' })]]),
      changedRunIds: ['a'],
    });

    expect(order).toEqual(['record', 'headlines']);
  });

  it('assigns monotonic decimal record revisions from committed material changes', async () => {
    const committed: SessionWorkflowRunSnapshotV1[] = [];
    const commitRecord = vi.fn<CommitRecord>(async (snapshot) => { committed.push(snapshot); });
    const writeHeadlines = vi.fn<WriteHeadlines>(async () => {});
    const publisher = createWorkflowActivityPublisher({ commitRecord, writeHeadlines, backendId: 'claude' });

    await publisher.publish({
      snapshots: new Map([['a', runSnapshot({ runId: 'a', recordRevision: '99', updatedAt: 2000 })]]),
      changedRunIds: ['a'],
    });

    expect(committed[0]?.recordRevision).toBe('1');
    expect(writeHeadlines.mock.calls[0]?.[0].workflow.activeRuns[0]).toMatchObject({
      runId: 'a',
      recordRevision: '1',
    });

    await publisher.publish({
      snapshots: new Map([[
        'a',
        runSnapshot({ runId: 'a', recordRevision: '100', completedAgents: 1, updatedAt: 3000 }),
      ]]),
      changedRunIds: ['a'],
    });

    expect(committed[1]?.recordRevision).toBe('2');
    expect(writeHeadlines.mock.calls[1]?.[0].workflow.activeRuns[0]).toMatchObject({
      runId: 'a',
      recordRevision: '2',
    });
  });

  it('continues from an existing durable record when the publisher has no in-memory commit yet', async () => {
    const existing = runSnapshot({
      runId: 'a',
      recordRevision: '7',
      completedAgents: 1,
      updatedAt: 1000,
    });
    const committed: SessionWorkflowRunSnapshotV1[] = [];
    const commitRecord = vi.fn<CommitRecord>(async (snapshot) => { committed.push(snapshot); });
    const writeHeadlines = vi.fn<WriteHeadlines>(async () => {});
    const readCommittedRunSnapshot = vi.fn(async (runId: string) => (runId === 'a' ? existing : null));
    const publisher = createWorkflowActivityPublisher({
      commitRecord,
      writeHeadlines,
      readCommittedRunSnapshot,
      backendId: 'claude',
    });

    await publisher.publish({
      snapshots: new Map([[
        'a',
        runSnapshot({
          runId: 'a',
          recordRevision: '1',
          completedAgents: 2,
          updatedAt: 2000,
        }),
      ]]),
      changedRunIds: ['a'],
    });

    expect(readCommittedRunSnapshot).toHaveBeenCalledWith('a');
    expect(committed[0]?.recordRevision).toBe('8');
    expect(writeHeadlines.mock.calls[0]?.[0].workflow.activeRuns[0]).toMatchObject({
      runId: 'a',
      recordRevision: '8',
    });
  });

  it('does not advance the committed headline revision while a record write is failing', async () => {
    let attempt = 0;
    const commitRecord = vi.fn<CommitRecord>(async (snapshot) => {
      if (snapshot.runId === 'a') {
        attempt += 1;
        if (attempt === 1) throw new Error('first attempt fails');
      }
    });
    const writeHeadlines = vi.fn<WriteHeadlines>(async () => {});
    const publisher = createWorkflowActivityPublisher({
      commitRecord,
      writeHeadlines,
      backendId: 'claude',
      onError: () => {},
    });

    await publisher.publish({
      snapshots: new Map([['a', runSnapshot({ runId: 'a', recordRevision: '2' })]]),
      changedRunIds: ['a'],
    });
    expect(writeHeadlines.mock.calls[0]?.[0].workflow.activeRuns).toHaveLength(0);

    await publisher.publish({
      snapshots: new Map([['a', runSnapshot({ runId: 'a', recordRevision: '2' })]]),
      changedRunIds: ['a'],
    });
    expect(writeHeadlines.mock.calls[1]?.[0].workflow.activeRuns[0]).toMatchObject({
      runId: 'a',
      recordRevision: '1',
    });
  });

  it('partitions permanent record-write failures out of scheduler retries', async () => {
    const error = Object.assign(new Error('Session not found'), { code: 'session_not_found' });
    const commitRecord = vi.fn<CommitRecord>(async () => { throw error; });
    const writeHeadlines = vi.fn<WriteHeadlines>(async () => {});
    const onError = vi.fn();
    const publisher = createWorkflowActivityPublisher({
      commitRecord,
      writeHeadlines,
      backendId: 'claude',
      onError,
    });

    const result = await publisher.publish({
      snapshots: new Map([['a', runSnapshot({ runId: 'a' })]]),
      changedRunIds: ['a'],
    });

    expect(result.failedRunIds).toEqual([]);
    expect(result.permanentFailedRunIds).toEqual(['a']);
    expect(onError).toHaveBeenCalledWith(error, { runId: 'a', retryable: false });
    expect(writeHeadlines.mock.calls[0]?.[0].workflow.activeRuns).toHaveLength(0);
  });

  it('names every agent in the agent-activity headline of the same single write', async () => {
    // The workflow headline is count-only, so a client that has fetched no transcript page can name
    // no agent. This is the roster that makes a cold open complete — and it leaves in the SAME
    // metadata write as the counts, so the two keys cannot disagree about what exists.
    const commitRecord = vi.fn<CommitRecord>(async () => {});
    const writeHeadlines = vi.fn<WriteHeadlines>(async () => {});
    const publisher = createWorkflowActivityPublisher({ commitRecord, writeHeadlines, backendId: 'claude' });

    await publisher.publish({
      snapshots: new Map([['wf_1', runSnapshot({
        runId: 'wf_1',
        agents: [
          agentSnapshot({ id: 'a1', status: 'active', updatedAt: 1_100 }),
          agentSnapshot({ id: 'a2', status: 'complete', updatedAt: 1_200 }),
        ],
      })]]),
      changedRunIds: ['wf_1'],
    });

    expect(writeHeadlines).toHaveBeenCalledTimes(1);
    const bundle = writeHeadlines.mock.calls[0]![0];
    expect(bundle.agentActivity.activeEntries.map((entry) => entry.entryId)).toEqual([
      'workflow_agent:wf_1:a1',
      'workflow_run:wf_1',
    ]);
    expect(bundle.agentActivity.recentEntries?.map((entry) => entry.entryId))
      .toEqual(['workflow_agent:wf_1:a2']);
    // Grouping only: the agent names its run, and nothing is summed from it.
    expect(bundle.agentActivity.activeEntries.find((entry) => entry.kind === 'workflow_agent')?.parentId)
      .toBe('workflow_run:wf_1');
    // The workflow key keeps exactly the shape every released client already reads.
    expect(bundle.workflow.activeRuns.map((run) => run.runId)).toEqual(['wf_1']);
    expect(bundle.workflow.activeRuns[0]).not.toHaveProperty('agents');
  });

  it('never publishes an agent entry for a run whose durable record write failed', async () => {
    // The two keys are derived from the same committed state, so a run with no durable record is
    // absent from BOTH — never a pointer at a record that does not exist.
    const commitRecord = vi.fn<CommitRecord>(async () => { throw new Error('write failed'); });
    const writeHeadlines = vi.fn<WriteHeadlines>(async () => {});
    const publisher = createWorkflowActivityPublisher({
      commitRecord,
      writeHeadlines,
      backendId: 'claude',
      onError: () => {},
    });

    await publisher.publish({
      snapshots: new Map([['wf_1', runSnapshot({ runId: 'wf_1', agents: [agentSnapshot({ id: 'a1' })] })]]),
      changedRunIds: ['wf_1'],
    });

    const bundle = writeHeadlines.mock.calls[0]![0];
    expect(bundle.workflow.activeRuns).toHaveLength(0);
    expect(bundle.agentActivity.activeEntries).toHaveLength(0);
  });

  it('stamps the record revision on the run entry only, and never on an agent', async () => {
    // An agent has no record of its own — it lives inside the run's. Stamping it would publish a
    // second freshness authority for one record.
    const commitRecord = vi.fn<CommitRecord>(async () => {});
    const writeHeadlines = vi.fn<WriteHeadlines>(async () => {});
    const publisher = createWorkflowActivityPublisher({ commitRecord, writeHeadlines, backendId: 'claude' });

    await publisher.publish({
      snapshots: new Map([['wf_1', runSnapshot({ runId: 'wf_1', agents: [agentSnapshot({ id: 'a1' })] })]]),
      changedRunIds: ['wf_1'],
    });

    const entries = writeHeadlines.mock.calls[0]![0].agentActivity.activeEntries;
    expect(entries.find((entry) => entry.kind === 'workflow_run')?.recordRevision).toBe('1');
    expect(entries.find((entry) => entry.kind === 'workflow_agent')).not.toHaveProperty('recordRevision');
  });

  it('publishes no start for a run or agent that never recorded one', async () => {
    // A `startedAt ?? updatedAt ?? finishedAt` chain made a finished 16-second agent report `0:00`.
    // Absent evidence of a start, the field is absent and the surface shows nothing.
    const commitRecord = vi.fn<CommitRecord>(async () => {});
    const writeHeadlines = vi.fn<WriteHeadlines>(async () => {});
    const publisher = createWorkflowActivityPublisher({ commitRecord, writeHeadlines, backendId: 'claude' });

    await publisher.publish({
      snapshots: new Map([['wf_1', runSnapshot({
        runId: 'wf_1',
        updatedAt: 5_000,
        agents: [
          agentSnapshot({ id: 'a1', updatedAt: 5_000 }),
          agentSnapshot({ id: 'a2', updatedAt: 5_000, startedAt: 4_000 }),
        ],
      })]]),
      changedRunIds: ['wf_1'],
    });

    const entries = writeHeadlines.mock.calls[0]![0].agentActivity.activeEntries;
    expect(entries.find((entry) => entry.entryId === 'workflow_run:wf_1')).not.toHaveProperty('startedAt');
    expect(entries.find((entry) => entry.entryId === 'workflow_agent:wf_1:a1')).not.toHaveProperty('startedAt');
    expect(entries.find((entry) => entry.entryId === 'workflow_agent:wf_1:a2')?.startedAt).toBe(4_000);
  });

  it('keeps agent display fresh for an unchanged run without advancing its record pointer', async () => {
    // Display may move ahead of the last durable write; the record pointer may not. Without a
    // display snapshot the agent rows would freeze at the last committed write while the run's
    // counts stayed fresh.
    const commitRecord = vi.fn<CommitRecord>(async () => {});
    const writeHeadlines = vi.fn<WriteHeadlines>(async () => {});
    const publisher = createWorkflowActivityPublisher({ commitRecord, writeHeadlines, backendId: 'claude' });

    await publisher.publish({
      snapshots: new Map([['wf_1', runSnapshot({
        runId: 'wf_1',
        agents: [agentSnapshot({ id: 'a1', status: 'active', updatedAt: 1_000 })],
      })]]),
      changedRunIds: ['wf_1'],
    });

    await publisher.publish({
      snapshots: new Map([['wf_1', runSnapshot({
        runId: 'wf_1',
        recordRevision: '9',
        agents: [agentSnapshot({ id: 'a1', status: 'complete', updatedAt: 2_000 })],
      })]]),
      changedRunIds: [],
    });

    const second = writeHeadlines.mock.calls[1]![0].agentActivity;
    expect(second.recentEntries?.map((entry) => entry.entryId)).toEqual(['workflow_agent:wf_1:a1']);
    expect(second.activeEntries.find((entry) => entry.kind === 'workflow_run')?.recordRevision).toBe('1');
    expect(commitRecord).toHaveBeenCalledTimes(1);
  });
});
