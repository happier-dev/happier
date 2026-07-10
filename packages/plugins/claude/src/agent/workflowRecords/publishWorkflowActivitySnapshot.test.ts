import { describe, expect, it, vi } from 'vitest';

import {
  SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
  type SessionWorkflowActivityHeadlineV1,
  type SessionWorkflowRunSnapshotV1,
} from '@happier-dev/plugin-sdk/experimental/sessions/workState';

import { createWorkflowActivityPublisher } from './publishWorkflowActivitySnapshot.js';

type CommitRecord = (snapshot: SessionWorkflowRunSnapshotV1) => Promise<void>;
type WriteHeadline = (headline: SessionWorkflowActivityHeadlineV1) => Promise<void>;

function runSnapshot(params: Readonly<{
  runId: string;
  status?: SessionWorkflowRunSnapshotV1['status'];
  recordRevision?: string;
  updatedAt?: number;
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
    totalAgents: 1,
    completedAgents: params.completedAgents ?? 0,
    phases: [],
    agents: [],
  };
}

describe('createWorkflowActivityPublisher', () => {
  it('writes the durable record first, then the headline', async () => {
    const order: string[] = [];
    const commitRecord = vi.fn<CommitRecord>(async () => { order.push('record'); });
    const writeHeadline = vi.fn<WriteHeadline>(async () => { order.push('headline'); });
    const publisher = createWorkflowActivityPublisher({ commitRecord, writeHeadline, backendId: 'claude' });

    await publisher.publish({
      snapshots: new Map([['a', runSnapshot({ runId: 'a' })]]),
      changedRunIds: ['a'],
    });

    expect(order).toEqual(['record', 'headline']);
  });

  it('assigns monotonic decimal record revisions from committed material changes', async () => {
    const committed: SessionWorkflowRunSnapshotV1[] = [];
    const commitRecord = vi.fn<CommitRecord>(async (snapshot) => { committed.push(snapshot); });
    const writeHeadline = vi.fn<WriteHeadline>(async () => {});
    const publisher = createWorkflowActivityPublisher({ commitRecord, writeHeadline, backendId: 'claude' });

    await publisher.publish({
      snapshots: new Map([['a', runSnapshot({ runId: 'a', recordRevision: '99', updatedAt: 2000 })]]),
      changedRunIds: ['a'],
    });

    expect(committed[0]?.recordRevision).toBe('1');
    expect(writeHeadline.mock.calls[0]?.[0].activeRuns[0]).toMatchObject({
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
    expect(writeHeadline.mock.calls[1]?.[0].activeRuns[0]).toMatchObject({
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
    const writeHeadline = vi.fn<WriteHeadline>(async () => {});
    const readCommittedRunSnapshot = vi.fn(async (runId: string) => (runId === 'a' ? existing : null));
    const publisher = createWorkflowActivityPublisher({
      commitRecord,
      writeHeadline,
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
    expect(writeHeadline.mock.calls[0]?.[0].activeRuns[0]).toMatchObject({
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
    const writeHeadline = vi.fn<WriteHeadline>(async () => {});
    const publisher = createWorkflowActivityPublisher({
      commitRecord,
      writeHeadline,
      backendId: 'claude',
      onError: () => {},
    });

    await publisher.publish({
      snapshots: new Map([['a', runSnapshot({ runId: 'a', recordRevision: '2' })]]),
      changedRunIds: ['a'],
    });
    expect(writeHeadline.mock.calls[0]?.[0].activeRuns).toHaveLength(0);

    await publisher.publish({
      snapshots: new Map([['a', runSnapshot({ runId: 'a', recordRevision: '2' })]]),
      changedRunIds: ['a'],
    });
    expect(writeHeadline.mock.calls[1]?.[0].activeRuns[0]).toMatchObject({
      runId: 'a',
      recordRevision: '1',
    });
  });

  it('partitions permanent record-write failures out of scheduler retries', async () => {
    const error = Object.assign(new Error('Session not found'), { code: 'session_not_found' });
    const commitRecord = vi.fn<CommitRecord>(async () => { throw error; });
    const writeHeadline = vi.fn<WriteHeadline>(async () => {});
    const onError = vi.fn();
    const publisher = createWorkflowActivityPublisher({
      commitRecord,
      writeHeadline,
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
    expect(writeHeadline.mock.calls[0]?.[0].activeRuns).toHaveLength(0);
  });
});
