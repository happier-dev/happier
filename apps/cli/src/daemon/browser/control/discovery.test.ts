import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import { describe, expect, it, vi } from 'vitest';
import { createBrowserSidecarCdpControlAdapter, type BrowserSidecarCdpEventSubscriber } from '../sidecar/controlAdapter';
import { createBrowserAutomationOwnerRegistry } from '../automation/owners';
import { createBrowserAutomationDaemonService } from '../automation/service';
import { createBrowserAutomationCdpAdapter } from '../automation/adapters/cdp';
import { createControlAdapterAutomationTransport } from '../automation/adapters/controlBridge';
import { createBrowserDaemonControlBroker } from './broker';
import { createBrowserDaemonControlRoutes } from './routes';
import { registerDaemonBrowserControlHandler } from '../../../rpc/handlers/daemonBrowserControl';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { RpcHandler } from '../../../api/rpc/types';
import { createMachineLiveStreamCaptureRegistry } from '../../peer/mediation/stream/captureRegistry';
import { createBrowserCdpScreencastProducer } from '../capture/cdpScreencast';
import { registerBrowserLiveCapture } from '../capture/registration';

describe('daemon browser view discovery', () => {
  it('projects only the requested session from the live control owner and removes closed views', async () => {
    const broker = createBrowserDaemonControlBroker();
    const view = { browserSessionId: 'session', viewId: 'view' };
    const owners = createBrowserAutomationOwnerRegistry();
    const control = owners.getInputControl(view);
    const listeners = new Set<BrowserSidecarCdpEventSubscriber>();
    let blockFocus = false;
    let focusIssued = false;
    let releaseFocus: () => void = () => {};
    const focusAck = new Promise<void>(resolve => { releaseFocus = resolve; });
    const transport = {
      openPage: async () => ({ targetId: 'private-cdp-target', sessionId: 'private-cdp-session' }),
      dispatchPageCommand: async (command: { method: string }) => command.method === 'Page.getFrameTree'
        ? { frameTree: { frame: { id: 'frame', loaderId: 'document', url: 'https://example.test/' } } } : {},
      dispatchBrowserCommand: async (command: { method: string }) => {
        if (blockFocus && command.method === 'Target.activateTarget') { focusIssued = true; await focusAck; }
        return { success: true };
      },
      subscribeCdpEvents: (listener: BrowserSidecarCdpEventSubscriber) => {
        listeners.add(listener); return () => { listeners.delete(listener); };
      },
    };
    const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: 'session', sidecarId: 'sidecar', transport,
      resolveInputControl: () => control });
    const contextCapture = { transport, resolvePageHandle: adapter.resolvePageHandle,
      getNavigationState: adapter.getNavigationState, subscribeBrowserEvents: adapter.subscribeBrowserEvents,
      subscribeCdpEvents: transport.subscribeCdpEvents, subscribeViewLifecycle: adapter.subscribeViewLifecycle };
    const automation = createBrowserAutomationDaemonService({ owners,
      adapter: createBrowserAutomationCdpAdapter({ transport: createControlAdapterAutomationTransport({ adapter, contextCapture }) }),
      subscribeViewLifecycle: adapter.subscribeViewLifecycle });
    const registry = createMachineLiveStreamCaptureRegistry();
    const producer = createBrowserCdpScreencastProducer({ contextCapture, resolveInputControl: owners.getInputControl });
    const registration = registerBrowserLiveCapture({ registry, producer, contextCapture, automation: () => automation });
    broker.registerAdapter(adapter);
    const routes = createBrowserDaemonControlRoutes({ broker, captureRegistry: registry, automation: () => automation });
    const discover = () => routes.listViews('session');
    const handlers = new Map<string, RpcHandler>();
    registerDaemonBrowserControlHandler({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, { browserControl: routes });
    try {
      const target = { kind: 'externalUrl' as const, targetId: 'external', url: 'https://example.test/' };
      await routes.dispatchCommand({ kind: 'openView', commandId: 'open', ...view, target, platform: 'web' });
      expect(discover()).toMatchObject([{ ...view, sourceId: browserViewKey(view), target,
        adapterKind: 'chromiumSidecar', events: [expect.objectContaining({ kind: 'navigationStateChanged' })],
        captureSource: { sourceId: browserViewKey(view), sourceKind: 'browser', supportedCodecs: ['image.mjpeg'] } }]);
      expect(routes.listViews('other-session')).toEqual([]);
      const rpcDiscover = handlers.get(RPC_METHODS.DAEMON_BROWSER_VIEW_LIST);
      expect(await rpcDiscover?.({ machineId: 'machine', browserSessionId: 'session' })).toMatchObject({
        protocolVersion: 1, views: [{ ...view, sourceId: browserViewKey(view) }],
      });
      expect(JSON.stringify(discover())).not.toContain('private-cdp');
      const focus = { kind: 'focusView' as const, commandId: 'focus-held', ...view };
      blockFocus = true;
      const queuedFocus = routes.dispatchCommand(focus, { authority: 'account_automation' });
      await vi.waitFor(() => expect(focusIssued).toBe(true));
      let observationDrained = false;
      const unregisterDrain = control.registerConfidentialityDrain(async () => { observationDrained = true; });
      const hold = control.beginConfidentialityHold();
      await new Promise<void>(resolve => { setImmediate(resolve); });
      expect.soft(observationDrained).toBe(false);
      const material = 'D26-AWAITED-CONTROL-METADATA-UNIQUE';
      for (const listener of [...listeners]) listener({ method: 'Target.targetInfoChanged',
        params: { targetInfo: { targetId: 'private-cdp-target', title: material } } });
      for (const listener of [...listeners]) listener({ method: 'Page.frameNavigated', sessionId: 'private-cdp-session',
        params: { frame: { id: 'frame', loaderId: 'submitted', url: `https://example.test/?credential=${material}` } } });
      releaseFocus();
      const settledFocus = await queuedFocus;
      // Acknowledged input already issued before the hold retains its known settlement.
      // Acquiring confidentiality must drain it, and its result cannot expose held metadata.
      expect.soft(settledFocus).toMatchObject({ status: 'dispatched' });
      expect.soft(JSON.stringify(settledFocus)).not.toContain(material);
      await hold;
      expect(observationDrained).toBe(true);
      unregisterDrain();
      blockFocus = false;
      const signal = new AbortController().signal;
      expect.soft(await rpcDiscover?.({ machineId: 'machine', browserSessionId: 'session' },
        { signal, callerAuthority: 'account_automation' })).toMatchObject({ protocolVersion: 1, views: [{ ...view }] });
      expect.soft(await rpcDiscover?.({ machineId: 'machine', browserSessionId: 'session' })).toMatchObject({ protocolVersion: 1, views: [{ ...view }] });
      expect.soft(await rpcDiscover?.({ machineId: 'machine', browserSessionId: 'session' },
        { signal, callerAuthority: 'present_user' })).toMatchObject({ views: [{ ...view }] });
      expect.soft(discover()).toMatchObject([{ ...view }]);
      expect.soft(JSON.stringify(discover())).not.toContain(material);
      const rpcDispatch = handlers.get(RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH);
      // The owner-scoped UI RPC supplies human authority; Agent control uses the routes directly.
      const humanFocus = await rpcDispatch?.({ machineId: 'machine', command: focus });
      expect.soft(humanFocus).toMatchObject({ result: { status: 'dispatched' } });
      expect.soft(JSON.stringify(humanFocus)).not.toContain(material);
      expect.soft(await routes.dispatchCommand(focus))
        .toMatchObject({ status: 'failed', error: { code: 'permission_denied' } });
      expect.soft(await routes.dispatchCommand(focus, { authority: 'account_automation' }))
        .toMatchObject({ status: 'failed', error: { code: 'permission_denied' } });
      registry.unregister(browserViewKey(view));
      expect(routes.listViews('session')[0]?.captureSource).toBeUndefined();
      await routes.dispatchCommand({ kind: 'closeView', commandId: 'close', ...view }, { authority: 'present_user' });
      expect(discover()).toEqual([]);
    } finally { releaseFocus(); registration.dispose(); await producer.dispose(); automation.dispose(); adapter.dispose(); }
  });
});
