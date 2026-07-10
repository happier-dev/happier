import { describe, expect, it } from 'vitest';

type BrowserCapabilitiesModule = typeof import('./browserCapabilities.js');

async function loadBrowserCapabilitiesModule(): Promise<BrowserCapabilitiesModule | null> {
  return import('./browserCapabilities.js').catch(() => null);
}

describe('browser capabilities payload', () => {
  it('defaults browser target support to disabled and empty', async () => {
    const mod = await loadBrowserCapabilitiesModule();

    const result = mod?.BrowserCapabilitiesSchema.safeParse({});

    expect(result?.success).toBe(true);
    if (result?.success) {
      expect(result.data.viewTargets.enabled).toBe(false);
      expect(result.data.viewTargets.supportedTargetKinds).toEqual([]);
      expect(result.data.internal.enabled).toBe(false);
      expect(result.data.sidecar.enabled).toBe(false);
      expect(result.data.diagnostics.enabled).toBe(false);
      expect(result.data.diagnostics.bodyCapture).toBe('unavailable');
      expect(result.data.context.enabled).toBe(false);
      expect(result.data.context.supportedContextKinds).toEqual([]);
      expect(result.data.automation.enabled).toBe(false);
      expect(result.data.automation.injectedPage.available).toBe(false);
      expect(result.data.automation.eval.enabled).toBe(false);
      expect(result.data.automation.timeline.maxEntriesPerView).toBe(500);
      expect(result.data.recording.enabled).toBe(false);
      expect(result.data.recording.supportedCaptureKinds).toEqual([]);
      expect(result.data.recording.attachmentsEnabled).toBe(false);
    }
  });

  it('accepts known browser view target kinds only', async () => {
    const mod = await loadBrowserCapabilitiesModule();

    const result = mod?.BrowserCapabilitiesSchema.safeParse({
      viewTargets: {
        enabled: true,
        supportedTargetKinds: ['localServicePreview', 'externalUrl'],
      },
    });

    expect(result?.success).toBe(true);

    const invalid = mod?.BrowserCapabilitiesSchema.safeParse({
      viewTargets: {
        enabled: true,
        supportedTargetKinds: ['rawCdp'],
      },
    });

    expect(invalid?.success).toBe(false);
  });

  it('ignores future top-level browser capability sections without rejecting the feature payload', async () => {
    const mod = await loadBrowserCapabilitiesModule();

    const result = mod?.BrowserCapabilitiesSchema.safeParse({
      viewTargets: {
        enabled: true,
        supportedTargetKinds: ['externalUrl'],
      },
      futureCapturePipeline: {
        enabled: true,
      },
    });

    expect(result?.success).toBe(true);
    if (result?.success) {
      expect(result.data.viewTargets.enabled).toBe(true);
      expect(result.data.viewTargets.supportedTargetKinds).toEqual(['externalUrl']);
      expect(result.data).not.toHaveProperty('futureCapturePipeline');
    }
  });

  it('parses diagnostics and context details as capabilities, not gates', async () => {
    const mod = await loadBrowserCapabilitiesModule();

    const result = mod?.BrowserCapabilitiesSchema.safeParse({
      diagnostics: {
        enabled: true,
        available: true,
        supportedFamilies: ['console', 'network', 'proxyTunnel'],
        supportedFidelities: ['previewProxy', 'injectedPage'],
        retention: {
          consoleEntriesPerView: 1000,
          networkEntriesPerView: 500,
          maxBytesPerView: 8_388_608,
          maxBatchIntervalMs: 100,
        },
        bodyCapture: 'unavailable',
        payloadCapture: 'unavailable',
      },
      context: {
        enabled: true,
        available: true,
        supportedContextKinds: ['browserPageReference', 'browserScreenshot', 'browserNetworkSummary'],
        screenshot: {
          supported: true,
          requiresAttachmentUploads: true,
          maxWidth: 1920,
          maxHeight: 1080,
          maxBytes: 5_000_000,
        },
        text: {
          maxSelectionChars: 2048,
          maxSummaryChars: 8192,
        },
        disabledReasons: [],
      },
    });

    expect(result?.success).toBe(true);
    if (result?.success) {
      expect(result.data.diagnostics.supportedFamilies).toEqual(['console', 'network', 'proxyTunnel']);
      expect(result.data.diagnostics.bodyCapture).toBe('unavailable');
      expect(result.data.context.screenshot.requiresAttachmentUploads).toBe(true);
    }
  });

  it('parses automation details as capability facts, not feature gates', async () => {
    const mod = await loadBrowserCapabilitiesModule();

    const result = mod?.BrowserCapabilitiesSchema.safeParse({
      automation: {
        enabled: true,
        available: true,
        supportedActions: ['snapshot', 'click', 'type', 'waitFor'],
        supportedFidelities: ['nativeWebView', 'injectedPage'],
        supportedAdapterKinds: ['localPreview'],
        maxActionTimeoutMs: 15_000,
        timeline: {
          maxEntriesPerView: 250,
          retentionMs: 300_000,
        },
        injectedPage: {
          enabled: true,
          available: true,
          capabilityVersion: '1.0.0',
        },
        eval: {
          enabled: false,
          available: false,
          requiresDiagnosticsInteraction: true,
        },
      },
    });

    expect(result?.success).toBe(true);
    if (result?.success) {
      expect(result.data.automation.supportedActions).toEqual(['snapshot', 'click', 'type', 'waitFor']);
      expect(result.data.automation.injectedPage.capabilityVersion).toBe('1.0.0');
      expect(result.data.automation.eval.requiresDiagnosticsInteraction).toBe(true);
    }
  });

  it('parses recording details as fail-closed capabilities, not gates or transport bytes', async () => {
    const mod = await loadBrowserCapabilitiesModule();

    const result = mod?.BrowserCapabilitiesSchema.safeParse({
      recording: {
        enabled: true,
        attachmentsEnabled: true,
        available: true,
        supportedCaptureKinds: ['cdpScreencast', 'streamFrameCapture'],
        supportedMimeTypes: ['video/webm', 'video/mp4'],
        supportedAdapterKinds: ['chromiumSidecar', 'streamedBrowserSurface'],
        maxDurationMs: 30_000,
        maxBytes: 16_000_000,
        maxFps: 12,
        audioSupported: false,
        cursorOverlaySupported: true,
        actionTimelineChaptersSupported: true,
        supportedRetentionClasses: ['preSend', 'attached'],
        disabledReasons: [],
      },
    });

    expect(result?.success).toBe(true);
    if (result?.success) {
      expect(result.data.recording.supportedCaptureKinds).toEqual(['cdpScreencast', 'streamFrameCapture']);
      expect(result.data.recording.maxBytes).toBe(16_000_000);
      expect(JSON.stringify(result.data.recording)).not.toContain('base64');
    }
  });
});
