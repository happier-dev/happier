import { describe, expect, it } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
  buildConnectedServiceCredentialRecord,
  deriveAccountMachineKeyFromRecoverySecret,
  deriveSettingsSecretsKeyV1,
  encryptSecretStringV1,
  openAccountScopedBlobCiphertext,
  openConnectedServiceCredentialCiphertext,
} from '@happier-dev/protocol';

import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { encodeAutomationTemplateForTransport } from '@/sync/domains/automations/automationTemplateTransport';
import { settingsParse } from '@/sync/domains/settings/settings';

import { buildAccountEncryptionMigrateToE2eeRequest } from './buildAccountEncryptionMigrateToE2eeRequest';

function createLegacyCredentials(): Extract<AuthCredentials, { secret: string }> {
  return {
    token: 't',
    secret: Buffer.from(new Uint8Array(32).fill(9)).toString('base64url'),
  };
}

const CONTENT_KEY_PROOF = {
  publicKey: 'account-public-key',
  challenge: 'challenge',
  signature: 'challenge-signature',
  contentPublicKey: 'content-public-key',
  contentPublicKeySig: 'content-public-key-signature',
} as const;

function assertObject(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new Error(`Expected ${name} to be an object`);
  }
}

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error(`Expected ${name} to be a string`);
  }
}

describe('buildAccountEncryptionMigrateToE2eeRequest', () => {
  it('builds assert_empty directives when no connected services or automations exist', async () => {
    const credentials = createLegacyCredentials();

    const request = await buildAccountEncryptionMigrateToE2eeRequest({
      credentials,
      keyProof: CONTENT_KEY_PROOF,
      expectedSettingsVersion: 1,
      settings: { schemaVersion: 2, backendEnabledById: {} } as any,
      connectedServiceProfiles: [],
      automations: [],
      fetchConnectedServiceCredentialPlain: async () => {
        throw new Error('unexpected fetchConnectedServiceCredentialPlain');
      },
    });

    expect(request.toMode).toBe('e2ee');
    expect(request.connectedServices).toEqual({ action: 'assert_empty' });
    expect(request.automations).toEqual({ action: 'assert_empty' });
    expect(request.settingsContent?.t).toBe('encrypted');
    expect(request.keyProof).toEqual(CONTENT_KEY_PROOF);
    expect(typeof (request.settingsContent as any).c).toBe('string');
    expect(request).not.toHaveProperty('sessions');
  });

  it('includes the released legacy Voice adapter projection in encrypted full-settings migrations', async () => {
    const credentials = createLegacyCredentials();
    const material = resolveAccountScopedCryptoMaterialFromCredentials(credentials);
    const recoverySecret = Buffer.from(credentials.secret, 'base64url');
    const settingsSecretsKey = deriveSettingsSecretsKeyV1(
      deriveAccountMachineKeyFromRecoverySecret(recoverySecret),
    );
    const elevenLabsDefaults = settingsParse({}).voice.providers.realtime_elevenlabs;
    if (!elevenLabsDefaults) throw new Error('expected ElevenLabs defaults');
    assertObject(elevenLabsDefaults.config, 'ElevenLabs default config');
    assertObject(elevenLabsDefaults.config.byo, 'ElevenLabs default BYO config');

    const request = await buildAccountEncryptionMigrateToE2eeRequest({
      credentials,
      keyProof: CONTENT_KEY_PROOF,
      expectedSettingsVersion: 1,
      settings: settingsParse({
        secrets: [{
          id: 'voice-elevenlabs-secret',
          name: 'Voice ElevenLabs',
          kind: 'apiKey',
          encryptedValue: {
            _isSecretValue: true,
            encryptedValue: encryptSecretStringV1(
              'xi_migration_key',
              settingsSecretsKey,
              () => new Uint8Array(24).fill(8),
            ),
          },
          createdAt: 1,
          updatedAt: 1,
        }],
        voice: {
          providerId: 'realtime_elevenlabs',
          credentialBindings: [{
            providerId: 'realtime_elevenlabs',
            credentialBindings: { account: { api_key: 'voice-elevenlabs-secret' } },
          }],
          providers: {
            realtime_elevenlabs: {
              schemaVersion: 2,
              config: {
                ...elevenLabsDefaults.config,
                billingMode: 'byo',
                byo: { ...elevenLabsDefaults.config.byo, agentId: 'agent_1' },
              },
            },
          },
        },
      }),
      connectedServiceProfiles: [],
      automations: [],
      fetchConnectedServiceCredentialPlain: async () => {
        throw new Error('unexpected fetchConnectedServiceCredentialPlain');
      },
    });

    expect(request.settingsContent?.t).toBe('encrypted');
    if (!request.settingsContent || request.settingsContent.t !== 'encrypted') {
      throw new Error('expected encrypted settings content');
    }
    const openedSettings = openAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material,
      ciphertext: request.settingsContent.c,
    });
    expect(openedSettings).not.toBeNull();
    if (!openedSettings) throw new Error('expected opened settings');
    assertObject(openedSettings.value, 'opened settings');
    assertObject(openedSettings.value.voice, 'legacy voice projection');
    assertObject(openedSettings.value.voice.adapters, 'legacy voice adapters');
    assertObject(
      openedSettings.value.voice.adapters.realtime_elevenlabs,
      'legacy ElevenLabs adapter',
    );
    assertObject(
      openedSettings.value.voice.adapters.realtime_elevenlabs.byo,
      'legacy ElevenLabs BYO settings',
    );

    expect(openedSettings.value.voiceSettingsV1).toEqual(
      expect.objectContaining({ providerId: 'realtime_elevenlabs' }),
    );
    expect(openedSettings.value.voice.adapters.realtime_elevenlabs.byo.apiKey).toHaveProperty(
      'encryptedValue',
    );
    expect(openedSettings.value.voice.adapters.realtime_elevenlabs.byo.apiKey).not.toHaveProperty(
      'value',
    );
  });

  it('migrates plaintext connected service credentials and automations to encrypted envelopes', async () => {
    const credentials = createLegacyCredentials();
    const material = resolveAccountScopedCryptoMaterialFromCredentials(credentials);

    const record = buildConnectedServiceCredentialRecord({
      now: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'token',
      token: {
        token: 'tok-1',
        providerAccountId: 'acct-1',
        providerEmail: 'x@example.com',
      },
    });

    const plainTemplateCiphertext = await encodeAutomationTemplateForTransport({
      accountMode: 'plain',
      template: {
        directory: '/tmp/project',
        prompt: 'Hi',
        existingSessionId: 's1',
      },
    });

    const request = await buildAccountEncryptionMigrateToE2eeRequest({
      credentials,
      keyProof: CONTENT_KEY_PROOF,
      expectedSettingsVersion: 1,
      settings: { schemaVersion: 2, backendEnabledById: {}, pushEnabled: true } as any,
      connectedServiceProfiles: [{ serviceId: 'openai-codex', profileId: 'work' }],
      automations: [{ id: 'auto_1', templateCiphertext: plainTemplateCiphertext }],
      fetchConnectedServiceCredentialPlain: async () => ({ content: { t: 'plain', v: record } }),
    });

    expect(request.connectedServices.action).toBe('migrate');
    if (request.connectedServices.action !== 'migrate') throw new Error('expected migrate');
    expect(request.connectedServices.credentials).toHaveLength(1);
    const cred = request.connectedServices.credentials[0];
    assertObject(cred, 'connected service credential');
    expect(cred.kind).toBe('sealed');
    assertObject(cred.sealed, 'sealed connected service credential');
    expect(cred.sealed.format).toBe('account_scoped_v1');
    assertString(cred.sealed.ciphertext, 'sealed ciphertext');

    const openedCred = openConnectedServiceCredentialCiphertext({
      material,
      ciphertext: cred.sealed.ciphertext,
    });
    expect(openedCred).not.toBeNull();
    if (!openedCred) throw new Error('Expected opened credential');
    expect(openedCred.value).toEqual(expect.objectContaining({ kind: 'token' }));

    expect(request.settingsContent?.t).toBe('encrypted');
    const openedSettings = openAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material,
      ciphertext: (request.settingsContent as any).c,
    });
    expect(openedSettings?.value).toEqual(expect.objectContaining({ pushEnabled: true }));

    expect(request.automations.action).toBe('migrate');
    if (request.automations.action !== 'migrate') throw new Error('expected migrate');
    const template = request.automations.templates[0];
    assertObject(template, 'automation template');
    assertString(template.templateCiphertext, 'automation templateCiphertext');
    const envelope = JSON.parse(template.templateCiphertext);
    expect(envelope.kind).toBe('happier_automation_template_encrypted_v1');
  });

  it('rejects a fetched plaintext credential whose embedded binding differs from the requested profile', async () => {
    const credentials = createLegacyCredentials();
    const misboundRecord = buildConnectedServiceCredentialRecord({
      now: 1,
      serviceId: 'openai-codex',
      profileId: 'other',
      kind: 'token',
      token: { token: 'tok-foreign', providerAccountId: 'acct-1', providerEmail: null },
    });

    await expect(buildAccountEncryptionMigrateToE2eeRequest({
      credentials,
      keyProof: CONTENT_KEY_PROOF,
      expectedSettingsVersion: 1,
      settings: { schemaVersion: 2, backendEnabledById: {} } as any,
      connectedServiceProfiles: [{ serviceId: 'openai-codex', profileId: 'work' }],
      automations: [],
      fetchConnectedServiceCredentialPlain: async () => ({ content: { t: 'plain', v: misboundRecord } }),
    })).rejects.toMatchObject({ code: 'connected_service_credential_binding_mismatch' });
  });
});
