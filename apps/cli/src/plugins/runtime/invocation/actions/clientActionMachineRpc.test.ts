import { describe, expect, it } from 'vitest';
import { RPC_METHODS, type UiContributedActionExecuteRequestV1 } from '@happier-dev/protocol';

import { createClientActionMachineRpcExecutor } from './clientActionMachineRpc';

const request: UiContributedActionExecuteRequestV1 = {
  v: 1, action: { pluginId: 'acme.client', localId: 'run' }, input: {},
  surface: 'agent', expectedContributorOccurrenceId: 'acme.client:1',
};

describe('client Action machine RPC outcome custody', () => {
  it('refuses a missing answering UI before issuing any effect', async () => {
    const execute = createClientActionMachineRpcExecutor(() => ({
      hasConnectedClientRpcHandler: () => false,
      callConnectedClientRpc: async () => { throw new Error('Must not issue without an answering UI'); },
    }));
    expect(await execute(request, {})).toMatchObject({
      ok: false, errorCode: 'plugin_action_client_target_unavailable', actionHandlerInvocation: 'notStarted',
    });
  });

  it('preserves known client results and caller lifetime through the existing machine RPC', async () => {
    const abort = new AbortController();
    const execute = createClientActionMachineRpcExecutor(() => ({
      hasConnectedClientRpcHandler: () => true,
      callConnectedClientRpc: async (method, payload, options) => {
        expect(method).toBe(RPC_METHODS.UI_CONTRIBUTED_ACTION_EXECUTE);
        expect(payload).toEqual(request);
        expect(options.signal).toBe(abort.signal);
        expect(options.timeoutMs).toBeNull();
        options.onIssued();
        return { ok: true, result: { ok: true, result: { sessionId: 'new-session' } } };
      },
    }));
    expect(await execute(request, { signal: abort.signal })).toEqual({
      ok: true, result: { sessionId: 'new-session' },
    });
  });

  it('reports an issued transport loss as unknown without replaying the effect', async () => {
    let issuedRequests = 0;
    const execute = createClientActionMachineRpcExecutor(() => ({
      hasConnectedClientRpcHandler: () => true,
      callConnectedClientRpc: async (_method, _payload, options) => {
        issuedRequests += 1;
        options.onIssued();
        return { ok: false, errorCode: 'machine_socket_unavailable' };
      },
    }));
    const result = await execute(request, {});
    expect(result).toMatchObject({ ok: false, errorCode: 'plugin_action_outcome_unknown' });
    expect(result).not.toHaveProperty('actionHandlerInvocation');
    expect(issuedRequests).toBe(1);
  });

  it('retains a definitive RPC-method refusal even after request issuance', async () => {
    const execute = createClientActionMachineRpcExecutor(() => ({
      hasConnectedClientRpcHandler: () => true,
      callConnectedClientRpc: async (_method, _payload, options) => {
        options.onIssued();
        return { ok: false, errorCode: 'RPC_METHOD_NOT_AVAILABLE' };
      },
    }));
    expect(await execute(request, {})).toMatchObject({
      ok: false, errorCode: 'plugin_action_client_target_unavailable', actionHandlerInvocation: 'notStarted',
    });
  });

  it('does not accept a malformed success as an effect outcome', async () => {
    const execute = createClientActionMachineRpcExecutor(() => ({
      hasConnectedClientRpcHandler: () => true,
      callConnectedClientRpc: async (_method, _payload, options) => {
        options.onIssued();
        return { ok: true, result: { ok: true, result: null, caller: { kind: 'host' } } };
      },
    }));
    expect(await execute(request, {})).toMatchObject({ ok: false, errorCode: 'plugin_action_outcome_unknown' });
  });
});
