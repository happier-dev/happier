import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  readCredentialsMock,
  readStoredCredentialsMock,
} = vi.hoisted(() => ({
  readCredentialsMock: vi.fn(),
  readStoredCredentialsMock: vi.fn(),
}));

vi.mock('@/persistence', () => ({
  readCredentials: readCredentialsMock,
  readStoredCredentials: readStoredCredentialsMock,
}));

vi.mock('@/features/featureDecisionService', () => ({
  resolveCliFeatureDecisionForServer: vi.fn(async () => ({
    decision: { state: 'enabled' },
    serverSnapshot: null,
  })),
  resolveCliFeatureDecision: vi.fn(() => ({ state: 'enabled' })),
}));

import { indexSavedSecretsByIdFromAccountSettings } from '@/settings/secrets/indexSavedSecretsById';
import { resolveMcpValueRefPlaintext } from '@/mcp/servers/resolveMcpValueRefPlaintext';
import { resolveProviderCliDependencies } from './deps';

describe('resolveProviderCliDependencies token-only settings secrets', () => {
  beforeEach(() => {
    readCredentialsMock.mockReset();
    readStoredCredentialsMock.mockReset();
    readCredentialsMock.mockResolvedValue(null);
    readStoredCredentialsMock.mockResolvedValue({
      token: 'token-only',
      encryption: null,
    });
  });

  it('creates a plaintext Saved Secret that the canonical resolver can use without a key', async () => {
    const deps = await resolveProviderCliDependencies();
    const prepared = await deps.createSavedSecret({
      name: 'Provider API key',
      value: 'sk-token-only-provider',
    });
    const accountSettings = { secrets: [prepared.record] };
    const savedSecretsById = indexSavedSecretsByIdFromAccountSettings(accountSettings);

    expect(prepared.record.encryptedValue).toEqual({
      _isSecretValue: true,
      value: 'sk-token-only-provider',
    });
    expect(resolveMcpValueRefPlaintext({
      valueRef: { t: 'savedSecret', secretId: prepared.id },
      savedSecretsById,
      settingsSecretsKey: null,
      settingsSecretsReadKeys: [],
      processEnv: {},
    })).toBe('sk-token-only-provider');
    expect(readStoredCredentialsMock).toHaveBeenCalledOnce();
    expect(readCredentialsMock).not.toHaveBeenCalled();
  });
});
