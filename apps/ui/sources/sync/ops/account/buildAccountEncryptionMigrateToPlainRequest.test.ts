import { describe, expect, it } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
  buildConnectedServiceCredentialRecord,
  deriveAccountMachineKeyFromRecoverySecret,
  deriveSettingsSecretsKeyV1,
  encryptSecretStringV1,
  openConnectedServiceCredentialCiphertext,
  sealConnectedServiceCredentialCiphertext,
} from '@happier-dev/protocol';

import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';

import { buildAccountEncryptionMigrateToPlainRequest } from './buildAccountEncryptionMigrateToPlainRequest';

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
  expectedAccountVersion: 4,
  expectedSigningKeyFingerprint: 'aemk1_signing',
  expectedContentKeyFingerprint: 'aemk1_content',
} as const;
import { encodeAutomationTemplateForTransport } from '@/sync/domains/automations/automationTemplateTransport';
import { settingsParse } from '@/sync/domains/settings/settings';

function createLegacyCredentials(): Extract<AuthCredentials, { secret: string }> {
  return {
    token: 't',
    secret: Buffer.from(new Uint8Array(32).fill(4)).toString('base64url'),
  };
}

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

describe('buildAccountEncryptionMigrateToPlainRequest', () => {
  it('includes Account-owned new-session drafts in the atomic plain migration request', async () => {
    const credentials = createLegacyCredentials();
    const address = {
      kind: 'newSession' as const,
      draftId: '00000000-0000-4000-8000-000000000111',
    };
    const document = {
      v: 1 as const,
      composer: {
        text: { mutationId: '00000000-0000-4000-8000-000000000112', value: 'draft' },
        mentions: { mutationId: '00000000-0000-4000-8000-000000000113', value: [] },
        attachments: { mutationId: '00000000-0000-4000-8000-000000000114', value: [] },
      },
      target: { kind: 'newSession' as const, authoring: {} },
      extensions: {},
    };

    const request = await buildAccountEncryptionMigrateToPlainRequest({
      storageDirectives: EMPTY_STORAGE_DIRECTIVES,
      ...CURRENTNESS,
      credentials,
      expectedSettingsVersion: 7,
      settings: { schemaVersion: 2, backendEnabledById: {} } as any,
      connectedServiceProfiles: [],
      automations: [],
      sessionDrafts: [{ address, baseRevision: 8, document }],
      fetchConnectedServiceCredentialSealed: async () => {
        throw new Error('unexpected fetchConnectedServiceCredentialSealed');
      },
      decryptAutomationTemplateRaw: async () => {
        throw new Error('unexpected decryptAutomationTemplateRaw');
      },
    });

    expect(request.sessionDrafts).toEqual({
      items: [{
        address,
        expectedRevision: 8,
        content: { t: 'plain', v: { v: 1, address, document } },
      }],
    });
  });

  it('builds assert_empty directives when no connected services or automations exist', async () => {
    const credentials = createLegacyCredentials();

    const request = await buildAccountEncryptionMigrateToPlainRequest({
      storageDirectives: EMPTY_STORAGE_DIRECTIVES,
      ...CURRENTNESS,
      credentials,
      expectedSettingsVersion: 7,
      settings: { schemaVersion: 2, backendEnabledById: {} } as any,
      connectedServiceProfiles: [],
      automations: [],
      fetchConnectedServiceCredentialSealed: async () => {
        throw new Error('unexpected fetchConnectedServiceCredentialSealed');
      },
      decryptAutomationTemplateRaw: async () => {
        throw new Error('unexpected decryptAutomationTemplateRaw');
      },
    });

    expect(request.toMode).toBe('plain');
    expect(request.expectedSettingsVersion).toBe(7);
    expect(request.settingsContent?.t).toBe('plain');
    expect(request.connectedServices).toEqual({ action: 'assert_empty' });
    expect(request.automations).toEqual({ action: 'assert_empty' });
    expect(request.sessions).toEqual({ action: 'assert_empty' });
    expect(request.sessionDrafts).toBeUndefined();
  });

  it('includes the released legacy Voice adapter projection in plain full-settings migrations', async () => {
    const credentials = createLegacyCredentials();
    const recoverySecret = Buffer.from(credentials.secret, 'base64url');
    const settingsSecretsKey = deriveSettingsSecretsKeyV1(
      deriveAccountMachineKeyFromRecoverySecret(recoverySecret),
    );
    const elevenLabsDefaults = settingsParse({}).voice.providers[
      'happier.voice.elevenlabs/realtime-elevenlabs'
    ];
    if (!elevenLabsDefaults) throw new Error('expected ElevenLabs defaults');
    assertObject(elevenLabsDefaults.config, 'ElevenLabs default config');

    const request = await buildAccountEncryptionMigrateToPlainRequest({
      storageDirectives: EMPTY_STORAGE_DIRECTIVES,
      ...CURRENTNESS,
      credentials,
      expectedSettingsVersion: 7,
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
      fetchConnectedServiceCredentialSealed: async () => {
        throw new Error('unexpected fetchConnectedServiceCredentialSealed');
      },
      decryptAutomationTemplateRaw: async () => {
        throw new Error('unexpected decryptAutomationTemplateRaw');
      },
    });

    expect(request.settingsContent?.t).toBe('plain');
    if (!request.settingsContent || request.settingsContent.t !== 'plain') {
      throw new Error('expected plain settings content');
    }
    assertObject(request.settingsContent.v, 'plain settings');
    assertObject(request.settingsContent.v.voice, 'legacy voice projection');
    assertObject(request.settingsContent.v.voice.adapters, 'legacy voice adapters');
    assertObject(
      request.settingsContent.v.voice.adapters.realtime_elevenlabs,
      'legacy ElevenLabs adapter',
    );
    assertObject(
      request.settingsContent.v.voice.adapters.realtime_elevenlabs.byo,
      'legacy ElevenLabs BYO settings',
    );

    expect(request.settingsContent.v.voiceSettingsV1).toEqual(
      expect.objectContaining({
        providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
      }),
    );
    expect(request.settingsContent.v.voice.adapters.realtime_elevenlabs.byo.apiKey).toEqual({
      _isSecretValue: true,
      value: 'xi_migration_key',
    });
  });

  it('migrates connected service credentials and plaintext-safe automation templates to plain envelopes', async () => {
    const credentials = createLegacyCredentials();
    const material = resolveAccountScopedCryptoMaterialFromCredentials(credentials);

    const record = buildConnectedServiceCredentialRecord({
      now: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: 123,
      oauth: {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-1',
        providerEmail: null,
      },
    });

    const sealedCiphertext = sealConnectedServiceCredentialCiphertext({
      material,
      payload: record,
      randomBytes: () => new Uint8Array(24).fill(2),
    });

    // Sanity: opening yields the record.
    const opened = openConnectedServiceCredentialCiphertext({ material, ciphertext: sealedCiphertext });
    expect(opened).not.toBeNull();
    if (!opened) throw new Error('Expected opened credential');
    expect(opened.value).toEqual(expect.objectContaining({ kind: 'oauth' }));

    const sensitiveTemplateCiphertext = await encodeAutomationTemplateForTransport({
      accountMode: 'e2ee',
      template: {
        directory: '/tmp/project',
        prompt: 'Hi',
        existingSessionId: 's1',
        sessionEncryptionKeyBase64: 'dek',
        sessionEncryptionVariant: 'dataKey',
      },
      encryptRaw: async (value) => `cipher:${Buffer.from(JSON.stringify(value)).toString('base64')}`,
    });

    const safeTemplateCiphertext = await encodeAutomationTemplateForTransport({
      accountMode: 'e2ee',
      template: {
        directory: '/tmp/project',
        prompt: 'Hello',
        existingSessionId: 's2',
      },
      encryptRaw: async (value) => `cipher:${Buffer.from(JSON.stringify(value)).toString('base64')}`,
    });

    const request = await buildAccountEncryptionMigrateToPlainRequest({
      storageDirectives: EMPTY_STORAGE_DIRECTIVES,
      ...CURRENTNESS,
      credentials,
      expectedSettingsVersion: 7,
      settings: { schemaVersion: 2, backendEnabledById: {} } as any,
      connectedServiceProfiles: [{ serviceId: 'openai-codex', profileId: 'work' }],
      automations: [
        { id: 'auto_sensitive', templateVersion: 3, templateCiphertext: sensitiveTemplateCiphertext },
        { id: 'auto_safe', templateVersion: 5, templateCiphertext: safeTemplateCiphertext },
      ],
      fetchConnectedServiceCredentialSealed: async () => ({
        revisionSemantics: 'revisioned',
        credentialRevision: CREDENTIAL_REVISION,
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct-1', expiresAt: 123 },
      }),
      decryptAutomationTemplateRaw: async (payloadCiphertext) => {
        // See encodeAutomationTemplateForTransport above.
        const prefix = 'cipher:';
        const b64 = payloadCiphertext.startsWith(prefix) ? payloadCiphertext.slice(prefix.length) : payloadCiphertext;
        const json = Buffer.from(b64, 'base64').toString('utf8');
        return JSON.parse(json);
      },
    });

    expect(request.connectedServices.action).toBe('migrate');
    if (request.connectedServices.action !== 'migrate') throw new Error('expected migrate');
    expect(request.connectedServices.credentials).toHaveLength(1);
    expect(request.connectedServices.credentials[0]).toEqual(expect.objectContaining({
      serviceId: 'openai-codex',
      profileId: 'work',
      expectedCredentialRevision: CREDENTIAL_REVISION,
      kind: 'plain',
      record: expect.objectContaining({ kind: 'oauth' }),
    }));

    expect(request.automations.action).toBe('migrate');
    if (request.automations.action !== 'migrate') throw new Error('expected migrate');
    expect(request.automations.templates).toHaveLength(2);

    const sensitive = request.automations.templates[0];
    assertObject(sensitive, 'sensitive automation template');
    expect(sensitive.automationId).toBe('auto_sensitive');
    expect(sensitive.expectedTemplateVersion).toBe(3);
    expect(sensitive.templateCiphertext).toBe(sensitiveTemplateCiphertext);

    const safe = request.automations.templates[1];
    assertObject(safe, 'safe automation template');
    expect(safe.automationId).toBe('auto_safe');
    expect(safe.expectedTemplateVersion).toBe(5);
    assertString(safe.templateCiphertext, 'safe automation templateCiphertext');
    const plainEnvelope = JSON.parse(safe.templateCiphertext);
    expect(plainEnvelope.kind).toBe('happier_automation_template_plain_v1');
  });

  it('rejects a decrypted sealed credential whose embedded binding differs from the requested profile', async () => {
    const credentials = createLegacyCredentials();
    const material = resolveAccountScopedCryptoMaterialFromCredentials(credentials);
    const misboundRecord = buildConnectedServiceCredentialRecord({
      now: 1,
      serviceId: 'openai-codex',
      profileId: 'other',
      kind: 'token',
      token: { token: 'tok-foreign', providerAccountId: 'acct-1', providerEmail: null },
    });
    const sealedCiphertext = sealConnectedServiceCredentialCiphertext({
      material,
      payload: misboundRecord,
      randomBytes: () => new Uint8Array(24).fill(2),
    });

    await expect(buildAccountEncryptionMigrateToPlainRequest({
      storageDirectives: EMPTY_STORAGE_DIRECTIVES,
      ...CURRENTNESS,
      credentials,
      expectedSettingsVersion: 7,
      settings: { schemaVersion: 2, backendEnabledById: {} } as any,
      connectedServiceProfiles: [{ serviceId: 'openai-codex', profileId: 'work' }],
      automations: [],
      fetchConnectedServiceCredentialSealed: async () => ({
        revisionSemantics: 'revisioned',
        credentialRevision: CREDENTIAL_REVISION,
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'token', providerEmail: null, providerAccountId: 'acct-1', expiresAt: null },
      }),
      decryptAutomationTemplateRaw: async () => null,
    })).rejects.toMatchObject({ code: 'connected_service_credential_binding_mismatch' });
  });

  it('unseals canonical machine-key-sealed saved secrets when migrating a legacy account to plain storage', async () => {
    const credentials = createLegacyCredentials();
    const recoverySecret = Buffer.from(credentials.secret, 'base64url');
    const machineKey = deriveAccountMachineKeyFromRecoverySecret(recoverySecret);
    const canonicalSettingsKey = deriveSettingsSecretsKeyV1(machineKey);

    const request = await buildAccountEncryptionMigrateToPlainRequest({
      storageDirectives: EMPTY_STORAGE_DIRECTIVES,
      ...CURRENTNESS,
      credentials,
      expectedSettingsVersion: 9,
      settings: {
        schemaVersion: 2,
        backendEnabledById: {},
        secrets: [
          {
            id: 'sec1',
            name: 'Canonical Secret',
            kind: 'apiKey',
            encryptedValue: {
              _isSecretValue: true,
              encryptedValue: encryptSecretStringV1(
                'sk-canonical',
                canonicalSettingsKey,
                () => new Uint8Array(24).fill(8),
              ),
            },
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      } as any,
      connectedServiceProfiles: [],
      automations: [],
      fetchConnectedServiceCredentialSealed: async () => {
        throw new Error('unexpected fetchConnectedServiceCredentialSealed');
      },
      decryptAutomationTemplateRaw: async () => {
        throw new Error('unexpected decryptAutomationTemplateRaw');
      },
    });

    expect(request.settingsContent?.t).toBe('plain');
    if (!request.settingsContent || request.settingsContent.t !== 'plain') {
      throw new Error('expected plain settings content');
    }
    expect((request.settingsContent.v as any)?.secrets?.[0]?.encryptedValue?.value).toBe('sk-canonical');
  });
});
