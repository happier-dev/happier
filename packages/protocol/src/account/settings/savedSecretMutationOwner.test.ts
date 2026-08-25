import { describe, expect, it } from 'vitest';

import {
  AccountSettingsSavedSecretMutationError,
  applyAccountSettingsSavedSecretMutation,
  applyAccountSettingsVoiceCredentialSourceMutation,
  eraseAccountSettingsPluginSecretBindings,
  listAccountSettingsSavedSecretReferences,
  resolveAccountSettingsPluginSecret,
  resolveAccountSettingsVoiceCredentialSource,
  type AccountSettingsVoiceCredentialSourceMutation,
} from './savedSecretMutationOwner.js';
import { VoiceProviderContributionSchema } from '../../plugins/contributions/voiceProviders.js';
import { SAVED_SECRET_COLLECTION_MAX_ENTRIES } from '../../profiles/backendProfileSchema.js';
import { accountSettingsParse } from './accountSettings.js';
import { ACCOUNT_SETTINGS_MAX_SAVED_SECRETS_BYTES } from './catalog/accountSettingBounds.js';

const voiceContribution = Object.freeze({
  pluginId: 'happier.voice.openai',
  localId: 'realtime-openai',
});

const voicePurpose = Object.freeze({
  consumer: voiceContribution,
  purpose: 'credential-api-key',
});

const voiceDeclaration = VoiceProviderContributionSchema.parse({
  id: voiceContribution.localId,
  title: 'OpenAI realtime',
  kind: 'conversation',
  roles: ['realtime_conversation'],
  platforms: ['web'],
  capabilities: {
    turn: { cancelResponse: false, bargeIn: false },
  },
  credentials: {
    slot: {
      id: 'api_key',
      purpose: voicePurpose.purpose,
      title: 'API key',
    },
    requirement: { kind: 'always' },
    sources: [{
      kind: 'savedSecret',
      secretKinds: ['apiKey'],
      rawGrants: [{
        realm: 'web',
        phase: 'prepare',
        request: {
          kind: 'httpHeaders',
          origin: 'https://api.openai.com',
          headerNames: ['authorization'],
        },
      }],
    }, {
      kind: 'connectedAccount',
      service: { pluginId: 'happier.voice.openai', localId: 'openai' },
      rawGrants: [{
        realm: 'web',
        phase: 'prepare',
        request: {
          kind: 'httpHeaders',
          origin: 'https://api.openai.com',
          headerNames: ['authorization'],
        },
      }],
    }],
  },
  client: {
    artifactId: 'web-runtime',
    modulePath: './voiceRuntime',
    exportName: 'activate',
  },
});

function applyVoiceCredentialSourceMutation(
  settings: Readonly<Record<string, unknown>>,
  mutation: Omit<AccountSettingsVoiceCredentialSourceMutation, 'expectedSettingsVersion'>
    & Partial<Pick<AccountSettingsVoiceCredentialSourceMutation, 'expectedSettingsVersion'>>,
): ReturnType<typeof applyAccountSettingsVoiceCredentialSourceMutation> {
  return applyAccountSettingsVoiceCredentialSourceMutation(settings, {
    ...mutation,
    expectedSettingsVersion: mutation.expectedSettingsVersion ?? 4,
  }, voiceDeclaration);
}

function resolveVoiceCredentialSource(
  settings: Readonly<Record<string, unknown>>,
  machineId: string | null,
): ReturnType<typeof resolveAccountSettingsVoiceCredentialSource> {
  return resolveAccountSettingsVoiceCredentialSource(settings, {
    contribution: voiceContribution,
    credentialSlotId: 'api_key',
    purpose: voicePurpose,
    machineId,
  });
}

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
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'savedSecret' },
        credentialBindings: {
          account: { api_key: secret.id },
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

  it('erases one plugin binding set through the canonical census without deleting shared or user-owned SavedSecrets', () => {
    const orphan = { ...secret, id: 'secret-plugin-orphan', name: 'Plugin orphan' };
    const shared = { ...secret, id: 'secret-plugin-shared', name: 'Shared with sibling' };
    const userOwned = { ...secret, id: 'secret-user-owned', name: 'Selected by user' };
    const siblingOwned = { ...secret, id: 'secret-sibling-owned', name: 'Sibling-owned' };
    const settings = {
      secrets: [orphan, shared, userOwned, siblingOwned],
      pluginSecretBindingsV1: {
        '["acme.erase","account","first"]': {
          pluginId: 'acme.erase',
          custody: 'account',
          localId: 'first',
          savedSecretId: orphan.id,
          createdForBinding: true,
        },
        '["acme.erase","account","second"]': {
          pluginId: 'acme.erase',
          custody: 'account',
          localId: 'second',
          savedSecretId: orphan.id,
          createdForBinding: false,
        },
        '["acme.erase","account","shared"]': {
          pluginId: 'acme.erase',
          custody: 'account',
          localId: 'shared',
          savedSecretId: shared.id,
          createdForBinding: true,
        },
        '["acme.erase","account","selected"]': {
          pluginId: 'acme.erase',
          custody: 'account',
          localId: 'selected',
          savedSecretId: userOwned.id,
          createdForBinding: false,
        },
        '["sibling.plugin","account","shared"]': {
          pluginId: 'sibling.plugin',
          custody: 'account',
          localId: 'shared',
          savedSecretId: shared.id,
          createdForBinding: false,
        },
        '["sibling.plugin","account","owned"]': {
          pluginId: 'sibling.plugin',
          custody: 'account',
          localId: 'owned',
          savedSecretId: siblingOwned.id,
          createdForBinding: true,
        },
      },
      untouchedFutureRoot: { preserve: true },
    };

    const result = eraseAccountSettingsPluginSecretBindings(settings, 'acme.erase');

    expect(result.removedBindingCount).toBe(4);
    expect(result.removedSavedSecretCount).toBe(1);
    expect((result.settings.secrets as Array<{ id: string }>).map(({ id }) => id))
      .toEqual([shared.id, userOwned.id, siblingOwned.id]);
    expect(result.settings.pluginSecretBindingsV1).toEqual({
      '["sibling.plugin","account","owned"]': {
        pluginId: 'sibling.plugin',
        custody: 'account',
        localId: 'owned',
        savedSecretId: siblingOwned.id,
        createdForBinding: true,
      },
      '["sibling.plugin","account","shared"]': {
        pluginId: 'sibling.plugin',
        custody: 'account',
        localId: 'shared',
        savedSecretId: shared.id,
        createdForBinding: false,
      },
    });
    expect(result.settings.untouchedFutureRoot).toEqual({ preserve: true });
  });

  it('atomically binds a declared Account plugin secret and keeps its selected SavedSecret reference-safe', () => {
    const settings = {
      secrets: [secret],
      untouchedFutureRoot: { value: 'preserve-me' },
    };

    const bound = applyAccountSettingsSavedSecretMutation(settings, {
      kind: 'bindPluginSecret',
      target: {
        pluginId: 'acme.notifications',
        localId: 'webhook-token',
      },
      expectedSecretId: null,
      expectedSecretUpdatedAt: null,
      secretId: secret.id,
    });

    expect(bound.settings.pluginSecretBindingsV1).toEqual({
      '["acme.notifications","account","webhook-token"]': {
        pluginId: 'acme.notifications',
        custody: 'account',
        localId: 'webhook-token',
        savedSecretId: secret.id,
        createdForBinding: false,
      },
    });
    expect(JSON.stringify(bound.settings.pluginSecretBindingsV1)).not.toContain('ciphertext-old');
    expect(bound.settings.untouchedFutureRoot).toEqual({ value: 'preserve-me' });

    expect(() => applyAccountSettingsSavedSecretMutation(bound.settings, {
      kind: 'delete',
      secretId: secret.id,
      expectedUpdatedAt: 1,
    })).toThrowError(expect.objectContaining<AccountSettingsSavedSecretMutationError>({
      code: 'saved_secret_in_use',
      references: [{
        owner: 'plugin',
        path: 'pluginSecretBindingsV1["[\\"acme.notifications\\",\\"account\\",\\"webhook-token\\"]"]',
      }],
    }));
  });

  it('unbinds a plugin secret without deleting its SavedSecret record', () => {
    const settings = {
      secrets: [secret],
      pluginSecretBindingsV1: {
        '["acme.notifications","account","webhook-token"]': {
          pluginId: 'acme.notifications',
          custody: 'account',
          localId: 'webhook-token',
          savedSecretId: secret.id,
          createdForBinding: true,
        },
      },
    };

    const result = applyAccountSettingsSavedSecretMutation(settings, {
      kind: 'unbindPluginSecret',
      target: {
        pluginId: 'acme.notifications',
        localId: 'webhook-token',
      },
      expectedSecretId: secret.id,
      expectedSecretUpdatedAt: secret.updatedAt,
    });

    expect(result.settings.pluginSecretBindingsV1).toBeUndefined();
    expect((result.settings.secrets as readonly { id: string }[]).map(({ id }) => id))
      .toEqual([secret.id]);
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
        contribution: voiceContribution,
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
      approvedRecipientContractDigest: `sha256:${'b'.repeat(64)}`,
    });

    expect((result.settings.secrets as Array<{ id: string }>).map(({ id }) => id))
      .toEqual(['secret-voice-target-local', secret.id]);
    expect(result.settings.voiceSettingsV1).toMatchObject({
      credentialBindings: [{
        contribution: voiceContribution,
        approvedRecipientContractDigest: `sha256:${'b'.repeat(64)}`,
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

  it('atomically saves and selects one qualified Voice SavedSecret without activating a mismatched target', () => {
    const settings = {
      secrets: [secret],
      voiceSettingsV1: {
        credentialBindings: [{
          contribution: voiceContribution,
          credentialSlotId: 'api_key',
          credentialSource: { kind: 'connectedAccount' },
          credentialBindings: {
            account: { api_key: secret.id },
          },
        }],
      },
      connectedAccountPurposeBindingsV1: {
        v: 1,
        bindings: [{
          purpose: voicePurpose,
          target: {
            kind: 'account',
            account: {
              service: { pluginId: 'happier.voice.openai', localId: 'openai' },
              accountId: 'account-openai',
            },
          },
        }],
      },
      untouchedFutureRoot: { value: 'preserve-me' },
    };
    const before = structuredClone(settings);
    const replacement = {
      ...secret,
      id: 'secret-openai-next',
      name: 'OpenAI next',
      updatedAt: 2,
    };

    expect(() => applyVoiceCredentialSourceMutation(settings, {
      contribution: voiceContribution,
      credentialSlotId: 'api_key',
      selection: { kind: 'savedSecret' },
      savedSecretMutation: {
        kind: 'replaceVoiceCredentialSecret',
        target: {
          contribution: { ...voiceContribution, localId: 'other-voice' },
          credentialSlotId: 'api_key',
          machineId: null,
        },
        expectedSecretId: secret.id,
        expectedSecretUpdatedAt: 1,
        secret: replacement,
      },
    })).toThrowError(expect.objectContaining({ code: 'saved_secret_invalid' }));
    expect(settings).toEqual(before);

    expect(() => applyVoiceCredentialSourceMutation(settings, {
      contribution: voiceContribution,
      credentialSlotId: 'api_key',
      selection: { kind: 'savedSecret' },
      savedSecretMutation: {
        kind: 'replaceVoiceCredentialSecret',
        target: {
          contribution: voiceContribution,
          credentialSlotId: 'api_key',
          machineId: null,
        },
        expectedSecretId: secret.id,
        expectedSecretUpdatedAt: 0,
        secret: replacement,
      },
    })).toThrowError(expect.objectContaining({ code: 'saved_secret_conflict' }));
    expect(settings).toEqual(before);

    const result = applyVoiceCredentialSourceMutation(settings, {
      contribution: voiceContribution,
      credentialSlotId: 'api_key',
      selection: { kind: 'savedSecret' },
      savedSecretMutation: {
        kind: 'replaceVoiceCredentialSecret',
        target: {
          contribution: voiceContribution,
          credentialSlotId: 'api_key',
          machineId: null,
        },
        expectedSecretId: secret.id,
        expectedSecretUpdatedAt: 1,
        secret: replacement,
      },
    });

    expect(result.settings).toMatchObject({
      secrets: [{ id: replacement.id }],
      voiceSettingsV1: {
        credentialBindings: [{
          contribution: voiceContribution,
          credentialSlotId: 'api_key',
          credentialSource: { kind: 'savedSecret' },
          credentialBindings: {
            account: { api_key: replacement.id },
          },
        }],
      },
      connectedAccountPurposeBindingsV1: { v: 1, bindings: [] },
      untouchedFutureRoot: { value: 'preserve-me' },
    });
  });

  it('selects a Connected Account while preserving dormant secrets and exact unrelated purpose bindings', () => {
    const unrelatedPurpose = {
      consumer: { pluginId: 'happier.voice.other', localId: 'conversation' },
      purpose: 'credential',
    };
    const settings = {
      secrets: [secret],
      voiceSettingsV1: {
        credentialBindings: [{
          contribution: voiceContribution,
          credentialSlotId: 'api_key',
          credentialSource: { kind: 'savedSecret' },
          credentialBindings: {
            account: { api_key: secret.id },
            byMachineId: { machine_a: { api_key: secret.id } },
          },
        }],
      },
      connectedAccountPurposeBindingsV1: {
        v: 1,
        bindings: [{
          purpose: unrelatedPurpose,
          target: {
            kind: 'group',
            service: { pluginId: 'happier.voice.other', localId: 'service' },
            groupId: 'other-group',
          },
        }],
      },
    };
    const selectedTarget = {
      kind: 'account',
      account: {
        service: { pluginId: 'happier.voice.openai', localId: 'openai' },
        accountId: 'account-openai-next',
      },
    };

    const result = applyVoiceCredentialSourceMutation(settings, {
      contribution: voiceContribution,
      credentialSlotId: 'api_key',
      selection: { kind: 'connectedAccount', target: selectedTarget },
    });

    expect(result.settings.secrets).toEqual([secret]);
    expect(result.settings.voiceSettingsV1).toMatchObject({
      credentialBindings: [{
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'connectedAccount' },
        credentialBindings: {
          account: { api_key: secret.id },
          byMachineId: { machine_a: { api_key: secret.id } },
        },
      }],
    });
    expect(result.settings.connectedAccountPurposeBindingsV1).toEqual({
      v: 1,
      bindings: [
        { purpose: unrelatedPurpose, target: settings.connectedAccountPurposeBindingsV1.bindings[0]!.target },
        { purpose: voicePurpose, target: selectedTarget },
      ],
    });
  });

  it('keeps a standalone qualified secret edit dormant under the active Connected Account selection', () => {
    const selectedTarget = {
      kind: 'account' as const,
      account: {
        service: { pluginId: 'happier.voice.openai', localId: 'openai' },
        accountId: 'account-openai',
      },
    };
    const settings = {
      secrets: [secret],
      voiceSettingsV1: {
        credentialBindings: [{
          contribution: voiceContribution,
          credentialSlotId: 'api_key',
          credentialSource: { kind: 'connectedAccount' },
          credentialBindings: { account: { api_key: secret.id } },
        }],
      },
      connectedAccountPurposeBindingsV1: {
        v: 1,
        bindings: [{ purpose: voicePurpose, target: selectedTarget }],
      },
    };

    const result = applyAccountSettingsSavedSecretMutation(settings, {
      kind: 'replaceVoiceCredentialSecret',
      target: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        machineId: null,
      },
      expectedSecretId: secret.id,
      expectedSecretUpdatedAt: 1,
      secret: {
        ...secret,
        id: 'secret-dormant-next',
        updatedAt: 2,
      },
    });

    expect(result.settings.voiceSettingsV1).toMatchObject({
      credentialBindings: [{
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'connectedAccount' },
        credentialBindings: { account: { api_key: 'secret-dormant-next' } },
      }],
    });
    expect(result.settings.connectedAccountPurposeBindingsV1).toEqual(
      settings.connectedAccountPurposeBindingsV1,
    );
  });

  it('selects none by removing only the effective purpose binding while preserving dormant values', () => {
    const settings = {
      secrets: [secret],
      voiceSettingsV1: {
        credentialBindings: [{
          contribution: voiceContribution,
          credentialSlotId: 'api_key',
          credentialSource: { kind: 'connectedAccount' },
          credentialBindings: { account: { api_key: secret.id } },
        }],
      },
      connectedAccountPurposeBindingsV1: {
        v: 1,
        bindings: [{
          purpose: voicePurpose,
          target: {
            kind: 'group',
            service: { pluginId: 'happier.voice.openai', localId: 'openai' },
            groupId: 'openai-group',
          },
        }],
      },
    };

    const result = applyVoiceCredentialSourceMutation(settings, {
      contribution: voiceContribution,
      credentialSlotId: 'api_key',
      selection: { kind: 'none' },
    });

    expect(result.settings.secrets).toEqual([secret]);
    expect(result.settings.voiceSettingsV1).toMatchObject({
      credentialBindings: [{
        credentialSource: { kind: 'none' },
        credentialBindings: { account: { api_key: secret.id } },
      }],
    });
    expect(result.settings.connectedAccountPurposeBindingsV1).toEqual({
      v: 1,
      bindings: [],
    });
  });

  it('resolves a selected qualified SavedSecret by exact machine with account fallback and ignores overrides for null', () => {
    const settings = {
      secrets: [
        { ...secret, id: 'secret-account' },
        { ...secret, id: 'secret-machine' },
      ],
      voiceSettingsV1: {
        credentialBindings: [{
          contribution: voiceContribution,
          credentialSlotId: 'api_key',
          credentialSource: { kind: 'savedSecret' },
          credentialBindings: {
            account: { api_key: 'secret-account' },
            byMachineId: { machine_a: { api_key: 'secret-machine' } },
          },
        }],
      },
      connectedAccountPurposeBindingsV1: { v: 1, bindings: [] },
    };

    expect(resolveVoiceCredentialSource(settings, 'machine_a')).toMatchObject({
      selection: { kind: 'savedSecret' },
      savedSecret: { secretId: 'secret-machine', source: 'machine_override' },
    });
    expect(resolveVoiceCredentialSource(settings, 'machine_b')).toMatchObject({
      selection: { kind: 'savedSecret' },
      savedSecret: { secretId: 'secret-account', source: 'account' },
    });
    expect(resolveVoiceCredentialSource(settings, null)).toMatchObject({
      selection: { kind: 'savedSecret' },
      savedSecret: { secretId: 'secret-account', source: 'account' },
    });
  });

  it('reactivates a dormant SavedSecret by selection only without changing its identity', () => {
    const selectedTarget = {
      kind: 'account' as const,
      account: {
        service: { pluginId: 'happier.voice.openai', localId: 'openai' },
        accountId: 'account-openai',
      },
    };
    const settings = {
      secrets: [secret],
      voiceSettingsV1: {
        credentialBindings: [{
          contribution: voiceContribution,
          credentialSlotId: 'api_key',
          credentialSource: { kind: 'connectedAccount' },
          credentialBindings: { account: { api_key: secret.id } },
        }],
      },
      connectedAccountPurposeBindingsV1: {
        v: 1,
        bindings: [{ purpose: voicePurpose, target: selectedTarget }],
      },
    };

    expect(resolveVoiceCredentialSource(settings, null)).toEqual({
      selection: { kind: 'connectedAccount', target: selectedTarget },
      binding: { purpose: voicePurpose, target: selectedTarget },
      savedSecret: null,
      approvedRecipientContractDigest: null,
    });

    const result = applyVoiceCredentialSourceMutation(settings, {
      contribution: voiceContribution,
      credentialSlotId: 'api_key',
      selection: { kind: 'savedSecret' },
    });

    expect(result.settings.secrets).toEqual([secret]);
    expect(result.settings.connectedAccountPurposeBindingsV1).toEqual({
      v: 1,
      bindings: [],
    });
    expect(resolveVoiceCredentialSource(result.settings, null)).toEqual({
      selection: { kind: 'savedSecret' },
      binding: null,
      savedSecret: { secretId: secret.id, source: 'account' },
      approvedRecipientContractDigest: null,
    });
  });

  it('binds an existing SavedSecret to an unbound Voice slot atomically with its purpose binding', () => {
    const orphanedTarget = {
      kind: 'account' as const,
      account: {
        service: { pluginId: 'happier.voice.openai', localId: 'openai' },
        accountId: 'account-openai',
      },
    };
    // The binding row was lost while the SavedSecret record survived, and the
    // purpose binding it left behind is exactly the cross-store inconsistency
    // the resolver fails closed on.
    const settings = {
      secrets: [secret],
      voiceSettingsV1: { credentialBindings: [] },
      connectedAccountPurposeBindingsV1: {
        v: 1,
        bindings: [{ purpose: voicePurpose, target: orphanedTarget }],
      },
    };
    expect(() => resolveVoiceCredentialSource(settings, null)).toThrowError(
      expect.objectContaining<AccountSettingsSavedSecretMutationError>({
        code: 'saved_secret_reference_invalid',
      }),
    );

    const result = applyVoiceCredentialSourceMutation(settings, {
      contribution: voiceContribution,
      credentialSlotId: 'api_key',
      selection: { kind: 'savedSecret' },
      savedSecretMutation: {
        kind: 'bindVoiceCredentialSavedSecret',
        target: {
          contribution: voiceContribution,
          credentialSlotId: 'api_key',
          machineId: null,
        },
        expectedSecretId: null,
        expectedSecretUpdatedAt: null,
        secretId: secret.id,
      },
    });

    expect(result.settings.secrets).toEqual([secret]);
    expect(result.settings.connectedAccountPurposeBindingsV1).toEqual({
      v: 1,
      bindings: [],
    });
    expect(resolveVoiceCredentialSource(result.settings, null)).toEqual({
      selection: { kind: 'savedSecret' },
      binding: null,
      savedSecret: { secretId: secret.id, source: 'account' },
      approvedRecipientContractDigest: null,
    });
  });

  it('re-points a bound Voice slot at another existing SavedSecret without deleting either record', () => {
    const other = { ...secret, id: 'secret-other', name: 'Other', updatedAt: 3 };
    const settings = {
      secrets: [secret, other],
      voiceSettingsV1: {
        credentialBindings: [{
          contribution: voiceContribution,
          credentialSlotId: 'api_key',
          credentialSource: { kind: 'savedSecret' },
          credentialBindings: { account: { api_key: secret.id } },
        }],
      },
      connectedAccountPurposeBindingsV1: { v: 1, bindings: [] },
    };

    const result = applyAccountSettingsSavedSecretMutation(settings, {
      kind: 'bindVoiceCredentialSavedSecret',
      target: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        machineId: null,
      },
      expectedSecretId: secret.id,
      expectedSecretUpdatedAt: secret.updatedAt,
      secretId: other.id,
    });

    expect(result.settings.secrets).toEqual([secret, other]);
    expect(resolveVoiceCredentialSource(result.settings, null)).toEqual({
      selection: { kind: 'savedSecret' },
      binding: null,
      savedSecret: { secretId: other.id, source: 'account' },
      approvedRecipientContractDigest: null,
    });
  });

  it('repairs a Voice slot that still points at a destroyed SavedSecret record', () => {
    // The exact state a binding-loss event leaves behind: the slot keeps its
    // reference while the record it names is gone, so every CAS the surface can
    // build carries `expectedSecretUpdatedAt: null`.
    const settings = {
      secrets: [secret],
      voiceSettingsV1: {
        credentialBindings: [{
          contribution: voiceContribution,
          credentialSlotId: 'api_key',
          credentialSource: { kind: 'savedSecret' },
          credentialBindings: { account: { api_key: 'secret-destroyed' } },
        }],
      },
      connectedAccountPurposeBindingsV1: { v: 1, bindings: [] },
    };

    const result = applyAccountSettingsSavedSecretMutation(settings, {
      kind: 'bindVoiceCredentialSavedSecret',
      target: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        machineId: null,
      },
      expectedSecretId: 'secret-destroyed',
      expectedSecretUpdatedAt: null,
      secretId: secret.id,
    });

    expect(result.settings.secrets).toEqual([secret]);
    expect(resolveVoiceCredentialSource(result.settings, null)).toEqual({
      selection: { kind: 'savedSecret' },
      binding: null,
      savedSecret: { secretId: secret.id, source: 'account' },
      approvedRecipientContractDigest: null,
    });

    // The assertion is checked, not waived: the same call conflicts once the
    // named record is present, because the caller read a different snapshot.
    expect(() => applyAccountSettingsSavedSecretMutation({
      ...settings,
      secrets: [secret, { ...secret, id: 'secret-destroyed', updatedAt: 9 }],
    }, {
      kind: 'bindVoiceCredentialSavedSecret',
      target: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        machineId: null,
      },
      expectedSecretId: 'secret-destroyed',
      expectedSecretUpdatedAt: null,
      secretId: secret.id,
    })).toThrowError(expect.objectContaining<AccountSettingsSavedSecretMutationError>({
      code: 'saved_secret_conflict',
    }));
  });

  it('replaces the key of a Voice slot that still points at a destroyed SavedSecret record', () => {
    const settings = {
      secrets: [] as unknown[],
      voiceSettingsV1: {
        credentialBindings: [{
          contribution: voiceContribution,
          credentialSlotId: 'api_key',
          credentialSource: { kind: 'savedSecret' },
          credentialBindings: { account: { api_key: 'secret-destroyed' } },
        }],
      },
      connectedAccountPurposeBindingsV1: { v: 1, bindings: [] },
    };

    const result = applyAccountSettingsSavedSecretMutation(settings, {
      kind: 'replaceVoiceCredentialSecret',
      target: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        machineId: null,
      },
      expectedSecretId: 'secret-destroyed',
      expectedSecretUpdatedAt: null,
      secret: { ...secret, id: 'secret-reentered', updatedAt: 7 },
    });

    expect(resolveVoiceCredentialSource(result.settings, null)).toEqual({
      selection: { kind: 'savedSecret' },
      binding: null,
      savedSecret: { secretId: 'secret-reentered', source: 'account' },
      approvedRecipientContractDigest: null,
    });
  });

  it('fails an existing-SavedSecret binding closed for an unknown secret id and a stale source', () => {
    const settings = {
      secrets: [secret],
      voiceSettingsV1: { credentialBindings: [] },
      connectedAccountPurposeBindingsV1: { v: 1, bindings: [] },
    };

    expect(() => applyAccountSettingsSavedSecretMutation(settings, {
      kind: 'bindVoiceCredentialSavedSecret',
      target: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        machineId: null,
      },
      expectedSecretId: null,
      expectedSecretUpdatedAt: null,
      secretId: 'secret-that-does-not-exist',
    })).toThrowError(expect.objectContaining<AccountSettingsSavedSecretMutationError>({
      code: 'saved_secret_not_found',
    }));

    expect(() => applyAccountSettingsSavedSecretMutation(settings, {
      kind: 'bindVoiceCredentialSavedSecret',
      target: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        machineId: null,
      },
      expectedSecretId: secret.id,
      expectedSecretUpdatedAt: secret.updatedAt,
      secretId: secret.id,
    })).toThrowError(expect.objectContaining<AccountSettingsSavedSecretMutationError>({
      code: 'saved_secret_conflict',
    }));

    expect(settings.voiceSettingsV1.credentialBindings).toEqual([]);
  });

  it('rejects SavedSecret selection after that source leaves the current declaration', () => {
    const settings = {
      secrets: [secret],
      voiceSettingsV1: { credentialBindings: [] },
      connectedAccountPurposeBindingsV1: { v: 1, bindings: [] },
    };
    const withoutSavedSecret = VoiceProviderContributionSchema.parse({
      ...voiceDeclaration,
      credentials: {
        ...voiceDeclaration.credentials!,
        sources: voiceDeclaration.credentials!.sources.filter((source) => (
          source.kind !== 'savedSecret'
        )),
      },
    });

    expect(() => applyAccountSettingsVoiceCredentialSourceMutation(settings, {
      contribution: voiceContribution,
      credentialSlotId: 'api_key',
      expectedSettingsVersion: 4,
      selection: { kind: 'savedSecret' },
    }, withoutSavedSecret)).toThrowError(expect.objectContaining({
      code: 'saved_secret_invalid',
    }));
    expect(settings.voiceSettingsV1.credentialBindings).toEqual([]);
  });

  it('rejects retired Voice identity dimensions on current qualified mutation and resolution inputs', () => {
    const settings = {
      secrets: [secret],
      voiceSettingsV1: { credentialBindings: [] },
      connectedAccountPurposeBindingsV1: { v: 1, bindings: [] },
    };
    const before = structuredClone(settings);

    expect(() => applyVoiceCredentialSourceMutation(settings, {
      contribution: voiceContribution,
      credentialSlotId: 'api_key',
      selection: { kind: 'savedSecret' },
      purpose: voicePurpose,
      providerId: 'realtime_openai',
      settingsKey: 'voice',
    } as never)).toThrowError(expect.objectContaining({ code: 'saved_secret_invalid' }));
    expect(() => resolveAccountSettingsVoiceCredentialSource(settings, {
      contribution: voiceContribution,
      credentialSlotId: 'api_key',
      purpose: voicePurpose,
      machineId: null,
      providerId: 'realtime_openai',
      settingsKey: 'voice',
    } as never)).toThrowError(expect.objectContaining({ code: 'saved_secret_invalid' }));
    expect(settings).toEqual(before);
  });

  it('keeps a legacy provider-id row reference-enumerable but rejects it at current qualified boundaries', () => {
    const settings = {
      secrets: [secret],
      voiceSettingsV1: {
        credentialBindings: [{
          providerId: 'realtime_openai',
          credentialBindings: { account: { api_key: secret.id } },
        }],
      },
      connectedAccountPurposeBindingsV1: { v: 1, bindings: [] },
    };

    expect(listAccountSettingsSavedSecretReferences(settings, secret.id)).toEqual([{
      owner: 'voice',
      path: 'voiceSettingsV1.credentialBindings[0].credentialBindings.account.api_key',
    }]);
    expect(() => resolveVoiceCredentialSource(settings, null)).toThrowError(
      expect.objectContaining({ code: 'saved_secret_reference_invalid' }),
    );
    expect(() => applyVoiceCredentialSourceMutation(settings, {
      contribution: voiceContribution,
      credentialSlotId: 'api_key',
      selection: { kind: 'savedSecret' },
    })).toThrowError(expect.objectContaining({ code: 'saved_secret_reference_invalid' }));
  });

  it.each([
    {
      name: 'an unknown retired providerId field',
      binding: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'savedSecret' },
        credentialBindings: { account: { api_key: secret.id } },
        providerId: 'realtime_openai',
      },
    },
    {
      name: 'an unknown retired settingsKey field',
      binding: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'savedSecret' },
        credentialBindings: { account: { api_key: secret.id } },
        settingsKey: 'voice',
      },
    },
    {
      name: 'a malformed dormant slot map',
      binding: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'savedSecret' },
        credentialBindings: {
          account: { api_key: secret.id },
          byMachineId: { dormant_machine: { dormant_slot: 42 } },
        },
      },
    },
    {
      name: 'a noncanonical recipient-contract digest',
      binding: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'savedSecret' },
        credentialBindings: { account: { api_key: secret.id } },
        approvedRecipientContractDigest: 'recipient-contract-not-canonical',
      },
    },
  ])('rejects $name at both current qualified owner boundaries', ({ binding }) => {
    const settings = {
      secrets: [secret],
      voiceSettingsV1: { credentialBindings: [binding] },
      connectedAccountPurposeBindingsV1: { v: 1, bindings: [] },
    };
    const before = structuredClone(settings);

    expect(() => resolveVoiceCredentialSource(settings, null)).toThrowError(
      expect.objectContaining({ code: 'saved_secret_reference_invalid' }),
    );
    expect(() => applyVoiceCredentialSourceMutation(settings, {
      contribution: voiceContribution,
      credentialSlotId: 'api_key',
      selection: { kind: 'savedSecret' },
    })).toThrowError(expect.objectContaining({ code: 'saved_secret_reference_invalid' }));
    expect(settings).toEqual(before);
  });

  it('rejects a noncanonical recipient-contract digest on a current qualified approval mutation', () => {
    expect(() => applyAccountSettingsSavedSecretMutation(referencedSettings(), {
      kind: 'approveVoiceCredentialRecipientContract',
      target: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        machineId: null,
      },
      expectedSecretId: secret.id,
      expectedSecretUpdatedAt: 1,
      approvedRecipientContractDigest: 'recipient-contract-not-canonical',
    })).toThrowError(expect.objectContaining({ code: 'saved_secret_invalid' }));
  });

  it('renews one Voice recipient approval without replacing or exposing its SavedSecret', () => {
    const before = referencedSettings();
    const renewedDigest = `sha256:${'c'.repeat(64)}`;
    const result = applyAccountSettingsSavedSecretMutation(before, {
      kind: 'approveVoiceCredentialRecipientContract',
      target: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        machineId: null,
      },
      expectedSecretId: secret.id,
      expectedSecretUpdatedAt: 1,
      approvedRecipientContractDigest: renewedDigest,
    });

    expect(result.settings.secrets).toEqual(before.secrets);
    expect(result.settings.voiceSettingsV1).toMatchObject({
      credentialBindings: [{
        contribution: voiceContribution,
        approvedRecipientContractDigest: renewedDigest,
        credentialBindings: {
          account: { api_key: secret.id },
        },
      }],
    });
  });

  it('rejects Voice recipient approval when the bound SavedSecret changed concurrently', () => {
    expect(() => applyAccountSettingsSavedSecretMutation(referencedSettings(), {
      kind: 'approveVoiceCredentialRecipientContract',
      target: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        machineId: null,
      },
      expectedSecretId: secret.id,
      expectedSecretUpdatedAt: 0,
      approvedRecipientContractDigest: `sha256:${'d'.repeat(64)}`,
    })).toThrow(expect.objectContaining({
      code: 'saved_secret_conflict',
    }));
  });

  it('atomically removes one Voice binding and deletes its secret only when no sibling still references it', () => {
    const exclusive = {
      ...referencedSettings(),
      secretBindingsByProfileId: {},
      providerSettingsV1: { v: 1, secretBindingsByConnectionId: {} },
      voice: { credentialBindings: [] },
      mcpServersSettingsV1: { v: 1, servers: [], bindings: [] },
      acpCatalogSettingsV1: { v: 2, backends: [] },
      connectedAccountServiceConfigurationsV1: { v: 1, entries: [] },
    };
    const result = applyAccountSettingsSavedSecretMutation(exclusive, {
      kind: 'removeVoiceCredentialSecret',
      target: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        machineId: null,
      },
      expectedSecretId: secret.id,
      expectedSecretUpdatedAt: 1,
    });

    expect(result.settings.secrets).toEqual([]);
    expect(result.settings.voiceSettingsV1).toMatchObject({
      credentialBindings: [{
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'savedSecret' },
        credentialBindings: {},
      }],
    });
  });

  it('rejects a stale Voice target before creating or deleting any SavedSecret', () => {
    expect(() => applyAccountSettingsSavedSecretMutation(referencedSettings(), {
      kind: 'replaceVoiceCredentialSecret',
      target: {
        contribution: voiceContribution,
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
        contribution: voiceContribution,
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
        contribution: voiceContribution,
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

  it.each([
    ['wrong custody', {
      '["acme.notifications","account","webhook-token"]': {
        pluginId: 'acme.notifications',
        custody: 'machine',
        localId: 'webhook-token',
        savedSecretId: secret.id,
        createdForBinding: false,
      },
    }],
    ['extra entry field', {
      '["acme.notifications","account","webhook-token"]': {
        pluginId: 'acme.notifications',
        custody: 'account',
        localId: 'webhook-token',
        savedSecretId: secret.id,
        createdForBinding: false,
        future: true,
      },
    }],
    ['noncanonical qualified key', {
      'acme.notifications/account/webhook-token': {
        pluginId: 'acme.notifications',
        custody: 'account',
        localId: 'webhook-token',
        savedSecretId: secret.id,
        createdForBinding: false,
      },
    }],
    ['more than 256 bindings', Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => {
        const localId = `field-${index}`;
        return [
          JSON.stringify(['acme.notifications', 'account', localId]),
          {
            pluginId: 'acme.notifications',
            custody: 'account',
            localId,
            savedSecretId: secret.id,
            createdForBinding: false,
          },
        ];
      }),
    )],
    ['more than 64 KiB', {
      '["acme.notifications","account","webhook-token"]': {
        pluginId: 'acme.notifications',
        custody: 'account',
        localId: 'webhook-token',
        savedSecretId: 'x'.repeat((64 * 1024) + 1),
        createdForBinding: false,
      },
    }],
  ])('fails every plugin binding consumer closed for malformed present bindings: %s', (_label, bindings) => {
    const settings = {
      secrets: [secret],
      pluginSecretBindingsV1: bindings,
      untouchedFutureRoot: { preserve: true },
    };
    const before = structuredClone(settings);
    const expectedError = expect.objectContaining({
      code: 'saved_secret_reference_invalid',
    });

    expect(() => listAccountSettingsSavedSecretReferences(settings, secret.id))
      .toThrowError(expectedError);
    expect(() => resolveAccountSettingsPluginSecret(settings, {
      pluginId: 'acme.notifications',
      localId: 'webhook-token',
    })).toThrowError(expectedError);
    expect(() => applyAccountSettingsSavedSecretMutation(settings, {
      kind: 'delete',
      secretId: secret.id,
      expectedUpdatedAt: 1,
    })).toThrowError(expectedError);
    expect(settings).toEqual(before);
  });

  it.each([
    ['extra root key', {
      v: 1,
      entries: [{
        service: { pluginId: 'plugin.example', localId: 'service-a' },
        modeId: 'token',
        revision: 'configuration-1',
        values: {},
        secretRefs: { api_key: secret.id },
      }],
      future: true,
    }],
    ['extra entry key', {
      v: 1,
      entries: [{
        service: { pluginId: 'plugin.example', localId: 'service-a' },
        modeId: 'token',
        revision: 'configuration-1',
        values: {},
        secretRefs: { api_key: secret.id },
        future: true,
      }],
    }],
    ['more than 256 entries', {
      v: 1,
      entries: Array.from({ length: 257 }, (_, index) => ({
        service: { pluginId: 'plugin.example', localId: `service-${index}` },
        modeId: 'token',
        revision: `configuration-${index}`,
        values: {},
        secretRefs: { api_key: secret.id },
      })),
    }],
    ['duplicate service and mode target', {
      v: 1,
      entries: [1, 2].map((revision) => ({
        service: { pluginId: 'plugin.example', localId: 'service-a' },
        modeId: 'token',
        revision: `configuration-${revision}`,
        values: {},
        secretRefs: { api_key: secret.id },
      })),
    }],
    ['malformed service identity', {
      v: 1,
      entries: [{
        service: { pluginId: '', localId: 'service-a' },
        modeId: 'token',
        revision: 'configuration-1',
        values: {},
        secretRefs: { api_key: secret.id },
      }],
    }],
    ['malformed mode identity', {
      v: 1,
      entries: [{
        service: { pluginId: 'plugin.example', localId: 'service-a' },
        modeId: 'x'.repeat(257),
        revision: 'configuration-1',
        values: {},
        secretRefs: { api_key: secret.id },
      }],
    }],
    ['extra service identity key', {
      v: 1,
      entries: [{
        service: { pluginId: 'plugin.example', localId: 'service-a', future: true },
        modeId: 'token',
        revision: 'configuration-1',
        values: {},
        secretRefs: { api_key: secret.id },
      }],
    }],
    ['malformed revision', {
      v: 1,
      entries: [{
        service: { pluginId: 'plugin.example', localId: 'service-a' },
        modeId: 'token',
        revision: '',
        values: {},
        secretRefs: { api_key: secret.id },
      }],
    }],
    ['non-string SavedSecret reference', {
      v: 1,
      entries: [{
        service: { pluginId: 'plugin.example', localId: 'service-a' },
        modeId: 'token',
        revision: 'configuration-1',
        values: {},
        secretRefs: { api_key: 7 },
      }],
    }],
    ['empty SavedSecret reference', {
      v: 1,
      entries: [{
        service: { pluginId: 'plugin.example', localId: 'service-a' },
        modeId: 'token',
        revision: 'configuration-1',
        values: {},
        secretRefs: { api_key: '' },
      }],
    }],
    ['oversized SavedSecret reference', {
      v: 1,
      entries: [{
        service: { pluginId: 'plugin.example', localId: 'service-a' },
        modeId: 'token',
        revision: 'configuration-1',
        values: {},
        secretRefs: { api_key: 'x'.repeat(513) },
      }],
    }],
    ['more than 64 SavedSecret references', {
      v: 1,
      entries: [{
        service: { pluginId: 'plugin.example', localId: 'service-a' },
        modeId: 'token',
        revision: 'configuration-1',
        values: {},
        secretRefs: Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [`field-${index}`, `secret-${index}`]),
        ),
      }],
    }],
  ])('rejects malformed Connected Account reference roots through the persisted owner: %s', (_label, root) => {
    expect(() => listAccountSettingsSavedSecretReferences({
      connectedAccountServiceConfigurationsV1: root,
    }, secret.id)).toThrowError(expect.objectContaining<AccountSettingsSavedSecretMutationError>({
      code: 'saved_secret_reference_invalid',
    }));
  });

  it.each([
    'api key',
    '__proto__',
    'A'.repeat(129),
  ])('rejects invalid qualified Voice credential slot key %s through the canonical schema', (credentialSlotId) => {
    const settings = {
      secrets: [secret],
      voiceSettingsV1: { credentialBindings: [] },
      connectedAccountPurposeBindingsV1: { v: 1, bindings: [] },
    };
    const before = structuredClone(settings);

    expect(() => applyVoiceCredentialSourceMutation(settings, {
      contribution: voiceContribution,
      credentialSlotId,
      selection: { kind: 'savedSecret' },
    })).toThrowError(expect.objectContaining({ code: 'saved_secret_invalid' }));
    expect(settings).toEqual(before);
  });

});

describe('SavedSecret collection capacity', () => {
  function savedSecretAt(index: number) {
    return {
      id: `secret-${index}`,
      name: `Secret ${index}`,
      kind: 'apiKey' as const,
      encryptedValue: {
        _isSecretValue: true as const,
        encryptedValue: { t: 'enc-v1' as const, c: `ciphertext-${index}` },
      },
      createdAt: 1,
      updatedAt: 1,
    };
  }

  const fullCollection = Array.from(
    { length: SAVED_SECRET_COLLECTION_MAX_ENTRIES },
    (_unused, index) => savedSecretAt(index),
  );

  it('refuses an add that would push the collection past what canonical parsing exposes', () => {
    // Accepting the 257th entry persists a record the canonical reader
    // truncates away, so a previously valid Provider secret silently stops
    // resolving at spawn. Refuse the write instead.
    expect(() => applyAccountSettingsSavedSecretMutation(
      { secrets: fullCollection },
      { kind: 'add', secret: savedSecretAt(SAVED_SECRET_COLLECTION_MAX_ENTRIES) },
    )).toThrowError(expect.objectContaining({
      code: 'saved_secret_collection_full',
    }));
    // The refusal is only correct while the canonical reader really does hide
    // that entry. Measure the reader instead of restating the owner's constant.
    const oversized = [...fullCollection, savedSecretAt(SAVED_SECRET_COLLECTION_MAX_ENTRIES)];
    expect(accountSettingsParse({ secrets: oversized }).secrets.length)
      .toBeLessThan(oversized.length);
  });

  it('accepts an add that exactly reaches the collection maximum', () => {
    const result = applyAccountSettingsSavedSecretMutation(
      { secrets: fullCollection.slice(0, SAVED_SECRET_COLLECTION_MAX_ENTRIES - 1) },
      { kind: 'add', secret: savedSecretAt(SAVED_SECRET_COLLECTION_MAX_ENTRIES) },
    );
    const written = result.settings.secrets as readonly unknown[];
    expect(written.length).toBe(SAVED_SECRET_COLLECTION_MAX_ENTRIES);
    // Every entry this owner accepts must survive the canonical Account
    // Settings parse. Comparing the two ends of the contract catches a ceiling
    // that drifts apart from the reader's; comparing either one to the shared
    // constant it is built from cannot.
    expect(accountSettingsParse(result.settings).secrets.length).toBe(written.length);
  });

  it('still allows a delete to recover an already oversized collection', () => {
    const oversized = [...fullCollection, savedSecretAt(SAVED_SECRET_COLLECTION_MAX_ENTRIES)];
    const result = applyAccountSettingsSavedSecretMutation(
      { secrets: oversized },
      { kind: 'delete', secretId: 'secret-0', expectedUpdatedAt: 1 },
    );
    expect((result.settings.secrets as readonly unknown[]).length)
      .toBe(SAVED_SECRET_COLLECTION_MAX_ENTRIES);
  });

  function largeSavedSecretAt(index: number) {
    return {
      ...savedSecretAt(index),
      encryptedValue: {
        _isSecretValue: true as const,
        encryptedValue: { t: 'enc-v1' as const, c: `${index}-${'c'.repeat(3000)}` },
      },
    };
  }

  function secretsRootBytes(secrets: readonly unknown[]): number {
    return new TextEncoder().encode(JSON.stringify(secrets)).byteLength;
  }

  /**
   * The largest collection whose serialized root still fits the Account
   * ceiling, plus the entry that would push it past. Derived by measuring the
   * real serialization rather than by assuming an entry size.
   */
  const nearByteCeiling = (() => {
    const kept: ReturnType<typeof largeSavedSecretAt>[] = [];
    for (let index = 0; index < SAVED_SECRET_COLLECTION_MAX_ENTRIES; index += 1) {
      const candidate = largeSavedSecretAt(index);
      if (secretsRootBytes([...kept, candidate]) > ACCOUNT_SETTINGS_MAX_SAVED_SECRETS_BYTES) {
        return { kept, crossing: candidate };
      }
      kept.push(candidate);
    }
    throw new Error('Fixture never reached the SavedSecret byte ceiling');
  })();

  it('refuses an add that would push the collection past the byte ceiling the reader enforces', () => {
    // Preconditions: the starting collection is well inside the cardinality
    // limit and fully visible, so a refusal here cannot be the entry-count
    // guard firing instead.
    expect(nearByteCeiling.kept.length).toBeLessThan(SAVED_SECRET_COLLECTION_MAX_ENTRIES);
    expect(accountSettingsParse({ secrets: nearByteCeiling.kept }).secrets.length)
      .toBe(nearByteCeiling.kept.length);

    expect(() => applyAccountSettingsSavedSecretMutation(
      { secrets: nearByteCeiling.kept },
      { kind: 'add', secret: nearByteCeiling.crossing },
    )).toThrowError(expect.objectContaining({
      code: 'saved_secret_collection_full',
    }));

    // The refusal is only correct while the canonical reader really does lose
    // the whole root at that size. Measure the reader instead of restating the
    // owner's ceiling: an oversized root recovers to its default, so the write
    // would have hidden every already-working secret, not just the new one.
    const oversized = [...nearByteCeiling.kept, nearByteCeiling.crossing];
    expect(secretsRootBytes(oversized)).toBeGreaterThan(ACCOUNT_SETTINGS_MAX_SAVED_SECRETS_BYTES);
    expect(accountSettingsParse({ secrets: oversized }).secrets.length).toBe(0);
  });

  it('accepts an add that keeps the collection inside the byte ceiling', () => {
    const base = nearByteCeiling.kept.slice(0, nearByteCeiling.kept.length - 1);
    const result = applyAccountSettingsSavedSecretMutation(
      { secrets: base },
      { kind: 'add', secret: savedSecretAt(SAVED_SECRET_COLLECTION_MAX_ENTRIES) },
    );
    const written = result.settings.secrets as readonly unknown[];
    expect(written.length).toBe(base.length + 1);
    expect(accountSettingsParse(result.settings).secrets.length).toBe(written.length);
  });

  it('still allows a delete to recover a collection that is already past the byte ceiling', () => {
    const oversized = [...nearByteCeiling.kept, nearByteCeiling.crossing];
    const result = applyAccountSettingsSavedSecretMutation(
      { secrets: oversized },
      { kind: 'delete', secretId: 'secret-0', expectedUpdatedAt: 1 },
    );
    const written = result.settings.secrets as readonly unknown[];
    expect(written.length).toBe(oversized.length - 1);
    expect(secretsRootBytes(written)).toBeLessThan(secretsRootBytes(oversized));
  });
});
