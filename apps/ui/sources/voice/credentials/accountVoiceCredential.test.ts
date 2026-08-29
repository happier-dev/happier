import { describe, expect, it, vi } from 'vitest';

import { VoiceProviderContributionSchema } from '@happier-dev/protocol';

import { settingsParse } from '@/sync/domains/settings/settings';
import {
  approveAccountVoiceCredentialRecipientContract,
  applyAccountVoiceCredentialSourceSelection as applyAccountVoiceCredentialSourceSelectionAtOwner,
  materializeAccountVoiceCredential,
  mutateAccountVoiceCredentialSource,
  removeAccountVoiceCredential,
  resolveAccountVoiceCredential,
  resolveAccountVoiceCredentialSourceSelection,
  resolveAccountVoiceCredentialStatus,
  resolveExactAccountVoiceCredentialSecretId,
  resolveSelectedVoiceCredentialRawGrants,
  saveAndUseAccountVoiceCredential as saveAndUseAccountVoiceCredentialAtOwner,
  shouldUseVoiceCredentialSourceMutationForSavedSecret,
  upsertAccountVoiceCredential,
} from './accountVoiceCredential';

function voiceDeclaration(
  contribution: Readonly<{ pluginId: string; localId: string }>,
  purpose: string,
) {
  const rawGrant = {
    realm: 'web' as const,
    phase: 'prepare' as const,
    request: {
      kind: 'httpHeaders' as const,
      origin: 'https://api.openai.com',
      headerNames: ['authorization'],
    },
  };
  return VoiceProviderContributionSchema.parse({
    id: contribution.localId,
    title: 'Voice provider',
    kind: 'conversation' as const,
    roles: ['realtime_conversation' as const],
    platforms: ['web' as const],
    capabilities: { turn: { cancelResponse: false, bargeIn: false } },
    credentials: {
      slot: { id: 'api_key', purpose, title: 'API key' },
      requirement: { kind: 'always' as const },
      sources: [{ kind: 'savedSecret' as const, secretKinds: ['apiKey' as const], rawGrants: [rawGrant] }, {
        kind: 'connectedAccount' as const,
        service: { pluginId: 'happier.voice.openai', localId: 'openai' },
        rawGrants: [rawGrant],
      }, {
        kind: 'connectedAccount' as const,
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        rawGrants: [rawGrant],
      }],
    },
    client: { artifactId: 'web-runtime', modulePath: './voiceRuntime' as const, exportName: 'activate' as const },
  });
}

function applyAccountVoiceCredentialSourceSelection(params: Parameters<
  typeof applyAccountVoiceCredentialSourceSelectionAtOwner
>[0] extends never ? never : Readonly<{
  settings: Parameters<typeof applyAccountVoiceCredentialSourceSelectionAtOwner>[0]['settings'];
  contribution: Readonly<{ pluginId: string; localId: string }>;
  credentialSlotId: string;
  purpose: Readonly<{
    consumer: Readonly<{ pluginId: string; localId: string }>;
    purpose: string;
  }>;
  selection: Parameters<typeof applyAccountVoiceCredentialSourceSelectionAtOwner>[0]['mutation']['selection'];
}>) {
  return applyAccountVoiceCredentialSourceSelectionAtOwner({
    settings: params.settings,
    mutation: {
      contribution: params.contribution,
      credentialSlotId: params.credentialSlotId,
      selection: params.selection,
      expectedSettingsVersion: 4,
    },
    currentDeclaration: voiceDeclaration(params.contribution, params.purpose.purpose),
  });
}

function saveAndUseAccountVoiceCredential(params: Omit<
  Parameters<typeof saveAndUseAccountVoiceCredentialAtOwner>[0],
  'expectedSettingsVersion' | 'currentDeclaration'
> & Readonly<{ purpose: Readonly<{
  consumer: Readonly<{ pluginId: string; localId: string }>;
  purpose: string;
}> }>) {
  const { purpose, ...mutation } = params;
  return saveAndUseAccountVoiceCredentialAtOwner({
    ...mutation,
    expectedSettingsVersion: 4,
    currentDeclaration: voiceDeclaration(params.contribution, purpose.purpose),
  });
}

const OPENAI_VOICE_CONTRIBUTION = Object.freeze({
  pluginId: 'happier.voice.openai',
  localId: 'realtime-openai',
});
const XAI_VOICE_CONTRIBUTION = Object.freeze({
  pluginId: 'happier.voice.xai',
  localId: 'realtime-grok',
});
const PACKED_VOICE_CONTRIBUTION = Object.freeze({
  pluginId: 'acme.packed-voice',
  localId: 'conversation',
});

describe('account Voice credential source mutation', () => {
  it('projects only the selected source grants for the exact access scope and request', () => {
    const base = voiceDeclaration(OPENAI_VOICE_CONTRIBUTION, 'voice.client-auth');
    const webGrant = {
      realm: 'web' as const,
      phase: 'prepare' as const,
      request: {
        kind: 'httpHeaders' as const,
        origin: 'https://api.openai.com',
        headerNames: ['authorization'],
      },
    };
    const connectionGrant = {
      realm: 'web' as const,
      phase: 'connection' as const,
      request: {
        kind: 'httpHeaders' as const,
        origin: 'https://api.openai.com',
        headerNames: ['authorization', 'x-request-id'],
      },
    };
    const connectedGrant = {
      realm: 'web' as const,
      phase: 'prepare' as const,
      request: {
        kind: 'httpHeaders' as const,
        origin: 'https://accounts.example.com',
        headerNames: ['x-account-token'],
      },
    };
    const declaration = VoiceProviderContributionSchema.parse({
      ...base,
      credentials: {
        ...base.credentials,
        sources: base.credentials?.sources.map((source, index) => (
          index === 0
            ? { ...source, rawGrants: [webGrant, connectionGrant] }
            : index === 1
              ? { ...source, rawGrants: [connectedGrant] }
              : source
        )),
      },
    });

    expect(resolveSelectedVoiceCredentialRawGrants({
      declaration,
      contribution: OPENAI_VOICE_CONTRIBUTION,
      selection: { kind: 'savedSecret' },
      access: {
        realm: 'web',
        phase: 'connection',
        request: {
          kind: 'httpHeaders',
          origin: 'https://api.openai.com',
          headerNames: ['x-request-id', 'authorization'],
        },
      },
    })).toEqual([connectionGrant]);
    expect(resolveSelectedVoiceCredentialRawGrants({
      declaration,
      contribution: OPENAI_VOICE_CONTRIBUTION,
      selection: { kind: 'savedSecret' },
      access: {
        realm: 'web',
        phase: 'connection',
        request: {
          kind: 'httpHeaders',
          origin: 'https://api.openai.com',
          headerNames: ['authorization'],
        },
      },
    })).toEqual([]);
    expect(resolveSelectedVoiceCredentialRawGrants({
      declaration,
      contribution: OPENAI_VOICE_CONTRIBUTION,
      selection: {
        kind: 'connectedAccount',
        target: {
          kind: 'account',
          account: {
            service: { pluginId: 'happier.voice.openai', localId: 'openai' },
            accountId: 'account-a',
          },
        },
      },
      access: {
        realm: 'web',
        phase: 'prepare',
        request: {
          kind: 'httpHeaders',
          origin: 'https://accounts.example.com',
          headerNames: ['x-account-token'],
        },
      },
    })).toEqual([connectedGrant]);
  });

  it.each([
    [{ kind: 'none' }, true],
    [{ kind: 'savedSecret' }, true],
    [null, true],
    [undefined, true],
    [{ kind: 'connectedAccount' }, false],
  ] as const)(
    'routes a SavedSecret gesture through the source owner unless selection is definitively Connected Account',
    (selection, expected) => {
      expect(shouldUseVoiceCredentialSourceMutationForSavedSecret(selection)).toBe(expected);
    },
  );

  it('preserves a possible Account Settings dispatch as outcomeUnknown instead of claiming the voice source applied', async () => {
    const expectedDeclaration = voiceDeclaration(
      OPENAI_VOICE_CONTRIBUTION,
      'voice.client-auth',
    );
    let mutations = 0;

    await expect(mutateAccountVoiceCredentialSource({
      mutation: {
        contribution: OPENAI_VOICE_CONTRIBUTION,
        credentialSlotId: 'api_key',
        selection: { kind: 'savedSecret' },
        expectedSettingsVersion: 4,
      },
      expectedDeclaration,
      resolveCurrentDeclaration: () => expectedDeclaration,
      mutateAccountSettingsOnce: async (input) => {
        mutations += 1;
        input.mutate({});
        return {
          status: 'outcomeUnknown',
          lastKnownSettingsVersion: 5,
          safeSnapshotVersion: 5,
        };
      },
    })).resolves.toEqual({
      status: 'outcomeUnknown',
      lastKnownSettingsVersion: 5,
      safeSnapshotVersion: 5,
    });

    expect(mutations).toBe(1);
  });

  it('reports the admitted commit as applied when the declaration changes during the boundary await', async () => {
    const expectedDeclaration = voiceDeclaration(
      OPENAI_VOICE_CONTRIBUTION,
      'voice.client-auth',
    );
    let currentDeclaration = expectedDeclaration;
    let signalAdmitted!: () => void;
    const admitted = new Promise<void>((resolve) => {
      signalAdmitted = resolve;
    });
    let releaseCommit!: () => void;
    const commitReleased = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const target = {
      kind: 'account' as const,
      account: {
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        accountId: 'codex-account',
      },
    };
    const mutation = {
      contribution: OPENAI_VOICE_CONTRIBUTION,
      credentialSlotId: 'api_key',
      selection: { kind: 'connectedAccount' as const, target },
      expectedSettingsVersion: 4,
    };

    const resultPromise = mutateAccountVoiceCredentialSource({
      mutation,
      expectedDeclaration,
      resolveCurrentDeclaration: () => currentDeclaration,
      mutateAccountSettingsOnce: async (input) => {
        const applied = input.mutate({});
        signalAdmitted();
        await commitReleased;
        return { status: 'applied', settingsVersion: 5, value: applied.value };
      },
    });

    await admitted;
    currentDeclaration = voiceDeclaration(
      OPENAI_VOICE_CONTRIBUTION,
      'voice.changed-after-admission',
    );
    releaseCommit();

    await expect(resultPromise).resolves.toEqual({
      status: 'applied',
      settingsVersion: 5,
      selection: { kind: 'connectedAccount', target },
      binding: {
        purpose: {
          consumer: OPENAI_VOICE_CONTRIBUTION,
          purpose: 'voice.client-auth',
        },
        target,
      },
    });
  });
});

describe('account Voice credential ownership', () => {
  it('keeps the source resolver preparatory without suppressing legacy OpenAI SavedSecret materialization', () => {
    const withDormantSecret = upsertAccountVoiceCredential({
      settings: settingsParse({}),
      contribution: OPENAI_VOICE_CONTRIBUTION,
      credentialSlotId: 'api_key',
      value: 'sk-dormant',
      generateId: () => 'voice-openai-secret',
      now: 10,
      expectedSecretId: null,
      expectedSecretUpdatedAt: null,
    }).settings;
    const purpose = {
      consumer: OPENAI_VOICE_CONTRIBUTION,
      purpose: 'voice.client-auth',
    } as const;

    expect(resolveAccountVoiceCredentialSourceSelection({
      settings: withDormantSecret,
      contribution: OPENAI_VOICE_CONTRIBUTION,
      credentialSlotId: 'api_key',
      purpose,
      machineId: null,
    })).toMatchObject({
      persisted: true,
      selection: { kind: 'none' },
      savedSecret: null,
    });

    const savedSecret = applyAccountVoiceCredentialSourceSelection({
      settings: withDormantSecret,
      contribution: OPENAI_VOICE_CONTRIBUTION,
      credentialSlotId: 'api_key',
      purpose,
      selection: { kind: 'savedSecret' },
    }).settings;
    expect(resolveAccountVoiceCredentialSourceSelection({
      settings: savedSecret,
      contribution: OPENAI_VOICE_CONTRIBUTION,
      credentialSlotId: 'api_key',
      purpose,
      machineId: null,
    })).toMatchObject({
      persisted: true,
      selection: { kind: 'savedSecret' },
      savedSecret: { secretId: 'voice-openai-secret', source: 'account' },
    });

    const connectedTarget = {
      kind: 'account' as const,
      account: {
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        accountId: 'codex-account',
      },
    };
    const connected = applyAccountVoiceCredentialSourceSelection({
      settings: savedSecret,
      contribution: OPENAI_VOICE_CONTRIBUTION,
      credentialSlotId: 'api_key',
      purpose,
      selection: { kind: 'connectedAccount', target: connectedTarget },
    }).settings;
    expect(resolveAccountVoiceCredentialSourceSelection({
      settings: connected,
      contribution: OPENAI_VOICE_CONTRIBUTION,
      credentialSlotId: 'api_key',
      purpose,
      machineId: null,
    })).toMatchObject({
      selection: { kind: 'connectedAccount', target: connectedTarget },
      binding: { purpose, target: connectedTarget },
      savedSecret: null,
    });
    expect(resolveAccountVoiceCredential(
      connected,
      OPENAI_VOICE_CONTRIBUTION,
      'api_key',
      null,
    )).toEqual({ secretId: 'voice-openai-secret', source: 'account' });
    const decrypt = vi.fn(() => 'sk-dormant');
    expect(materializeAccountVoiceCredential({
      settings: connected,
      contribution: OPENAI_VOICE_CONTRIBUTION,
      credentialSlotId: 'api_key',
      decrypt,
    })).toBe('sk-dormant');
    expect(decrypt).toHaveBeenCalledOnce();
    expect(connected.secrets).toEqual([
      expect.objectContaining({ id: 'voice-openai-secret' }),
    ]);
  });

  it('atomically saves and selects a SavedSecret through the shared replacement mutation', () => {
    const purpose = {
      consumer: OPENAI_VOICE_CONTRIBUTION,
      purpose: 'voice.client-auth',
    } as const;
    const created = saveAndUseAccountVoiceCredential({
      settings: settingsParse({}),
      contribution: OPENAI_VOICE_CONTRIBUTION,
      credentialSlotId: 'api_key',
      purpose,
      value: 'sk-new',
      generateId: () => 'voice-openai-secret',
      now: 10,
      expectedSecretId: null,
      expectedSecretUpdatedAt: null,
    });
    expect(created.secretId).toBe('voice-openai-secret');
    expect(resolveAccountVoiceCredentialSourceSelection({
      settings: created.settings,
      contribution: OPENAI_VOICE_CONTRIBUTION,
      credentialSlotId: 'api_key',
      purpose,
      machineId: null,
    })).toMatchObject({
      selection: { kind: 'savedSecret' },
      savedSecret: { secretId: 'voice-openai-secret' },
    });

    expect(() => saveAndUseAccountVoiceCredential({
      settings: created.settings,
      contribution: OPENAI_VOICE_CONTRIBUTION,
      credentialSlotId: 'api_key',
      purpose,
      value: 'sk-stale',
      generateId: () => 'should-not-land',
      now: 20,
      expectedSecretId: 'voice-openai-secret',
      expectedSecretUpdatedAt: 9,
    })).toThrow();
    expect(created.settings.secrets).toEqual([
      expect.objectContaining({ id: 'voice-openai-secret', updatedAt: 10 }),
    ]);
  });

  it('edits one dormant account binding without machine affinity', () => {
    const initial = settingsParse({});
    const created = upsertAccountVoiceCredential({
      settings: initial,
      contribution: OPENAI_VOICE_CONTRIBUTION,
      credentialSlotId: 'api_key',
      value: 'sk-first',
      generateId: () => 'voice-openai-secret',
      now: 10,
      expectedSecretId: null,
      expectedSecretUpdatedAt: null,
    });
    expect(created.accountSettings.voiceSettingsV1).toMatchObject({
      credentialBindings: [{
        contribution: OPENAI_VOICE_CONTRIBUTION,
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'none' },
        credentialBindings: { account: { api_key: 'voice-openai-secret' } },
      }],
    });
    expect(created.accountSettings.voiceSettingsV1).not.toHaveProperty(
      'credentialBindings.0.providerId',
    );
    expect(resolveAccountVoiceCredential(
      settingsParse(created.accountSettings),
      OPENAI_VOICE_CONTRIBUTION,
      'api_key',
      'machine-a',
    )).toEqual({ secretId: 'voice-openai-secret', source: 'account' });
    expect(resolveExactAccountVoiceCredentialSecretId({
      settings: settingsParse(created.accountSettings),
      contribution: OPENAI_VOICE_CONTRIBUTION,
      credentialSlotId: 'api_key',
      machineId: null,
    })).toBe('voice-openai-secret');

    const changed = upsertAccountVoiceCredential({
      settings: created.settings,
      contribution: OPENAI_VOICE_CONTRIBUTION,
      credentialSlotId: 'api_key',
      value: 'sk-second',
      generateId: () => 'voice-openai-secret-next',
      now: 20,
      expectedSecretId: 'voice-openai-secret',
      expectedSecretUpdatedAt: 10,
    });
    expect(changed.settings.secrets).toEqual([expect.objectContaining({
      id: 'voice-openai-secret-next',
      encryptedValue: { _isSecretValue: true, value: 'sk-second' },
      createdAt: 20,
      updatedAt: 20,
    })]);
  });

  it('preserves the selected external provider and config when recipient approval is renewed', () => {
    const providerId = 'acme.packed-voice/conversation';
    const providerEnvelope = {
      schemaVersion: 2,
      config: {
        mode: 'default',
        profile: 'balanced',
        enableProvisioning: true,
      },
    };
    const recipientContractBefore = `sha256:${'a'.repeat(64)}`;
    const recipientContractAfter = `sha256:${'b'.repeat(64)}`;
    const credentialCreated = upsertAccountVoiceCredential({
      settings: settingsParse({}),
      contribution: PACKED_VOICE_CONTRIBUTION,
      credentialSlotId: 'api_key',
      value: 'source-account-secret',
      generateId: () => 'packed-voice-secret',
      now: 1,
      expectedSecretId: null,
      expectedSecretUpdatedAt: null,
      approvedRecipientContractDigest: recipientContractBefore,
    }).settings;
    const initial = {
      ...credentialCreated,
      voice: {
        ...credentialCreated.voice,
        providerId,
        providers: {
          ...credentialCreated.voice.providers,
          [providerId]: providerEnvelope,
        },
      },
      voiceSettingsV1: {
        ...credentialCreated.voiceSettingsV1,
        providerId,
        providers: {
          ...credentialCreated.voiceSettingsV1.providers,
          [providerId]: providerEnvelope,
        },
      },
    };

    const changed = upsertAccountVoiceCredential({
      settings: initial,
      contribution: PACKED_VOICE_CONTRIBUTION,
      credentialSlotId: 'api_key',
      value: 'source-account-secret',
      generateId: () => 'packed-voice-secret-reapproved',
      now: 2,
      expectedSecretId: 'packed-voice-secret',
      expectedSecretUpdatedAt: 1,
      approvedRecipientContractDigest: recipientContractAfter,
    });

    expect(changed.settings.voice).toMatchObject({
      providerId,
      providers: {
        [providerId]: providerEnvelope,
      },
    });
    expect(changed.settings.voiceSettingsV1).toMatchObject({
      providerId,
      providers: {
        [providerId]: providerEnvelope,
      },
      credentialBindings: [{
        contribution: PACKED_VOICE_CONTRIBUTION,
        credentialSlotId: 'api_key',
        approvedRecipientContractDigest: recipientContractAfter,
        credentialBindings: {
          account: { api_key: 'packed-voice-secret-reapproved' },
        },
      }],
    });
  });

  it('renews recipient approval in place without rotating the selected secret', () => {
    const created = saveAndUseAccountVoiceCredential({
      settings: settingsParse({}),
      contribution: PACKED_VOICE_CONTRIBUTION,
      credentialSlotId: 'api_key',
      purpose: {
        consumer: PACKED_VOICE_CONTRIBUTION,
        purpose: 'voice.client-auth',
      },
      value: 'source-account-secret',
      generateId: () => 'packed-voice-secret',
      now: 1,
      expectedSecretId: null,
      expectedSecretUpdatedAt: null,
      approvedRecipientContractDigest: `sha256:${'a'.repeat(64)}`,
    }).settings;

    const approved = approveAccountVoiceCredentialRecipientContract({
      settings: created,
      contribution: PACKED_VOICE_CONTRIBUTION,
      credentialSlotId: 'api_key',
      expectedSecretId: 'packed-voice-secret',
      expectedSecretUpdatedAt: 1,
      approvedRecipientContractDigest: `sha256:${'b'.repeat(64)}`,
    });

    expect(approved.settings.secrets).toEqual(created.secrets);
    expect(resolveAccountVoiceCredential(
      approved.settings,
      PACKED_VOICE_CONTRIBUTION,
      'api_key',
      null,
      `sha256:${'b'.repeat(64)}`,
    )).toEqual({ secretId: 'packed-voice-secret', source: 'account' });
  });

  it('distinguishes a retained SavedSecret awaiting recipient review from a missing credential', () => {
    const requiredDigest = `sha256:${'b'.repeat(64)}`;
    const created = saveAndUseAccountVoiceCredential({
      settings: settingsParse({}),
      contribution: PACKED_VOICE_CONTRIBUTION,
      credentialSlotId: 'api_key',
      purpose: {
        consumer: PACKED_VOICE_CONTRIBUTION,
        purpose: 'voice.client-auth',
      },
      value: 'source-account-secret',
      generateId: () => 'packed-voice-secret',
      now: 1,
      expectedSecretId: null,
      expectedSecretUpdatedAt: null,
      approvedRecipientContractDigest: `sha256:${'a'.repeat(64)}`,
    }).settings;

    expect(resolveAccountVoiceCredentialStatus({
      settings: created,
      contribution: PACKED_VOICE_CONTRIBUTION,
      credentialSlotId: 'api_key',
      requiredRecipientContractDigest: requiredDigest,
    })).toEqual({
      status: 'review_required',
      reference: {
        secretId: 'packed-voice-secret',
        source: 'account',
      },
    });
    expect(resolveAccountVoiceCredentialStatus({
      settings: settingsParse({}),
      contribution: PACKED_VOICE_CONTRIBUTION,
      credentialSlotId: 'api_key',
      requiredRecipientContractDigest: requiredDigest,
    })).toEqual({
      status: 'missing',
      reference: null,
    });
  });

  it('reports an unresolvable account-settings snapshot as unknown rather than missing', () => {
    const parsed = settingsParse({
      secrets: [{
        id: 'packed-voice-secret',
        name: 'Voice',
        kind: 'apiKey',
        encryptedValue: { _isSecretValue: true, value: 'source-account-secret' },
        createdAt: 1,
        updatedAt: 1,
      }],
    });
    // A single non-canonical entry makes the whole `credentialBindings`
    // collection unreadable; the stored credential is untouched.
    const unreadable = {
      ...parsed,
      voiceSettingsV1: {
        ...parsed.voiceSettingsV1,
        credentialBindings: [{ notACredentialBinding: true }],
      },
    } as unknown as typeof parsed;

    expect(resolveAccountVoiceCredentialStatus({
      settings: unreadable,
      contribution: PACKED_VOICE_CONTRIBUTION,
      credentialSlotId: 'api_key',
    })).toEqual({
      status: 'unknown',
      reference: null,
    });
  });

  it('resolves an exact machine override before account fallback', () => {
    const settings = settingsParse({
      secrets: [
        { id: 'account-secret', name: 'Account', kind: 'apiKey', encryptedValue: { _isSecretValue: true, value: 'account' }, createdAt: 1, updatedAt: 1 },
        { id: 'machine-secret', name: 'Machine', kind: 'apiKey', encryptedValue: { _isSecretValue: true, value: 'machine' }, createdAt: 1, updatedAt: 1 },
      ],
      voiceSettingsV1: {
        credentialBindings: [{
          contribution: PACKED_VOICE_CONTRIBUTION,
          credentialSlotId: 'api_key',
          credentialSource: { kind: 'savedSecret' },
          credentialBindings: {
            account: { api_key: 'account-secret' },
            byMachineId: { 'machine-a': { api_key: 'machine-secret' } },
          },
        }],
      },
    });
    expect(resolveAccountVoiceCredential(
      settings,
      PACKED_VOICE_CONTRIBUTION,
      'api_key',
      'machine-a',
    )?.source).toBe('machine_override');
    expect(resolveAccountVoiceCredential(
      settings,
      PACKED_VOICE_CONTRIBUTION,
      'api_key',
      'machine-b',
    )?.source).toBe('account');
    expect(resolveAccountVoiceCredential(
      settings,
      PACKED_VOICE_CONTRIBUTION,
      'api_key',
      null,
    )?.source).toBe('account');
  });

  it('materializes only through the invocation-scoped decrypt callback', () => {
    const settings = saveAndUseAccountVoiceCredential({
      settings: settingsParse({}), contribution: XAI_VOICE_CONTRIBUTION,
      credentialSlotId: 'api_key',
      purpose: {
        consumer: XAI_VOICE_CONTRIBUTION,
        purpose: 'voice.client-auth',
      },
      value: 'xai-key', generateId: () => 'xai-secret', now: 1, expectedSecretId: null,
      expectedSecretUpdatedAt: null,
    }).settings;
    const decrypt = vi.fn(() => 'xai-key');
    expect(materializeAccountVoiceCredential({
      settings,
      contribution: XAI_VOICE_CONTRIBUTION,
      credentialSlotId: 'api_key',
      decrypt,
    })).toBe('xai-key');
    expect(decrypt).toHaveBeenCalledOnce();
  });

  it('unbinds and deletes only an otherwise unreferenced SavedSecret', () => {
    const created = upsertAccountVoiceCredential({
      settings: settingsParse({}), contribution: OPENAI_VOICE_CONTRIBUTION,
      credentialSlotId: 'api_key',
      value: 'shared', generateId: () => 'shared-secret', now: 1, expectedSecretId: null,
      expectedSecretUpdatedAt: null,
    }).settings;
    const shared = {
      ...created,
      secretBindingsByProfileId: { profile: { OPENAI_API_KEY: 'shared-secret' } },
    };
    expect(removeAccountVoiceCredential({
      settings: shared,
      contribution: OPENAI_VOICE_CONTRIBUTION,
      credentialSlotId: 'api_key',
      expectedSecretId: 'shared-secret',
      expectedSecretUpdatedAt: 1,
    }).settings.secrets)
      .toHaveLength(1);
    expect(removeAccountVoiceCredential({
      settings: created,
      contribution: OPENAI_VOICE_CONTRIBUTION,
      credentialSlotId: 'api_key',
      expectedSecretId: 'shared-secret',
      expectedSecretUpdatedAt: 1,
    }).settings.secrets)
      .toEqual([]);
  });

  it('rejects a stale target-local Voice replacement instead of overwriting the CAS winner', () => {
    const current = upsertAccountVoiceCredential({
      settings: settingsParse({}),
      contribution: OPENAI_VOICE_CONTRIBUTION,
      credentialSlotId: 'api_key',
      value: 'winner',
      generateId: () => 'winner-secret',
      now: 1,
      expectedSecretId: null,
      expectedSecretUpdatedAt: null,
    }).settings;

    expect(() => upsertAccountVoiceCredential({
      settings: current,
      contribution: OPENAI_VOICE_CONTRIBUTION,
      credentialSlotId: 'api_key',
      value: 'stale',
      generateId: () => 'stale-secret',
      now: 2,
      expectedSecretId: null,
      expectedSecretUpdatedAt: null,
    })).toThrowError(expect.objectContaining({ code: 'saved_secret_conflict' }));

    expect(() => upsertAccountVoiceCredential({
      settings: current,
      contribution: OPENAI_VOICE_CONTRIBUTION,
      credentialSlotId: 'api_key',
      value: 'stale-after-global-rotation',
      generateId: () => 'stale-after-rotation-secret',
      now: 2,
      expectedSecretId: 'winner-secret',
      expectedSecretUpdatedAt: 0,
    })).toThrowError(expect.objectContaining({ code: 'saved_secret_conflict' }));
  });
});
