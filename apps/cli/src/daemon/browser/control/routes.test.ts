import { BrowserCommandDispatchResultV1Schema } from '@happier-dev/protocol/browser/control/v1';
import { FeaturesResponseSchema, type BrowserCommandV1, type BrowserEventV1 } from '@happier-dev/protocol';
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

type RoutesModule = Readonly<{
  createBrowserDaemonControlRoutes?: (input: {
    broker: {
      dispatchCommand(command: BrowserCommandV1): Promise<unknown> | unknown;
    };
  }) => {
    dispatchCommand(command: unknown): Promise<unknown>;
  };
}>;

async function loadRoutes(): Promise<RoutesModule | null> {
  return import('./routes') as Promise<RoutesModule | null>;
}

describe('browser daemon control routes', () => {
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
    const gate = createBrowserDaemonFeatureGate({ env: {}, resolveServerFeaturesSnapshot: () => ({ status: 'ready',
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

  it('returns a typed malformed-command result for invalid BrowserCommandV1 input', async () => {
    const mod = await loadRoutes();

    expect(mod?.createBrowserDaemonControlRoutes).toBeTypeOf('function');
    if (!mod?.createBrowserDaemonControlRoutes) return;

    const routes = mod.createBrowserDaemonControlRoutes({
      broker: {
        dispatchCommand: vi.fn(),
      },
    });

    await expect(routes.dispatchCommand({
      kind: 'navigate',
      commandId: 'command_bad',
      url: 'https://browser.example.test/',
    })).resolves.toMatchObject({
      v: 1,
      commandId: 'command_bad',
      status: 'failed',
      error: { code: 'command_malformed' },
    });
  });

  it('returns a schema-valid malformed-command result when the malformed input command id is unsafe', async () => {
    const mod = await loadRoutes();

    expect(mod?.createBrowserDaemonControlRoutes).toBeTypeOf('function');
    if (!mod?.createBrowserDaemonControlRoutes) return;

    const routes = mod.createBrowserDaemonControlRoutes({
      broker: {
        dispatchCommand: vi.fn(),
      },
    });
    const result = await routes.dispatchCommand({
      kind: 'navigate',
      commandId: 'x'.repeat(300),
      url: 'https://browser.example.test/',
    });

    expect(result).toMatchObject({
      v: 1,
      commandId: 'unknown',
      status: 'failed',
      error: { code: 'command_malformed' },
    });
    expect(BrowserCommandDispatchResultV1Schema.safeParse(result).success).toBe(true);
  });

  it('delegates valid commands to the broker and returns the parsed dispatch result', async () => {
    const mod = await loadRoutes();

    expect(mod?.createBrowserDaemonControlRoutes).toBeTypeOf('function');
    if (!mod?.createBrowserDaemonControlRoutes) return;

    const command = {
      kind: 'navigate',
      commandId: 'command_navigate',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      url: 'https://browser.example.test/next',
    } satisfies BrowserCommandV1;
    const dispatchCommand = vi.fn(async () => ({
      v: 1,
      commandId: 'command_navigate',
      status: 'dispatched',
      adapterKind: 'chromiumSidecar',
      events: [],
    }));
    const routes = mod.createBrowserDaemonControlRoutes({
      broker: { dispatchCommand },
    });

    await expect(routes.dispatchCommand(command)).resolves.toEqual({
      v: 1,
      commandId: 'command_navigate',
      status: 'dispatched',
      adapterKind: 'chromiumSidecar',
      events: [],
    });
    expect(dispatchCommand).toHaveBeenCalledWith(command);
  });

  it('rejects broker results that are not bound to the dispatched command or daemon adapter kinds', async () => {
    const mod = await loadRoutes();

    expect(mod?.createBrowserDaemonControlRoutes).toBeTypeOf('function');
    if (!mod?.createBrowserDaemonControlRoutes) return;

    const command = {
      kind: 'navigate',
      commandId: 'command_navigate',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      url: 'https://browser.example.test/next',
    } satisfies BrowserCommandV1;
    const dispatchCommand = vi
      .fn()
      .mockResolvedValueOnce({
        v: 1,
        commandId: 'different_command',
        status: 'dispatched',
        adapterKind: 'chromiumSidecar',
        events: [],
      })
      .mockResolvedValueOnce({
        v: 1,
        commandId: 'command_navigate',
        status: 'dispatched',
        adapterKind: 'externalUrl',
        events: [],
      });
    const routes = mod.createBrowserDaemonControlRoutes({
      broker: { dispatchCommand },
    });

    await expect(routes.dispatchCommand(command)).resolves.toMatchObject({
      v: 1,
      commandId: 'command_navigate',
      status: 'failed',
      error: { code: 'adapter_unavailable' },
    });
    await expect(routes.dispatchCommand(command)).resolves.toMatchObject({
      v: 1,
      commandId: 'command_navigate',
      status: 'failed',
      error: { code: 'adapter_unavailable' },
    });
  });
});
