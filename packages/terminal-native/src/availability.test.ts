import { describe, expect, it } from 'vitest';

async function loadAvailabilityModule() {
  return import('./availability').catch((error: unknown) => error);
}

describe('terminal native availability', () => {
  it('reports unsupported platforms before touching a native module', async () => {
    const mod = await loadAvailabilityModule();
    expect(mod).toHaveProperty('getTerminalNativeAvailability');
    const availability = mod as {
      getTerminalNativeAvailability: (options: {
        nativeModule?: null;
        platform?: string;
      }) => unknown;
    };

    expect(availability.getTerminalNativeAvailability({ nativeModule: null, platform: 'web' })).toEqual({
      available: false,
      reason: 'unsupported-platform',
      detail: 'Native terminal renderers are only available on iOS and Android native builds.',
    });
  });

  it('distinguishes build exclusion, feature-disabled, missing module, and accessibility-unproven states', async () => {
    const mod = await loadAvailabilityModule();
    expect(mod).toHaveProperty('getTerminalNativeAvailability');
    const availability = mod as {
      getTerminalNativeAvailability: (options: {
        nativeModule?: unknown;
        platform?: string;
        buildIncluded?: boolean;
        featureEnabled?: boolean;
        accessibilityAccepted?: boolean;
      }) => unknown;
    };

    expect(availability.getTerminalNativeAvailability({ buildIncluded: false, platform: 'ios' })).toEqual({
      available: false,
      reason: 'build-not-included',
      detail: 'Native terminal renderers were excluded at build time.',
    });
    expect(availability.getTerminalNativeAvailability({ featureEnabled: false, platform: 'ios' })).toEqual({
      available: false,
      reason: 'feature-disabled',
      detail: 'Native terminal renderer features are disabled.',
    });
    expect(availability.getTerminalNativeAvailability({ nativeModule: null, platform: 'android' })).toEqual({
      available: false,
      reason: 'native-module-missing',
      detail: 'HappierTerminalNative is not linked in this native build.',
    });

    const nativeModule = {
      getAvailability: () => ({
        available: true,
        platform: 'ios',
        renderer: 'ios-ghosttykit',
        moduleVersion: '0.0.0',
        accessibility: 'fallback-required',
      }),
    };

    expect(availability.getTerminalNativeAvailability({
      nativeModule,
      platform: 'ios',
      accessibilityAccepted: false,
    })).toEqual({
      available: false,
      reason: 'accessibility-unproven',
      detail: 'Native terminal renderer accessibility has not been accepted for default selection.',
    });

    expect(availability.getTerminalNativeAvailability({
      nativeModule,
      platform: 'ios',
    })).toEqual({
      available: false,
      reason: 'accessibility-unproven',
      detail: 'Native terminal renderer accessibility has not been accepted for default selection.',
    });
  });

  it('normalizes native-package gate failures from platform modules', async () => {
    const mod = await loadAvailabilityModule();
    expect(mod).toHaveProperty('normalizeTerminalNativeAvailability');
    const availability = mod as {
      normalizeTerminalNativeAvailability: (payload: unknown) => unknown;
    };

    expect(availability.normalizeTerminalNativeAvailability({
      available: false,
      reason: 'package-proof-unaccepted',
      detail: 'package proof pending',
    })).toEqual({
      available: false,
      reason: 'package-proof-unaccepted',
      detail: 'package proof pending',
    });

    expect(availability.normalizeTerminalNativeAvailability({
      available: false,
      reason: 'artifact-missing',
    })).toEqual({
      available: false,
      reason: 'artifact-missing',
    });

    expect(availability.normalizeTerminalNativeAvailability({
      available: false,
      reason: 'abi-unsupported',
      detail: 'arm64-v8a smoke missing',
    })).toEqual({
      available: false,
      reason: 'abi-unsupported',
      detail: 'arm64-v8a smoke missing',
    });

    expect(availability.normalizeTerminalNativeAvailability({
      available: false,
      reason: 'surface-not-ready',
      detail: 'surface has not been initialized',
    })).toEqual({
      available: false,
      reason: 'surface-not-ready',
      detail: 'surface has not been initialized',
    });
  });

  it('rejects renderer availability for a different runtime platform', async () => {
    const mod = await loadAvailabilityModule();
    expect(mod).toHaveProperty('getTerminalNativeAvailability');
    const availability = mod as {
      getTerminalNativeAvailability: (options: {
        nativeModule?: unknown;
        platform?: string;
        buildIncluded?: boolean;
        featureEnabled?: boolean;
        accessibilityAccepted?: boolean;
      }) => unknown;
    };

    const nativeModule = {
      getAvailability: () => ({
        available: true,
        platform: 'ios',
        renderer: 'ios-ghosttykit',
        moduleVersion: '0.0.0',
        accessibility: 'native',
      }),
    };

    expect(availability.getTerminalNativeAvailability({
      nativeModule,
      platform: 'android',
      buildIncluded: true,
      featureEnabled: true,
      accessibilityAccepted: true,
    })).toEqual({
      available: false,
      reason: 'renderer-unavailable',
      detail: 'HappierTerminalNative returned renderer availability for a different platform.',
    });
  });

  it('accepts platform-matched native renderer availability after gates pass', async () => {
    const mod = await loadAvailabilityModule();
    expect(mod).toHaveProperty('getTerminalNativeAvailability');
    const availability = mod as {
      getTerminalNativeAvailability: (options: {
        nativeModule?: unknown;
        platform?: string;
        buildIncluded?: boolean;
        featureEnabled?: boolean;
        accessibilityAccepted?: boolean;
      }) => unknown;
    };

    const nativeModule = {
      getAvailability: () => ({
        available: true,
        platform: 'android',
        renderer: 'android-termux',
        moduleVersion: '0.0.0',
        accessibility: 'native',
      }),
    };

    expect(availability.getTerminalNativeAvailability({
      nativeModule,
      platform: 'android',
      buildIncluded: true,
      featureEnabled: true,
      accessibilityAccepted: true,
    })).toEqual({
      available: true,
      platform: 'android',
      renderer: 'android-termux',
      moduleVersion: '0.0.0',
      accessibility: 'native',
    });
  });

  it('returns explicit diagnostics for fallback-required native states', async () => {
    const mod = await loadAvailabilityModule();
    expect(mod).toHaveProperty('getTerminalNativeAvailabilityDiagnostic');
    const availability = mod as {
      getTerminalNativeAvailabilityDiagnostic: (options: {
        nativeModule?: unknown;
        platform?: string;
        buildIncluded?: boolean;
        featureEnabled?: boolean;
        accessibilityAccepted?: boolean;
      }) => unknown;
    };

    expect(availability.getTerminalNativeAvailabilityDiagnostic({
      buildIncluded: false,
      platform: 'ios',
    })).toEqual({
      availability: {
        available: false,
        reason: 'build-not-included',
        detail: 'Native terminal renderers were excluded at build time.',
      },
      fallbackRenderer: 'xterm-webview',
      fallbackRequired: true,
      blockers: [{
        reason: 'build-not-included',
        detail: 'Native terminal renderers were excluded at build time.',
      }],
    });

    expect(availability.getTerminalNativeAvailabilityDiagnostic({
      nativeModule: {
        getAvailability: () => ({
          available: true,
          platform: 'ios',
          renderer: 'ios-ghosttykit',
          moduleVersion: '0.0.0',
          accessibility: 'fallback-required',
        }),
      },
      platform: 'ios',
      buildIncluded: true,
      featureEnabled: true,
      accessibilityAccepted: true,
    })).toEqual({
      availability: {
        available: true,
        platform: 'ios',
        renderer: 'ios-ghosttykit',
        moduleVersion: '0.0.0',
        accessibility: 'fallback-required',
      },
      fallbackRenderer: 'xterm-webview',
      fallbackRequired: true,
      blockers: [],
    });

    expect(availability.getTerminalNativeAvailabilityDiagnostic({
      nativeModule: {
        getAvailability: () => ({
          available: true,
          platform: 'ios',
          renderer: 'ios-ghosttykit',
          moduleVersion: '0.0.0',
          accessibility: 'native',
        }),
      },
      platform: 'ios',
      buildIncluded: true,
      featureEnabled: true,
      accessibilityAccepted: true,
    })).toEqual({
      availability: {
        available: true,
        platform: 'ios',
        renderer: 'ios-ghosttykit',
        moduleVersion: '0.0.0',
        accessibility: 'native',
      },
      fallbackRenderer: 'xterm-webview',
      fallbackRequired: false,
      blockers: [],
    });
  });
});
