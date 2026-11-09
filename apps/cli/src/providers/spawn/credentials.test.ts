import { withSavedSecretMaterializer } from '@/settings/secrets/savedSecretCatalog.testkit';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROVIDER_SETTINGS_V1,
  ProviderSettingsV1Schema,
  encryptSecretStringV1,
  sealSavedSecretResourceStoredContentV1,
  type ProviderSettingsV1,
} from '@happier-dev/protocol';

import {
  resolveProviderCredentialPlaintext,
  resolveProviderCredentialReference,
} from './credentials';
import { createSavedSecretMaterializerV1 } from '@/settings/secrets/savedSecretCatalog';

const key = new Uint8Array(32).fill(7);
const encryptedValue = encryptSecretStringV1('secret-value', key, (length) => new Uint8Array(length).fill(3));
const sharedSecretRef = 'happier:shared-secret:v1:resource-provider';
const sharedSecretResource = {
  resourceId: 'resource-provider',
  ownerAccountId: 'owner-account',
  displayName: 'Shared provider key',
  kind: 'apiKey' as const,
  encryptionMode: 'plain' as const,
  revision: 1,
  storedContent: sealSavedSecretResourceStoredContentV1({
    resourceId: 'resource-provider',
    mode: 'plain',
    content: { v: 1, name: 'Shared provider key', kind: 'apiKey', value: 'shared-provider-value' },
  }),
  materialStatus: 'ready' as const,
};

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
  it('consumes the operation materializer without rebuilding captured secret material', () => {
    const resource = { ...sharedSecretResource, displayName: 'Vault provider key', relationship: 'owner' as const, capabilities: { use: true }, storedContent: sealSavedSecretResourceStoredContentV1({
      resourceId: sharedSecretResource.resourceId, mode: 'plain', content: { v: 2, name: 'Vault provider key', kind: 'apiKey',
        source: { kind: 'external', contribution: { pluginId: 'acme.vault', localId: 'main' }, account: 'account', reference: 'op://vault/item/field' } },
    }) };
    const materializer = createSavedSecretMaterializerV1({ resourceCatalogState: undefined, accountSettings: {}, settingsSecretsReadKeys: [], resources: [resource],
      externalAcquisitions: new Map([[sharedSecretRef, { status: 'ready', value: 'shared-provider-value' }]]) });
    const inspected = materializer.inspect(sharedSecretRef);
    if (inspected.status !== 'ready') throw new Error('Expected admitted secret');
    expect(resolveProviderCredentialPlaintext({
      reference: { kind: 'apiKey', secretId: sharedSecretRef, secretRecordFingerprint: inspected.fingerprint },
      accountSettings: {}, settingsSecretsReadKeys: [], savedSecretMaterializer: materializer,
      connectionId: 'pc_gateway', machineId: 'machine-a',
    })).toMatchObject({ ok: true, credential: { kind: 'apiKey', value: 'shared-provider-value' } });
  });
  it('requires every selected companion binding and refuses rotation or withdrawal of either secret', () => {
    const base = { providerSettings: settings(), accountSettings,
      connectionId: 'pc_gateway', machineId: 'machine-a', credentialSlotId: 'apiKey', required: true,
      additionalCredentials: [{ slotId: 'upstreamKey' }] };
    expect(resolveProviderCredentialReference(withSavedSecretMaterializer(base))).toMatchObject({ ok: false, error: { code: 'provider_secret_missing' } });
    const pairedAccountSettings = { secrets: accountSettings.secrets.map(secret => secret.id === 'secret-account'
      ? { ...secret, encryptedValue: { _isSecretValue: true, encryptedValue: encryptSecretStringV1('upstream-secret-value', key, length => new Uint8Array(length).fill(5)) } }
      : secret) };
    const withCompanion = { ...base, accountSettings: pairedAccountSettings, providerSettings: { ...settings(), secretBindingsByConnectionId: {
      pc_gateway: { account: { apiKey: 'secret-account', upstreamKey: 'secret-account' },
        byMachineId: { 'machine-a': { apiKey: 'secret-machine' } } },
    } } };
    const reference = resolveProviderCredentialReference(withSavedSecretMaterializer(withCompanion));
    expect(reference).toMatchObject({ ok: true, reference: { additionalCredentials: [{ slotId: 'upstreamKey', secretId: 'secret-account' }] } });
    if (!reference.ok) throw new Error('Expected both admitted references');
    const materialize = (current: unknown, isCurrent = () => true) => resolveProviderCredentialPlaintext(withSavedSecretMaterializer({
      reference: reference.reference, accountSettings: current, settingsSecretsReadKeys: [key],
      connectionId: 'pc_gateway', machineId: 'machine-a', isCurrent,
    }));
    expect(materialize(pairedAccountSettings)).toMatchObject({ ok: true, credential: {
      value: 'secret-value', additionalCredentials: [{ slotId: 'upstreamKey', value: 'upstream-secret-value' }],
    } });
    expect(materialize({ secrets: accountSettings.secrets.filter(secret => secret.id !== 'secret-account') }))
      .toMatchObject({ ok: false, error: { code: 'provider_authorization_changed' } });
    expect(materialize(accountSettings)).toMatchObject({ ok: false, error: { code: 'provider_authorization_changed' } });
    expect(materialize(accountSettings, () => false)).toMatchObject({ ok: false, error: { code: 'provider_authorization_changed' } });
  });

  it('selects the machine binding before account binding and fingerprints ciphertext without decrypting', () => {
    const result = resolveProviderCredentialReference(withSavedSecretMaterializer({
      providerSettings: settings(),
      accountSettings,
      connectionId: 'pc_gateway',
      machineId: 'machine-a',
      credentialSlotId: 'apiKey',
      required: true,
    }));

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
    expect(resolveProviderCredentialReference(withSavedSecretMaterializer({
      providerSettings: { ...settings(), secretBindingsByConnectionId: {} },
      accountSettings,
      connectionId: 'pc_gateway',
      machineId: 'machine-a',
      credentialSlotId: 'apiKey',
      required: false,
    }))).toEqual({ ok: true, reference: { kind: 'none' } });
  });

  it('fails before decryption when a required binding or persisted ciphertext is missing', () => {
    expect(resolveProviderCredentialReference(withSavedSecretMaterializer({
      providerSettings: { ...settings(), secretBindingsByConnectionId: {} },
      accountSettings,
      connectionId: 'pc_gateway',
      machineId: 'machine-a',
      credentialSlotId: 'apiKey',
      required: true,
    }))).toMatchObject({ ok: false, error: { code: 'provider_secret_missing' } });

    expect(resolveProviderCredentialReference(withSavedSecretMaterializer({
      providerSettings: settings(),
      accountSettings: {
        secrets: [{ id: 'secret-machine', encryptedValue: { _isSecretValue: true, value: 'plaintext-only' } }],
      },
      connectionId: 'pc_gateway',
      machineId: 'machine-a',
      credentialSlotId: 'apiKey',
      required: true,
    }))).toMatchObject({ ok: false, error: { code: 'provider_secret_missing' } });
  });

  it('decrypts only the exact previously fingerprinted record and rejects rotation races', () => {
    const referenceResult = resolveProviderCredentialReference(withSavedSecretMaterializer({
      providerSettings: settings(), accountSettings, connectionId: 'pc_gateway', machineId: 'machine-a',
      credentialSlotId: 'apiKey', required: true,
    }));
    if (!referenceResult.ok) throw new Error('Expected reference');

    expect(resolveProviderCredentialPlaintext(withSavedSecretMaterializer({
      reference: referenceResult.reference,
      accountSettings,
      settingsSecretsReadKeys: [key],
      connectionId: 'pc_gateway',
      machineId: 'machine-a',
    }))).toEqual({ ok: true, credential: { kind: 'apiKey', value: 'secret-value' } });

    expect(resolveProviderCredentialPlaintext(withSavedSecretMaterializer({ reference: referenceResult.reference, accountSettings,
      settingsSecretsReadKeys: [key], connectionId: 'pc_gateway', machineId: 'machine-a', isCurrent: () => false,
    }))).toMatchObject({ ok: false, error: { code: 'provider_authorization_changed' } });

    const rotated = encryptSecretStringV1('rotated', key, (length) => new Uint8Array(length).fill(4));
    expect(resolveProviderCredentialPlaintext(withSavedSecretMaterializer({
      reference: referenceResult.reference,
      accountSettings: { secrets: [{ id: 'secret-machine', encryptedValue: { _isSecretValue: true, encryptedValue: rotated } }] },
      settingsSecretsReadKeys: [key],
      connectionId: 'pc_gateway',
      machineId: 'machine-a',
    }))).toMatchObject({ ok: false, error: { code: 'provider_authorization_changed' } });
  });

  it('captures and materializes a shared Saved Secret through the canonical catalog', () => {
    const providerSettings = {
      ...settings(),
      secretBindingsByConnectionId: {
        pc_gateway: { account: { apiKey: sharedSecretRef }, byMachineId: {} },
      },
    };
    const referenceResult = resolveProviderCredentialReference(withSavedSecretMaterializer({
      providerSettings,
      accountSettings: { secrets: [] },
      savedSecretResources: [sharedSecretResource],
      connectionId: 'pc_gateway',
      machineId: 'machine-a',
      credentialSlotId: 'apiKey',
      required: true,
    }));
    expect(referenceResult).toMatchObject({
      ok: true,
      reference: { kind: 'apiKey', secretId: sharedSecretRef },
    });
    if (!referenceResult.ok) throw new Error('Expected shared Saved Secret reference');

    expect(resolveProviderCredentialPlaintext(withSavedSecretMaterializer({
      reference: referenceResult.reference,
      accountSettings: { secrets: [] },
      savedSecretResources: [sharedSecretResource],
      settingsSecretsReadKeys: [],
      connectionId: 'pc_gateway',
      machineId: 'machine-a',
    }))).toEqual({ ok: true, credential: { kind: 'apiKey', value: 'shared-provider-value' } });

    expect(resolveProviderCredentialPlaintext(withSavedSecretMaterializer({
      reference: referenceResult.reference,
      accountSettings: { secrets: [] },
      savedSecretResources: [{ ...sharedSecretResource, revision: 2 }],
      settingsSecretsReadKeys: [],
      connectionId: 'pc_gateway',
      machineId: 'machine-a',
    }))).toMatchObject({ ok: false, error: { code: 'provider_authorization_changed' } });
  });
});
