import { describe, expect, it } from 'vitest';

import { OPENCODE_AGENT_RUNTIME_CONTRIBUTION } from './runtime.js';

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
  connectedServices?: Readonly<{
    runtimeAuthAdapter?: Readonly<{
      classifyRuntimeAuthFailure?: (input: Readonly<{ error: unknown; selection?: unknown }>) => unknown;
      refreshActiveProfile?: (input: unknown) => Promise<unknown>;
      recoverAfterRuntimeAuthSwitch?: (input: unknown) => Promise<unknown>;
    }>;
  }>;
}>;

describe('OPENCODE_AGENT_RUNTIME_CONTRIBUTION', () => {
  it('publishes the plugin-owned session-control adapter behavior', () => {
    const contribution: RuntimeContributionWithSessionControl = OPENCODE_AGENT_RUNTIME_CONTRIBUTION;
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
      opencodeServerBaseUrl: 'http://127.0.0.1:49196',
      opencodeServerBaseUrlExplicit: true,
    })).toBe('server');
    expect(adapter?.resolveVendorResumeId?.({
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'opencode',
        provider: {
          backendMode: 'server',
          providerSessionId: ' opencode-session-1 ',
        },
      },
    })).toBe('opencode-session-1');
  });

  it('publishes the plugin-owned connected-service runtime-auth adapter', async () => {
    const contribution: RuntimeContributionWithSessionControl = OPENCODE_AGENT_RUNTIME_CONTRIBUTION;
    const adapter = contribution.connectedServices?.runtimeAuthAdapter;

    expect(adapter?.classifyRuntimeAuthFailure).toBeTypeOf('function');
    expect(adapter?.refreshActiveProfile).toBeTypeOf('function');
    expect(adapter?.recoverAfterRuntimeAuthSwitch).toBeTypeOf('function');
    expect(adapter?.classifyRuntimeAuthFailure?.({
      selection: {
        serviceId: 'openai-codex',
        activeProfileId: 'profile-1',
      },
      error: {
        name: 'ProviderAuthError',
        data: { message: 'Token refresh failed: 401' },
      },
    })).toMatchObject({
      serviceId: 'openai-codex',
      profileId: 'profile-1',
      kind: 'auth_expired',
      connectedServiceRecovery: 'available',
    });
  });
});
