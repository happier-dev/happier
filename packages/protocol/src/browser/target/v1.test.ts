import { describe, expect, it } from 'vitest';
import { LocalServiceLaunchTargetV1Schema } from '../../local/services/launcher/v1.js';
import { browserViewKey } from '../view/key.js';

type BrowserTargetModule = typeof import('./v1.js');

async function loadBrowserTargetModule(): Promise<BrowserTargetModule | null> {
  return import('./v1.js').catch(() => null);
}

describe('browser view target v1 protocol', () => {
  it('preserves the daemon view tuple in streamed targets and reads existing tupleless saved targets', async () => {
    const { BrowserViewTargetV1Schema } = await import('./v1.js');
    const savedTarget = { kind: 'streamedBrowser', targetId: 'source', streamId: 'source' };
    const target = { ...savedTarget, daemonView: { browserSessionId: 'session', viewId: 'view' } };
    expect(BrowserViewTargetV1Schema.parse(target)).toEqual(target);
    const daemonView = { browserSessionId: 's'.repeat(256), viewId: 'v'.repeat(256) };
    const sourceId = browserViewKey(daemonView);
    const derivedTarget = { ...target, targetId: sourceId, streamId: sourceId, daemonView };
    expect(BrowserViewTargetV1Schema.parse(derivedTarget)).toEqual(derivedTarget);
    expect(BrowserViewTargetV1Schema.parse(savedTarget)).toEqual(savedTarget);
    expect(BrowserViewTargetV1Schema.safeParse({ ...target, daemonView: { viewId: 'view' } }).success).toBe(false);
    expect(BrowserViewTargetV1Schema.safeParse({ ...target, daemonView: { browserSessionId: 'session' } }).success).toBe(false);
  });

  it('preserves a sessionless managed preview binding through the launcher and refuses mismatched authority', async () => {
    const { BrowserViewTargetV1Schema } = await import('./v1.js');
    const target = {
      kind: 'localServicePreview', targetId: 'preview_123', machineId: 'machine_123',
      serviceTarget: {
        kind: 'managed_service', machineId: 'machine_123', managedServiceId: 'service_123',
        cwd: '/repo/web', declaration: { workspaceRefId: 'workspace_123', selection: { kind: 'manifest', name: 'web' } },
      },
    };
    const result = BrowserViewTargetV1Schema.safeParse(target);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const launcher = LocalServiceLaunchTargetV1Schema.parse({
      id: 'preview:preview_123', source: 'registered_preview', machineId: target.machineId,
      title: 'Web', confidence: 'high', state: 'available', browserTarget: result.data,
    });
    expect(launcher.browserTarget).toEqual(target);
    expect(BrowserViewTargetV1Schema.safeParse({ ...target, machineId: 'another_machine' }).success).toBe(false);
    expect(BrowserViewTargetV1Schema.safeParse({ ...target, sessionId: 'session_123' }).success).toBe(false);
  });

  it('accepts local service preview targets and preserves display identity', async () => {
    const mod = await loadBrowserTargetModule();

    const result = mod?.BrowserViewTargetV1Schema.safeParse({
      kind: 'localServicePreview',
      targetId: 'preview_123',
      sessionId: 'session_123',
      machineId: 'machine_123',
      display: {
        title: 'Kitchen Sink',
        addressLabel: 'localhost:5173',
        folderLabel: 'happier',
      },
    });

    expect(result?.success).toBe(true);
    if (result?.success) {
      expect(result.data.display.title).toBe('Kitchen Sink');
      expect(result.data.display.addressLabel).toBe('localhost:5173');
    }
  });

  it('rejects unknown target kinds instead of accepting unowned browser behavior', async () => {
    const mod = await loadBrowserTargetModule();

    const result = mod?.BrowserViewTargetV1Schema.safeParse({
      kind: 'rawCdp',
      targetId: 'browser_123',
    });

    expect(result?.success).toBe(false);
  });

  it('rejects non-http external URL browser targets', async () => {
    const mod = await loadBrowserTargetModule();

    const result = mod?.BrowserViewTargetV1Schema.safeParse({
      kind: 'externalUrl',
      targetId: 'external_123',
      url: 'javascript:alert(1)',
    });

    expect(result?.success).toBe(false);
  });

  it('accepts simulator preview targets with producer source identity', async () => {
    const mod = await loadBrowserTargetModule();

    const result = mod?.BrowserViewTargetV1Schema.safeParse({
      kind: 'simulatorPreview',
      targetId: 'simulator_123',
      deviceId: 'emulator-5554',
      sourceId: 'simulator:android:emulator-5554:screen',
      display: {
        title: 'Pixel 9',
      },
    });

    expect(result?.success).toBe(true);
    if (result?.success) {
      expect(result.data.kind).toBe('simulatorPreview');
      expect(result.data.sourceId).toBe('simulator:android:emulator-5554:screen');
    }
  });

  it('accepts local-service-backed target suggestions without duplicating identity fields', async () => {
    const mod = await loadBrowserTargetModule();

    const result = mod?.BrowserTargetSuggestionV1Schema.safeParse({
      suggestionId: 'suggestion_1',
      source: { kind: 'localServiceInventory', serviceId: 'service_1' },
      target: {
        kind: 'localServicePreview',
        targetId: 'preview_123',
        sessionId: 'session_123',
        machineId: 'machine_123',
      },
      display: {
        title: 'Kitchen Sink',
        addressLabel: 'localhost:5173',
        folderLabel: 'happier',
      },
      lastSeenAt: 1_000,
    });

    expect(result?.success).toBe(true);
  });
});
