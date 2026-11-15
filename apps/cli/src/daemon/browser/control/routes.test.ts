import { BrowserCommandDispatchResultV1Schema } from '@happier-dev/protocol/browser/control/v1';
import { FeaturesResponseSchema, type BrowserEventV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createBrowserAutomationOwnerRegistry } from '../automation/owners';
import { createBrowserAutomationDaemonService } from '../automation/service';
import { createBrowserAutomationCdpAdapter } from '../automation/adapters/cdp';
import { createControlAdapterAutomationTransport } from '../automation/adapters/controlBridge';
import { createBrowserSidecarCdpControlAdapter, type BrowserSidecarCdpEventSubscriber } from '../sidecar/controlAdapter';
import { createBrowserDaemonRuntimeActionExecutor } from '../actions/runtimeActionExecutor';
import { createBrowserDaemonFeatureGate } from '../featureGate';
import { createBrowserDaemonControlBroker } from './broker';
import { createBrowserDaemonControlRoutes } from './routes';

describe('browser daemon control routes', () => {
  it('validates the external adapter result once across broker and route', async () => {
    const broker = createBrowserDaemonControlBroker();
    broker.registerAdapter({ adapterKind: 'chromiumSidecar', ownsView: () => true,
      supportsOpenView: () => true,
      dispatchCommand: command => ({ v: 1, commandId: command.commandId,
        status: 'dispatched', adapterKind: 'chromiumSidecar', events: [] }) });
    const parse = vi.spyOn(BrowserCommandDispatchResultV1Schema, 'safeParse');
    try {
      expect(await createBrowserDaemonControlRoutes({ broker }).dispatchCommand({ kind: 'focusView',
        commandId: 'focus', browserSessionId: 'session', viewId: 'view' })).toMatchObject({ status: 'dispatched' });
      expect(parse).toHaveBeenCalledTimes(1);
    } finally { parse.mockRestore(); }
  });
  it('contains held page metadata through CDP events, inventories and the actual Agent focus Action while preserving private human state', async () => {
    const view = { browserSessionId: 'browser_session_1', viewId: 'view_1' };
    const owners = createBrowserAutomationOwnerRegistry();
    const control = owners.getInputControl(view);
    let notify!: BrowserSidecarCdpEventSubscriber;
    let activated = false;
    // Chromium's network boundary supplies arbitrary page-derived metadata; all owners below are real.
    const transport = {
      openPage: async () => ({ targetId: 'target', sessionId: 'cdp_session' }),
      dispatchPageCommand: async ({ method }: { method: string }) => method === 'Page.getFrameTree'
        ? { frameTree: { frame: { id: 'frame', loaderId: 'document', url: 'https://example.test/' } } }
        : {},
      dispatchBrowserCommand: async ({ method }: { method: string }) => {
        if (method === 'Target.activateTarget') activated = true;
        return { success: true };
      },
      subscribeCdpEvents: (listener: BrowserSidecarCdpEventSubscriber) => { notify = listener; return () => {}; },
    };
    const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: view.browserSessionId,
      sidecarId: 'sidecar', transport, resolveInputControl: owners.getInputControl });
    const automation = createBrowserAutomationDaemonService({ owners,
      adapter: createBrowserAutomationCdpAdapter({ transport: createControlAdapterAutomationTransport({ adapter,
        contextCapture: { transport, resolvePageHandle: adapter.resolvePageHandle, getNavigationState: adapter.getNavigationState },
      }) }), subscribeViewLifecycle: adapter.subscribeViewLifecycle });
    const broker = createBrowserDaemonControlBroker();
    broker.registerAdapter(adapter);
    const routes = createBrowserDaemonControlRoutes({ broker, automation: () => automation });
    const gate = createBrowserDaemonFeatureGate({ env: { NODE_ENV: 'test' }, resolveServerFeaturesSnapshot: () => ({ status: 'ready',
      features: FeaturesResponseSchema.parse({ features: { browser: { enabled: true,
        viewTargets: { enabled: true }, internal: { enabled: true }, sidecar: { enabled: true } } } }),
    }) });
    await gate.refresh();
    expect(gate.isEnabled('browser.sidecar')).toBe(true);
    const execute = createBrowserDaemonRuntimeActionExecutor({ control: routes, featureGate: gate });
    const events: BrowserEventV1[] = [];
    adapter.subscribeBrowserEvents(event => events.push(event));
    try {
      expect(await routes.dispatchCommand({ kind: 'openView', commandId: 'open', ...view, platform: 'web',
        target: { kind: 'externalUrl', targetId: 'external', url: 'https://example.test/' } }, { authority: 'present_user' }))
        .toMatchObject({ status: 'dispatched' });
      await control.beginConfidentialityHold();
      events.length = 0;
      const material = 'D26-METADATA-CREDENTIAL-UNIQUE';
      notify({ method: 'Target.targetInfoChanged', params: { targetInfo: { targetId: 'target', title: material } } });
      notify({ method: 'Page.frameNavigated', sessionId: 'cdp_session', params: {
        frame: { id: 'frame', loaderId: 'submitted_document', url: `https://example.test/submitted?credential=${material}` },
      } });
      const focused = await execute({ actionId: 'browser.view.focus',
        input: { kind: 'focusView', commandId: 'agent-focus', ...view }, context: { defaultSessionId: view.browserSessionId } });
      expect.soft(JSON.stringify(events)).not.toContain(material);
      expect.soft(JSON.stringify(broker.listViews(view.browserSessionId))).not.toContain(material);
      expect.soft(JSON.stringify(routes.listViews(view.browserSessionId))).not.toContain(material);
      expect.soft(JSON.stringify(focused)).not.toContain(material);
      expect.soft(focused).toMatchObject({ status: 'failed', error: { code: 'permission_denied' } });
      expect.soft(activated).toBe(false);
      expect(adapter.getNavigationState(view)).toMatchObject({ title: material,
        currentUrl: `https://example.test/submitted?credential=${material}`, navigationGeneration: 1 });
      expect(await routes.dispatchCommand({ kind: 'focusView', commandId: 'human-focus', ...view }, { authority: 'present_user' }))
        .toMatchObject({ status: 'dispatched' });
      expect(activated).toBe(true);
      expect(control.isObservationHeld()).toBe(true);
    } finally { automation.dispose(); adapter.dispose(); }
  });

  it.each([
    ['command_bad', 'command_bad'],
    ['x'.repeat(300), 'x'.repeat(300)],
  ])('returns a strict-schema failure for malformed input with command id %s', async (commandId, expectedId) => {
    const routes = createBrowserDaemonControlRoutes({ broker: createBrowserDaemonControlBroker() });
    const result = await routes.dispatchCommand({ kind: 'navigate', commandId, url: 'https://browser.example.test/' });
    expect(BrowserCommandDispatchResultV1Schema.parse(result)).toMatchObject({
      v: 1, commandId: expectedId, status: 'failed', error: { code: 'command_malformed' },
    });
  });
});
