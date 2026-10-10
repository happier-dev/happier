import { afterEach, describe, expect, it } from 'vitest';

import {
  sealSavedSecretResourceStoredContentV1,
  VoiceCredentialBindingIdentityV1Schema,
  type VoiceCredentialBindingIdentityV1,
} from '@happier-dev/protocol';

import {
  clearActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshot,
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { SavedSecretCatalogResourceInputV1 } from '@/settings/secrets/savedSecretCatalog';
import { SavedSecretOperationAdmissionError } from '@/settings/secrets/hydrateSavedSecretCatalog';
import {
  createVoiceCredentialResolver,
  type VoiceCredentialResolver,
} from './resolver';

const GOOGLE_STT_CONTRIBUTION = Object.freeze({
  pluginId: 'happier.voice.google',
  localId: 'gemini-stt',
});

/** The persisted selection identity a Voice contribution projects for its slot. */
function identityFor(
  contribution: Readonly<{ pluginId: string; localId: string }>,
  credentialSlotId = 'api_key',
): VoiceCredentialBindingIdentityV1 {
  return VoiceCredentialBindingIdentityV1Schema.parse({
    contribution,
    credentialSlotId,
    purpose: { consumer: contribution, purpose: 'voice.client-auth' },
  });
}

function publishLegacy(params: Readonly<{
  scopeKey: string;
  accountValue: string;
}>) {
  setActiveAccountSettingsSnapshot({
    source: 'network', scopeKey: params.scopeKey, settingsVersion: 1, loadedAtMs: 1,
    settingsSecretsReadKeys: [],
    settings: {
      secrets: [
        { id: `${params.scopeKey}-account`, name: 'Account key', kind: 'apiKey', encryptedValue: { _isSecretValue: true, value: params.accountValue } },
      ],
      voiceSettingsV1: {
        credentialBindings: [{
          providerId: 'google_gemini',
          credentialBindings: {
            account: { api_key: `${params.scopeKey}-account` },
          },
        }],
      },
    } as never,
  });
}

function publishQualified(params: Readonly<{
  scopeKey: string;
  accountValue: string;
  contribution: Readonly<{ pluginId: string; localId: string }>;
  credentialSlotId?: string;
  machineValue?: string;
  credentialSource?: 'none' | 'savedSecret' | 'connectedAccount';
  settingsVersion?: number;
  secretUpdatedAt?: number;
  includeSecret?: boolean;
  unrelatedVoiceProvider?: boolean;
  secretId?: string;
  savedSecretResources?: readonly SavedSecretCatalogResourceInputV1[];
  savedSecretCatalogState?: 'ready' | 'temporarily_unavailable';
}>) {
  const credentialSlotId = params.credentialSlotId ?? 'api_key';
  setActiveAccountSettingsSnapshot({
    source: 'network',
    scopeKey: params.scopeKey,
    settingsVersion: params.settingsVersion ?? 1,
    loadedAtMs: 1,
    settingsSecretsReadKeys: [],
    connectedPurposeCatalog: { status: 'ready', revision: 1, record: { key: 'purposes', value: {
      v: 1,
      bindings: params.credentialSource === 'connectedAccount' ? [{
        purpose: { consumer: params.contribution, purpose: 'voice.client-auth' },
        target: { kind: 'account', account: {
          service: { pluginId: 'happier.agent.openai', localId: 'openai' }, accountId: 'openai-account',
        } },
      }] : [],
    } } },
    settings: {
      secrets: params.includeSecret === false
        ? []
        : [
            {
              id: `${params.scopeKey}-account`,
              name: 'Account key',
              kind: 'apiKey',
              encryptedValue: { _isSecretValue: true, value: params.accountValue },
              createdAt: 1,
              updatedAt: params.secretUpdatedAt ?? 1,
            },
            ...(params.machineValue
              ? [{
                  id: `${params.scopeKey}-machine`,
                  name: 'Machine key',
                  kind: 'apiKey',
                  encryptedValue: { _isSecretValue: true, value: params.machineValue },
                  createdAt: 1,
                  updatedAt: params.secretUpdatedAt ?? 1,
                }]
              : []),
          ],
      voiceSettingsV1: {
        credentialBindings: [{
          contribution: params.contribution,
          credentialSlotId,
          credentialSource: { kind: params.credentialSource ?? 'savedSecret' },
          credentialBindings: {
            account: { [credentialSlotId]: params.secretId ?? `${params.scopeKey}-account` },
            ...(params.machineValue
              ? { byMachineId: { machine_a: { [credentialSlotId]: `${params.scopeKey}-machine` } } }
              : {}),
          },
        }],
        ...(params.unrelatedVoiceProvider
          ? {
              providers: {
                'happier.voice.unrelated/provider': {
                  schemaVersion: 1,
                  config: { enabled: true },
                },
              },
            }
          : {}),
      },
    } as never,
    ...(params.savedSecretResources ? { savedSecretResources: params.savedSecretResources } : {}),
    ...(params.savedSecretCatalogState ? { savedSecretCatalogState: params.savedSecretCatalogState } : {}),
  } as never);
}

afterEach(() => resetActiveAccountSettingsSnapshotForTests());

describe('Voice credential resolver', () => {
  it('does not admit the predecessor providerId request shape at the current resolver boundary', async () => {
    publishLegacy({ scopeKey: 'account-a', accountValue: 'account-key' });
    const resolver = createVoiceCredentialResolver({ machineId: null });
    const legacyProvider = 'google_gemini' as unknown as Parameters<VoiceCredentialResolver['status']>[0];
    const legacyInput = {
      providerId: 'google_gemini',
      credentialSlotId: 'api_key',
      use: async (secret: string) => secret,
    } as unknown as Parameters<VoiceCredentialResolver['withSecret']>[0];

    expect(resolver.status(legacyProvider)).toEqual({
      available: false,
      source: null,
      materialStatus: 'missing',
    });
    await expect(resolver.withSecret(legacyInput)).rejects.toMatchObject({
      code: 'credential_unavailable',
    });
  });

  it('reports and materializes a machine override before account fallback', async () => {
    publishQualified({
      scopeKey: 'account-a',
      accountValue: 'account-key',
      machineValue: 'machine-key',
      contribution: GOOGLE_STT_CONTRIBUTION,
    });
    const resolver = createVoiceCredentialResolver({ machineId: 'machine_a' });
    expect(resolver.status(identityFor(GOOGLE_STT_CONTRIBUTION))).toEqual({
      available: true,
      source: 'machine_override',
      materialStatus: 'ready',
    });
    await expect(resolver.withSecret({
      identity: identityFor(GOOGLE_STT_CONTRIBUTION),
      use: async (secret) => secret,
    })).resolves.toBe('machine-key');
  });

  it('does not reuse account A after the active snapshot switches to account B', async () => {
    const resolver = createVoiceCredentialResolver({ machineId: 'machine_a' });
    publishQualified({ scopeKey: 'account-a', accountValue: 'a-key', contribution: GOOGLE_STT_CONTRIBUTION });
    await expect(resolver.withSecret({ identity: identityFor(GOOGLE_STT_CONTRIBUTION), use: async (secret) => secret }))
      .resolves.toBe('a-key');
    publishQualified({ scopeKey: 'account-b', accountValue: 'b-key', contribution: GOOGLE_STT_CONTRIBUTION });
    await expect(resolver.withSecret({ identity: identityFor(GOOGLE_STT_CONTRIBUTION), use: async (secret) => secret }))
      .resolves.toBe('b-key');
  });

  it('keeps an in-flight SavedSecret operation only while its selected credential remains current', async () => {
    const replacements = [{
      label: 'unrelated Account Settings mutation',
      next: {
        settingsVersion: 2,
        unrelatedVoiceProvider: true,
      },
      allowed: true,
    }, {
      label: 'source switch',
      next: {
        settingsVersion: 2,
        credentialSource: 'connectedAccount' as const,
      },
      allowed: false,
    }, {
      label: 'SavedSecret revocation',
      next: {
        settingsVersion: 2,
        includeSecret: false,
      },
      allowed: false,
    }, {
      label: 'selected credential revision',
      next: {
        settingsVersion: 2,
        secretUpdatedAt: 2,
      },
      allowed: false,
    }, {
      label: 'same Account re-entry',
      next: {
        settingsVersion: 2,
      },
      clearAccountFirst: true,
      allowed: false,
    }] as const;

    for (const replacement of replacements) {
      resetActiveAccountSettingsSnapshotForTests();
      const resolver = createVoiceCredentialResolver({ machineId: null });
      publishQualified({
        scopeKey: 'account-a',
        accountValue: 'a-key',
        contribution: GOOGLE_STT_CONTRIBUTION,
      });
      let markStarted!: () => void;
      let releaseUse!: () => void;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const release = new Promise<void>((resolve) => { releaseUse = resolve; });
      const operation = resolver.withSecret({
        identity: identityFor(GOOGLE_STT_CONTRIBUTION),
        use: async (secret) => {
          markStarted();
          await release;
          return secret;
        },
      });
      await started;
      if ('clearAccountFirst' in replacement && replacement.clearAccountFirst) {
        clearActiveAccountSettingsSnapshot();
      }
      publishQualified({
        scopeKey: 'account-a',
        accountValue: 'a-key',
        contribution: GOOGLE_STT_CONTRIBUTION,
        ...replacement.next,
      });
      releaseUse();

      if (replacement.allowed) {
        await expect(operation, replacement.label).resolves.toBe('a-key');
      } else {
        await expect(operation, replacement.label).rejects.toMatchObject({
          code: 'credential_unavailable',
        });
      }
    }
  });

  it('resolves account-only client operations without consulting machine overrides', async () => {
    publishQualified({
      scopeKey: 'account-a',
      accountValue: 'account-key',
      machineValue: 'machine-key',
      contribution: GOOGLE_STT_CONTRIBUTION,
    });
    const resolver = createVoiceCredentialResolver({ machineId: null });
    expect(resolver.status(identityFor(GOOGLE_STT_CONTRIBUTION))).toEqual({
      available: true,
      source: 'account',
      materialStatus: 'ready',
    });
    await expect(resolver.withSecret({
      identity: identityFor(GOOGLE_STT_CONTRIBUTION),
      use: async (secret) => secret,
    })).resolves.toBe('account-key');
  });

  it('uses the canonical catalog for a ready shared resource and fences its revision', async () => {
    const resourceId = 'resource_voice_shared';
    const secretId = 'happier:shared-secret:v1:' + resourceId;
    const sharedResource = (revision: number, value: string) => ({
      resourceId,
      ownerAccountId: 'owner-account',
      displayName: 'Shared Voice key',
      kind: 'apiKey' as const,
      encryptionMode: 'plain' as const,
      revision,
      storedContent: sealSavedSecretResourceStoredContentV1({
        resourceId,
        mode: 'plain',
        content: { v: 1 as const, name: 'Shared Voice key', kind: 'apiKey' as const, value },
      }),
      materialStatus: 'ready' as const,
    });
    publishQualified({
      scopeKey: 'account-a',
      accountValue: 'unused-personal-key',
      contribution: GOOGLE_STT_CONTRIBUTION,
      secretId,
      savedSecretResources: [sharedResource(1, 'shared-key-v1')],
    });
    let snapshot = getActiveAccountSettingsSnapshot();
    const resolver = createVoiceCredentialResolver({
      machineId: null,
      getSnapshot: () => snapshot,
      getLifetimeToken: () => 1,
      // This case is about the post-use revision fence, so the Home admits the
      // operation unchanged; its own refusals are the next two cases.
      refreshForOperation: async () => snapshot as never,
    });

    expect(resolver.status(identityFor(GOOGLE_STT_CONTRIBUTION))).toEqual({
      available: true,
      source: 'account',
      materialStatus: 'ready',
    });
    let releaseUse!: () => void;
    const release = new Promise<void>((resolve) => { releaseUse = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const operation = resolver.withSecret({
      identity: identityFor(GOOGLE_STT_CONTRIBUTION),
      use: async (secret) => {
        expect(secret).toBe('shared-key-v1');
        markStarted();
        await release;
        return 'provider-result';
      },
    });
    await started;
    snapshot = snapshot && {
      ...snapshot,
      loadedAtMs: 2,
      savedSecretResources: [sharedResource(2, 'shared-key-v2')],
    };
    releaseUse();

    await expect(operation).rejects.toMatchObject({
      code: 'credential_unavailable',
      materialStatus: 'repair_required',
    });
  });

  it.each([
    ['preparing_encrypted_access', 'temporarily_unavailable'],
    ['recipient_mode_unsupported', 'mode_incompatible'],
    ['temporarily_unavailable', 'temporarily_unavailable'],
    ['access_removed', 'forbidden'],
    ['deleted', 'deleted'],
    ['update_required', 'repair_required'],
  ] as const)(
    'fails closed when a shared resource whose catalog status is %s',
    async (materialStatus, resolvedStatus) => {
      const resourceId = 'resource_voice_shared';
      publishQualified({
        scopeKey: 'account-a',
        accountValue: 'unused-personal-key',
        contribution: GOOGLE_STT_CONTRIBUTION,
        secretId: 'happier:shared-secret:v1:' + resourceId,
        savedSecretResources: [{
          resourceId,
          ownerAccountId: 'owner-account',
          displayName: 'Shared Voice key',
          kind: 'apiKey',
          encryptionMode: 'plain',
          revision: 1,
          storedContent: sealSavedSecretResourceStoredContentV1({
            resourceId,
            mode: 'plain',
            content: { v: 1, name: 'Shared Voice key', kind: 'apiKey', value: 'shared-key' },
          }),
          materialStatus,
        }],
      });
      const resolver = createVoiceCredentialResolver({ machineId: null });

      expect(resolver.status(identityFor(GOOGLE_STT_CONTRIBUTION))).toEqual({
        available: false,
        source: null,
        materialStatus: resolvedStatus,
      });
      await expect(resolver.withSecret({
        identity: identityFor(GOOGLE_STT_CONTRIBUTION),
        use: async () => undefined,
      })).rejects.toMatchObject({ code: 'credential_unavailable', materialStatus: resolvedStatus });
    },
  );

  it('admits a new Voice operation against Home-current shared material, not the hydrated row', async () => {
    const resourceId = 'resource_voice_admission';
    const secretId = `happier:shared-secret:v1:${resourceId}`;
    const sharedResource = (revision: number, value: string) => ({
      resourceId,
      ownerAccountId: 'owner-account',
      displayName: 'Shared Voice key',
      kind: 'apiKey' as const,
      encryptionMode: 'plain' as const,
      revision,
      storedContent: sealSavedSecretResourceStoredContentV1({
        resourceId,
        mode: 'plain',
        content: { v: 1 as const, name: 'Shared Voice key', kind: 'apiKey' as const, value },
      }),
      materialStatus: 'ready' as const,
    });
    publishQualified({
      scopeKey: 'account-a',
      accountValue: 'unused-personal-key',
      contribution: GOOGLE_STT_CONTRIBUTION,
      secretId,
      savedSecretResources: [sharedResource(1, 'stale-plaintext')],
    });
    const hydrated = getActiveAccountSettingsSnapshot();

    // 1. The Home revoked this shared reference and its AccountChange hint was
    //    never delivered, so the hydrated row still looks ready. The operation
    //    must be refused before any plaintext reaches `use`.
    const revokedCalls: unknown[] = [];
    let used = false;
    const revoked = createVoiceCredentialResolver({
      machineId: null,
      getSnapshot: () => hydrated,
      getLifetimeToken: () => 1,
      refreshForOperation: async (input) => {
        revokedCalls.push(input);
        throw new SavedSecretOperationAdmissionError({
          reason: 'reference_unavailable',
          reference: secretId,
        });
      },
    });
    expect(revoked.status(identityFor(GOOGLE_STT_CONTRIBUTION)).materialStatus).toBe('ready');
    await expect(revoked.withSecret({
      identity: identityFor(GOOGLE_STT_CONTRIBUTION),
      use: async () => { used = true; return 'never'; },
    })).rejects.toMatchObject({
      code: 'credential_unavailable',
      materialStatus: 'temporarily_unavailable',
    });
    expect(used).toBe(false);
    // Exactly one bounded batch for this operation's own reference set.
    expect(revokedCalls).toEqual([{
      expectedScopeKey: 'account-a',
      references: [{ ref: secretId }],
    }]);

    // 2. A stale reference is a distinct typed refusal, not a generic failure.
    const stale = createVoiceCredentialResolver({
      machineId: null,
      getSnapshot: () => hydrated,
      getLifetimeToken: () => 1,
      refreshForOperation: async () => {
        throw new SavedSecretOperationAdmissionError({
          reason: 'reference_stale',
          reference: secretId,
        });
      },
    });
    await expect(stale.withSecret({
      identity: identityFor(GOOGLE_STT_CONTRIBUTION),
      use: async () => 'never',
    })).rejects.toMatchObject({
      code: 'credential_unavailable',
      materialStatus: 'repair_required',
      admissionReason: 'reference_stale',
    });

    // 3. An admitted operation runs against the material the Home returned,
    //    not the plaintext the cached snapshot still holds.
    const rotated = hydrated && {
      ...hydrated,
      loadedAtMs: 2,
      savedSecretResources: [sharedResource(2, 'rotated-plaintext')],
    };
    const admitted = createVoiceCredentialResolver({
      machineId: null,
      getSnapshot: () => rotated,
      getLifetimeToken: () => 1,
      refreshForOperation: async () => rotated as never,
    });
    await expect(admitted.withSecret({
      identity: identityFor(GOOGLE_STT_CONTRIBUTION),
      use: async (secret) => secret,
    })).resolves.toBe('rotated-plaintext');
  });

  it('reports an authoritatively absent shared resource distinctly from temporary unavailability', async () => {
    publishQualified({
      scopeKey: 'account-a',
      accountValue: 'unused-personal-key',
      contribution: GOOGLE_STT_CONTRIBUTION,
      secretId: 'happier:shared-secret:v1:missing-resource',
      savedSecretResources: [],
      savedSecretCatalogState: 'ready',
    });
    const resolver = createVoiceCredentialResolver({ machineId: null });

    expect(resolver.status(identityFor(GOOGLE_STT_CONTRIBUTION))).toEqual({
      available: false,
      source: null,
      materialStatus: 'forbidden',
    });
    await expect(resolver.withSecret({
      identity: identityFor(GOOGLE_STT_CONTRIBUTION),
      use: async () => undefined,
    })).rejects.toMatchObject({
      code: 'credential_unavailable',
      materialStatus: 'forbidden',
    });
  });

  it('resolves canonical bindings only for the exact qualified contribution and declared slot', async () => {
    const contribution = GOOGLE_STT_CONTRIBUTION;
    publishQualified({ scopeKey: 'account-a', accountValue: 'account-key', contribution });
    const resolver = createVoiceCredentialResolver({ machineId: null });

    expect(resolver.status(identityFor(contribution))).toEqual({
      available: true,
      source: 'account',
      materialStatus: 'ready',
    });
    await expect(resolver.withSecret({
      identity: identityFor(contribution),
      use: async (secret) => secret,
    })).resolves.toBe('account-key');

    await expect(resolver.withSecret({
      identity: identityFor({ ...contribution, localId: 'google-cloud-tts' }),
      use: async (secret) => secret,
    })).rejects.toMatchObject({ code: 'credential_unavailable' });

    await expect(resolver.withSecret({
      identity: identityFor(contribution, 'other_slot'),
      use: async (secret) => secret,
    })).rejects.toMatchObject({ code: 'credential_unavailable' });
  });

  it.each(['none', 'connectedAccount'] as const)(
    'does not use a dormant SavedSecret binding when the selected source is %s',
    async (credentialSource) => {
      // The dormant SavedSecret reference is deliberately preserved by the
      // source mutation owner; a deselected source must still resolve nothing.
      publishQualified({
        scopeKey: 'account-a',
        accountValue: 'account-key',
        machineValue: 'machine-key',
        contribution: GOOGLE_STT_CONTRIBUTION,
        credentialSource,
      });
      const accountResolver = createVoiceCredentialResolver({ machineId: null });
      const machineResolver = createVoiceCredentialResolver({ machineId: 'machine_a' });

      expect(accountResolver.status(identityFor(GOOGLE_STT_CONTRIBUTION)))
        .toEqual({ available: false, source: null, materialStatus: 'missing' });
      expect(machineResolver.status(identityFor(GOOGLE_STT_CONTRIBUTION)))
        .toEqual({ available: false, source: null, materialStatus: 'missing' });
      await expect(accountResolver.withSecret({
        identity: identityFor(GOOGLE_STT_CONTRIBUTION),
        use: async (secret) => secret,
      })).rejects.toMatchObject({ code: 'credential_unavailable' });
      await expect(machineResolver.withSecret({
        identity: identityFor(GOOGLE_STT_CONTRIBUTION),
        use: async (secret) => secret,
      })).rejects.toMatchObject({ code: 'credential_unavailable' });
    },
  );

  it('fails closed when the binding, record, or decryptable value is unavailable', async () => {
    publishQualified({ scopeKey: 'account-a', accountValue: 'a-key', contribution: GOOGLE_STT_CONTRIBUTION });
    const resolver = createVoiceCredentialResolver({ machineId: 'machine_a' });
    await expect(resolver.withSecret({
      identity: identityFor({ pluginId: 'happier.voice.google', localId: 'google-cloud-tts' }),
      use: async () => undefined,
    }))
      .rejects.toMatchObject({ code: 'credential_unavailable' });
  });
});
