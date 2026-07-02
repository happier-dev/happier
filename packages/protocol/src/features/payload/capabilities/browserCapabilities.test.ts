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
});
