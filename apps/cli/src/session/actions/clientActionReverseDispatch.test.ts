import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps, RPC_METHODS, UiActionDispatchRequestV1Schema, ActionIdSchema } from '@happier-dev/protocol';
import { createClientActionReverseDispatcher, type ClientActionMachineRpc } from './clientActionReverseDispatch';
import { createCliSettingsDeclarationAction } from './settingsDeclarationAction';

function executor(client: ClientActionMachineRpc | null) {
  return createActionExecutor({ clientActionExecute: createClientActionReverseDispatcher(() => client),
    settingsDeclarationAction: createCliSettingsDeclarationAction({}) } as unknown as ActionExecutorDeps);
}

describe('client Action reverse delivery', () => {
  const reversal = { scope: { serverId: 'home', accountId: 'account' }, beforeVersion: 4, appliedVersion: 5,
    before: { value: 'dark' }, applied: { value: 'light' } };
  it.each([
    { actionId: 'settings.get', input: { anchor: 'appearance.themeMode', includeVersion: true },
      result: { anchor: 'appearance.themeMode', value: 'dark', settingsVersion: 4 } },
    { actionId: 'settings.set', input: { anchor: 'appearance.themeMode', value: 'light', expectedSettingsVersion: 4 },
      result: { anchor: 'appearance.themeMode', value: 'light', settingsVersion: 5 } },
    { actionId: 'settings.set', input: { anchor: 'appearance.themeMode', value: 'light', reversal: { kind: 'capture' } },
      result: { anchor: 'appearance.themeMode', value: 'light', reversal } },
    { actionId: 'settings.set', input: { anchor: 'appearance.themeMode', value: 'dark',
      reversal: { kind: 'restore', ...reversal } }, result: { anchor: 'appearance.themeMode', value: 'dark' } },
  ] as const)('conditional Settings $actionId reaches the answering client without losing its conditions', async request => {
    let deliveries = 0;
    const client: ClientActionMachineRpc = {
      hasConnectedClientRpcHandler: method => method === RPC_METHODS.UI_ACTION_EXECUTE,
      // Machine RPC is the boundary: this is the admitted answering App's typed result.
      callConnectedClientRpc: async (_method, payload, options) => {
        expect(UiActionDispatchRequestV1Schema.parse(payload)).toMatchObject({ actionId: request.actionId, input: request.input });
        options.onIssued(); ++deliveries;
        return { ok: true, result: { v: 1, execution: { ok: true, result: request.result } } };
      },
    };
    const context = { surface: 'cli', authority: 'present_user', presentUserConfirmation: { actionId: request.actionId } } as const;
    expect(await executor(client).execute(request.actionId, request.input, context)).toEqual({ ok: true, result: request.result });
    expect(deliveries).toBe(1);
    expect(await executor(null).execute(request.actionId, request.input, context)).toMatchObject(
      { ok: false, errorCode: 'unavailable', details: { reason: 'client_unavailable', recovery: { kind: 'connect_client' } } });
    expect(await executor(client).execute('settings.get', { anchor: 'delegation.workDepthLimit' }, { surface: 'cli' }))
      .toMatchObject({ ok: false, errorCode: 'not_authenticated' });
    expect(deliveries).toBe(1);
  });

  it('conditional Settings refuses a malformed issued receipt without an ordinary headless fallback', async () => {
    let deliveries = 0;
    const client: ClientActionMachineRpc = {
      hasConnectedClientRpcHandler: () => true,
      callConnectedClientRpc: async (_method, _payload, options) => {
        options.onIssued(); ++deliveries;
        return { ok: true, result: { v: 1, execution: { ok: true, result: {
          anchor: 'appearance.themeMode', value: 'light', reversal: { ...reversal, appliedVersion: 4 },
        } } } };
      },
    };
    expect(await executor(client).execute('settings.set', { anchor: 'appearance.themeMode', value: 'light', reversal: { kind: 'capture' } },
      { surface: 'cli', authority: 'present_user', presentUserConfirmation: { actionId: 'settings.set' } }))
      .toMatchObject({ ok: false, errorCode: 'outcome_uncertain' });
    expect(deliveries).toBe(1);
  });
  it('projects live plugin caller provenance without sending process-local occurrence metadata', async () => {
    const sourceCustody = { kind: 'development', registeredRootId: 'settings-probe-root' } as const;
    const dispatch = createClientActionReverseDispatcher(() => ({
      hasConnectedClientRpcHandler: () => true,
      callConnectedClientRpc: async (_method, payload, options) => {
        expect(UiActionDispatchRequestV1Schema.parse(payload).context.actionCaller).toEqual({
          kind: 'plugin', pluginId: 'example.settings-probe', contributionLocalId: 'inspect', sourceCustody, startedBy: 'user',
        });
        options.onIssued();
        return { ok: true, result: { v: 1, execution: { ok: true, result: { items: [] } } } };
      },
    }));
    expect(await dispatch({ actionId: 'settings.list', input: {}, context: {
      surface: 'cli', authority: 'account_automation', actionCaller: {
        kind: 'plugin', pluginId: 'example.settings-probe', contributionLocalId: 'inspect', sourceCustody,
        occurrenceId: 'live-occurrence', initiatingCaller: { kind: 'host' },
      },
    } })).toEqual({ ok: true, result: { items: [] } });
  });
  it('reads a device setting through the answering client and gives actionable absence', async () => {
    const result = { anchor: 'appearance.themeMode', value: 'dark' };
    const client: ClientActionMachineRpc = {
      hasConnectedClientRpcHandler: method => method === RPC_METHODS.UI_ACTION_EXECUTE,
      callConnectedClientRpc: async (_method, payload, options) => {
        expect(UiActionDispatchRequestV1Schema.parse(payload)).toMatchObject({ actionId: 'settings.get', input: { anchor: 'appearance.themeMode' } });
        options.onIssued();
        return { ok: true, result: { v: 1, execution: { ok: true, result } } };
      },
    };
    expect(await executor(client).execute('settings.get', { anchor: 'appearance.themeMode' }, { surface: 'cli', authority: 'present_user' }))
      .toEqual({ ok: true, result });
    expect(await executor(null).execute('settings.get', { anchor: 'appearance.themeMode' }, { surface: 'cli' }))
      .toMatchObject({ ok: false, errorCode: 'unavailable', error: 'noClient', details: {
        reason: 'client_unavailable', recovery: { kind: 'connect_client', rpcMethod: RPC_METHODS.UI_ACTION_EXECUTE },
      } });
  });
  it('opens an editable authoring draft through the answering client and returns typed absence when it is disconnected', async () => {
    const actionId = ActionIdSchema.parse('session.authoring.open');
    const input = { seed: { prompt: 'Help me author this checkout.', placement: {
      kind: 'exactTarget', serverId: 'home', machineId: 'machine', directory: '/checkout',
    } } };
    const client: ClientActionMachineRpc = {
      hasConnectedClientRpcHandler: method => method === RPC_METHODS.UI_ACTION_EXECUTE,
      callConnectedClientRpc: async (_method, payload, options) => {
        expect(UiActionDispatchRequestV1Schema.parse(payload)).toMatchObject({ actionId, input });
        options.onIssued();
        return { ok: true, result: { v: 1, execution: { ok: true, result: {
          kind: 'opened', draftId: 'draft', destination: 'newSession',
        } } } };
      },
    };
    const context = { surface: 'cli', authority: 'present_user' } as const;
    await expect(executor(client).execute(actionId, input, context)).resolves.toEqual({ ok: true, result: {
      kind: 'opened', draftId: 'draft', destination: 'newSession',
    } });
    await expect(executor(null).execute(actionId, input, context)).resolves.toEqual({ ok: true, result: {
      kind: 'unavailable', reason: 'client_unavailable',
    } });
  });
  it('delivers configured Companion input reads through the admitted client transport and refuses headless delivery', async () => {
    const surface = { serverId: 'home', accountId: 'account', owner: { kind: 'companion', sessionId: 'session' } } as const;
    const ref = { surface, instanceId: 'checks' };
    const bindings = { count: { kind: 'value', value: 7 } } as const;
    const client: ClientActionMachineRpc = {
      hasConnectedClientRpcHandler: method => method === RPC_METHODS.UI_ACTION_EXECUTE,
      callConnectedClientRpc: async (_method, payload, options) => {
        const request = UiActionDispatchRequestV1Schema.parse(payload);
        expect(request).toMatchObject({ actionId: 'widgets.item.inputs.get', input: { ref } });
        options.onIssued();
        return { ok: true, result: { v: 1, execution: { ok: true, result: { ref, bindings } } } };
      },
    };
    const context = { surface: 'agent', defaultSessionId: 'session', serverId: 'home' } as const;
    await expect(executor(client).execute('widgets.item.inputs.get', { ref }, context))
      .resolves.toEqual({ ok: true, result: { ref, bindings } });
    await expect(executor(null).execute('widgets.item.inputs.get', { ref }, context))
      .resolves.toEqual({ ok: false, errorCode: 'unavailable', error: 'noClient' });
    expect(UiActionDispatchRequestV1Schema.safeParse({ v: 1, actionId: 'widgets.item.inputs.get',
      input: { ref: { ...ref, surface: { ...surface, owner: { kind: 'home' } } } },
      context: { surface: 'agent', authority: 'account_automation' } }).success).toBe(false);
  });
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
