import { describe, expect, it } from 'vitest';

describe('browser events protocol v1', () => {
  it('accepts adapter-neutral navigation and view lifecycle events', async () => {
    const mod = await import('../index.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    expect(mod.BrowserEventV1Schema.safeParse({
      kind: 'viewOpened',
      eventId: 'event_1',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      target: {
        kind: 'localServicePreview',
        targetId: 'preview_1',
        sessionId: 'session_1',
        machineId: 'machine_1',
      },
	      platform: 'web',
	      currentUrl: 'https://preview.happier.test/app',
	      currentUrlExpiresAt: 1_700_000_000_000,
	      adapterKind: 'localPreview',
      engineKind: 'webIframe',
      adapterCapabilities: {
        adapterKind: 'localPreview',
        supportedTargetKinds: ['localServicePreview'],
        supportedRenderEngines: ['webIframe'],
        navigation: { canNavigate: true, canReload: true },
      },
      occurredAt: 1_000,
    }).success).toBe(true);

    expect(mod.BrowserEventV1Schema.safeParse({
      kind: 'navigationStateChanged',
      eventId: 'event_2',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      currentUrl: 'https://preview.happier.test/',
      pendingUrl: 'https://preview.happier.test/app',
      title: 'Preview',
      loadingState: 'loading',
      loadingProgress: 0.5,
      canGoBack: false,
      canGoForward: true,
      securityOrigin: 'https://preview.happier.test/',
      occurredAt: 1_100,
    }).success).toBe(true);
  });

  it('rejects browser events with CDP-specific kinds in the public control stream', async () => {
    const mod = await import('../index.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    expect(mod.BrowserEventV1Schema.safeParse({
      kind: 'Runtime.consoleAPICalled',
      eventId: 'event_1',
      viewId: 'view_1',
    }).success).toBe(false);
  });
});
