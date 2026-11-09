import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { createBrowserDaemonRuntimeActionExecutor } from './runtimeActionExecutor';
import { createBrowserAutomationReverseDispatcher } from '../automation/reverseDispatch';
import { createBrowserDaemonControlBroker } from '../control/broker';
import { createBrowserDaemonControlRoutes } from '../control/routes';
import { createBrowserSidecarCdpControlAdapter } from '../sidecar/controlAdapter';

const fixtureSource = new URL('../../../../../ui/sources/dev/testkit/fixtures/actionExecutorBoundary.ts', import.meta.url).href;
const { createActionExecutorBoundaryFixture }: {
  createActionExecutorBoundaryFixture(overrides: Partial<ActionExecutorDeps>): ActionExecutorDeps;
} = await import(fixtureSource);
const view = { browserSessionId: 'stopped-session', viewId: 'retained-managed-view' };
const close = { ...view, kind: 'closeView', commandId: 'close-retained-view' } as const;
const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
  bypassApprovals: true } as const;

describe('Browser view lifecycle after its Session stops', () => {
  it.each(['no invoking Session', 'no UI route', 'no mounted responder'] as const)(
    'settles an absent view through its lifecycle result with %s', async placement => {
      const broker = createBrowserDaemonControlBroker();
      const unexpected = async (): Promise<never> => { throw new Error('An absent view must not issue CDP commands'); };
      const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: view.browserSessionId,
        sidecarId: 'sidecar', transport: { openPage: unexpected, dispatchPageCommand: unexpected,
          dispatchBrowserCommand: unexpected } });
      const unregister = broker.registerAdapter(adapter);
      const runtimeActionExecute = createBrowserDaemonRuntimeActionExecutor({
        control: createBrowserDaemonControlRoutes({ broker }), ownsAutomationView: broker.ownsView,
        featureGate: { isEnabled: () => true, refresh: async () => {} },
        ...(placement === 'no UI route' ? {} : { uiAutomation: createBrowserAutomationReverseDispatcher({
          getMachineClient: () => ({
            // The Home's connected-client registry is the only substituted boundary.
            callConnectedClientRpc: async () => ({ ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }),
          }),
        }) }),
      });
      const executor = createActionExecutor(createActionExecutorBoundaryFixture({ runtimeActionExecute }));
      try {
        expect(await executor.execute('browser.view.close', close, { ...context,
          ...(placement === 'no invoking Session' ? {} : { defaultSessionId: view.browserSessionId }),
        })).toMatchObject({ ok: false, errorCode: 'view_not_found',
          details: { commandId: close.commandId, status: 'failed' } });
      } finally { unregister(); adapter.dispose(); }
    });

  it('closes a retained managed view without a running Session or mounted UI', async () => {
    const methods: string[] = [];
    const adapter = createBrowserSidecarCdpControlAdapter({ ...view, sidecarId: 'sidecar', transport: {
      // CDP is the external boundary. View bindings and lifecycle routing stay real.
      openPage: async () => ({ targetId: 'target', sessionId: 'cdp-session' }),
      dispatchPageCommand: async () => ({}),
      dispatchBrowserCommand: async ({ method }) => { methods.push(method); return { success: true }; },
    } });
    const broker = createBrowserDaemonControlBroker();
    const unregister = broker.registerAdapter(adapter);
    const runtimeActionExecute = createBrowserDaemonRuntimeActionExecutor({
      control: createBrowserDaemonControlRoutes({ broker }), ownsAutomationView: broker.ownsView,
      featureGate: { isEnabled: () => true, refresh: async () => {} },
    });
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ runtimeActionExecute }));
    try {
      expect(await executor.execute('browser.view.open', { ...view, kind: 'openView', commandId: 'open-view',
        platform: 'web', target: { kind: 'externalUrl', targetId: 'intent', url: 'https://example.test/' },
      }, context)).toMatchObject({ ok: true, result: { status: 'dispatched' } });
      expect(await executor.execute('browser.view.close', close, context))
        .toMatchObject({ ok: true, result: { status: 'dispatched' } });
      expect(methods.filter(method => method === 'Target.closeTarget')).toHaveLength(1);
      expect(broker.listViews(view.browserSessionId)).toEqual([]);
    } finally { unregister(); adapter.dispose(); }
  });
});
