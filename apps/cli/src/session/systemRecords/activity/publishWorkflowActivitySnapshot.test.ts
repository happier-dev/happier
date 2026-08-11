import { describe, expect, it, vi } from 'vitest';

import {
  SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
  type SessionWorkflowActivityHeadlineV1,
  type SessionWorkflowRunSnapshotV1,
} from '@happier-dev/protocol';

import { CliClientUpgradeRequiredError } from '@/api/clientCompatibility/cliClientCompatibility';
import { createHttpStatusError, createInvalidResponseShapeError } from '@/api/client/httpStatusError';

import {
  createWorkflowActivityPublisher,
  type SessionActivityHeadlineBundle,
} from './publishWorkflowActivitySnapshot';

type CommitRecord = (snapshot: SessionWorkflowRunSnapshotV1) => Promise<void>;
type WriteHeadlines = (bundle: SessionActivityHeadlineBundle) => Promise<void>;

function runSnapshot(params: Readonly<{
  runId: string;
  status?: SessionWorkflowRunSnapshotV1['status'];
  recordRevision?: string;
  updatedAt?: number;
  totalAgents?: number;
  completedAgents?: number;
}>): SessionWorkflowRunSnapshotV1 {
  return {
    v: 1,
    projectionVersion: SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
    runId: params.runId,
    backendId: 'claude',
    title: `Run ${params.runId}`,
    status: params.status ?? 'active',
    recordRevision: params.recordRevision ?? '1',
    updatedAt: params.updatedAt ?? 1000,
    totalAgents: params.totalAgents ?? 1,
    completedAgents: params.completedAgents ?? 0,
    phases: [],
    agents: [],
  };
}

function runSnapshotWithAgents(params: Readonly<{ runId: string }>): SessionWorkflowRunSnapshotV1 {
  return {
    ...runSnapshot({ runId: params.runId, totalAgents: 2, completedAgents: 1, updatedAt: 1000 }),
    startedAt: 800,
    agents: [
      { id: 'agent_done', title: 'finished agent', status: 'complete', startedAt: 800, completedAt: 950, updatedAt: 950 },
      { id: 'agent_live', title: 'live agent', status: 'active', startedAt: 900, updatedAt: 1000 },
    ],
  };
}

describe('createWorkflowActivityPublisher', () => {
  it('writes the durable record FIRST, then the headline SECOND', async () => {
    const order: string[] = [];
    const commitRecord = vi.fn<CommitRecord>(async () => { order.push('record'); });
    const writeHeadlines = vi.fn<WriteHeadlines>(async () => { order.push('headline'); });
    const publisher = createWorkflowActivityPublisher({ commitRecord, writeHeadlines, backendId: 'claude' });

    await publisher.publish({
      snapshots: new Map([['a', runSnapshot({ runId: 'a' })]]),
      changedRunIds: ['a'],
    });

    expect(order).toEqual(['record', 'headline']);
    expect(commitRecord).toHaveBeenCalledTimes(1);
    expect(writeHeadlines).toHaveBeenCalledTimes(1);
  });

  it('owns the durable decimal record revision sequence', async () => {
    const committed: SessionWorkflowRunSnapshotV1[] = [];
    const commitRecord = vi.fn<CommitRecord>(async (snapshot) => { committed.push(snapshot); });
    const writeHeadlines = vi.fn<WriteHeadlines>(async () => {});
    const publisher = createWorkflowActivityPublisher({ commitRecord, writeHeadlines, backendId: 'claude' });

    await publisher.publish({
      snapshots: new Map([['a', runSnapshot({ runId: 'a', recordRevision: '0', updatedAt: 2000 })]]),
      changedRunIds: ['a'],
    });

    expect(committed[0]?.recordRevision).toBe('1');
    expect(writeHeadlines.mock.calls[0]?.[0].workflow.activeRuns[0]).toMatchObject({ runId: 'a', recordRevision: '1' });

    await publisher.publish({
      snapshots: new Map([['a', runSnapshot({ runId: 'a', recordRevision: '0', completedAgents: 1, updatedAt: 3000 })]]),
      changedRunIds: ['a'],
    });

    expect(committed[1]?.recordRevision).toBe('2');
    expect(writeHeadlines.mock.calls[1]?.[0].workflow.activeRuns[0]).toMatchObject({ runId: 'a', recordRevision: '2' });
  });

  it('seeds durable revision state from an existing committed record after publisher restart', async () => {
    const committed: SessionWorkflowRunSnapshotV1[] = [];
    const existing = runSnapshot({
      runId: 'a',
      recordRevision: '7',
      completedAgents: 1,
      updatedAt: 1000,
    });
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
    expect(writeHeadlines.mock.calls[0]?.[0].workflow.activeRuns[0]).toMatchObject({ runId: 'a', recordRevision: '8' });
  });

  it('builds a headline whose run entry carries the publisher-committed recordRevision', async () => {
    const commitRecord = vi.fn<CommitRecord>(async () => {});
    const writeHeadlines = vi.fn<WriteHeadlines>(async () => {});
    const publisher = createWorkflowActivityPublisher({ commitRecord, writeHeadlines, backendId: 'claude' });

    await publisher.publish({
      snapshots: new Map([['a', runSnapshot({ runId: 'a', recordRevision: '3', updatedAt: 2000 })]]),
      changedRunIds: ['a'],
    });

    const headline = writeHeadlines.mock.calls[0]?.[0].workflow;
    expect(headline.activeRuns).toHaveLength(1);
    expect(headline.activeRuns[0]).toMatchObject({ runId: 'a', recordRevision: '1', recordUpdatedAt: expect.any(Number) });
    // Headline must be count-only: no phases/agents leak.
    expect(headline.activeRuns[0]).not.toHaveProperty('phases');
    expect(headline.activeRuns[0]).not.toHaveProperty('agents');
  });

  it('isolates failures per run: a failed record for run A does not block run B', async () => {
    const commitRecord = vi.fn<CommitRecord>(async (snapshot) => {
      if (snapshot.runId === 'a') throw new Error('write failed for A');
    });
    const writeHeadlines = vi.fn<WriteHeadlines>(async () => {});
    const onError = vi.fn();
    const publisher = createWorkflowActivityPublisher({ commitRecord, writeHeadlines, backendId: 'claude', onError });

    await publisher.publish({
      snapshots: new Map([
        ['a', runSnapshot({ runId: 'a', recordRevision: '2' })],
        ['b', runSnapshot({ runId: 'b', recordRevision: '5' })],
      ]),
      changedRunIds: ['a', 'b'],
    });

    // B committed and reached the headline; A's failure was surfaced but did not block B.
    expect(onError).toHaveBeenCalledTimes(1);
    const headline = writeHeadlines.mock.calls[0]?.[0].workflow;
    const runIds = headline.activeRuns.map((r: { runId: string }) => r.runId);
    expect(runIds).toContain('b');
    // A never committed, so it is omitted from the headline (no stale pointer to a missing record).
    expect(runIds).not.toContain('a');
  });

  it('does not advance a run headline revision when that run\'s record write keeps failing', async () => {
    let attempt = 0;
    const commitRecord = vi.fn<CommitRecord>(async (snapshot) => {
      if (snapshot.runId === 'a') {
        attempt += 1;
        if (attempt === 1) throw new Error('first attempt fails');
      }
    });
    const writeHeadlines = vi.fn<WriteHeadlines>(async () => {});
    const publisher = createWorkflowActivityPublisher({ commitRecord, writeHeadlines, backendId: 'claude', onError: () => {} });

    await publisher.publish({ snapshots: new Map([['a', runSnapshot({ runId: 'a', recordRevision: '2' })]]), changedRunIds: ['a'] });
    // First publish: A failed, headline has no A.
    expect(writeHeadlines.mock.calls[0]?.[0].workflow.activeRuns).toHaveLength(0);

    await publisher.publish({ snapshots: new Map([['a', runSnapshot({ runId: 'a', recordRevision: '2' })]]), changedRunIds: ['a'] });
    // Second publish: A's record write succeeds; now it appears in the headline at the first durable rev.
    expect(writeHeadlines.mock.calls[1]?.[0].workflow.activeRuns[0]).toMatchObject({ runId: 'a', recordRevision: '1' });
  });

  it('does not ask the scheduler to retry permanent record-write failures', async () => {
    const error = Object.assign(new Error('Session not found'), { code: 'session_not_found' });
    const commitRecord = vi.fn<CommitRecord>(async () => { throw error; });
    const writeHeadlines = vi.fn<WriteHeadlines>(async () => {});
    const onError = vi.fn();
    const publisher = createWorkflowActivityPublisher({ commitRecord, writeHeadlines, backendId: 'claude', onError });

    const result = await publisher.publish({
      snapshots: new Map([['a', runSnapshot({ runId: 'a' })]]),
      changedRunIds: ['a'],
    });

    expect(result.failedRunIds).toEqual([]);
    expect(result.permanentFailedRunIds).toEqual(['a']);
    expect(onError).toHaveBeenCalledWith(error, { runId: 'a', retryable: false });
    expect(writeHeadlines.mock.calls[0]?.[0].workflow.activeRuns).toHaveLength(0);
  });

  it('reads a rejecting STATUS as permanent, not only the handful of codes it knows by name', async () => {
    // The code vocabulary below cannot see a server that simply refuses these bytes: a validation
    // 400 from a server released before this record kind existed, a 403, or the 426 that says this
    // build must be upgraded all arrive with a status and no recognised code. Classified as
    // retryable, each becomes the coalescer's 300 ms re-queue for the session's lifetime.
    const cases: ReadonlyArray<Readonly<{ label: string; error: unknown; permanent: boolean }>> = [
      { label: '400', error: createHttpStatusError(400, 'Invalid parameters'), permanent: true },
      { label: '403', error: createHttpStatusError(403, 'Forbidden'), permanent: true },
      {
        label: '426',
        error: new CliClientUpgradeRequiredError({
          error: 'client-upgrade-required',
          requirement: { v: 1, clientKind: 'session-runner', minimumAppVersion: '9.0.0', updateUrl: null },
        }),
        permanent: true,
      },
      { label: 'unparseable body', error: createInvalidResponseShapeError('Unexpected response shape'), permanent: true },
      // Still retried: a busy server, a rate limit, and a dropped socket are all worth another try.
      { label: '503', error: createHttpStatusError(503, 'Busy'), permanent: false },
      { label: '429', error: createHttpStatusError(429, 'Too many requests'), permanent: false },
      { label: 'socket hang up', error: new Error('socket hang up'), permanent: false },
    ];

    for (const testCase of cases) {
      const commitRecord = vi.fn<CommitRecord>(async () => { throw testCase.error; });
      const writeHeadlines = vi.fn<WriteHeadlines>(async () => {});
      const publisher = createWorkflowActivityPublisher({ commitRecord, writeHeadlines, backendId: 'claude', onError: () => {} });

      const result = await publisher.publish({
        snapshots: new Map([['a', runSnapshot({ runId: 'a' })]]),
        changedRunIds: ['a'],
      });

      expect({ label: testCase.label, permanent: result.permanentFailedRunIds }).toEqual({
        label: testCase.label,
        permanent: testCase.permanent ? ['a'] : [],
      });
      expect(result.failedRunIds).toEqual(testCase.permanent ? [] : ['a']);
    }
  });

  it('partitions terminal runs into recentRuns and keeps active runs in activeRuns', async () => {
    const commitRecord = vi.fn<CommitRecord>(async () => {});
    const writeHeadlines = vi.fn<WriteHeadlines>(async () => {});
    const publisher = createWorkflowActivityPublisher({ commitRecord, writeHeadlines, backendId: 'claude' });

    await publisher.publish({
      snapshots: new Map([
        ['active', runSnapshot({ runId: 'active', status: 'active' })],
        ['done', runSnapshot({ runId: 'done', status: 'complete' })],
      ]),
      changedRunIds: ['active', 'done'],
    });

    const headline = writeHeadlines.mock.calls[0]?.[0].workflow;
    expect(headline.activeRuns.map((r: { runId: string }) => r.runId)).toEqual(['active']);
    expect((headline.recentRuns ?? []).map((r: { runId: string }) => r.runId)).toEqual(['done']);
    expect(headline.primaryRunId).toBe('active');
  });

  it('only commits records for changed runs but includes all known runs in the headline', async () => {
    const commitRecord = vi.fn<CommitRecord>(async () => {});
    const writeHeadlines = vi.fn<WriteHeadlines>(async () => {});
    const publisher = createWorkflowActivityPublisher({ commitRecord, writeHeadlines, backendId: 'claude' });

    // First publish establishes both runs.
    await publisher.publish({
      snapshots: new Map([
        ['a', runSnapshot({ runId: 'a' })],
        ['b', runSnapshot({ runId: 'b' })],
      ]),
      changedRunIds: ['a', 'b'],
    });
    commitRecord.mockClear();
    writeHeadlines.mockClear();

    // Second publish: only A changed; B's record must NOT be re-committed, but B stays in headline.
    await publisher.publish({
        snapshots: new Map([
        ['a', runSnapshot({ runId: 'a', recordRevision: '2', completedAgents: 1, updatedAt: 2000 })],
        ['b', runSnapshot({ runId: 'b' })],
      ]),
      changedRunIds: ['a'],
    });

    expect(commitRecord).toHaveBeenCalledTimes(1);
    expect(commitRecord.mock.calls[0]?.[0].runId).toBe('a');
    const headline = writeHeadlines.mock.calls[0]?.[0].workflow;
    expect(headline.activeRuns.map((r: { runId: string }) => r.runId).sort()).toEqual(['a', 'b']);
  });

  it('publishes the unified agent-activity headline alongside the workflow headline, in ONE write', async () => {
    const order: string[] = [];
    const commitRecord = vi.fn<CommitRecord>(async () => { order.push('record'); });
    const writeHeadlines = vi.fn<WriteHeadlines>(async () => { order.push('headlines'); });
    const publisher = createWorkflowActivityPublisher({ commitRecord, writeHeadlines, backendId: 'claude' });

    await publisher.publish({
      snapshots: new Map([['a', runSnapshotWithAgents({ runId: 'a' })]]),
      changedRunIds: ['a'],
    });

    // Record first, then a SINGLE metadata write carrying both keys — never one write per key.
    expect(order).toEqual(['record', 'headlines']);
    expect(writeHeadlines).toHaveBeenCalledTimes(1);
    const bundle = writeHeadlines.mock.calls[0]?.[0];
    expect(bundle.workflow.activeRuns.map((run: { runId: string }) => run.runId)).toEqual(['a']);
    expect(bundle.agentActivity.activeEntries.map((entry: { entryId: string }) => entry.entryId)).toEqual([
      'workflow_agent:a:agent_live',
      'workflow_run:a',
    ]);
    expect(bundle.agentActivity.activeEntries[0]).toMatchObject({
      kind: 'workflow_agent',
      title: 'live agent',
      status: 'running',
      startedAt: 900,
      parentId: 'workflow_run:a',
      runId: 'a',
    });
    expect(bundle.agentActivity.recentEntries?.map((entry: { entryId: string }) => entry.entryId)).toEqual([
      'workflow_agent:a:agent_done',
    ]);
  });

  /**
   * The unified headline's run entry carries the freshness token a client invalidates its cached
   * `activity/workflow_run.v1` on. It must be the revision that was COMMITTED, not the one the
   * caller happened to hand in: publishing the incoming value would point clients at a record
   * version that never existed, and a client comparing it for equality would either refetch a
   * record that had not changed or — the failure that shipped — never refetch one that had.
   */
  it('publishes the COMMITTED record revision on the unified run entry, not the incoming one', async () => {
    const commitRecord = vi.fn<CommitRecord>(async () => {});
    const writeHeadlines = vi.fn<WriteHeadlines>(async () => {});
    const publisher = createWorkflowActivityPublisher({ commitRecord, writeHeadlines, backendId: 'claude' });

    await publisher.publish({
      snapshots: new Map([['a', runSnapshot({ runId: 'a', recordRevision: '0' })]]),
      changedRunIds: ['a'],
    });
    const first = writeHeadlines.mock.calls[0]?.[0].agentActivity.activeEntries
      .find((entry) => entry.entryId === 'workflow_run:a');
    expect(first).toMatchObject({ recordRevision: '1' });
    expect(first?.recordRevision).toBe(commitRecord.mock.calls[0]?.[0].recordRevision);

    // An unchanged run keeps its committed revision, so a display-only refresh does not invalidate
    // a client's cached record.
    await publisher.publish({
      snapshots: new Map([['a', runSnapshot({ runId: 'a', recordRevision: '0', updatedAt: 9000 })]]),
      changedRunIds: [],
    });
    const second = writeHeadlines.mock.calls[1]?.[0].agentActivity.activeEntries
      .find((entry) => entry.entryId === 'workflow_run:a');
    expect(second).toMatchObject({ updatedAt: 9000, recordRevision: '1' });
  });

  it('never fabricates a start timestamp for an entry whose source has none (D-8)', async () => {
    const commitRecord = vi.fn<CommitRecord>(async () => {});
    const writeHeadlines = vi.fn<WriteHeadlines>(async () => {});
    const publisher = createWorkflowActivityPublisher({ commitRecord, writeHeadlines, backendId: 'claude' });

    await publisher.publish({
      snapshots: new Map([['a', runSnapshot({ runId: 'a', status: 'complete', updatedAt: 5000 })]]),
      changedRunIds: ['a'],
    });

    const entry = writeHeadlines.mock.calls[0]?.[0].agentActivity.recentEntries?.[0];
    expect(entry).toMatchObject({ entryId: 'workflow_run:a', status: 'succeeded', updatedAt: 5000 });
    expect(entry && 'startedAt' in entry).toBe(false);
  });

  it('bounds terminal agent-activity history while leaving live entries uncapped', async () => {
    const commitRecord = vi.fn<CommitRecord>(async () => {});
    const writeHeadlines = vi.fn<WriteHeadlines>(async () => {});
    const publisher = createWorkflowActivityPublisher({
      commitRecord,
      writeHeadlines,
      backendId: 'claude',
      recentEntriesLimit: 2,
    });

    const snapshots = new Map<string, SessionWorkflowRunSnapshotV1>();
    for (let index = 0; index < 4; index += 1) {
      snapshots.set(`done_${index}`, runSnapshot({
        runId: `done_${index}`,
        status: 'complete',
        updatedAt: 1000 + index,
      }));
    }
    for (let index = 0; index < 6; index += 1) {
      snapshots.set(`live_${index}`, runSnapshot({ runId: `live_${index}`, status: 'active' }));
    }

    await publisher.publish({ snapshots, changedRunIds: [...snapshots.keys()] });

    const agentActivity = writeHeadlines.mock.calls[0]?.[0].agentActivity;
    expect(agentActivity.activeEntries).toHaveLength(6);
    expect(agentActivity.recentEntries).toHaveLength(2);
    expect(agentActivity.truncated).toEqual({ reason: 'entry_limit', omittedCount: 2 });
  });
});
