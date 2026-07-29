import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROVIDER_SETTINGS_V1,
  ProviderSettingsV1Schema,
  encryptSecretStringV1,
  type ProviderSettingsV1,
} from '@happier-dev/protocol';

import {
  resolveProviderCredentialPlaintext,
  resolveProviderCredentialReference,
} from './credentials';

const key = new Uint8Array(32).fill(7);
const encryptedValue = encryptSecretStringV1('secret-value', key, (length) => new Uint8Array(length).fill(3));

function settings(): ProviderSettingsV1 {
  return ProviderSettingsV1Schema.parse({
    ...DEFAULT_PROVIDER_SETTINGS_V1,
    connections: [{
      v: 1,
      id: 'pc_gateway',
      source: { kind: 'contribution', contributionKey: 'acme.gateway/main' },
      role: 'default',
      displayName: 'Gateway',
      displayNameMode: 'automatic',
      revision: 0,
      createdAt: 1,
      updatedAt: 1,
    }],
    secretBindingsByConnectionId: {
      pc_gateway: {
        account: { apiKey: 'secret-account' },
        byMachineId: { 'machine-a': { apiKey: 'secret-machine' } },
      },
    },
  });
}

const accountSettings = {
  secrets: [
    { id: 'secret-account', encryptedValue: { _isSecretValue: true, encryptedValue } },
    { id: 'secret-machine', encryptedValue: { _isSecretValue: true, encryptedValue } },
  ],
};

describe('provider spawn credential resolution', () => {
  it('selects the machine binding before account binding and fingerprints ciphertext without decrypting', () => {
    const result = resolveProviderCredentialReference({
      providerSettings: settings(),
      accountSettings,
      connectionId: 'pc_gateway',
      machineId: 'machine-a',
      credentialSlotId: 'apiKey',
      required: true,
    });

    expect(result).toMatchObject({
      ok: true,
      reference: {
        kind: 'apiKey',
        secretId: 'secret-machine',
        secretRecordFingerprint: expect.stringMatching(/^saved-secret-record:v1:/),
      },
    });
  });

  it('returns explicit no-auth for an optional unbound credential', () => {
    expect(resolveProviderCredentialReference({
      providerSettings: { ...settings(), secretBindingsByConnectionId: {} },
      accountSettings,
      connectionId: 'pc_gateway',
      machineId: 'machine-a',
      credentialSlotId: 'apiKey',
      required: false,
    })).toEqual({ ok: true, reference: { kind: 'none' } });
  });

  it('fails before decryption when a required binding or persisted ciphertext is missing', () => {
    expect(resolveProviderCredentialReference({
      providerSettings: { ...settings(), secretBindingsByConnectionId: {} },
      accountSettings,
      connectionId: 'pc_gateway',
      machineId: 'machine-a',
      credentialSlotId: 'apiKey',
      required: true,
    })).toMatchObject({ ok: false, error: { code: 'provider_secret_missing' } });

    expect(resolveProviderCredentialReference({
      providerSettings: settings(),
      accountSettings: {
        secrets: [{ id: 'secret-machine', encryptedValue: { _isSecretValue: true, value: 'plaintext-only' } }],
      },
      connectionId: 'pc_gateway',
      machineId: 'machine-a',
      credentialSlotId: 'apiKey',
      required: true,
    })).toMatchObject({ ok: false, error: { code: 'provider_secret_missing' } });
  });

  it('decrypts only the exact previously fingerprinted record and rejects rotation races', () => {
    const referenceResult = resolveProviderCredentialReference({
      providerSettings: settings(), accountSettings, connectionId: 'pc_gateway', machineId: 'machine-a',
      credentialSlotId: 'apiKey', required: true,
    });
    if (!referenceResult.ok) throw new Error('Expected reference');

    expect(resolveProviderCredentialPlaintext({
      reference: referenceResult.reference,
      accountSettings,
      settingsSecretsReadKeys: [key],
      connectionId: 'pc_gateway',
      machineId: 'machine-a',
    })).toEqual({ ok: true, credential: { kind: 'apiKey', value: 'secret-value' } });

    const rotated = encryptSecretStringV1('rotated', key, (length) => new Uint8Array(length).fill(4));
    expect(resolveProviderCredentialPlaintext({
      reference: referenceResult.reference,
      accountSettings: { secrets: [{ id: 'secret-machine', encryptedValue: { _isSecretValue: true, encryptedValue: rotated } }] },
      settingsSecretsReadKeys: [key],
      connectionId: 'pc_gateway',
      machineId: 'machine-a',
    })).toMatchObject({ ok: false, error: { code: 'provider_authorization_changed' } });
  });
});
