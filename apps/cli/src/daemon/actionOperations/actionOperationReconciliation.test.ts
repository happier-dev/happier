import { describe, expect, it } from 'vitest';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions';
import { createExecutionRunProjectSetupProjection, createExecutionRunProjectSetupProjectionOwner,
  projectExecutionRunSetupBase } from '@/agent/runtime/bridges/executionRun/executionRunProjectSetup';
import { createHostActionOperationRuntime } from './createHostActionOperationRuntime';

describe('native Action operation read reconciliation', () => {
  it('reads retained native history without republishing unchanged receipts, while publishing one real owner change', async () => {
    const scope = { accountId: 'account', machineId: 'machine' };
    const subscribers: ActionOperationSnapshotV1[][] = [[], []];
    // These sinks stand for two network subscribers; all lifecycle/projection logic is real.
    const runtime = createHostActionOperationRuntime({ machineId: scope.machineId,
      resolveAccountId: async () => scope.accountId,
      publishSnapshot: snapshot => { for (const subscriber of subscribers) subscriber.push(snapshot); } });
    const setups = new Map<string, ReturnType<typeof createExecutionRunProjectSetupProjection>>();
    const listeners = new Set<(id: string) => void>();
    const createdAt = Date.now();
    // More durable receipts than the host's 50-receipt retention. This models the
    // hundreds-of-frames shape, not an asserted census of the encrypted live window.
    for (let index = 0; index < 435; index++) {
      const runId = `settled-${index}`;
      setups.set(runId, createExecutionRunProjectSetupProjection({ runId, scope,
        signal: new AbortController().signal,
        readBaseSnapshot: () => projectExecutionRunSetupBase({ runId, status: 'succeeded',
          startedAtMs: createdAt + index, finishedAtMs: createdAt + index }, scope),
        publish: () => { for (const listener of listeners) listener(runId); } }));
    }
    const runId = 'real-active-run';
    const active = createExecutionRunProjectSetupProjection({ runId, scope,
      signal: new AbortController().signal,
      readBaseSnapshot: () => projectExecutionRunSetupBase({ runId, status: 'running', startedAtMs: createdAt }, scope),
      publish: () => { for (const listener of listeners) listener(runId); } });
    setups.set(runId, active);
    const owner = createExecutionRunProjectSetupProjectionOwner({ getSetup: id => setups.get(id),
      listIds: () => [...setups.keys()],
      waitForChange: async () => { throw new Error('No terminal wait is requested'); },
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); } } });
    const detach = runtime.attachOwner(owner);
    try {
      await runtime.handlers.listV2({});
      const retained = runtime.store.get(scope, runId);
      for (const subscriber of subscribers) subscriber.length = 0;
      for (let repeat = 0; repeat < 10; repeat++) await runtime.handlers.listV2({});
      expect(subscribers.map(rows => rows.length), 'equal native history must produce zero publications per subscriber').toEqual([0, 0]);
      expect(runtime.store.get(scope, runId)).toBe(retained);

      const before = active.snapshot()!;
      active.context.operationProgress.update({ phase: 'executing', label: 'Running' });
      await new Promise<void>(resolve => setImmediate(resolve));
      for (const subscriber of subscribers) {
        expect(subscriber).toHaveLength(1);
        expect(subscriber[0]).toMatchObject({ operationId: runId, revision: before.revision + 1,
          progress: { phase: 'executing' } });
      }
      for (let repeat = 0; repeat < 10; repeat++) await runtime.handlers.listV2({});
      expect(subscribers.map(rows => rows.length)).toEqual([1, 1]);
    } finally { detach(); }
  });
});
