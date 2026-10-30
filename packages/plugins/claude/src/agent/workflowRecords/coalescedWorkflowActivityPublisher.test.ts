import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
  type SessionWorkflowRunSnapshotV1,
} from '@happier-dev/plugin-sdk/sessions/work-state';

import { createCoalescedWorkflowActivityPublisher } from './coalescedWorkflowActivityPublisher.js';
import type { WorkflowActivityPublishInput } from './publishWorkflowActivitySnapshot.js';
import { createWorkflowActivityPublisher } from './publishWorkflowActivitySnapshot.js';

function runSnapshot(runId: string, status: SessionWorkflowRunSnapshotV1['status'] = 'active'): SessionWorkflowRunSnapshotV1 {
  return {
    v: 1,
    projectionVersion: SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
    runId,
    backendId: 'claude',
    title: `Run ${runId}`,
    status,
    recordRevision: '1',
    updatedAt: 1000,
    totalAgents: 1,
    completedAgents: 0,
    phases: [],
    agents: [],
  };
}

function httpFailure(status: number, message: string): Error & { response: { status: number } } {
  return Object.assign(new Error(message), { response: { status } });
}

describe('createCoalescedWorkflowActivityPublisher', () => {
  it('rearms a retry when the timer fires before its fractional monotonic deadline', async () => {
    const monotonicNow = performance.now.bind(performance);
    let clockReads = 0;
    // Real clock reads consume submillisecond time; native timers truncate fractional delays.
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => monotonicNow() + clockReads++ / 1000);
    let available = false;
    const records: SessionWorkflowRunSnapshotV1[] = [];
    const publisher = createWorkflowActivityPublisher({
      backendId: 'claude',
      commitRecord: async (snapshot) => {
        records.push(snapshot);
        if (!available) throw httpFailure(500, 'Unavailable');
      },
      writeHeadlines: () => {},
    });
    const scheduler = createCoalescedWorkflowActivityPublisher({
      publisher, getSnapshots: () => new Map([['a', runSnapshot('a')]]),
    });
    try {
      scheduler.notify({ changedRunIds: ['a'], startedRunIds: ['a'], terminalRunIds: [], statusChangedRunIds: [] });
      await vi.advanceTimersByTimeAsync(0);
      available = true;
      await vi.advanceTimersByTimeAsync(500);
      expect(records).toHaveLength(2);
    } finally {
      scheduler.dispose();
      clock.mockRestore();
    }
  });

  it('retries after the elapsed backoff when the system wall clock moves backwards', async () => {
    vi.setSystemTime(100000);
    let available = false;
    const records: SessionWorkflowRunSnapshotV1[] = [];
    const publisher = createWorkflowActivityPublisher({
      backendId: 'claude',
      commitRecord: async (snapshot) => {
        records.push(snapshot);
        if (!available) throw httpFailure(500, 'Unavailable');
      },
      writeHeadlines: () => {},
    });
    const scheduler = createCoalescedWorkflowActivityPublisher({
      publisher, getSnapshots: () => new Map([['a', runSnapshot('a')]]),
    });
    scheduler.notify({ changedRunIds: ['a'], startedRunIds: ['a'], terminalRunIds: [], statusChangedRunIds: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(records).toHaveLength(1);
    vi.setSystemTime(1000);
    available = true;
    await vi.advanceTimersByTimeAsync(500);
    expect(records).toHaveLength(2);
    scheduler.dispose();
  });

  it('re-queues a drain that threw a retryable error, and drops one the server refused permanently', async () => {
    // The whole-drain catch covers the headline write, which is a separate request from the per-run
    // records. A 503 there is worth another attempt; a 400/403 is the same bytes being refused
    // again, and re-queueing it would create a metadata-write loop for the session's lifetime.
    for (const testCase of [
      { error: httpFailure(503, 'Busy'), expectedPublishes: 2 },
      { error: httpFailure(400, 'Invalid parameters'), expectedPublishes: 1 },
    ]) {
      const writeHeadlines = vi.fn(async () => { throw testCase.error; });
      const publisher = createWorkflowActivityPublisher({
        backendId: 'claude', commitRecord: async () => {}, writeHeadlines,
      });
      const scheduler = createCoalescedWorkflowActivityPublisher({
        publisher,
        getSnapshots: () => new Map([['a', runSnapshot('a')]]),
        debounceMs: 300,
        onError: () => {},
      });

      scheduler.notify({ changedRunIds: ['a'], startedRunIds: [], terminalRunIds: ['a'], statusChangedRunIds: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(writeHeadlines).toHaveBeenCalledTimes(1);
      await scheduler.flush();
      expect(writeHeadlines).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(500);

      expect(writeHeadlines).toHaveBeenCalledTimes(testCase.expectedPublishes);
      scheduler.dispose();
    }
  });

  it('does not retry permanent durable write refusals', async () => {
    const commitRecord = vi.fn(async () => { throw httpFailure(400, 'Invalid parameters'); });
    const publisher = createWorkflowActivityPublisher({ backendId: 'claude', commitRecord, writeHeadlines: () => {} });
    const scheduler = createCoalescedWorkflowActivityPublisher({
      publisher, getSnapshots: () => new Map([['a', runSnapshot('a')]]),
    });
    scheduler.notify({ changedRunIds: ['a'], startedRunIds: ['a'], terminalRunIds: [], statusChangedRunIds: [] });
    await vi.advanceTimersByTimeAsync(0);
    await scheduler.flush();
    await vi.advanceTimersByTimeAsync(30000);
    expect(commitRecord).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it('keeps terminal observations queued during a failed in-flight write behind its retry deadline', async () => {
    let rejectFirstWrite!: (error: unknown) => void;
    const firstWrite = new Promise<void>((_resolve, reject) => { rejectFirstWrite = reject; });
    const records: SessionWorkflowRunSnapshotV1[] = [];
    const snapshots = new Map([['a', runSnapshot('a')]]);
    const publisher = createWorkflowActivityPublisher({
      backendId: 'claude',
      commitRecord: async (snapshot) => {
        records.push(snapshot);
        if (records.length === 1) await firstWrite;
      },
      writeHeadlines: () => {},
    });
    const scheduler = createCoalescedWorkflowActivityPublisher({ publisher, getSnapshots: () => snapshots });
    scheduler.notify({ changedRunIds: ['a'], startedRunIds: ['a'], terminalRunIds: [], statusChangedRunIds: [] });
    await vi.advanceTimersByTimeAsync(0);
    snapshots.set('a', runSnapshot('a', 'complete'));
    scheduler.notify({ changedRunIds: ['a'], startedRunIds: [], terminalRunIds: ['a'], statusChangedRunIds: [] });
    const flush = scheduler.flush();
    rejectFirstWrite(httpFailure(500, 'Unavailable'));
    await flush;
    expect(records).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(records.map((record) => record.status)).toEqual(['active', 'complete']);
    scheduler.dispose();
  });

  it('backs off failed runs across notifications and flushes while publishing healthy runs and recovering the latest state', async () => {
    let available = false;
    const records: SessionWorkflowRunSnapshotV1[] = [];
    const headlines: string[][] = [];
    const snapshots = new Map([['a', runSnapshot('a')], ['b', runSnapshot('b')]]);
    const publisher = createWorkflowActivityPublisher({
      backendId: 'claude',
      commitRecord: async (snapshot) => {
        records.push(snapshot);
        if (snapshot.runId === 'a' && !available) throw httpFailure(500, 'Unavailable');
      },
      writeHeadlines: (bundle) => {
        headlines.push([...bundle.workflow.activeRuns, ...(bundle.workflow.recentRuns ?? [])].map((run) => run.runId));
      },
    });
    const scheduler = createCoalescedWorkflowActivityPublisher({ publisher, getSnapshots: () => snapshots });
    const notify = (runId: string, terminal = false) => scheduler.notify({
      changedRunIds: [runId], startedRunIds: terminal ? [] : [runId],
      terminalRunIds: terminal ? [runId] : [], statusChangedRunIds: [],
    });

    notify('a');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(records.filter((record) => record.runId === 'a')).toHaveLength(1);

    snapshots.set('a', { ...runSnapshot('a'), totalAgents: 2 });
    scheduler.notify({ changedRunIds: ['a'], startedRunIds: [], terminalRunIds: [], statusChangedRunIds: [] });
    snapshots.set('a', { ...runSnapshot('a', 'complete'), totalAgents: 3 });
    notify('a', true);
    await scheduler.flush();
    notify('b');
    await vi.advanceTimersByTimeAsync(0);
    expect(records.map((record) => record.runId)).toEqual(['a', 'b']);
    expect(headlines.at(-1)).toEqual(['b']);

    await vi.advanceTimersByTimeAsync(200);
    expect(records.filter((record) => record.runId === 'a')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(records.filter((record) => record.runId === 'a')).toHaveLength(2);
    available = true;
    await vi.advanceTimersByTimeAsync(1);
    expect(records.filter((record) => record.runId === 'a')).toHaveLength(3);
    expect(records.at(-1)).toMatchObject({ runId: 'a', status: 'complete', totalAgents: 3 });
    expect(headlines.at(-1)?.sort()).toEqual(['a', 'b']);

    available = false;
    snapshots.set('a', { ...runSnapshot('a', 'complete'), totalAgents: 4 });
    notify('a', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(records.filter((record) => record.runId === 'a')).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(499);
    expect(records.filter((record) => record.runId === 'a')).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(records.filter((record) => record.runId === 'a')).toHaveLength(5);
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(30000);
    expect(records.filter((record) => record.runId === 'a')).toHaveLength(5);
  });

  it('flush leaves failed durable writes on the delayed retry path instead of retrying in a tight loop', async () => {
    let available = false;
    const records: SessionWorkflowRunSnapshotV1[] = [];
    const headlines: string[][] = [];
    const publisher = createWorkflowActivityPublisher({
      backendId: 'claude',
      commitRecord: async (snapshot) => {
        records.push(snapshot);
        if (!available) throw new Error('Server unavailable');
      },
      writeHeadlines: (bundle) => { headlines.push(bundle.workflow.activeRuns.map((run) => run.runId)); },
    });
    const scheduler = createCoalescedWorkflowActivityPublisher({
      publisher,
      getSnapshots: () => new Map([['a', runSnapshot('a')]]),
      debounceMs: 300,
    });

    scheduler.notify({ changedRunIds: ['a'], startedRunIds: [], terminalRunIds: [], statusChangedRunIds: [] });
    await scheduler.flush();
    expect(records).toHaveLength(1);
    expect(headlines).toEqual([[]]);
    await vi.advanceTimersByTimeAsync(499);
    expect(records).toHaveLength(1);

    available = true;
    await vi.advanceTimersByTimeAsync(1);
    expect(records).toHaveLength(2);
    expect(headlines).toEqual([[], ['a']]);
    scheduler.dispose();
  });


  it.each(['active', 'complete'] as const)('serializes a %s notification arriving during a flush-driven record write', async (status) => {
    let releaseFirstWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
    const records: SessionWorkflowRunSnapshotV1[] = [];
    const headlines: string[][] = [];
    const snapshots = new Map([['a', runSnapshot('a')]]);
    const publisher = createWorkflowActivityPublisher({
      backendId: 'claude',
      commitRecord: async (snapshot) => {
        records.push(snapshot);
        if (records.length === 1) await firstWrite;
      },
      writeHeadlines: (bundle) => { headlines.push((bundle.workflow.recentRuns ?? []).map((run) => run.runId)); },
    });
    const scheduler = createCoalescedWorkflowActivityPublisher({ publisher, getSnapshots: () => snapshots });
    scheduler.notify({ changedRunIds: ['a'], startedRunIds: [], terminalRunIds: [], statusChangedRunIds: [] });
    const flush = scheduler.flush();
    await vi.advanceTimersByTimeAsync(0);
    snapshots.set('a', { ...{ ...runSnapshot('a'), status }, updatedAt: 2000, totalAgents: 2 });
    scheduler.notify({ changedRunIds: ['a'], startedRunIds: [], terminalRunIds: status === 'complete' ? ['a'] : [], statusChangedRunIds: [] });
    await vi.advanceTimersByTimeAsync(0);
    const writesBeforeRelease = records.length;
    releaseFirstWrite();
    await flush;
    expect(writesBeforeRelease).toBe(1);
    expect(records.map((record) => record.status)).toEqual(['active', status]);
    expect(headlines.at(-1)).toEqual(status === 'complete' ? ['a'] : []);
    scheduler.dispose();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS', '500');
    vi.stubEnv('HAPPIER_SESSION_MUTATION_OUTBOX_MAX_RETRY_MS', '30000');
    vi.stubEnv('HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS', '0');
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it('flush waits for an immediate in-flight publish and drains changes queued behind it', async () => {
    let releaseFirstPublish!: () => void;
    const firstPublish = new Promise<void>((resolve) => {
      releaseFirstPublish = resolve;
    });
    const publisher = {
      publish: vi.fn(async (input: WorkflowActivityPublishInput) => {
        if (publisher.publish.mock.calls.length === 1) await firstPublish;
        return { failedRunIds: [], permanentFailedRunIds: [] };
      }),
    };
    const scheduler = createCoalescedWorkflowActivityPublisher({
      publisher,
      getSnapshots: () => new Map([
        ['a', runSnapshot('a')],
        ['b', runSnapshot('b')],
      ]),
      debounceMs: 300,
    });

    scheduler.notify({ changedRunIds: ['a'], startedRunIds: ['a'], terminalRunIds: [], statusChangedRunIds: [] });
    scheduler.notify({ changedRunIds: ['b'], startedRunIds: [], terminalRunIds: [], statusChangedRunIds: [] });
    let flushed = false;
    const flushPromise = scheduler.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);

    releaseFirstPublish();
    await flushPromise;

    expect(publisher.publish).toHaveBeenCalledTimes(2);
    expect(publisher.publish.mock.calls[1]?.[0].changedRunIds).toEqual(['b']);
    scheduler.dispose();
  });
});
