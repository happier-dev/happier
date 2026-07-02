import { describe, expect, it } from 'vitest';

import { OPENCODE_PROVIDER_RUNTIME_CONTRIBUTION } from './runtime.js';

type SessionControlAdapter = Readonly<{
  normalizeRuntimeKindOverride?: (value: unknown) => 'server' | 'acp' | null;
  applyRuntimeKindOverrideToAccountSettings?: (
    accountSettings: Record<string, unknown> | null,
    runtimeKind: 'server' | 'acp',
  ) => Record<string, unknown> | null;
  resolveConfiguredRuntimeKind?: (accountSettings?: Record<string, unknown> | null) => 'server' | 'acp' | null;
  resolvePersistedSessionRuntimeKind?: (metadata: unknown) => 'server' | 'acp' | null;
  resolveVendorResumeId?: (metadata: unknown) => string | null;
}>;

type RuntimeContributionWithSessionControl = Readonly<{
  sessionControlAdapter?: SessionControlAdapter;
}>;

describe('OPENCODE_PROVIDER_RUNTIME_CONTRIBUTION', () => {
  it('publishes the plugin-owned session-control adapter behavior', () => {
    const contribution: RuntimeContributionWithSessionControl = OPENCODE_PROVIDER_RUNTIME_CONTRIBUTION;
    const adapter = contribution.sessionControlAdapter;

    expect(adapter).toBeDefined();
    expect(adapter?.normalizeRuntimeKindOverride?.(' acp ')).toBe('acp');
    expect(adapter?.normalizeRuntimeKindOverride?.('server')).toBe('server');
    expect(adapter?.normalizeRuntimeKindOverride?.('appServer')).toBeNull();
    expect(adapter?.applyRuntimeKindOverrideToAccountSettings?.({ other: 'value' }, 'server')).toEqual({
      other: 'value',
      opencodeBackendMode: 'server',
    });
    expect(adapter?.resolveConfiguredRuntimeKind?.({ opencodeBackendMode: ' acp ' })).toBe('acp');
    expect(adapter?.resolvePersistedSessionRuntimeKind?.({
      opencodeBackendMode: 'server',
      opencodeServerBaseUrl: 'http://127.0.0.1:4096',
      opencodeServerBaseUrlExplicit: true,
    })).toBe('server');
    expect(adapter?.resolveVendorResumeId?.({
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'opencode',
        provider: {
          backendMode: 'server',
          providerSessionId: ' opencode-session-1 ',
        },
      },
    })).toBe('opencode-session-1');
  });
});
