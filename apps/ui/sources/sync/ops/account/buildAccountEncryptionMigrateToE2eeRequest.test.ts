import { describe, expect, it } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
  buildConnectedServiceCredentialRecord,
  openAccountScopedBlobCiphertext,
  openConnectedServiceCredentialCiphertext,
} from '@happier-dev/protocol';

import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { encodeAutomationTemplateForTransport } from '@/sync/domains/automations/automationTemplateTransport';

import { buildAccountEncryptionMigrateToE2eeRequest } from './buildAccountEncryptionMigrateToE2eeRequest';

function createLegacyCredentials(): AuthCredentials {
  return {
    token: 't',
    secret: Buffer.from(new Uint8Array(32).fill(9)).toString('base64url'),
  } as any;
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

describe('buildAccountEncryptionMigrateToE2eeRequest', () => {
  it('builds assert_empty directives when no connected services or automations exist', async () => {
    const credentials = createLegacyCredentials();

    const request = await buildAccountEncryptionMigrateToE2eeRequest({
      credentials,
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
    expect(typeof (request.settingsContent as any).c).toBe('string');
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
});
