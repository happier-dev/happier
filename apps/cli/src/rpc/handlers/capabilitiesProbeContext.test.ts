import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveProbeBackendContext } from './capabilitiesProbeContext';

const mocks = vi.hoisted(() => ({
  readStoredCredentials: vi.fn(),
  bootstrapAccountSettingsContext: vi.fn(),
}));

vi.mock('@/persistence', () => ({
  readStoredCredentials: mocks.readStoredCredentials,
}));

vi.mock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
  bootstrapAccountSettingsContext: mocks.bootstrapAccountSettingsContext,
}));

vi.mock('@/agent/catalog/registry', () => ({
  AGENTS: {
    opencode: { id: 'opencode' },
    codex: { id: 'codex', needsAccountSettingsForProbes: true },
  },
}));

describe('resolveProbeBackendContext', () => {
  const credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) },
  };

  beforeEach(() => {
    mocks.readStoredCredentials.mockReset();
    mocks.bootstrapAccountSettingsContext.mockReset();
    mocks.readStoredCredentials.mockResolvedValue(credentials);
    mocks.bootstrapAccountSettingsContext.mockResolvedValue({
      settings: { runtimePreference: 'connected' },
    });
  });

  it('loads plain account settings with token-only credentials', async () => {
    const tokenOnlyCredentials = {
      token: 'plain-token',
      encryption: null,
    };
    mocks.readStoredCredentials.mockResolvedValue(tokenOnlyCredentials);

    const context = await resolveProbeBackendContext({
      agentId: 'codex',
    });

    expect(mocks.readStoredCredentials).toHaveBeenCalledOnce();
    expect(mocks.bootstrapAccountSettingsContext).toHaveBeenCalledWith(expect.objectContaining({
      credentials: tokenOnlyCredentials,
    }));
    expect(context.credentials).toEqual(tokenOnlyCredentials);
  });

  it('does not load credentials or account settings for connected-service bindings', async () => {
    const context = await resolveProbeBackendContext({
      agentId: 'opencode',
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
    });

    expect(mocks.readStoredCredentials).not.toHaveBeenCalled();
    expect(mocks.bootstrapAccountSettingsContext).not.toHaveBeenCalled();
    expect(context).toEqual({
      backendTarget: undefined,
      credentials: null,
      accountSettings: null,
    });
  });

  it('retains account settings for configured ACP SavedSecret probes', async () => {
    const accountSettings = {
      secrets: [{
        id: 'secret-acp',
        name: 'ACP token',
        kind: 'token',
        encryptedValue: { _isSecretValue: true, value: 'plain-account-secret' },
        createdAt: 1,
        updatedAt: 1,
      }],
    };
    mocks.bootstrapAccountSettingsContext.mockResolvedValue({ settings: accountSettings });
    const backendTarget = { kind: 'configuredAcpBackend', backendId: 'review-bot' } as const;

    const context = await resolveProbeBackendContext({
      agentId: 'opencode',
      backendTarget,
    });

    expect(mocks.readStoredCredentials).toHaveBeenCalledOnce();
    expect(mocks.bootstrapAccountSettingsContext).toHaveBeenCalledWith(expect.objectContaining({
      credentials,
      backendTarget,
      mode: 'blocking',
      refresh: 'auto',
    }));
    expect(context).toEqual({
      backendTarget,
      credentials,
      accountSettings,
    });
  });

  it('does not let a probe transport parameter rewrite canonical account settings', async () => {
    mocks.bootstrapAccountSettingsContext.mockResolvedValue({
      settings: { codexBackendMode: 'mcp' },
    });

    const context = await resolveProbeBackendContext({
      agentId: 'codex',
      runtimeKindOverride: 'appServer',
    });

    expect(mocks.readStoredCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.bootstrapAccountSettingsContext).toHaveBeenCalledTimes(1);
    expect(context).toMatchObject({
      credentials,
      accountSettings: { codexBackendMode: 'mcp' },
    });
  });
});
