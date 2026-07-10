import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
  type SessionWorkflowRunSnapshotV1,
} from '@happier-dev/plugin-sdk/experimental/sessions/workState';

import { createCoalescedWorkflowActivityPublisher } from './coalescedWorkflowActivityPublisher.js';
import type { WorkflowActivityPublishInput } from './publishWorkflowActivitySnapshot.js';

function runSnapshot(runId: string): SessionWorkflowRunSnapshotV1 {
  return {
    v: 1,
    projectionVersion: SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
    runId,
    backendId: 'claude',
    title: `Run ${runId}`,
    status: 'active',
    recordRevision: '1',
    updatedAt: 1000,
    totalAgents: 1,
    completedAgents: 0,
    phases: [],
    agents: [],
  };
}

describe('createCoalescedWorkflowActivityPublisher', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('requeues failed run ids returned by the publisher for a delayed retry', async () => {
    const publishes: WorkflowActivityPublishInput[] = [];
    let attempt = 0;
    const publisher = {
      publish: vi.fn(async (input: WorkflowActivityPublishInput) => {
        publishes.push(input);
        attempt += 1;
        return { failedRunIds: attempt === 1 ? ['a'] : [], permanentFailedRunIds: [] };
      }),
    };
    const scheduler = createCoalescedWorkflowActivityPublisher({
      publisher,
      getSnapshots: () => new Map([['a', runSnapshot('a')]]),
      debounceMs: 300,
    });

    scheduler.notify({ changedRunIds: ['a'], startedRunIds: [], terminalRunIds: ['a'], statusChangedRunIds: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(publisher.publish).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(299);
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(publisher.publish).toHaveBeenCalledTimes(2);
    expect(publishes[1]?.changedRunIds).toEqual(['a']);
  });

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
