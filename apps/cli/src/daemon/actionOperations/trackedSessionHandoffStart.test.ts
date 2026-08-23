import { describe, expect, it, vi } from 'vitest';

import { createActionOperationRunner } from './actionOperationRunner';
import { createActionOperationStore } from './actionOperationStore';
import { createTrackedSessionHandoffStart } from './trackedSessionHandoffStart';

const request = {
  requestId: 'request-1',
  sessionId: 'session-1',
  sourceMachineId: 'machine-1',
  targetMachineId: 'machine-2',
  sessionStorageMode: 'direct' as const,
  targetSessionStorageMode: 'persisted' as const,
  preferredTransportStrategies: ['server_routed_stream'] as const,
};

describe('createTrackedSessionHandoffStart', () => {
  it('returns the historical start receipt while one correlated parent operation owns all phases', async () => {
    const snapshots: import('@happier-dev/protocol').ActionOperationSnapshotV1[] = [];
    const store = createActionOperationStore({ onRevision: (snapshot) => snapshots.push(snapshot) });
    const runner = createActionOperationRunner({ store, createOperationId: () => 'operation-1' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const startUntracked = vi.fn(async () => ({ handoffId: 'handoff-1', status: { status: 'pending' } }));
    const coordinate = vi.fn(async (input, context, startSource) => {
      expect(input.targetSessionStorageMode).toBe('persisted');
      await startSource(input);
      context.update({ progress: { kind: 'phase', phase: 'preparing_target' } });
      await gate;
      return { ok: true as const, result: { handoffId: 'handoff-1', status: { status: 'completed' } } };
    });
    const handle = createTrackedSessionHandoffStart({
      runner,
      getScope: async () => ({ accountId: 'account-1', machineId: 'machine-1' }),
      startUntracked,
      coordinate,
    });

    const first = handle(request);
    await Promise.resolve();
    const duplicate = handle(request);
    await expect(first).resolves.toMatchObject({ handoffId: 'handoff-1' });
    await expect(duplicate).resolves.toMatchObject({ handoffId: 'handoff-1' });
    expect(startUntracked).toHaveBeenCalledTimes(1);
    expect(coordinate).toHaveBeenCalledTimes(1);
    expect(store.list({}, { accountId: 'account-1', machineId: 'machine-1' }).items).toHaveLength(1);

    release();
    await vi.waitFor(() => expect(snapshots.at(-1)).toMatchObject({
      operationId: 'operation-1',
      requestId: 'request-1',
      state: 'succeeded',
      result: { handoffId: 'handoff-1' },
    }));
  });
});
