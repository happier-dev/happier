import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
  type SessionWorkflowRunSnapshotV1,
} from '@happier-dev/protocol';

import { createHttpStatusError } from '@/api/client/httpStatusError';

import { createCoalescedWorkflowActivityPublisher } from './coalescedWorkflowActivityPublisher';
import type { SessionActivityHeadlineBundle, WorkflowActivityPublishInput } from './publishWorkflowActivitySnapshot';
import { createWorkflowActivityPublisher } from './publishWorkflowActivitySnapshot';

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

describe('createCoalescedWorkflowActivityPublisher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS', '500');
    vi.stubEnv('HAPPIER_SESSION_MUTATION_OUTBOX_MAX_RETRY_MS', '30000');
    vi.stubEnv('HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS', '0');
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); });

  function setup() {
    const publishes: WorkflowActivityPublishInput[] = [];
    const publisher = { publish: vi.fn(async (input: WorkflowActivityPublishInput) => { publishes.push(input); return { failedRunIds: [], permanentFailedRunIds: [] }; }) };
    const scheduler = createCoalescedWorkflowActivityPublisher({
      publisher,
      getSnapshots: () => new Map([['a', runSnapshot('a')], ['b', runSnapshot('b')]]),
      debounceMs: 300,
    });
    return { publishes, publisher, scheduler };
  }

  it('debounces progress-only updates into a single publish after the delay', async () => {
    const { publisher, scheduler } = setup();
    scheduler.notify({ changedRunIds: ['a'], startedRunIds: [], terminalRunIds: [], statusChangedRunIds: [] });
    scheduler.notify({ changedRunIds: ['a'], startedRunIds: [], terminalRunIds: [], statusChangedRunIds: [] });
    expect(publisher.publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(publisher.publish).toHaveBeenCalledTimes(1);
  });

  it('publishes immediately on a run start (bypasses the debounce)', async () => {
    const { publisher, scheduler } = setup();
    scheduler.notify({ changedRunIds: ['a'], startedRunIds: ['a'], terminalRunIds: [], statusChangedRunIds: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(publisher.publish).toHaveBeenCalledTimes(1);
  });

  it('publishes immediately on a status change and on a terminal run', async () => {
    const { publisher, scheduler } = setup();
    scheduler.notify({ changedRunIds: ['a'], startedRunIds: [], terminalRunIds: [], statusChangedRunIds: ['a'] });
    await vi.advanceTimersByTimeAsync(0);
    expect(publisher.publish).toHaveBeenCalledTimes(1);

    scheduler.notify({ changedRunIds: ['a'], startedRunIds: [], terminalRunIds: ['a'], statusChangedRunIds: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(publisher.publish).toHaveBeenCalledTimes(2);
  });

  it('accumulates changed run ids across notifies and forwards them to the publisher', async () => {
    const { publishes, scheduler } = setup();
    scheduler.notify({ changedRunIds: ['a'], startedRunIds: [], terminalRunIds: [], statusChangedRunIds: [] });
    scheduler.notify({ changedRunIds: ['b'], startedRunIds: [], terminalRunIds: [], statusChangedRunIds: [] });
    await vi.advanceTimersByTimeAsync(300);
    expect(publishes).toHaveLength(1);
    expect([...publishes[0].changedRunIds].sort()).toEqual(['a', 'b']);
  });

  it('flush() publishes pending changes synchronously-ish without waiting for the debounce', async () => {
    const { publisher, scheduler } = setup();
    scheduler.notify({ changedRunIds: ['a'], startedRunIds: [], terminalRunIds: [], statusChangedRunIds: [] });
    expect(publisher.publish).not.toHaveBeenCalled();
    await scheduler.flush();
    expect(publisher.publish).toHaveBeenCalledTimes(1);
  });

  it('requeues failed run ids returned by the publisher for a delayed retry', async () => {
    const records: SessionWorkflowRunSnapshotV1[] = [];
    const publisher = createWorkflowActivityPublisher({
      backendId: 'claude',
      commitRecord: async (snapshot) => {
        records.push(snapshot);
        if (records.length === 1) throw createHttpStatusError(500, 'Unavailable');
      },
      writeHeadlines: () => {},
    });
    const scheduler = createCoalescedWorkflowActivityPublisher({
      publisher,
      getSnapshots: () => new Map([['a', runSnapshot('a')]]),
      debounceMs: 300,
    });

    scheduler.notify({ changedRunIds: ['a'], startedRunIds: [], terminalRunIds: ['a'], statusChangedRunIds: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(records).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(499);
    expect(records).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(records).toHaveLength(2);
    expect(records[1]?.runId).toBe('a');
    scheduler.dispose();
  });

  it('automatically publishes both headlines after an early retry wake without duplicating the durable record', async () => {
    // Timers and the monotonic clock are independent system boundaries: a timer can wake early.
    let monotonicNow = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => monotonicNow);
    const records: SessionWorkflowRunSnapshotV1[] = [];
    const headlines: SessionActivityHeadlineBundle[] = [];
    let metadataAttempts = 0;
    const publisher = createWorkflowActivityPublisher({
      backendId: 'claude',
      commitRecord: async (snapshot) => { records.push(snapshot); },
      writeHeadlines: (bundle) => {
        metadataAttempts += 1;
        if (metadataAttempts === 1) throw createHttpStatusError(503, 'Busy');
        headlines.push(bundle);
      },
    });
    const scheduler = createCoalescedWorkflowActivityPublisher({
      publisher, getSnapshots: () => new Map([['a', runSnapshot('a')]]), onError: () => {},
    });
    try {
      scheduler.notify({ changedRunIds: ['a'], startedRunIds: ['a'], terminalRunIds: [], statusChangedRunIds: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(records).toHaveLength(1);
      expect(metadataAttempts).toBe(1);

      monotonicNow = 499;
      await vi.advanceTimersByTimeAsync(500);
      expect(metadataAttempts).toBe(1);
      expect(headlines).toEqual([]);

      monotonicNow = 500;
      await vi.advanceTimersByTimeAsync(1);
      expect(metadataAttempts).toBe(2);
      expect(headlines[0]?.workflow.activeRuns.map((run) => run.runId)).toEqual(['a']);
      expect(headlines[0]?.agentActivity.activeEntries.map((entry) => entry.entryId)).toEqual(['workflow_run:a']);
      expect(records).toHaveLength(1);
    } finally {
      scheduler.dispose();
    }
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
        if (snapshot.runId === 'a' && !available) throw createHttpStatusError(500, 'Unavailable');
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
        if (!available) throw createHttpStatusError(500, 'Unavailable');
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
    rejectFirstWrite(createHttpStatusError(500, 'Unavailable'));
    await flush;
    expect(records).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(records.map((record) => record.status)).toEqual(['active', 'complete']);
    scheduler.dispose();
  });

  it('does not retry permanent durable write refusals', async () => {
    const commitRecord = vi.fn(async () => { throw createHttpStatusError(400, 'Invalid parameters'); });
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

  it('retries after the elapsed backoff when the system wall clock moves backwards', async () => {
    vi.setSystemTime(100000);
    let available = false;
    const records: SessionWorkflowRunSnapshotV1[] = [];
    const publisher = createWorkflowActivityPublisher({
      backendId: 'claude',
      commitRecord: async (snapshot) => {
        records.push(snapshot);
        if (!available) throw createHttpStatusError(500, 'Unavailable');
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
        if (!available) throw createHttpStatusError(500, 'Unavailable');
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

  it('flush waits for an in-flight write and drains new terminal observations arriving during it', async () => {
    let releaseFirstWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
    let firstAttempt = true;
    const headlines: string[][] = [];
    const snapshots = new Map([['a', runSnapshot('a')]]);
    const publisher = createWorkflowActivityPublisher({
      backendId: 'claude',
      commitRecord: async () => {
        if (firstAttempt) {
          firstAttempt = false;
          await firstWrite;
        }
      },
      writeHeadlines: (bundle) => {
        headlines.push((bundle.workflow.recentRuns ?? []).map((run) => run.runId));
      },
    });
    const scheduler = createCoalescedWorkflowActivityPublisher({ publisher, getSnapshots: () => snapshots });
    scheduler.notify({ changedRunIds: ['a'], startedRunIds: ['a'], terminalRunIds: [], statusChangedRunIds: [] });
    await vi.advanceTimersByTimeAsync(0);
    snapshots.set('a', runSnapshot('a', 'complete'));
    scheduler.notify({ changedRunIds: ['a'], startedRunIds: [], terminalRunIds: ['a'], statusChangedRunIds: [] });
    let flushed = false;
    const flush = scheduler.flush().then(() => { flushed = true; });
    expect(flushed).toBe(false);
    releaseFirstWrite();
    await flush;
    expect(headlines.at(-1)).toEqual(['a']);
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
    snapshots.set('a', { ...runSnapshot('a', status), updatedAt: 2000, totalAgents: 2 });
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

  it('re-queues a drain that threw a retryable error, and drops one the server refused permanently', async () => {
    // The whole-drain catch covers the headline write, which is a separate request from the per-run
    // records. A 503 there is worth another attempt; a 400/403 is the same bytes being refused
    // again, and re-queueing it would create a metadata-write loop for the session's lifetime.
    for (const testCase of [
      { error: createHttpStatusError(503, 'Busy'), expectedPublishes: 2 },
      { error: createHttpStatusError(400, 'Invalid parameters'), expectedPublishes: 1 },
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

  it('does nothing when notified with no changed runs', async () => {
    const { publisher, scheduler } = setup();
    scheduler.notify({ changedRunIds: [], startedRunIds: [], terminalRunIds: [], statusChangedRunIds: [] });
    await vi.advanceTimersByTimeAsync(300);
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('stops publishing after dispose', async () => {
    const { publisher, scheduler } = setup();
    scheduler.notify({ changedRunIds: ['a'], startedRunIds: [], terminalRunIds: [], statusChangedRunIds: [] });
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(300);
    expect(publisher.publish).not.toHaveBeenCalled();
  });
});
