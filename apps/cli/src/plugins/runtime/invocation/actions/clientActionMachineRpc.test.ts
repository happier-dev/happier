import { describe, expect, it } from 'vitest';
import { RPC_METHODS, type UiContributedActionExecuteRequestV1 } from '@happier-dev/protocol';

import { UiContributedActionExecuteResponseV1Schema } from '@happier-dev/protocol/plugins/actions/clientInvocationV1';
import { readPluginActionFailureAuthorPayload } from '@happier-dev/protocol/plugins/actions/invocation';
import { createClientActionMachineRpcExecutor } from './clientActionMachineRpc';

const request: UiContributedActionExecuteRequestV1 = {
  v: 1, action: { pluginId: 'acme.client', localId: 'run' }, input: {},
  surface: 'agent', expectedContributorOccurrenceId: 'acme.client:1',
};

describe('client Action machine RPC outcome custody', () => {
  it.each([
    { clientId: 'app-b', clients: ['app-a', 'app-b'], expected: 'app-b' },
    { clientId: undefined, clients: ['app-b'], expected: 'app-b' },
    { clientId: undefined, clients: ['app-a', 'app-b'], expected: 'client_ambiguous' },
    { clientId: 'disconnected', clients: ['app-a', 'app-b'], expected: 'client_not_available' },
  ])('uses the shared client-choice rule for contributed UI Actions: $expected', async ({ clientId, clients, expected }) => {
    const { selectRpcTarget } = await import('../../../../../../server/sources/app/api/socket/rpc/rpcTargetSelection');
    const effects: string[] = [];
    const execute = createClientActionMachineRpcExecutor(() => ({
      callConnectedClientRpc: async (_method, _request, options) => {
        const targets = clients.map(id => ({ id, timeout: () => ({ emitWithAck: async () => {
          effects.push(id); return { ok: true, result: { client: id } };
        } }) }));
        const selection = selectRpcTarget({ targets, answeringClient: options.answeringClient });
        if (selection.type === 'ambiguous') return { ok: false, errorCode: 'RPC_CLIENT_AMBIGUOUS', answeringClients: selection.clients };
        if (selection.type !== 'target') return { ok: false, errorCode: 'RPC_CLIENT_NOT_AVAILABLE' };
        options.onIssued();
        return { ok: true, result: await selection.target.timeout(0).emitWithAck('rpc-request', {}) };
      },
    }));
    const result = await execute(request, { signal: new AbortController().signal, ...(clientId ? { clientId } : {}) });
    if (expected.startsWith('app-')) {
      expect(result).toMatchObject({ ok: true, result: { client: expected } });
      expect(effects).toEqual([expected]);
    } else {
      expect(result).toMatchObject({ ok: false, errorCode: expected, actionHandlerInvocation: 'notStarted' });
      expect(effects).toEqual([]);
      if (expected === 'client_ambiguous') expect(result).toMatchObject({ data: {
        clients: clients.map(id => ({ id, deviceLabel: null })), recovery: { inputField: 'clientId' },
      } });
    }
  });
  it('uses a live answering UI even without a positive registration hint', async () => {
    const execute = createClientActionMachineRpcExecutor(() => ({
      hasConnectedClientRpcHandler: () => false,
      callConnectedClientRpc: async (_method, _payload, options) => {
        options.onIssued();
        return { ok: true, result: { ok: true, result: { delivered: true } } };
      },
    }));
    expect(await execute(request, {})).toMatchObject({
      ok: true, result: { delivered: true },
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

  it.each(['RPC_METHOD_NOT_AVAILABLE', 'RPC_METHOD_NOT_FOUND'])('retains a definitive %s refusal even after request issuance', async errorCode => {
    const execute = createClientActionMachineRpcExecutor(() => ({
      hasConnectedClientRpcHandler: () => true,
      callConnectedClientRpc: async (_method, _payload, options) => {
        options.onIssued();
        return { ok: false, errorCode };
      },
    }));
    expect(await execute(request, {})).toMatchObject({
      ok: false, errorCode: 'plugin_action_client_target_unavailable', actionHandlerInvocation: 'notStarted',
    });
  });

  it.each([undefined, 'app-b'])('retains a decoded UI retirement refusal as not started (clientId: %s)', async clientId => {
    const execute = createClientActionMachineRpcExecutor(() => ({
      callConnectedClientRpc: async (_method, _payload, options) => {
        options.onIssued();
        return { ok: true, result: { error: 'Method not found', errorCode: 'RPC_METHOD_NOT_FOUND' } };
      },
      hasConnectedClientRpcHandler: () => true,
    }));
    expect(await execute(request, { ...(clientId ? { clientId } : {}) })).toMatchObject({
      ok: false, errorCode: clientId ? 'client_not_available' : 'plugin_action_client_target_unavailable', actionHandlerInvocation: 'notStarted',
    });
  });

  it('refuses an absent machine transport without issuing an effect', async () => {
    expect(await createClientActionMachineRpcExecutor(() => null)(request, {})).toMatchObject({
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


it.each([false, true])('retains a typed transport rejection with issued=%s', async issued => {
  const execute = createClientActionMachineRpcExecutor(() => ({
    callConnectedClientRpc: async (_method, _payload, options) => {
      if (issued) options.onIssued();
      throw Object.assign(new Error('private transport detail'), { code: 'ECONNRESET' });
    },
  }));
  const result = UiContributedActionExecuteResponseV1Schema.parse(await execute(request, {}));
  expect(result).toMatchObject({ ok: false, errorCode: issued ? 'plugin_action_outcome_unknown' : 'plugin_action_client_target_unavailable' });
  expect(readPluginActionFailureAuthorPayload(!result.ok ? result.data : undefined)).toMatchObject({
    failureCause: { errorCode: 'ECONNRESET', errorClass: 'Error' },
  });
  expect(JSON.stringify(result)).not.toContain('private');
});
