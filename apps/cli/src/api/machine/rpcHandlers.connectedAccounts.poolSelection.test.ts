import { describe, expect, it } from 'vitest';
import { CONNECTED_SERVICE_POOL_SELECTION_RPC_METHOD, type ConnectedServicePoolSelectionGetResponseV1 } from '@happier-dev/protocol/connect/connectedServicePoolSelection';
import type { RpcHandler, RpcHandlerContext } from '../rpc/types';
import { registerMachineConnectedAccountRpcHandlers } from './rpcHandlers.connectedAccounts';

const group = { service: { pluginId: 'example.accounts', localId: 'service' }, groupId: 'pool' };
const projection = {
  group, observedAtMs: 1_000,
  selection: {
    selected: null, reason: 'manual_strategy', excluded: [],
    decisionTrace: {
      activeProfileId: 'account', reason: 'manual_strategy', strategy: 'manual', selectionBasis: 'manual_strategy',
      sticky: false, orderedEligibleCandidates: [], candidates: [],
    },
  },
} as const;

function register(readPoolSelection: () => Promise<unknown>) {
  const handlers = new Map<string, RpcHandler<unknown, unknown>>();
  registerMachineConnectedAccountRpcHandlers({
    machineId: 'machine', getRuntime: () => null,
    // The owner port is a wire boundary; malformed fixtures deliberately violate its declared result.
    getPoolSelectionRead: () => async () => await readPoolSelection() as ConnectedServicePoolSelectionGetResponseV1,
    rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } },
  });
  const handler = handlers.get(CONNECTED_SERVICE_POOL_SELECTION_RPC_METHOD);
  if (!handler) throw new Error('pool selection read is not registered');
  return handler;
}

describe('connected-account pool selection RPC', () => {
  it('returns the owner projection and refuses a different machine without reading it', async () => {
    const handler = register(async () => projection);
    const context = { signal: new AbortController().signal } satisfies RpcHandlerContext;
    await expect(handler({ machineId: 'machine', group }, context)).resolves.toEqual(projection);
    const rejectingHandler = register(async () => { throw new Error('wrong machine must not read'); });
    await expect(rejectingHandler({ machineId: 'other', group }, context)).resolves.toEqual({
      status: 'unavailable', code: 'connected_account_daemon_owner_unavailable',
    });
  });

  it('withholds owner data after cancellation or loss of admitted machine authority', async () => {
    const controller = new AbortController();
    const cancelled = register(async () => { controller.abort(); return projection; });
    await expect(cancelled({ machineId: 'machine', group }, { signal: controller.signal })).resolves.toMatchObject({ status: 'unavailable' });
    let current = true;
    const retired = register(async () => { current = false; return projection; });
    await expect(retired({ machineId: 'machine', group }, {
      signal: new AbortController().signal, verifyMachineAdmissionCurrent: async () => current,
    })).resolves.toMatchObject({ status: 'unavailable' });
  });

  it('refuses malformed owner data rather than returning an opaque success', async () => {
    const handler = register(async () => ({ ...projection, selection: { ...projection.selection, unexpected: true } }));
    await expect(handler({ machineId: 'machine', group })).resolves.toEqual({
      status: 'unavailable', code: 'connected_account_daemon_response_invalid',
    });
    const mismatched = register(async () => ({ ...projection, group: { ...group, groupId: 'another-pool' } }));
    await expect(mismatched({ machineId: 'machine', group })).resolves.toEqual({
      status: 'unavailable', code: 'connected_account_daemon_response_invalid',
    });
  });
});
