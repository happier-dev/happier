import { afterEach, describe, expect, it } from 'vitest';

import {
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createVoiceCredentialResolver } from './resolver';

function publish(params: Readonly<{ scopeKey: string; accountValue: string; machineValue?: string }>) {
  setActiveAccountSettingsSnapshot({
    source: 'network', scopeKey: params.scopeKey, settingsVersion: 1, loadedAtMs: 1,
    settingsSecretsReadKeys: [],
    settings: {
      secrets: [
        { id: `${params.scopeKey}-account`, encryptedValue: { _isSecretValue: true, value: params.accountValue } },
        ...(params.machineValue ? [{ id: `${params.scopeKey}-machine`, encryptedValue: { _isSecretValue: true, value: params.machineValue } }] : []),
      ],
      voice: {
        credentialBindings: [{
          providerId: 'google_gemini',
          credentialBindings: {
            account: { api_key: `${params.scopeKey}-account` },
            ...(params.machineValue ? { byMachineId: { machine_a: { api_key: `${params.scopeKey}-machine` } } } : {}),
          },
        }],
      },
    } as never,
  });
}

afterEach(() => resetActiveAccountSettingsSnapshotForTests());

describe('Voice credential resolver', () => {
  it('reports and materializes a machine override before account fallback', async () => {
    publish({ scopeKey: 'account-a', accountValue: 'account-key', machineValue: 'machine-key' });
    const resolver = createVoiceCredentialResolver({ machineId: 'machine_a' });
    expect(resolver.status('google_gemini', 'api_key')).toEqual({ available: true, source: 'machine_override' });
    await expect(resolver.withSecret({
      providerId: 'google_gemini', credentialSlotId: 'api_key',
      use: async (secret) => secret,
    })).resolves.toBe('machine-key');
  });

  it('does not reuse account A after the active snapshot switches to account B', async () => {
    const resolver = createVoiceCredentialResolver({ machineId: 'machine_a' });
    publish({ scopeKey: 'account-a', accountValue: 'a-key' });
    await expect(resolver.withSecret({ providerId: 'google_gemini', credentialSlotId: 'api_key', use: async (secret) => secret }))
      .resolves.toBe('a-key');
    publish({ scopeKey: 'account-b', accountValue: 'b-key' });
    await expect(resolver.withSecret({ providerId: 'google_gemini', credentialSlotId: 'api_key', use: async (secret) => secret }))
      .resolves.toBe('b-key');
  });

  it('fails an in-flight use when the active account snapshot changes', async () => {
    const resolver = createVoiceCredentialResolver({ machineId: null });
    publish({ scopeKey: 'account-a', accountValue: 'a-key' });
    let markStarted!: () => void;
    let releaseUse!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseUse = resolve; });
    const operation = resolver.withSecret({
      providerId: 'google_gemini',
      credentialSlotId: 'api_key',
      use: async (secret) => {
        markStarted();
        await release;
        return secret;
      },
    });
    await started;
    publish({ scopeKey: 'account-b', accountValue: 'b-key' });
    releaseUse();

    await expect(operation).rejects.toMatchObject({ code: 'credential_unavailable' });
  });

  it('resolves account-only client operations without consulting machine overrides', async () => {
    publish({ scopeKey: 'account-a', accountValue: 'account-key', machineValue: 'machine-key' });
    const resolver = createVoiceCredentialResolver({ machineId: null });
    expect(resolver.status('google_gemini', 'api_key')).toEqual({
      available: true,
      source: 'account',
    });
    await expect(resolver.withSecret({
      providerId: 'google_gemini',
      credentialSlotId: 'api_key',
      use: async (secret) => secret,
    })).resolves.toBe('account-key');
  });

  it('fails closed when the binding, record, or decryptable value is unavailable', async () => {
    publish({ scopeKey: 'account-a', accountValue: 'a-key' });
    const resolver = createVoiceCredentialResolver({ machineId: 'machine_a' });
    await expect(resolver.withSecret({ providerId: 'google_cloud', credentialSlotId: 'api_key', use: async () => undefined }))
      .rejects.toMatchObject({ code: 'credential_unavailable' });
  });
});
