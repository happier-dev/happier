import { describe, expect, it } from 'vitest';

import * as runtimePreferences from './index.js';
import { getProviderRuntimePreferencesAdapter } from './index.js';

describe('getProviderRuntimePreferencesAdapter', () => {
  it('projects canonical runtime preference defaults from the provider catalog', () => {
    expect(getProviderRuntimePreferencesAdapter('codex')).toEqual({
      sourcePreference: { default: 'system-first' },
      defaultRuntimeKind: { default: 'appServer' },
    });
    expect(getProviderRuntimePreferencesAdapter('opencode')).toEqual({
      sourcePreference: { default: 'system-first' },
      defaultRuntimeKind: { default: 'server' },
    });
  });

  it('does not expose plugin-owned Codex runtime preference helpers from the shared facade', () => {
    const codexRuntimePreferenceExports = [
      'isCodexVendorResumeBackendEnabled',
      'resolveCodexSessionRuntimePreferences',
      'resolveCodexRuntimeBackendMode',
      'resolveCodexSpawnExtrasForRuntime',
      'resolveCodexSpawnExtrasFromSettings',
    ] as const;

    for (const exportName of codexRuntimePreferenceExports) {
      expect(exportName in runtimePreferences).toBe(false);
    }
  });
});
