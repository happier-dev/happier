import { describe, expect, it, vi } from 'vitest';
import { SESSION_RUNTIME_ACTIVITY_PROJECTION_LEASE_MS } from '@happier-dev/protocol';

import {
  createSessionRuntimeActivityPublisher,
  type CreateSessionRuntimeActivityPublisherOptions,
} from './runtimeActivity.js';

type RuntimeActivitySession = CreateSessionRuntimeActivityPublisherOptions['session'];
const TEST_NOW_MS = 1_000;
const TEST_RENEWAL_NOW_MS = Math.floor(SESSION_RUNTIME_ACTIVITY_PROJECTION_LEASE_MS / 2) + TEST_NOW_MS;

function expiresAt(observedAtMs: number): number {
  return observedAtMs + SESSION_RUNTIME_ACTIVITY_PROJECTION_LEASE_MS;
}

describe('createSessionRuntimeActivityPublisher', () => {
  it('publishes a minimal runtime.activity projection for active and cleared sources', async () => {
    const writeStateField = vi.fn<RuntimeActivitySession['writeStateField']>(async () => {});
    const publisher = createSessionRuntimeActivityPublisher({
      session: { writeStateField },
      nowMs: () => TEST_NOW_MS,
    });

    await publisher.markSourceActive({
      sourceId: 'claude:task-1',
      sourceKind: 'provider_detached_task',
    });

    expect(writeStateField).toHaveBeenLastCalledWith({
      fieldId: 'runtime.activity',
      value: {
        v: 1,
        activeCount: 1,
        observedAtMs: TEST_NOW_MS,
        expiresAtMs: expiresAt(TEST_NOW_MS),
        sourceClass: 'provider_detached_task',
      },
      reason: 'runtime_activity_source_active',
    });

    await publisher.clearSource('claude:task-1');

    expect(writeStateField).toHaveBeenLastCalledWith({
      fieldId: 'runtime.activity',
      value: {
        v: 1,
        activeCount: 0,
        observedAtMs: null,
        expiresAtMs: null,
        sourceClass: null,
      },
      reason: 'runtime_activity_source_cleared',
    });
  });

  it('renews only source-keyed evidence and never ambient liveness', async () => {
    let now = TEST_NOW_MS;
    const writeStateField = vi.fn<RuntimeActivitySession['writeStateField']>(async () => {});
    const publisher = createSessionRuntimeActivityPublisher({
      session: { writeStateField },
      nowMs: () => now,
    });

    await publisher.markSourceActive({
      sourceId: 'claude:task-1',
      sourceKind: 'provider_detached_task',
    });
    now = TEST_RENEWAL_NOW_MS;

    await publisher.renewSource('ambient-query-open');
    expect(writeStateField).toHaveBeenCalledTimes(1);

    await publisher.renewSource('claude:task-1');
    expect(writeStateField).toHaveBeenCalledTimes(2);
    expect(writeStateField).toHaveBeenLastCalledWith({
      fieldId: 'runtime.activity',
      value: {
        v: 1,
        activeCount: 1,
        observedAtMs: TEST_RENEWAL_NOW_MS,
        expiresAtMs: expiresAt(TEST_RENEWAL_NOW_MS),
        sourceClass: 'provider_detached_task',
      },
      reason: 'runtime_activity_source_renewed',
    });
  });

  it('coalesces source-keyed renewals until the projection lease needs extension', async () => {
    let now = TEST_NOW_MS;
    const writeStateField = vi.fn<RuntimeActivitySession['writeStateField']>(async () => {});
    const publisher = createSessionRuntimeActivityPublisher({
      session: { writeStateField },
      nowMs: () => now,
    });

    await publisher.markSourceActive({
      sourceId: 'claude:task-1',
      sourceKind: 'provider_detached_task',
    });
    now = TEST_NOW_MS + 1;

    await publisher.markSourceActive({
      sourceId: 'claude:task-1',
      sourceKind: 'provider_detached_task',
    });
    await publisher.renewSource('claude:task-1');
    expect(writeStateField).toHaveBeenCalledTimes(1);

    now = TEST_RENEWAL_NOW_MS;
    await publisher.renewSource('claude:task-1');

    expect(writeStateField).toHaveBeenCalledTimes(2);
    expect(writeStateField).toHaveBeenLastCalledWith({
      fieldId: 'runtime.activity',
      value: {
        v: 1,
        activeCount: 1,
        observedAtMs: TEST_RENEWAL_NOW_MS,
        expiresAtMs: expiresAt(TEST_RENEWAL_NOW_MS),
        sourceClass: 'provider_detached_task',
      },
      reason: 'runtime_activity_source_renewed',
    });
  });

  it('writes an absolute idle projection for explicit owner-wide clear even when no local sources are known', async () => {
    const writeStateField = vi.fn<RuntimeActivitySession['writeStateField']>(async () => {});
    const publisher = createSessionRuntimeActivityPublisher({
      session: { writeStateField },
      nowMs: () => TEST_NOW_MS,
    });

    await publisher.clearAllSources();

    expect(writeStateField).toHaveBeenCalledWith({
      fieldId: 'runtime.activity',
      value: {
        v: 1,
        activeCount: 0,
        observedAtMs: null,
        expiresAtMs: null,
        sourceClass: null,
      },
      reason: 'runtime_activity_sources_cleared',
    });
  });

  it('retries a failed active projection write without waiting for another source event', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const writes: Parameters<RuntimeActivitySession['writeStateField']>[0][] = [];
      const writeStateField: RuntimeActivitySession['writeStateField'] = async (request) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('socket temporarily unavailable');
        }
        writes.push(request);
      };
      const publisher = createSessionRuntimeActivityPublisher({
        session: { writeStateField },
        nowMs: () => TEST_NOW_MS,
      });

      await expect(publisher.markSourceActive({
        sourceId: 'claude:workflow-task-1',
        sourceKind: 'provider_detached_task',
      })).resolves.toBeUndefined();

      expect(writes).toEqual([]);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(writes).toEqual([
        {
          fieldId: 'runtime.activity',
          value: {
            v: 1,
            activeCount: 1,
            observedAtMs: TEST_NOW_MS,
            expiresAtMs: expiresAt(TEST_NOW_MS),
            sourceClass: 'provider_detached_task',
          },
          reason: 'runtime_activity_source_active',
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('serializes overlapping source writes so a stale active projection cannot land after a clear', async () => {
    let releaseActiveWrite!: () => void;
    const activeWrite = new Promise<void>((resolve) => {
      releaseActiveWrite = resolve;
    });
    const applied: Parameters<RuntimeActivitySession['writeStateField']>[0][] = [];
    const writeStateField = vi.fn<RuntimeActivitySession['writeStateField']>(async (request) => {
      if (writeStateField.mock.calls.length === 1) {
        await activeWrite;
      }
      applied.push(request);
    });
    const publisher = createSessionRuntimeActivityPublisher({
      session: { writeStateField },
      nowMs: () => TEST_NOW_MS,
    });

    const activePromise = publisher.markSourceActive({
      sourceId: 'claude:task-1',
      sourceKind: 'provider_detached_task',
    });
    await vi.waitFor(() => {
      expect(writeStateField).toHaveBeenCalledTimes(1);
    });

    const clearPromise = publisher.clearSource('claude:task-1');
    await Promise.resolve();
    expect(writeStateField).toHaveBeenCalledTimes(1);

    releaseActiveWrite();
    await Promise.all([activePromise, clearPromise]);

    expect(applied).toEqual([
      {
        fieldId: 'runtime.activity',
        value: {
          v: 1,
          activeCount: 1,
          observedAtMs: TEST_NOW_MS,
          expiresAtMs: expiresAt(TEST_NOW_MS),
          sourceClass: 'provider_detached_task',
        },
        reason: 'runtime_activity_source_active',
      },
      {
        fieldId: 'runtime.activity',
        value: {
          v: 1,
          activeCount: 0,
          observedAtMs: null,
          expiresAtMs: null,
          sourceClass: null,
        },
        reason: 'runtime_activity_source_cleared',
      },
    ]);
  });
});
