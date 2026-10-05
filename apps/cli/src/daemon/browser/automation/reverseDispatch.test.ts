import { describe, expect, it, vi } from 'vitest';
import {
  UiBrowserAutomationDispatchRequestV1Schema,
  UiBrowserAutomationDispatchResultV1Schema,
  uiBrowserAutomationDispatchMethod,
  getActionSpec,
  createActionExecutor,
  FeaturesResponseSchema,
  type RuntimeActionExecuteArgs,
} from '@happier-dev/protocol';

import { createBrowserDaemonRuntimeActionExecutor } from '../actions/runtimeActionExecutor';
import { createBrowserSidecarCdpControlAdapter } from '../sidecar/controlAdapter';
import { createBrowserDaemonControlBroker } from '../control/broker';
import { createBrowserAutomationReverseDispatcher } from './reverseDispatch';
import { createDaemonRuntimeActionExecutor } from '../../runtimeActionExecutor';

const view = { browserSessionId: 'visible-session', viewId: 'visible-view' };
const request = { v: 1, ...view, automationRequestId: 'click-1', actionKind: 'click', navigationGeneration: 0,
  requestedBy: 'agent', requesterRef: { kind: 'agent', id: 'agent-1' }, timeoutMs: 1000, payload: { selector: '#button' } } as const;
const args: RuntimeActionExecuteArgs = { actionId: 'browser.automation.click', input: request,
  context: { surface: 'agent', authority: 'account_automation', defaultSessionId: 'happier-session' } };

describe('daemon browser reverse dispatch protocol boundary', () => {
  it.each(['takeControl', 'handBack'] as const)('routes %s to a client-owned slot without provisioning', async kind => {
    const uiAutomation = createBrowserAutomationReverseDispatcher({ getMachineClient: () => ({
      hasConnectedClientRpcHandler: method => method === uiBrowserAutomationDispatchMethod(view),
      callConnectedClientRpc: async (_method, payload) => {
        const wire = UiBrowserAutomationDispatchRequestV1Schema.parse(payload);
        expect(wire.sessionId).toBe(args.context.defaultSessionId);
        return { ok: true, result: { v: 1, status: 'dispatched', commandId: kind, adapterKind: 'localPreview', events: [],
        } };
      },
    }) });
    const execute = createBrowserDaemonRuntimeActionExecutor({ featureGate: { isEnabled: () => true, refresh: async () => {} },
      ownsAutomationView: () => false, uiAutomation, provisionAutomationRuntime: async () => { throw new Error('UI view must not provision'); } });
    expect(await execute({ ...args, actionId: `browser.control.${kind}`, input: { ...view, kind, commandId: kind } }))
      .toMatchObject({ status: 'dispatched', commandId: kind });
  });

  it.each(['browser.automation.click', 'browser.control.takeControl', 'browser.control.handBack'] as const)('preserves %s interrupted unknown through composed daemon and public Action settlement after an issued abort', async actionId => {
    const abort = new AbortController();
    let began!: () => void;
    const issued = new Promise<void>(resolve => { began = resolve; });
    let finish!: () => void;
    const uiAutomation = createBrowserAutomationReverseDispatcher({ getMachineClient: () => ({
      hasConnectedClientRpcHandler: () => true,
      callConnectedClientRpc: async (_method, _payload, options) => {
        options?.onIssued?.();
        began();
        await new Promise<void>(resolve => { finish = resolve; });
        return { ok: false, errorCode: 'RPC_CANCELLED' };
      },
    }) });
    const broker = createBrowserDaemonControlBroker();
    const runtimeActionExecute = createDaemonRuntimeActionExecutor({ env: {},
      resolveRouteOwners: () => ({ browserUiAutomation: { ownsAutomationView: broker.ownsView, uiAutomation } }),
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {
        browser: { enabled: true, viewTargets: { enabled: true }, internal: { enabled: true },
          sidecar: { enabled: true }, automation: { enabled: true } },
      } }) }),
    });
    const unused = async () => { throw new Error('Unexpected non-browser Action dependency'); };
    const executor = createActionExecutor({ runtimeActionExecute,
      executionRunStart: unused, executionRunList: unused, executionRunGet: unused, detachedExecutionRunSend: unused,
      executionRunStop: unused, executionRunAction: unused, executionRunWait: unused, sessionOpen: unused,
      sessionFork: unused, sessionRollback: unused, sessionSpawnNew: unused, pathsListRecent: unused,
      machinesList: unused, serversList: unused, reviewEnginesList: unused, agentsBackendsList: unused,
      agentsModelsList: unused, sessionSendMessage: unused, sessionPermissionRespond: unused, sessionUserActionAnswer: unused,
      sessionModeSet: unused, sessionModesList: unused, sessionTargetPrimarySet: unused, sessionTargetTrackedSet: unused,
      sessionList: unused, sessionActivityGet: unused, sessionRecentMessagesGet: unused, resetGlobalVoiceAgent: unused,
      // Unrelated host effects fail loudly if this browser boundary fixture reaches them.
      daemonMemorySearch: unused, daemonMemoryGetWindow: unused, daemonMemoryEnsureUpToDate: unused,
    });
    const input = actionId === 'browser.automation.click' ? request : { ...view, kind: actionId === 'browser.control.takeControl' ? 'takeControl' : 'handBack', commandId: actionId };
    const running = executor.execute(actionId, input, { ...args.context, bypassApprovals: true, signal: abort.signal });
    await issued;
    abort.abort();
    finish();
    await expect(running).resolves.toMatchObject({ ok: true, result: { status: 'interrupted', completion: 'unknown' } });
  });

  it('keeps pre-send unavailability distinct from unknown completion', async () => {
    const execute = createBrowserAutomationReverseDispatcher({ getMachineClient: () => ({
      hasConnectedClientRpcHandler: () => true,
      callConnectedClientRpc: async () => ({ ok: false, errorCode: 'machine_socket_unavailable' }),
    }) });
    expect(await execute(args)).toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
  });

  it('reports unknown completion when the UI disconnects after an effect-bearing send', async () => {
    let sent = false;
    const execute = createBrowserAutomationReverseDispatcher({ getMachineClient: () => ({
      hasConnectedClientRpcHandler: () => true,
      callConnectedClientRpc: async (_method, _payload, options) => {
        (options as Readonly<{ onIssued?: () => void }> | undefined)?.onIssued?.();
        sent = true;
        return { ok: false, errorCode: 'machine_socket_unavailable' };
      },
    }) });
    const result = await execute(args);
    expect(result).toMatchObject({ status: 'interrupted', completion: 'unknown' });
    expect(getActionSpec(args.actionId).outputSchema?.parse(result)).toMatchObject({ status: 'interrupted', completion: 'unknown' });
    expect(sent).toBe(true);
  });

  it('propagates invoking cancellation during a deferred UI effect and reports unknown completion', async () => {
    const abort = new AbortController();
    let signal: AbortSignal | undefined;
    let finish!: () => void;
    const execute = createBrowserAutomationReverseDispatcher({ getMachineClient: () => ({
      hasConnectedClientRpcHandler: () => true,
      callConnectedClientRpc: async (_method, _payload, options) => {
        signal = (options as Readonly<{ signal?: AbortSignal }> | undefined)?.signal;
        (options as Readonly<{ onIssued?: () => void }> | undefined)?.onIssued?.();
        await new Promise<void>(resolve => { finish = resolve; });
        return { ok: false, errorCode: 'RPC_CANCELLED' };
      },
    }) });
    const running = execute({ ...args, context: { ...args.context, signal: abort.signal } });
    abort.abort();
    finish();
    await expect(running).resolves.toMatchObject({ status: 'interrupted', completion: 'unknown' });
    expect(signal?.aborted).toBe(true);
  });

  it('dispatches to the exact UI RPC and forwards present-user cancellation authority without provisioning', async () => {
    const wireRequests: unknown[] = [];
    // Connected-client RPC is the network boundary. UI behavior is exercised by its own package.
    const uiAutomation = createBrowserAutomationReverseDispatcher({ getMachineClient: () => ({
      hasConnectedClientRpcHandler: method => method === uiBrowserAutomationDispatchMethod(view),
      callConnectedClientRpc: async (_method, payload) => {
        const wire = UiBrowserAutomationDispatchRequestV1Schema.parse(payload);
        wireRequests.push(wire);
        const result = wire.actionId === 'browser.automation.cancelActive'
          ? { v: 1, outcome: 'canceled', canceledCount: 1, completion: 'uncertain' }
          : { v: 1, automationRequestId: request.automationRequestId, durationMs: 0,
              navigationGenerationBefore: 0, navigationGenerationAfter: 0, controlEpochBefore: 0, controlEpochAfter: 0,
              status: 'succeeded', adapterKind: 'localPreview', fidelity: 'injectedPage',
              trustedInput: false, resultSummary: { clicked: true } };
        return { ok: true, result: UiBrowserAutomationDispatchResultV1Schema.parse(result) };
      },
    }) });
    const provisionAutomationRuntime = vi.fn(async () => 'provisioning' as const);
    const execute = createBrowserDaemonRuntimeActionExecutor({
      featureGate: { isEnabled: () => true, refresh: async () => {} }, ownsAutomationView: () => false,
      provisionAutomationRuntime, uiAutomation,
    });
    expect(await execute(args)).toMatchObject({ status: 'succeeded', resultSummary: { clicked: true } });
    expect(await execute({ actionId: 'browser.automation.cancelActive', input: view,
      context: { surface: 'agent', authority: 'present_user', defaultSessionId: 'happier-session' } }))
      .toEqual({ v: 1, outcome: 'canceled', canceledCount: 1, completion: 'uncertain' });
    expect(wireRequests).toEqual([
      { v: 1, sessionId: 'happier-session', actionId: args.actionId, input: request, authority: 'account_automation' },
      { v: 1, sessionId: 'happier-session', actionId: 'browser.automation.cancelActive', input: view, authority: 'present_user' },
    ]);
    expect(provisionAutomationRuntime).not.toHaveBeenCalled();
  });

  it('provisions only a view actually owned by the registered daemon broker adapter', async () => {
    const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: 'daemon-session', sidecarId: 'sidecar', transport: {
      openPage: async () => ({ targetId: 'target' }), dispatchPageCommand: async () => ({}), dispatchBrowserCommand: async () => ({}),
    } });
    const broker = createBrowserDaemonControlBroker();
    broker.registerAdapter(adapter);
    const daemonView = { browserSessionId: 'daemon-session', viewId: 'daemon-view' };
    try {
      expect(await broker.dispatchCommand({ kind: 'openView', commandId: 'open', ...daemonView, platform: 'desktop', focus: true,
        target: { kind: 'externalUrl', targetId: 'page', url: 'https://example.test/' } })).toMatchObject({ status: 'dispatched' });
      const provisionAutomationRuntime = vi.fn(async () => 'provisioning' as const);
      const execute = createBrowserDaemonRuntimeActionExecutor({ featureGate: { isEnabled: () => true, refresh: async () => {} },
        ownsAutomationView: broker.ownsView, provisionAutomationRuntime });
      expect(await execute({ ...args, input: { ...request, ...daemonView }, context: { ...args.context, defaultSessionId: daemonView.browserSessionId } }))
        .toMatchObject({ error: 'runtime_action_disabled:browser:browser_automation_runtime_provisioning' });
      expect(await execute({ ...args, input: { ...request, ...daemonView } })).toMatchObject({ errorCode: 'invalid_parameters' });
      expect(provisionAutomationRuntime).toHaveBeenCalledOnce();
      expect(await execute(args)).toMatchObject({ error: 'runtime_action_disabled:browser:browser_ui_automation_unavailable' });
      expect(provisionAutomationRuntime).toHaveBeenCalledOnce();
    } finally { adapter.dispose(); }
  });

  it('rejects disconnected UI targets without provisioning when no daemon route exists', async () => {
    const provisionAutomationRuntime = vi.fn(async () => 'provisioning' as const);
    const execute = createBrowserDaemonRuntimeActionExecutor({
      featureGate: { isEnabled: () => true, refresh: async () => {} }, ownsAutomationView: () => false, provisionAutomationRuntime,
      uiAutomation: createBrowserAutomationReverseDispatcher({ getMachineClient: () => null }),
    });
    expect(await execute(args)).toMatchObject({ ok: false, errorCode: 'runtime_action_disabled', error: 'runtime_action_disabled:browser:browser_ui_automation_unavailable' });
    expect(provisionAutomationRuntime).not.toHaveBeenCalled();
  });
});
