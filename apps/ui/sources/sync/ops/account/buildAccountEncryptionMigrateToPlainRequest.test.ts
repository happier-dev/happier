import { describe, expect, it } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
  buildConnectedServiceCredentialRecord,
  openConnectedServiceCredentialCiphertext,
  sealConnectedServiceCredentialCiphertext,
} from '@happier-dev/protocol';

import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';

import { buildAccountEncryptionMigrateToPlainRequest } from './buildAccountEncryptionMigrateToPlainRequest';
import { encodeAutomationTemplateForTransport } from '@/sync/domains/automations/automationTemplateTransport';

function createLegacyCredentials(): AuthCredentials {
  return {
    token: 't',
    secret: Buffer.from(new Uint8Array(32).fill(4)).toString('base64url'),
  } as any;
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

  it('migrates connected service credentials and automation templates to plain envelopes', async () => {
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
    expect(opened.value).toEqual(expect.objectContaining({ kind: 'oauth' }));

    const encryptedTemplateCiphertext = await encodeAutomationTemplateForTransport({
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

    const request = await buildAccountEncryptionMigrateToPlainRequest({
      credentials,
      expectedSettingsVersion: 7,
      settings: { schemaVersion: 2, backendEnabledById: {} } as any,
      connectedServiceProfiles: [{ serviceId: 'openai-codex', profileId: 'work' }],
      automations: [{ id: 'auto_1', templateCiphertext: encryptedTemplateCiphertext }],
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
    expect(request.automations.templates).toHaveLength(1);
    const plainEnvelope = JSON.parse(String(request.automations.templates[0]!.templateCiphertext));
    expect(plainEnvelope.kind).toBe('happier_automation_template_plain_v1');
  });
});
