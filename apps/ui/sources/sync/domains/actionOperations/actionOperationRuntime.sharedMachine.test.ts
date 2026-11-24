import { describe, expect, it } from 'vitest';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions';
import type { ActionOperationGetV1Response } from '@happier-dev/protocol/actions/operations/v1';
import { RpcError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

import { createActionOperationStore } from './actionOperationStore';
import { followSharedMachineActionOperations } from './actionOperationRuntime';

const serverId = 'server-a';
const accountId = 'ann';

function operation(
  operationId: string,
  machineId: string,
  revision: number,
  state: ActionOperationSnapshotV1['state'] = 'running',
  label?: string,
): ActionOperationSnapshotV1 {
  return {
    version: 1,
    operationId,
    revision,
    actionId: 'projects.script.run',
    state,
    scope: { accountId, machineId },
    title: 'Hold',
    createdAt: 1,
    startedAt: 2,
    cancellation: 'unsupported',
    ...(label ? { progress: { kind: 'phase', phase: 'running', label } } : {}),
    ...(state === 'succeeded' ? { settledAt: 3, result: {} } : {}),
  } as ActionOperationSnapshotV1;
}

/** The Machine RPC transport is the boundary: each held read stays open until the test answers it. */
function heldReads() {
  const open: {
    params: Readonly<{
      machineId: string;
      operationId: string;
      sinceRevision?: number;
      waitForTerminal?: true;
    }>;
    answer(response: ActionOperationGetV1Response): void;
    refuse(error: unknown): void;
  }[] = [];
  const read = (
    params: Readonly<{
      machineId: string;
      operationId: string;
      sinceRevision?: number;
      waitForTerminal?: true;
    }>,
  ) =>
    new Promise<ActionOperationGetV1Response>((answer, refuse) => {
      open.push({ params, answer, refuse });
    });
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { open, read, settle };
}

describe('shared-Machine operation updates', () => {
  it("holds one next-revision read per open operation on another Account's Machine and shows its progress without a new action", async () => {
    const store = createActionOperationStore();
    store.mergeSnapshots({
      serverId,
      snapshots: [
        operation('foreign', 'shared', 2),
        operation('own', 'mine', 5),
      ],
    });
    const reads = heldReads();
    const follower = followSharedMachineActionOperations({
      scope: { serverId, accountId },
      sharedMachineIds: new Set(['shared']),
      store,
      read: reads.read,
    });
    try {
      await reads.settle();
      // One held read, for the foreign operation only; the owner's own operation keeps its Account push.
      expect(
        reads.open.map((read) => [
          read.params.operationId,
          read.params.sinceRevision,
          read.params.waitForTerminal,
        ]),
      ).toEqual([['foreign', 2, true]]);

      reads.open
        .shift()!
        .answer({
          kind: 'found',
          operation: operation('foreign', 'shared', 3, 'running', 'Holding'),
        });
      await reads.settle();
      const shown = [...store.getSnapshot().operationsByKey.values()].find(
        (entry) => entry.snapshot.operationId === 'foreign',
      );
      expect(shown?.snapshot).toMatchObject({
        revision: 3,
        progress: { label: 'Holding' },
      });
      expect(
        reads.open.map((read) => [
          read.params.operationId,
          read.params.sinceRevision,
        ]),
      ).toEqual([['foreign', 3]]);

      reads.open
        .shift()!
        .answer({
          kind: 'found',
          operation: operation('foreign', 'shared', 4, 'succeeded'),
        });
      await reads.settle();
      // Terminal: no further read.
      expect(reads.open).toHaveLength(0);
    } finally {
      follower.dispose();
    }
  });

  it("stops at the next read when the requester's grant is withdrawn, and reads nothing with no open foreign operation", async () => {
    const store = createActionOperationStore();
    const reads = heldReads();
    const follower = followSharedMachineActionOperations({
      scope: { serverId, accountId },
      sharedMachineIds: new Set(['shared']),
      store,
      read: reads.read,
    });
    try {
      await reads.settle();
      expect(reads.open).toHaveLength(0);
      store.mergeSnapshots({
        serverId,
        snapshots: [operation('foreign', 'shared', 2)],
      });
      await reads.settle();
      expect(reads.open).toHaveLength(1);
      reads.open
        .shift()!
        .refuse(new RpcError('forbidden', RPC_ERROR_CODES.FORBIDDEN));
      await reads.settle();
      expect(reads.open).toHaveLength(0);
    } finally {
      follower.dispose();
    }
  });
});
