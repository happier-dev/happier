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
  it('reseals exact server-backed new-session drafts with the target Account material', async () => {
    const credentials = createLegacyCredentials();
    const material = resolveAccountScopedCryptoMaterialFromCredentials(credentials);
    const address = { kind: 'newSession', draftId: '00000000-0000-4000-8000-000000000101' } as const;
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
      credentials,
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
  });

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
    expect(request.sessionDrafts).toBeUndefined();
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
      expectedSettingsVersion: 1,
      settings: { schemaVersion: 2, backendEnabledById: {} } as any,
      connectedServiceProfiles: [{ serviceId: 'openai-codex', profileId: 'work' }],
      automations: [],
      fetchConnectedServiceCredentialPlain: async () => ({ content: { t: 'plain', v: misboundRecord } }),
    })).rejects.toMatchObject({ code: 'connected_service_credential_binding_mismatch' });
  });
});
