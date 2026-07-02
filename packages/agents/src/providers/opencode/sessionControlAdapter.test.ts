import { describe, expect, it } from 'vitest';

import { OPENCODE_SESSION_CONTROL_ADAPTER } from './sessionControlAdapter.js';

describe('OPENCODE_SESSION_CONTROL_ADAPTER', () => {
  it('normalizes configured and persisted OpenCode runtime kinds', () => {
    expect(OPENCODE_SESSION_CONTROL_ADAPTER.normalizeRuntimeKindOverride(' acp ')).toBe('acp');
    expect(OPENCODE_SESSION_CONTROL_ADAPTER.normalizeRuntimeKindOverride('server')).toBe('server');
    expect(OPENCODE_SESSION_CONTROL_ADAPTER.normalizeRuntimeKindOverride('appServer')).toBeNull();
    expect(OPENCODE_SESSION_CONTROL_ADAPTER.resolveConfiguredRuntimeKind({ opencodeBackendMode: ' acp ' })).toBe('acp');
    expect(OPENCODE_SESSION_CONTROL_ADAPTER.resolvePersistedSessionRuntimeKind({
      opencodeBackendMode: 'server',
      opencodeServerBaseUrl: 'http://127.0.0.1:4096',
      opencodeServerBaseUrlExplicit: true,
    })).toBe('server');
  });

  it('applies runtime kind overrides and reads vendor resume ids', () => {
    expect(OPENCODE_SESSION_CONTROL_ADAPTER.applyRuntimeKindOverrideToAccountSettings({ other: 'value' }, 'server')).toEqual({
      other: 'value',
      opencodeBackendMode: 'server',
    });
    expect(OPENCODE_SESSION_CONTROL_ADAPTER.resolveVendorResumeId({
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'opencode',
        provider: {
          backendMode: 'server',
          vendorSessionId: ' opencode-session-1 ',
        },
      },
    })).toBe('opencode-session-1');
  });
});
