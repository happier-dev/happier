import { describe, expect, it } from 'vitest';
import { DaemonBrowserViewListResponseV1Schema } from '@happier-dev/protocol/browser/control/v1';
import { createBrowserDaemonRuntimeActionExecutor } from './runtimeActionExecutor';
import { createBrowserDaemonControlBroker } from '../control/broker';
import { createBrowserDaemonControlRoutes } from '../control/routes';
import { createBrowserSidecarCdpControlAdapter } from '../sidecar/controlAdapter';

describe('browser view discovery Action', () => {
  it('lists the canonical Session views without extra CDP work, and rejects another Session', async () => {
    let commands = 0;
    // Chromium is the sole fake boundary; bindings, broker, routes and Action dispatch stay real.
    const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: 'session', sidecarId: 'sidecar', transport: {
      openPage: async () => { commands++; return { targetId: 'private-target', sessionId: 'private-session' }; },
      dispatchPageCommand: async () => { commands++; return {}; },
      dispatchBrowserCommand: async () => { commands++; return { success: true }; },
    } });
    const broker = createBrowserDaemonControlBroker();
    const unregister = broker.registerAdapter(adapter);
    const control = createBrowserDaemonControlRoutes({ broker });
    const execute = createBrowserDaemonRuntimeActionExecutor({ control, featureGate: { isEnabled: () => true, refresh: async () => {} } });
    try {
      expect(await control.dispatchCommand({ kind: 'openView', commandId: 'open', browserSessionId: 'session', viewId: 'view',
        platform: 'web', target: { kind: 'externalUrl', targetId: 'intent', url: 'https://example.test/' } })).toMatchObject({ status: 'dispatched' });
      const before = commands;
      const result = await execute({ actionId: 'browser.view.list', input: { machineId: 'machine', browserSessionId: 'session' },
        context: { defaultSessionId: 'session' } });
      expect(DaemonBrowserViewListResponseV1Schema.parse(result).views).toMatchObject([{ browserSessionId: 'session', viewId: 'view' }]);
      expect(JSON.stringify(result)).not.toContain('private-target');
      expect(JSON.stringify(result)).not.toContain('private-session');
      expect(commands).toBe(before);
      expect(await execute({ actionId: 'browser.view.list', input: { machineId: 'machine', browserSessionId: 'other' },
        context: { defaultSessionId: 'session' } })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
      expect(commands).toBe(before);
    } finally { unregister(); adapter.dispose(); }
  });
});
