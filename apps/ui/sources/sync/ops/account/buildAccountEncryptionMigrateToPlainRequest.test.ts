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
import { encodeAutomationTemplateForTransport } from '@/sync/domains/automations/automationTemplateTransport';

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
  it('builds assert_empty directives when no connected services or automations exist', async () => {
    const credentials = createLegacyCredentials();

    const request = await buildAccountEncryptionMigrateToPlainRequest({
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
      credentials,
      expectedSettingsVersion: 7,
      settings: { schemaVersion: 2, backendEnabledById: {} } as any,
      connectedServiceProfiles: [{ serviceId: 'openai-codex', profileId: 'work' }],
      automations: [
        { id: 'auto_sensitive', templateCiphertext: sensitiveTemplateCiphertext },
        { id: 'auto_safe', templateCiphertext: safeTemplateCiphertext },
      ],
      fetchConnectedServiceCredentialSealed: async () => ({
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
      kind: 'plain',
      record: expect.objectContaining({ kind: 'oauth' }),
    }));

    expect(request.automations.action).toBe('migrate');
    if (request.automations.action !== 'migrate') throw new Error('expected migrate');
    expect(request.automations.templates).toHaveLength(2);

    const sensitive = request.automations.templates[0];
    assertObject(sensitive, 'sensitive automation template');
    expect(sensitive.automationId).toBe('auto_sensitive');
    expect(sensitive.templateCiphertext).toBe(sensitiveTemplateCiphertext);

    const safe = request.automations.templates[1];
    assertObject(safe, 'safe automation template');
    expect(safe.automationId).toBe('auto_safe');
    assertString(safe.templateCiphertext, 'safe automation templateCiphertext');
    const plainEnvelope = JSON.parse(safe.templateCiphertext);
    expect(plainEnvelope.kind).toBe('happier_automation_template_plain_v1');
  });

  it('unseals canonical machine-key-sealed saved secrets when migrating a legacy account to plain storage', async () => {
    const credentials = createLegacyCredentials();
    const recoverySecret = Buffer.from(credentials.secret, 'base64url');
    const machineKey = deriveAccountMachineKeyFromRecoverySecret(recoverySecret);
    const canonicalSettingsKey = deriveSettingsSecretsKeyV1(machineKey);

    const request = await buildAccountEncryptionMigrateToPlainRequest({
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
