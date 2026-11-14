import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ACTION_OPERATION_RPC_METHODS_V2, ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { MachineReachabilityConfigureResultV1Schema } from '@happier-dev/protocol/machines/reachability/actionsV1';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createActionOperationRunner } from './actionOperationRunner';
import { createActionOperationStore } from './actionOperationStore';
import { createActionOperationRpcHandlers, registerActionOperationRpcHandlers } from './actionOperationRpcHandlers';
import { prepareProjectOpenReceiptPersistence } from './projectOpenReceiptPersistence';

const scope = { accountId: 'network-owner', machineId: 'network-machine' };
const actionId = 'machines.reachability.configure';
const recovery = {
  rules: { kind: 'file', content: 'table inet happier {\n  # prior owned rules\n}\n' },
  unit: { kind: 'file', content: '[Unit]\nDescription=Prior firewall\n' },
  table: 'table inet happier {\n}\n',
  boot: { present: true, enabled: false, running: true },
};
const result = {
  status: 'applied', machineId: scope.machineId, metadataVersion: 2,
  posture: { revision: 1, management: { providers: [], publicSsh: { kind: 'closed' } },
    defaultServiceIngress: { kind: 'none' } },
  selections: [], observation: { revision: 1, management: { daemon: 'ready', providers: [], publicSsh: 'closed' },
    privateNetworks: [], ingress: [] }, recovery,
};

describe('Network recovery in the retained Action outcome', () => {
  it('preserves the exact native capture through the public Configure output schema', () => {
    expect(MachineReachabilityConfigureResultV1Schema.parse(result)).toEqual(result);
  });

  it('admits only the returned uncertain Configure facts in an uncertain operation', () => {
    const snapshot = { version: 1, operationId: 'network-operation', revision: 2, actionId, scope,
      title: 'Network', createdAt: 1, startedAt: 1, state: 'running', cancellation: 'unsupported',
      observation: { kind: 'outcome_uncertain', code: 'action_outcome_unknown' },
      result: { ...result, status: 'outcome_unknown', errorCode: 'action_outcome_unknown' } };
    expect(ActionOperationSnapshotV1Schema.parse(snapshot).result).toEqual(snapshot.result);
    for (const invalid of [
      { ...snapshot, result },
      { ...snapshot, observation: undefined },
      { ...snapshot, observation: { kind: 'outcome_uncertain', code: 'unrelated' } },
      { ...snapshot, actionId: 'machines.services.adopt' },
    ]) expect(ActionOperationSnapshotV1Schema.safeParse(invalid).success).toBe(false);
  });

  it.each(['applied', 'outcome_unknown'] as const)('serves the encrypted saved %s outcome to a fresh scoped reader after runner and task memory are gone', async status => {
    const outcome = { ...result, status, ...(status === 'outcome_unknown' ? { errorCode: 'action_outcome_unknown' } : {}) };
    const directory = await mkdtemp(join(tmpdir(), 'network-recovery-'));
    try {
      const open = () => prepareProjectOpenReceiptPersistence({ directory: join(directory, 'receipts'),
        keyPath: join(directory, 'key.json'), ...scope });
      const persistence = await open();
      // Disk/encryption is the boundary; the runner and retention owner remain real.
      const save = vi.spyOn(persistence, 'save');
      const store = createActionOperationStore({ projectOpenReceiptPersistence: persistence });
      const spec = getActionSpec(actionId);
      const runner = createActionOperationRunner({ store, generateOperationId: () => 'network-operation',
        resolveAction: () => ({ actionId, title: spec.title, operation: spec.operation, operationReentry: spec.operationReentry }) });
      expect(await runner.observe({ actionId, scope, requestId: 'network-request', input: {},
        execute: async ({ updateProgress }) => {
          const writesBeforeProgress = save.mock.calls.length;
          updateProgress({ phase: 'native.check', label: 'Checking firewall' });
          updateProgress({ phase: 'native.apply', label: 'Applying firewall' });
          expect(save.mock.calls.length).toBe(writesBeforeProgress);
          return { ok: true, result: outcome };
        } })).toEqual({ ok: true, result: outcome });

      // No task adapter, original runner or SSH connection is used by the fresh reader.
      const restored = createActionOperationStore({ projectOpenReceiptPersistence: await open() });
      const rpc = new RpcHandlerManager({ scopePrefix: scope.machineId, encryptionMode: 'plain' });
      let readerAccountId = scope.accountId;
      registerActionOperationRpcHandlers(rpc, createActionOperationRpcHandlers({ store: restored,
        runner: createActionOperationRunner({ store: restored, resolveAction: () => null }),
        machineId: scope.machineId, resolveAccountId: async () => readerAccountId }));
      expect(await rpc.invokeLocal(ACTION_OPERATION_RPC_METHODS_V2.get, { operationId: 'network-operation' }))
        .toMatchObject({ kind: 'found', operation: { state: status === 'applied' ? 'succeeded' : 'failed', result: outcome } });
      expect(save.mock.calls.map(([receipt]) => receipt.snapshot.state))
        .toEqual(status === 'applied' ? ['accepted', 'succeeded'] : ['accepted', 'running']);
      readerAccountId = 'another-account';
      expect(await rpc.invokeLocal(ACTION_OPERATION_RPC_METHODS_V2.get, { operationId: 'network-operation' }))
        .toEqual({ kind: 'not_found' });

      for (const partition of await readdir(join(directory, 'receipts'))) {
        for (const name of await readdir(join(directory, 'receipts', partition))) {
          const bytes = await readFile(join(directory, 'receipts', partition, name), 'utf8');
          expect(bytes).not.toContain('prior owned rules');
          expect(bytes).not.toContain('Prior firewall');
        }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
