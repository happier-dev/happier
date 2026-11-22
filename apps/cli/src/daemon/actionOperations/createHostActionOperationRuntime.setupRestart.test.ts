import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions';

import { createHostActionOperationRuntime } from './createHostActionOperationRuntime';
import { prepareProjectOpenReceiptPersistence } from './projectOpenReceiptPersistence';

const scope = { accountId: 'account', machineId: 'machine' };

describe('Machine Setup user-service restart', () => {
  it.each([true, false])('settles the retained receipt at replacement readiness (refreshed groups: %s)', async groupsRefreshed => {
    const directory = await mkdtemp(join(tmpdir(), 'setup-user-restart-'));
    try {
      const open = () => prepareProjectOpenReceiptPersistence({ ...scope, directory: join(directory, 'receipts'),
        keyPath: join(directory, 'key.json') });
      const snapshots: ActionOperationSnapshotV1[] = [];
      const operationId = 'setup-before-restart';
      const result = { operationId };
      const runtime = async () => createHostActionOperationRuntime({ machineId: scope.machineId,
        resolveAccountId: async () => scope.accountId, generateOperationId: () => operationId,
        publishSnapshot: snapshot => { snapshots.push(snapshot); }, projectOpenReceiptPersistence: await open() });
      const departing = await runtime();
      const prepared = Promise.withResolvers<void>();
      const dispatched = Promise.withResolvers<void>();
      const restart = vi.fn(async () => { dispatched.resolve(); return 'applied' as const; });
      const admission = await departing.observeExecution({ actionId: 'machines.setup.apply', input: {}, response: 'admission',
        execute: async context => {
          context.restartUserServices?.(restart);
          prepared.resolve();
          return { ok: true, result };
        } });
      expect(admission).toEqual({ ok: true, result: { status: 'accepted', operationId, machineId: scope.machineId } });
      await prepared.promise;
      expect(departing.store.get(scope, operationId)?.state).toBe('running');
      expect(restart).not.toHaveBeenCalled();

      const oldConnection = new AbortController();
      const departingObservation = departing.runner.waitForTerminal(scope, operationId, oldConnection.signal).catch(error => error);
      await dispatched.promise;
      expect(departing.store.get(scope, operationId)).toMatchObject({ state: 'running', cancellation: 'unsupported' });
      oldConnection.abort();
      expect(await departingObservation).toMatchObject({ name: 'AbortError' });

      const replacement = await runtime();
      const terminal = replacement.handlers.getV2({ waitForTerminal: true, operationId });
      expect(await replacement.handlers.getV2({ operationId })).toMatchObject({ kind: 'found', operation: { state: 'running' } });
      expect(snapshots.some(snapshot => snapshot.state === 'succeeded')).toBe(false);
      expect(await replacement.handlers.getV2({ operationId: 'unrelated' })).toEqual({ kind: 'not_found' });

      // The replacement's installed receiver has registered on the Home socket.
      replacement.store.settleRecoveredSetupRestarts(groupsRefreshed);
      const settled = groupsRefreshed ? { state: 'succeeded', result } : { state: 'failed',
        error: { errorCode: 'action_outcome_unknown', effectAttempted: true } };
      expect(await terminal).toMatchObject({ kind: 'found', operation: { operationId, ...settled } });
      expect(await (await runtime()).handlers.getV2({ operationId })).toMatchObject({ kind: 'found', operation: settled });
      expect(restart).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
