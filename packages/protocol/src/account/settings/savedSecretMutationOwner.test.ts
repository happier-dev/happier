import { describe, expect, it } from 'vitest';

import {
  AccountSettingsSavedSecretMutationError,
  applyAccountSettingsSavedSecretMutation,
  listAccountSettingsSavedSecretReferences,
} from './savedSecretMutationOwner.js';

const secret = {
  id: 'secret-shared',
  name: 'Shared',
  kind: 'apiKey' as const,
  encryptedValue: {
    _isSecretValue: true as const,
    encryptedValue: { t: 'enc-v1' as const, c: 'ciphertext-old' },
  },
  createdAt: 1,
  updatedAt: 1,
  futureSecretMetadata: {
    envelope: { t: 'future', c: 'opaque-target-metadata' },
  },
};

function referencedSettings(): Record<string, unknown> {
  return {
    secrets: [secret],
    secretBindingsByProfileId: {
      profile_a: { TOKEN: secret.id },
    },
    providerSettingsV1: {
      v: 1,
      secretBindingsByConnectionId: {
        pc_a: {
          account: { api_key: secret.id },
          byMachineId: { machine_a: { token: secret.id } },
        },
      },
    },
    voice: {
      credentialBindings: [{
        providerId: 'openai_compat',
        credentialBindings: { account: { api_key: secret.id } },
      }],
    },
    voiceSettingsV1: {
      credentialBindings: [{
        providerId: 'plugin.voice/example',
        credentialBindings: {
          byMachineId: { machine_a: { api_key: secret.id } },
        },
      }],
    },
    mcpServersSettingsV1: {
      v: 1,
      strictMode: false,
      servers: [{
        id: 'server-a',
        env: {
          TOKEN: { t: 'savedSecret', secretId: secret.id },
          LITERAL: { t: 'literal', v: secret.id },
        },
        remote: {
          headers: {
            Authorization: { t: 'savedSecret', secretId: secret.id },
          },
        },
      }],
      bindings: [{
        id: 'binding-a',
        overrides: {
          envPatch: {
            TOKEN: { t: 'savedSecret', secretId: secret.id },
            REMOVED: null,
          },
          remote: {
            headersPatch: {
              Authorization: { t: 'savedSecret', secretId: secret.id },
            },
          },
        },
      }],
    },
    acpCatalogSettingsV1: {
      v: 2,
      backends: [{
        id: 'backend-a',
        env: { TOKEN: { t: 'savedSecret', secretId: secret.id } },
      }],
    },
    connectedAccountServiceConfigurationsV1: {
      v: 1,
      entries: [
        {
          service: { pluginId: 'plugin.example', localId: 'service-a' },
          modeId: 'token',
          revision: 'configuration-1',
          values: {},
          secretRefs: { api_key: secret.id },
        },
        {
          service: { pluginId: 'plugin.example', localId: 'service-b' },
          modeId: 'token',
          revision: 'configuration-2',
          values: {},
          secretRefs: { api_key: secret.id },
        },
      ],
    },
  };
}

describe('Account Settings SavedSecret mutation owner', () => {
  it.each([
    {
      kind: 'unbindAndDelete',
      secretId: secret.id,
      expectedUpdatedAt: 1,
    },
    {
      kind: 'replaceConnectedAccountConfigurationSecret',
      target: {
        service: { pluginId: 'plugin.example', localId: 'service-a' },
        modeId: 'token',
        fieldId: 'api_key',
      },
      expectedConfigurationRevision: 'configuration-1',
      expectedSecretId: secret.id,
      secret: {
        ...secret,
        id: 'secret-retired-operation',
        updatedAt: 2,
      },
    },
  ])('fails the retired $kind mutation closed before settings changes', (mutation) => {
    const settings = referencedSettings();
    const before = structuredClone(settings);

    expect(() => applyAccountSettingsSavedSecretMutation(
      settings,
      mutation as never,
    )).toThrowError(expect.objectContaining<AccountSettingsSavedSecretMutationError>({
      code: 'saved_secret_invalid',
    }));
    expect(settings).toEqual(before);
  });

  it('enumerates every current canonical reference family and rejects referenced deletion typed', () => {
    const settings = referencedSettings();

    expect(
      listAccountSettingsSavedSecretReferences(settings, secret.id)
        .map((reference) => reference.owner),
    ).toEqual([
      'profile',
      'provider',
      'provider',
      'voice',
      'voice',
      'mcp',
      'mcp',
      'mcp',
      'mcp',
      'acp',
      'connectedAccountConfiguration',
      'connectedAccountConfiguration',
    ]);

    expect(() => applyAccountSettingsSavedSecretMutation(settings, {
      kind: 'delete',
      secretId: secret.id,
      expectedUpdatedAt: 1,
    })).toThrowError(expect.objectContaining<AccountSettingsSavedSecretMutationError>({
      code: 'saved_secret_in_use',
    }));
  });

  it('deletes the exact SavedSecret after every canonical owner has unbound it', () => {
    const result = applyAccountSettingsSavedSecretMutation({
      secrets: [secret],
      untouchedFutureRoot: { value: 'preserve-me' },
    }, {
      kind: 'delete',
      secretId: secret.id,
      expectedUpdatedAt: 1,
    });

    expect(result.settings).toEqual({
      secrets: [],
      untouchedFutureRoot: { value: 'preserve-me' },
    });
  });

  it('rejects generic replacement with the stable typed result while a Connected Account configuration references the secret', () => {
    const untouchedSibling = {
      ...secret,
      id: 'secret-untouched',
      name: 'Untouched',
      futureSecretMetadata: {
        envelope: { t: 'future', c: 'opaque-secret-metadata' },
      },
    };
    const settings = {
      ...referencedSettings(),
      secrets: [secret, untouchedSibling],
      untouchedFutureSibling: {
        envelope: { t: 'future', c: 'opaque-byte-for-byte' },
      },
    };
    expect(() => applyAccountSettingsSavedSecretMutation(settings, {
      kind: 'rotateGlobal',
      secretId: secret.id,
      expectedUpdatedAt: 1,
      encryptedValue: {
        _isSecretValue: true,
        encryptedValue: { t: 'enc-v1', c: 'ciphertext-new' },
      },
      updatedAt: 2,
    })).toThrowError(expect.objectContaining<AccountSettingsSavedSecretMutationError>({
      code: 'saved_secret_referenced_by_connected_account_configuration',
      references: [
        {
          owner: 'connectedAccountConfiguration',
          path: 'connectedAccountServiceConfigurationsV1.entries[0].secretRefs.api_key',
        },
        {
          owner: 'connectedAccountConfiguration',
          path: 'connectedAccountServiceConfigurationsV1.entries[1].secretRefs.api_key',
        },
      ],
    }));
    expect(settings.secrets).toEqual([secret, untouchedSibling]);
    expect(
      (
        settings.connectedAccountServiceConfigurationsV1 as {
          entries: Array<{ revision: string }>;
        }
      ).entries.map((entry) => entry.revision),
    ).toEqual(['configuration-1', 'configuration-2']);
  });

  it('preserves generic replacement for non-Connected-Account reference owners', () => {
    const settings = referencedSettings();
    const {
      connectedAccountServiceConfigurationsV1: _connectedAccountConfigurations,
      ...withoutConnectedAccountConfigurations
    } = settings;
    const result = applyAccountSettingsSavedSecretMutation(
      withoutConnectedAccountConfigurations,
      {
        kind: 'rotateGlobal',
        secretId: secret.id,
        expectedUpdatedAt: 1,
        encryptedValue: {
          _isSecretValue: true,
          encryptedValue: { t: 'enc-v1', c: 'ciphertext-new' },
        },
        updatedAt: 2,
      },
    );

    expect(result.settings.secrets).toEqual([
      {
        ...secret,
        encryptedValue: {
          _isSecretValue: true,
          encryptedValue: { t: 'enc-v1', c: 'ciphertext-new' },
        },
        updatedAt: 2,
      },
    ]);
  });

  it('target-locally creates and rebinds one Voice secret while preserving a shared sibling', () => {
    const result = applyAccountSettingsSavedSecretMutation(referencedSettings(), {
      kind: 'replaceVoiceCredentialSecret',
      target: {
        settingsKey: 'voice',
        providerId: 'openai_compat',
        credentialSlotId: 'api_key',
        machineId: null,
      },
      expectedSecretId: secret.id,
      expectedSecretUpdatedAt: 1,
      secret: {
        ...secret,
        id: 'secret-voice-target-local',
        name: 'Voice target local',
        encryptedValue: {
          _isSecretValue: true,
          encryptedValue: { t: 'enc-v1', c: 'ciphertext-voice-target-local' },
        },
        createdAt: 2,
        updatedAt: 2,
      },
      approvedRecipientContractDigest: 'recipient-contract-next',
    });

    expect((result.settings.secrets as Array<{ id: string }>).map(({ id }) => id))
      .toEqual(['secret-voice-target-local', secret.id]);
    expect(result.settings.voice).toMatchObject({
      credentialBindings: [{
        providerId: 'openai_compat',
        approvedRecipientContractDigest: 'recipient-contract-next',
        credentialBindings: {
          account: { api_key: 'secret-voice-target-local' },
        },
      }],
    });
    expect(
      listAccountSettingsSavedSecretReferences(result.settings, secret.id)
        .map((reference) => reference.owner),
    ).toContain('profile');
    expect(
      listAccountSettingsSavedSecretReferences(result.settings, secret.id)
        .filter((reference) => reference.owner === 'voice'),
    ).toHaveLength(1);
  });

  it('atomically removes one Voice binding and deletes its secret only when no sibling still references it', () => {
    const exclusive = {
      ...referencedSettings(),
      secretBindingsByProfileId: {},
      providerSettingsV1: { v: 1, secretBindingsByConnectionId: {} },
      voiceSettingsV1: { credentialBindings: [] },
      mcpServersSettingsV1: { v: 1, servers: [], bindings: [] },
      acpCatalogSettingsV1: { v: 2, backends: [] },
      connectedAccountServiceConfigurationsV1: { v: 1, entries: [] },
    };
    const result = applyAccountSettingsSavedSecretMutation(exclusive, {
      kind: 'removeVoiceCredentialSecret',
      target: {
        settingsKey: 'voice',
        providerId: 'openai_compat',
        credentialSlotId: 'api_key',
        machineId: null,
      },
      expectedSecretId: secret.id,
      expectedSecretUpdatedAt: 1,
    });

    expect(result.settings.secrets).toEqual([]);
    expect(result.settings.voice).toMatchObject({ credentialBindings: [] });
  });

  it('rejects a stale Voice target before creating or deleting any SavedSecret', () => {
    expect(() => applyAccountSettingsSavedSecretMutation(referencedSettings(), {
      kind: 'replaceVoiceCredentialSecret',
      target: {
        settingsKey: 'voice',
        providerId: 'openai_compat',
        credentialSlotId: 'api_key',
        machineId: null,
      },
      expectedSecretId: null,
      expectedSecretUpdatedAt: null,
      secret: {
        ...secret,
        id: 'secret-must-not-be-created',
        updatedAt: 2,
      },
    })).toThrowError(expect.objectContaining<AccountSettingsSavedSecretMutationError>({
      code: 'saved_secret_conflict',
    }));

    expect(() => applyAccountSettingsSavedSecretMutation(referencedSettings(), {
      kind: 'replaceVoiceCredentialSecret',
      target: {
        settingsKey: 'voice',
        providerId: 'openai_compat',
        credentialSlotId: 'api_key',
        machineId: null,
      },
      expectedSecretId: secret.id,
      expectedSecretUpdatedAt: 0,
      secret: {
        ...secret,
        id: 'secret-must-not-rebind-a-rotated-source',
        updatedAt: 2,
      },
    })).toThrowError(expect.objectContaining<AccountSettingsSavedSecretMutationError>({
      code: 'saved_secret_conflict',
    }));

    expect(() => applyAccountSettingsSavedSecretMutation(referencedSettings(), {
      kind: 'removeVoiceCredentialSecret',
      target: {
        settingsKey: 'voice',
        providerId: 'openai_compat',
        credentialSlotId: 'api_key',
        machineId: null,
      },
      expectedSecretId: 'stale-secret',
      expectedSecretUpdatedAt: 1,
    })).toThrowError(expect.objectContaining<AccountSettingsSavedSecretMutationError>({
      code: 'saved_secret_conflict',
    }));
  });

  it('does not treat unrelated equal strings or literal refs as SavedSecret references', () => {
    const settings = {
      secrets: [secret],
      label: secret.id,
      mcpServersSettingsV1: {
        servers: [{
          env: {
            LITERAL: { t: 'literal', v: secret.id },
          },
        }],
      },
    };
    expect(listAccountSettingsSavedSecretReferences(settings, secret.id)).toEqual([]);
  });

  it('fails deletion closed for every malformed-present canonical reference root', () => {
    const malformedSettings = [
      { secretBindingsByProfileId: [] },
      { providerSettingsV1: { secretBindingsByConnectionId: [] } },
      { voice: { credentialBindings: {} } },
      { voiceSettingsV1: { credentialBindings: {} } },
      { mcpServersSettingsV1: { servers: {}, bindings: [] } },
      { acpCatalogSettingsV1: { backends: {} } },
    ];
    for (const malformed of malformedSettings) {
      expect(() => applyAccountSettingsSavedSecretMutation({
        secrets: [secret],
        unknownFutureRoot: { value: secret.id },
        ...malformed,
      }, {
        kind: 'delete',
        secretId: secret.id,
        expectedUpdatedAt: 1,
      })).toThrowError(expect.objectContaining<AccountSettingsSavedSecretMutationError>({
        code: 'saved_secret_reference_invalid',
      }));
    }
  });

});
