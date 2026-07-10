import { describe, expect, it } from 'vitest';

type BrowserModule = typeof import('../index.js');

async function loadBrowserModule(): Promise<BrowserModule | null> {
  return import('../index.js').catch(() => null);
}

describe('browser session/view vocabulary v1', () => {
  it('serializes session, profile, view, storage, and input contracts', async () => {
    const mod = await loadBrowserModule();

    expect(mod?.BrowserProfileV1Schema.safeParse({
      profileId: 'profile_1',
      storageMode: 'session',
      owner: { kind: 'session', id: 'session_1' },
      cleanupOnSessionClose: true,
    }).success).toBe(true);

    expect(mod?.BrowserSessionV1Schema.safeParse({
      browserSessionId: 'browser_session_1',
      profileId: 'profile_1',
      createdAt: 1_000,
      state: 'active',
    }).success).toBe(true);

    expect(mod?.BrowserViewV1Schema.safeParse({
      viewId: 'view_1',
      browserSessionId: 'browser_session_1',
      target: {
        kind: 'localServicePreview',
        targetId: 'preview_1',
        sessionId: 'session_1',
        machineId: 'machine_1',
      },
      state: 'loading',
      platform: 'web',
    }).success).toBe(true);

    expect(mod?.BrowserViewV1Schema.safeParse({
      viewId: 'view_2',
      browserSessionId: 'browser_session_1',
      target: {
        kind: 'externalUrl',
        targetId: 'external_1',
        url: 'https://example.com/',
      },
	      state: 'ready',
	      platform: 'desktop',
	      currentUrl: 'https://example.com/',
	      currentUrlExpiresAt: 1_700_000_000_000,
	      pendingUrl: null,
      title: 'Example',
      faviconUrl: 'https://example.com/favicon.ico',
      loadingState: 'ready',
      loadingProgress: 1,
      canGoBack: true,
      canGoForward: false,
      securityOrigin: 'https://example.com/',
      lastError: null,
      adapterKind: 'externalUrl',
      engineKind: 'desktopWebView',
      adapterCapabilities: {
        adapterKind: 'externalUrl',
        supportedTargetKinds: ['externalUrl'],
        supportedRenderEngines: ['desktopWebView'],
        navigation: {
          canNavigate: true,
          canGoBack: true,
          canGoForward: true,
          canReload: true,
          canStop: true,
        },
      },
      openerViewId: null,
    }).success).toBe(true);

    expect(mod?.BrowserStoragePolicyV1Schema.safeParse({
      mode: 'ephemeral',
      clearOnClose: true,
      downloadsPersistence: 'prompt',
    }).success).toBe(true);

    expect(mod?.BrowserInputEventV1Schema.safeParse({
      kind: 'key',
      target: 'page',
      key: 'Enter',
      modifiers: [],
      sequence: 1,
    }).success).toBe(true);
  });

  it('rejects browser input that targets browser chrome', async () => {
    const mod = await loadBrowserModule();

    expect(mod?.BrowserInputEventV1Schema.safeParse({
      kind: 'key',
      target: 'chrome',
      key: 'Enter',
      modifiers: [],
      sequence: 1,
    }).success).toBe(false);
  });
});
