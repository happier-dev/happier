import { describe, expect, it } from 'vitest';

describe('browser adapter protocol contracts', () => {
  it('separates render engine kinds from semantic adapter target kinds', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    expect(mod.BrowserRenderEngineKindV1Schema.parse('webIframe')).toBe('webIframe');
    expect(mod.BrowserSemanticAdapterKindV1Schema.parse('hostedPlugin')).toBe('hostedPlugin');

    const capabilities = mod.BrowserAdapterCapabilitiesV1Schema.parse({
      adapterKind: 'localPreview',
      supportedTargetKinds: ['localServicePreview'],
      supportedRenderEngines: ['webIframe', 'nativeWebView'],
      navigation: {
        canNavigate: true,
        canGoBack: true,
        canGoForward: true,
        canReload: true,
        canStop: true,
      },
      diagnosticsFidelityByFamily: {
        network: 'previewProxy',
        console: 'unavailable',
      },
      automationActions: {
        snapshot: {
          available: true,
          fidelity: 'injectedPage',
          trustedInput: false,
        },
        click: {
          available: true,
          fidelity: 'injectedPage',
          trustedInput: false,
        },
      },
      contextKinds: ['browserPageReference'],
      inputRouting: 'native',
    });

    expect(capabilities.adapterKind).toBe('localPreview');
    expect(capabilities.diagnosticsFidelityByFamily.network).toBe('previewProxy');
    expect(capabilities.automationActions.snapshot?.fidelity).toBe('injectedPage');
    expect(capabilities.automationActions.click?.trustedInput).toBe(false);
  });

  it('models simulator previews as a first-class streamed-display adapter', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    expect(mod.BrowserSemanticAdapterKindV1Schema.parse('simulatorPreview')).toBe('simulatorPreview');

    const capabilities = mod.BrowserAdapterCapabilitiesV1Schema.parse({
      adapterKind: 'simulatorPreview',
      supportedTargetKinds: ['simulatorPreview'],
      supportedRenderEngines: ['streamedSurface'],
      inputRouting: 'pmsControlSideband',
      supportsStreamingDisplay: true,
    });

    expect(capabilities.adapterKind).toBe('simulatorPreview');
    expect(capabilities.supportedTargetKinds).toEqual(['simulatorPreview']);
    expect(capabilities.supportedRenderEngines).toEqual(['streamedSurface']);
    expect(capabilities.inputRouting).toBe('pmsControlSideband');
    expect(capabilities.supportsStreamingDisplay).toBe(true);
    expect(capabilities.automationActions?.snapshot?.available ?? false).toBe(false);
  });

  it('allows externalUrl adapters that render external URLs in the web iframe (best-effort framed browsing + system-browser escape)', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    // The web engine embeds external URLs best-effort in a sandboxed iframe; non-framable sites fall
    // back to the always-present open-in-system-browser escape (BrowserFrameExternalEscape). So an
    // externalUrl adapter legitimately advertises `webIframe` with usable navigation. The earlier
    // guard rejecting this contradicted the shipped iframe feature and disabled the address bar.
    const result = mod.BrowserAdapterCapabilitiesV1Schema.safeParse({
      adapterKind: 'externalUrl',
      supportedTargetKinds: ['externalUrl'],
      supportedRenderEngines: ['webIframe'],
      navigation: {
        canNavigate: true,
        canGoBack: false,
        canGoForward: false,
        canReload: true,
        canStop: true,
      },
      diagnosticsFidelityByFamily: {},
      contextKinds: ['browserPageReference'],
      inputRouting: 'native',
    });

    expect(result.success).toBe(true);
  });

  it('requires automation capabilities to be per-action and fidelity-labeled', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const capabilities = mod.BrowserAdapterCapabilitiesV1Schema.parse({
      adapterKind: 'hostedPlugin',
      supportedTargetKinds: ['hostedPluginWeb'],
      supportedRenderEngines: ['webIframe'],
      automationActions: {
        snapshot: {
          available: true,
          fidelity: 'injectedPage',
          trustedInput: false,
        },
        click: {
          available: true,
          fidelity: 'webIframe',
          trustedInput: false,
        },
        evaluate: {
          available: false,
          fidelity: 'unavailable',
          trustedInput: false,
          disabledReasons: ['browser_automation_eval_disabled'],
        },
        crossOriginFrameAccess: {
          available: false,
          fidelity: 'unavailable',
          trustedInput: false,
          disabledReasons: ['cross_origin_frame_unavailable'],
        },
      },
    });

    expect(capabilities.automationActions.click).toMatchObject({
      available: true,
      fidelity: 'webIframe',
      trustedInput: false,
    });
    expect(capabilities.automationActions.evaluate?.available).toBe(false);
    expect(capabilities.automationActions.crossOriginFrameAccess?.disabledReasons).toEqual([
      'cross_origin_frame_unavailable',
    ]);
  });
});
