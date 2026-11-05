import { describe, expect, it, vi, onTestFinished } from 'vitest';
import axios from 'axios';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { MachineSetupPlanResultV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MachineSetupSourceV1Schema } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import { getActionSpec } from '@happier-dev/protocol/actions';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { readMachineActionRpcResult } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import { createActionOperationRunner } from '@/daemon/actionOperations/actionOperationRunner';
import { unwrapActionResultForRpc } from '@/rpc/handlers/registerActionSpecRpcHandlers';
import { requireActionSuccess } from '../../../../ui/sources/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { createNativeSoftwareInstallFixture } from '@/testkit/machines/nativeSoftwareInstall';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { decodeBase64, encodeBase64, encrypt, decrypt } from '@/api/encryption';
import { socketRpcCodec, type SocketRpcContent } from '@happier-dev/sync-client';

describe('Setup failure carrier composition', () => {
  it.each(['plain', 'e2ee'] as const)('retains ENOSPC from apply through the operation reread, %s RPC and UI failure without credential text', async mode => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt' });
    const sources = MachineSetupSourceV1Schema.parse([{ kind: 'accountPreset', presetId: 'disk-full-preset',
      presetRevision: 1, setup: fixture.sources[0]!.setup }, { kind: 'direct', setup: {} }]);
    const plan = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({
      input: { homeId: 'srv_home', machineId: fixture.machine.id, sources, mode: 'effects' },
      context: fixture.context('machines.setup.plan'),
    }));
    const store = createActionOperationStore();
    const spec = getActionSpec('machines.setup.apply');
    const scope = { accountId: 'alice', machineId: fixture.machine.id };
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'disk-full',
      resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation! }) });
    // The Home HTTP adapter is an external boundary; the Setup owner and operation store stay real.
    const http = vi.spyOn(axios, 'post').mockRejectedValueOnce(Object.assign(new Error(
      'disk full at /var/cache/packages password=PRIVATE_SECRET token=PRIVATE_TOKEN private_key=/home/private/credential',
    ), { code: 'ENOSPC' }));
    onTestFinished(() => http.mockRestore());
    const execute = async () => ActionExecuteFailureSchema.parse(await fixture.apply({ input: {
      homeId: 'srv_home', machineId: fixture.machine.id, desiredRevision: plan.desiredRevision,
      sources: plan.sources, exclusions: plan.exclusions, recipePlans: plan.recipePlans ?? [],
    }, context: { ...fixture.context('machines.setup.apply'),
      operationAcceptance: { actionId: spec.id, operationId: 'disk-full', accept() {} }, operationOwnerUpdate: { update() {} } } }));
    const result = await runner.observe({ actionId: spec.id, scope, requestId: 'disk-full', execute });
    expect(result).toMatchObject({ ok: false, errorCode: 'ENOSPC' });
    const reread = await runner.observe({ actionId: spec.id, scope, requestId: 'disk-full', execute });
    const key = new Uint8Array(32).fill(23);
    const content: SocketRpcContent = mode === 'plain' ? { mode: 'plain' } : { mode: 'e2ee', cipher: {
      encryptRaw: async value => encodeBase64(encrypt(key, 'dataKey', value)),
      decryptRaw: async value => decrypt(key, 'dataKey', decodeBase64(value)),
    } };
    const rpc = new RpcHandlerManager({ scopePrefix: 'carrier', logger: () => {},
      ...(mode === 'plain' ? { encryptionMode: 'plain' as const } : { encryptionKey: key, encryptionVariant: 'dataKey' as const }) });
    for (const failure of [result, reread]) {
      const wire = unwrapActionResultForRpc(spec.id, failure);
      // Reconstruct the Action failure as the receiving RPC handler would, then
      // exercise the real catch, encryption and receiving Action boundary.
      const raw = wire && typeof wire === 'object'
        ? Object.fromEntries(Object.entries(wire).filter(([name]) => name !== 'ok')) : wire;
      rpc.registerHandler('failure', async () => readMachineActionRpcResult(raw));
      const method = 'carrier:failure';
      const callId = '0123456789abcdef0123456789abcdef';
      const params = await socketRpcCodec.encodeParams(content, {}, { method, callId });
      const response = await rpc.handleRequest({ method, params });
      const opened = await socketRpcCodec.decodeResult(content, { ok: true, result: response }, callId);
      let uiFailure: unknown;
      try { readMachineActionRpcResult(opened); }
      catch (error) {
        try { requireActionSuccess({ ok: false, ...normalizeActionExecutorThrownError(error) }); }
        catch (presented) { uiFailure = presented; }
      }
      expect(uiFailure).toMatchObject({ failureCause: { errorCode: 'ENOSPC', phase: 'machines.setup.apply' } });
      expect(JSON.stringify(wire)).not.toContain('/home/private/credential');
      expect(JSON.stringify(wire)).not.toContain('PRIVATE_SECRET');
      expect(JSON.stringify(wire)).not.toContain('PRIVATE_TOKEN');
      expect(String(uiFailure)).not.toContain('/home/private/credential');
    }
    expect(store.get(scope, 'disk-full')).toMatchObject({ state: 'failed', error: {
      failureCause: { errorCode: 'ENOSPC', phase: 'machines.setup.apply' },
    } });
  });
});
