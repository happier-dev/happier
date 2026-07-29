import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveProbeBackendContext } from './capabilitiesProbeContext';

const mocks = vi.hoisted(() => ({
  readCredentials: vi.fn(),
  bootstrapAccountSettingsContext: vi.fn(),
}));

vi.mock('@/persistence', () => ({
  readCredentials: mocks.readCredentials,
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
    mocks.readCredentials.mockReset();
    mocks.bootstrapAccountSettingsContext.mockReset();
    mocks.readCredentials.mockResolvedValue(credentials);
    mocks.bootstrapAccountSettingsContext.mockResolvedValue({
      settings: { runtimePreference: 'connected' },
    });
  });

  it('loads credentials and account settings when connected-service bindings are present', async () => {
    const context = await resolveProbeBackendContext({
      agentId: 'opencode',
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
    });

    expect(mocks.readCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.bootstrapAccountSettingsContext).toHaveBeenCalledWith(expect.objectContaining({
      credentials,
      agentId: 'opencode',
      mode: 'blocking',
      refresh: 'auto',
    }));
    expect(context).toMatchObject({
      backendTarget: undefined,
      credentials,
      accountSettings: { runtimePreference: 'connected' },
    });
  });

  it('applies an explicit runtime-kind override to account settings before returning them', async () => {
    mocks.bootstrapAccountSettingsContext.mockResolvedValue({
      settings: { codexBackendMode: 'mcp' },
    });

    const context = await resolveProbeBackendContext({
      agentId: 'codex',
      runtimeKindOverride: 'appServer',
    });

    expect(mocks.readCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.bootstrapAccountSettingsContext).toHaveBeenCalledTimes(1);
    expect(context).toMatchObject({
      credentials,
      accountSettings: { codexBackendMode: 'appServer' },
    });
  });
});
