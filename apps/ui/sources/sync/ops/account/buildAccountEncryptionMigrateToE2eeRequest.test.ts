import { describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
  buildConnectedServiceCredentialRecord,
  deriveAccountMachineKeyFromRecoverySecret,
  deriveSettingsSecretsKeyV1,
  encryptSecretStringV1,
  createAccountEncryptionMigrateProofSigningInputV1,
  openAccountScopedBlobCiphertext,
  openConnectedServiceCredentialCiphertext,
} from '@happier-dev/protocol';

import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { encodeAutomationTemplateForTransport } from '@/sync/domains/automations/automationTemplateTransport';
import { settingsParse } from '@/sync/domains/settings/settings';

import { buildAccountEncryptionMigrateToE2eeRequest } from './buildAccountEncryptionMigrateToE2eeRequest';

const EMPTY_STORAGE_DIRECTIVES = {
  machines: { action: 'assert_empty' as const },
  todos: { action: 'assert_empty' as const },
  artifacts: { action: 'assert_empty' as const },
  sessions: { action: 'assert_empty' as const },
  reviewComments: { action: 'assert_empty' as const },
  sessionOrganization: { action: 'assert_empty' as const },
  pets: { action: 'assert_empty' as const },
};
const CREDENTIAL_REVISION =
  'csr_0123456789ABCDEFGHJKMNPQRS';
const CURRENTNESS = {
  accountId: 'account-1',
  expectedAccountVersion: 4,
  expectedSigningKeyFingerprint: null,
  expectedContentKeyFingerprint: null,
} as const;

function createLegacyCredentials(): Extract<AuthCredentials, { secret: string }> {
  return {
    token: 't',
    secret: Buffer.from(new Uint8Array(32).fill(9)).toString('base64url'),
  };
}

const CONTENT_KEY_PROOF = {
  v: 1 as const,
  publicKey: Buffer.from(new Uint8Array(32).fill(1)).toString('base64'),
  contentPublicKey: Buffer.from(new Uint8Array(32).fill(2)).toString('base64'),
  contentPublicKeySig: 'content-public-key-signature',
  sign: () => 'request-signature',
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
  it('includes Account-owned new-session drafts in the signed atomic e2ee migration request', async () => {
    const credentials = createLegacyCredentials();
    const material = resolveAccountScopedCryptoMaterialFromCredentials(credentials);
    const sign = vi.fn(() => 'request-signature');
    const address = {
      kind: 'newSession' as const,
      draftId: '00000000-0000-4000-8000-000000000101',
    };
    const document = {
      v: 1 as const,
      composer: {
        text: { mutationId: '00000000-0000-4000-8000-000000000102', value: 'draft' },
        mentions: { mutationId: '00000000-0000-4000-8000-000000000103', value: [] },
        attachments: { mutationId: '00000000-0000-4000-8000-000000000104', value: [] },
      },
      target: { kind: 'newSession' as const, authoring: {} },
      extensions: {},
    };

    const request = await buildAccountEncryptionMigrateToE2eeRequest({
      storageDirectives: EMPTY_STORAGE_DIRECTIVES,
      ...CURRENTNESS,
      credentials,
      keyProof: { ...CONTENT_KEY_PROOF, sign },
      expectedSettingsVersion: 1,
      settings: { schemaVersion: 2, backendEnabledById: {} } as any,
      connectedServiceProfiles: [],
      automations: [],
      sessionDrafts: [{ address, baseRevision: 7, document }],
      fetchConnectedServiceCredentialPlain: async () => {
        throw new Error('unexpected fetchConnectedServiceCredentialPlain');
      },
    });

    expect(request.sessionDrafts?.items).toHaveLength(1);
    const item = request.sessionDrafts!.items[0];
    expect(item).toMatchObject({ address, expectedRevision: 7, content: { t: 'encrypted' } });
    if (item.content.t !== 'encrypted') throw new Error('expected encrypted draft');
    expect(openAccountScopedBlobCiphertext({
      kind: 'account_session_draft_private_payload',
      material,
      ciphertext: item.content.c,
    })?.value).toEqual({ v: 1, address, document });
    expect(sign).toHaveBeenCalledWith(
      createAccountEncryptionMigrateProofSigningInputV1({
        request,
        accountId: CURRENTNESS.accountId,
        sourceMode: 'plain',
      }),
    );
  });

  it('builds assert_empty directives when no connected services or automations exist', async () => {
    const credentials = createLegacyCredentials();
    const sign = vi.fn(() => 'request-signature');

    const request = await buildAccountEncryptionMigrateToE2eeRequest({
      storageDirectives: EMPTY_STORAGE_DIRECTIVES,
      ...CURRENTNESS,
      credentials,
      keyProof: {
        ...CONTENT_KEY_PROOF,
        sign,
      },
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
    expect(request.keyProof).toEqual({
      v: 1,
      publicKey: CONTENT_KEY_PROOF.publicKey,
      signature: 'request-signature',
      contentPublicKey: CONTENT_KEY_PROOF.contentPublicKey,
      contentPublicKeySig: CONTENT_KEY_PROOF.contentPublicKeySig,
    });
    expect(typeof (request.settingsContent as any).c).toBe('string');
    expect(request.sessions).toEqual({ action: 'assert_empty' });
    expect(request.sessionDrafts).toBeUndefined();
    expect(sign).toHaveBeenCalledWith(
      createAccountEncryptionMigrateProofSigningInputV1({
        request,
        accountId: CURRENTNESS.accountId,
        sourceMode: 'plain',
      }),
    );
  });

  it('includes the released legacy Voice adapter projection in encrypted full-settings migrations', async () => {
    const credentials = createLegacyCredentials();
    const material = resolveAccountScopedCryptoMaterialFromCredentials(credentials);
    const recoverySecret = Buffer.from(credentials.secret, 'base64url');
    const settingsSecretsKey = deriveSettingsSecretsKeyV1(
      deriveAccountMachineKeyFromRecoverySecret(recoverySecret),
    );
    const elevenLabsDefaults = settingsParse({}).voice.providers[
      'happier.voice.elevenlabs/realtime-elevenlabs'
    ];
    if (!elevenLabsDefaults) throw new Error('expected ElevenLabs defaults');
    assertObject(elevenLabsDefaults.config, 'ElevenLabs default config');

    const request = await buildAccountEncryptionMigrateToE2eeRequest({
      storageDirectives: EMPTY_STORAGE_DIRECTIVES,
      ...CURRENTNESS,
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
            'happier.voice.elevenlabs/realtime-elevenlabs': {
              schemaVersion: 2,
              config: {
                ...elevenLabsDefaults.config,
                billingMode: 'byo',
                agentId: 'agent_1',
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
      expect.objectContaining({
        providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
      }),
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
      storageDirectives: EMPTY_STORAGE_DIRECTIVES,
      ...CURRENTNESS,
      credentials,
      keyProof: CONTENT_KEY_PROOF,
      expectedSettingsVersion: 1,
      settings: { schemaVersion: 2, backendEnabledById: {}, pushEnabled: true } as any,
      connectedServiceProfiles: [{ serviceId: 'openai-codex', profileId: 'work' }],
      automations: [{ id: 'auto_1', templateVersion: 6, templateCiphertext: plainTemplateCiphertext }],
      fetchConnectedServiceCredentialPlain: async () => ({
        revisionSemantics: 'revisioned',
        credentialRevision: CREDENTIAL_REVISION,
        content: { t: 'plain', v: record },
      }),
    });

    expect(request.connectedServices.action).toBe('migrate');
    if (request.connectedServices.action !== 'migrate') throw new Error('expected migrate');
    expect(request.connectedServices.credentials).toHaveLength(1);
    const cred = request.connectedServices.credentials[0];
    assertObject(cred, 'connected service credential');
    expect(cred.kind).toBe('sealed');
    expect(cred.expectedCredentialRevision).toBe(
      CREDENTIAL_REVISION,
    );
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
    expect(template.expectedTemplateVersion).toBe(6);
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
      storageDirectives: EMPTY_STORAGE_DIRECTIVES,
      ...CURRENTNESS,
      credentials,
      keyProof: CONTENT_KEY_PROOF,
      expectedSettingsVersion: 1,
      settings: { schemaVersion: 2, backendEnabledById: {} } as any,
      connectedServiceProfiles: [{ serviceId: 'openai-codex', profileId: 'work' }],
      automations: [],
      fetchConnectedServiceCredentialPlain: async () => ({
        revisionSemantics: 'revisioned',
        credentialRevision: CREDENTIAL_REVISION,
        content: { t: 'plain', v: misboundRecord },
      }),
    })).rejects.toMatchObject({ code: 'connected_service_credential_binding_mismatch' });
  });
});
