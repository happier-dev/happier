import axios, { AxiosHeaders } from 'axios';
import tweetnacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';
import { MACHINE_ACCESS_LOSS_SERVER_ORIGIN } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent, type MachineRpcAdmissionBoundary } from '@/api/machine/machineRpcAuthorization';
import { registerMachineAccessLossReceiver } from '@/daemon/externalActions/registerMachineAccessLossReceiver';
import { createHostActionOperationRuntime } from './createHostActionOperationRuntime';

describe('finite operation authenticated access-loss custody', () => {
  it('lets already admitted finite work finish after access loss at the next request boundary', async () => {
    let nextId = 0;
    const runtime = createHostActionOperationRuntime({ serverId: 'home', machineId: 'machine', resolveAccountId: async () => 'alice',
      custodyBinding: { serverId: 'home', installationId: 'installation' },
      generateOperationId: () => `operation-${++nextId}` });
    const releases: (() => void)[] = [];
    const owners = new Map<string, AbortSignal>();
    const keys = tweetnacl.sign.keyPair();
    // Only Home HTTP is substituted; signed verification, receiver, operation
    // scope, runner cancellation and terminal observation remain real.
    const network = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { v: 1, ok: true },
      statusText: '', headers: {}, config: { headers: new AxiosHeaders() } });
    try {
      const boundary: MachineRpcAdmissionBoundary = { machineId: 'machine', resolveCustodianAccountId: async () => 'alice', resolveInstallationId: () => 'installation',
        verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input,
          privateKey: keys.secretKey, daemonToken: 'daemon', serverHttpBaseUrl: 'https://home.invalid' }) };
      const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain',
        authorizeRequest: request => authorizeMachineRpcRequest(request, boundary) });
      registerMachineAccessLossReceiver(rpc, { serverId: 'home', machineId: 'machine', resolveInstallationId: () => 'installation' });
      rpc.registerHandler('execute', (_input: unknown, context) => runtime.observeExecution({ actionId: 'projects.compute.exec', input: {},
        rpcContext: context,
        execute: async operation => {
          owners.set(context!.machineAdmission!.actorAccountId, operation.signal);
          operation.operationOwnerUpdate.update({ domainRef: { kind: 'projectCommand', purpose: 'exec', serverId: 'home',
            machineId: 'machine', workspaceRefId: 'workspace', cwd: '/project' } });
          await new Promise<void>(resolve => releases.push(resolve));
          return operation.signal.aborted ? { ok: false, errorCode: 'cancelled', error: 'cancelled' } : { ok: true, result: {} };
        } }));
      for (const accountId of ['bob', 'carol', 'alice']) expect(await rpc.handleRequest({ method: 'machine:execute', params: {},
        machineAdmission: { actorAccountId: accountId, custodianAccountId: 'alice', machineId: 'machine',
          installationId: 'installation', role: 'use', encryptionMode: 'plain' } })).toMatchObject({ ok: true });
      const request = { method: `machine:${RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS}`, params: { v: 1, subjectAccountId: 'bob' },
        authorization: MACHINE_ACCESS_LOSS_SERVER_ORIGIN, machineAdmission: { actorAccountId: 'alice', custodianAccountId: 'alice',
          machineId: 'machine', installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const } };
      expect(await rpc.handleRequest({ ...request, authorization: undefined })).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
      expect(owners.get('bob')?.aborted).toBe(false);
      const interrupted = new Promise<'interrupted'>(resolve => {
        owners.get('bob')!.addEventListener('abort', () => resolve('interrupted'), { once: true });
      });
      const retirement = rpc.handleRequest(request);
      expect(await Promise.race([retirement.then(() => 'settled'), interrupted])).toBe('settled');
      expect(owners.get('bob')?.aborted).toBe(false);
      expect(owners.get('carol')?.aborted).toBe(false);
      expect(owners.get('alice')?.aborted).toBe(false);
      expect(runtime.store.get({ accountId: 'bob', machineId: 'machine' }, 'operation-1')).toMatchObject({ state: 'accepted' });
      releases[0]!();
      expect(await retirement).toEqual({ kind: 'settled' });
      expect(await runtime.runner.waitForTerminal({ accountId: 'bob', machineId: 'machine' }, 'operation-1')).toMatchObject({ state: 'succeeded' });
      expect(await rpc.handleRequest(request)).toEqual({ kind: 'settled' });
    } finally { releases.forEach(release => release()); network.mockRestore(); }
  });
});
