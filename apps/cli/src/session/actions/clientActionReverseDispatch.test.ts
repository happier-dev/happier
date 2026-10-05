import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps, RPC_METHODS } from '@happier-dev/protocol';
import { createClientActionReverseDispatcher, type ClientActionMachineRpc } from './clientActionReverseDispatch';

function executor(client: ClientActionMachineRpc | null) {
  return createActionExecutor({ clientActionExecute: createClientActionReverseDispatcher(() => client) } as unknown as ActionExecutorDeps);
}

describe('client Action reverse delivery', () => {
  it.each([
    ['ui.find', { op: 'read' }, { ok: true, result: { status: 'unavailable', reason: 'noClient' } }],
    ['session.pending.next', {}, { ok: true, result: { status: 'unavailable' } }],
    ['workspace.tabs.list', {}, { ok: false, errorCode: 'unavailable', error: 'noClient' }],
  ] as const)('returns typed absence for %s with an older or disconnected app', async (actionId, input, result) => {
    await expect(executor({ hasConnectedClientRpcHandler: () => false,
      callConnectedClientRpc: async () => { throw new Error('must not issue'); },
    }).execute(actionId, input, { surface: 'mcp', authority: 'account_automation' })).resolves.toEqual(result);
  });

  it.each(['lost', 'malformed'] as const)('never retries an issued %s result', async disposition => {
    let effects = 0;
    const client: ClientActionMachineRpc = {
      hasConnectedClientRpcHandler: method => method === RPC_METHODS.UI_ACTION_EXECUTE,
      callConnectedClientRpc: async (_method, _request, options) => {
        expect(options.timeoutMs).toBe(null);
        options.onIssued(); effects++;
        if (disposition === 'lost') throw new Error('connection lost');
        return { ok: true, result: { v: 1, execution: { ok: true, result: { status: 'idle', privateText: 'secret' } } } };
      },
    };
    await expect(executor(client).execute('ui.find', { op: 'read' }, { surface: 'agent' }))
      .resolves.toEqual({ ok: false, errorCode: 'outcome_uncertain', error: 'outcome_uncertain' });
    expect(effects).toBe(1);
  });

  it('accepts method disappearance before execution as absence, not a successful effect', async () => {
    const client: ClientActionMachineRpc = {
      hasConnectedClientRpcHandler: () => true,
      callConnectedClientRpc: async (_method, _params, options) => {
        options.onIssued();
        return { ok: false, errorCode: 'RPC_METHOD_NOT_AVAILABLE' };
      },
    };
    await expect(executor(client).execute('workspace.tabs.list', {}, { surface: 'agent' }))
      .resolves.toEqual({ ok: false, errorCode: 'unavailable', error: 'noClient' });
  });
});
