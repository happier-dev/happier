import { afterEach, describe, expect, it } from 'vitest';

import {
  VoiceCredentialBindingIdentityV1Schema,
  type VoiceCredentialBindingIdentityV1,
} from '@happier-dev/protocol';

import {
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
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
}>) {
  const credentialSlotId = params.credentialSlotId ?? 'api_key';
  setActiveAccountSettingsSnapshot({
    source: 'network', scopeKey: params.scopeKey, settingsVersion: 1, loadedAtMs: 1,
    settingsSecretsReadKeys: [],
    settings: {
      secrets: [
        { id: `${params.scopeKey}-account`, name: 'Account key', kind: 'apiKey', encryptedValue: { _isSecretValue: true, value: params.accountValue } },
        ...(params.machineValue
          ? [{ id: `${params.scopeKey}-machine`, name: 'Machine key', kind: 'apiKey', encryptedValue: { _isSecretValue: true, value: params.machineValue } }]
          : []),
      ],
      voiceSettingsV1: {
        credentialBindings: [{
          contribution: params.contribution,
          credentialSlotId,
          credentialSource: { kind: params.credentialSource ?? 'savedSecret' },
          credentialBindings: {
            account: { [credentialSlotId]: `${params.scopeKey}-account` },
            ...(params.machineValue
              ? { byMachineId: { machine_a: { [credentialSlotId]: `${params.scopeKey}-machine` } } }
              : {}),
          },
        }],
      },
      ...(params.credentialSource === 'connectedAccount'
        ? {
            connectedAccountPurposeBindingsV1: {
              v: 1,
              bindings: [{
                purpose: { consumer: params.contribution, purpose: 'voice.client-auth' },
                target: {
                  kind: 'account',
                  account: {
                    service: { pluginId: 'happier.agent.openai', localId: 'openai' },
                    accountId: 'openai-account',
                  },
                },
              }],
            },
          }
        : {}),
    } as never,
  });
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

    expect(resolver.status(legacyProvider)).toEqual({ available: false, source: null });
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

  it('fails an in-flight use when the active account snapshot changes', async () => {
    const resolver = createVoiceCredentialResolver({ machineId: null });
    publishQualified({ scopeKey: 'account-a', accountValue: 'a-key', contribution: GOOGLE_STT_CONTRIBUTION });
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
    publishQualified({ scopeKey: 'account-b', accountValue: 'b-key', contribution: GOOGLE_STT_CONTRIBUTION });
    releaseUse();

    await expect(operation).rejects.toMatchObject({ code: 'credential_unavailable' });
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
    });
    await expect(resolver.withSecret({
      identity: identityFor(GOOGLE_STT_CONTRIBUTION),
      use: async (secret) => secret,
    })).resolves.toBe('account-key');
  });

  it('resolves canonical bindings only for the exact qualified contribution and declared slot', async () => {
    const contribution = GOOGLE_STT_CONTRIBUTION;
    publishQualified({ scopeKey: 'account-a', accountValue: 'account-key', contribution });
    const resolver = createVoiceCredentialResolver({ machineId: null });

    expect(resolver.status(identityFor(contribution))).toEqual({ available: true, source: 'account' });
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
        .toEqual({ available: false, source: null });
      expect(machineResolver.status(identityFor(GOOGLE_STT_CONTRIBUTION)))
        .toEqual({ available: false, source: null });
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
