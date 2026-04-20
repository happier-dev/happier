import { describe, expect, it } from 'vitest';

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
});
