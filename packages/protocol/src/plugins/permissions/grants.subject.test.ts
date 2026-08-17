import { describe, expect, it } from 'vitest';

import {
  CredentialAccessDeclarationDigestSchema,
  GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
  PluginCredentialAccessSlotIdSchema,
  PluginInstallReviewPrincipalDigestSchema,
  PluginPermissionGrantRequestActionInputV1Schema,
  PluginPermissionGrantV1Schema,
  PluginPermissionSubjectV1Schema,
} from '../../index.js';

const digest = 'a'.repeat(64);

const credentialSubject = {
  kind: 'credential_access_disclosure',
  contribution: {
    pluginId: 'happier.voice.openai',
    localId: 'openai-realtime',
  },
  credentialSlotId: 'api-key.primary',
  purpose: 'voice-session',
  accessDeclarationDigest: digest,
  selectedAuthorityDigest: 'c'.repeat(64),
  selectedRawAccessDigest: 'd'.repeat(64),
  installedGenerationId: 'generation-1',
  installReviewPrincipalDigest: 'b'.repeat(64),
} as const;

describe('plugin permission grant subjects', () => {
  it('accepts only strict general and credential-access subjects', () => {
    expect(PluginPermissionSubjectV1Schema.parse(GENERAL_PLUGIN_PERMISSION_SUBJECT_V1))
      .toEqual({ kind: 'general' });
    expect(PluginPermissionSubjectV1Schema.parse(credentialSubject)).toEqual(credentialSubject);
    expect(PluginPermissionSubjectV1Schema.safeParse({ kind: 'general', credentialSlotId: 'extra' }).success)
      .toBe(false);
  });

  it('uses canonical bounded record keys and lowercase sha256 digests', () => {
    expect(PluginCredentialAccessSlotIdSchema.parse('api-key.primary')).toBe('api-key.primary');
    for (const invalid of [' api-key', 'api key', '__proto__', 'constructor', 'A'.repeat(129)]) {
      expect(PluginCredentialAccessSlotIdSchema.safeParse(invalid).success).toBe(false);
    }
    expect(CredentialAccessDeclarationDigestSchema.parse(digest)).toBe(digest);
    expect(PluginInstallReviewPrincipalDigestSchema.parse('b'.repeat(64))).toBe('b'.repeat(64));
    expect(CredentialAccessDeclarationDigestSchema.safeParse('A'.repeat(64)).success).toBe(false);
    expect(PluginInstallReviewPrincipalDigestSchema.safeParse('b'.repeat(63)).success).toBe(false);
  });

  it('requires a subject on grant records and grant requests', () => {
    const grant = {
      v: 1,
      id: 'grant-1',
      accountId: 'account-1',
      pluginId: 'happier.voice.openai',
      capability: 'credentials.materialize.raw',
      targetScope: { kind: 'account' },
      authoritySource: { kind: 'bundled' },
      status: 'active',
      grantedByUserId: 'user-1',
      grantedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    expect(PluginPermissionGrantV1Schema.safeParse(grant).success).toBe(false);
    expect(PluginPermissionGrantV1Schema.parse({ ...grant, subject: credentialSubject }).subject)
      .toEqual(credentialSubject);

    const request = {
      pluginId: grant.pluginId,
      capability: grant.capability,
      targetScope: grant.targetScope,
      requester: { kind: 'plugin', pluginId: grant.pluginId },
      reason: 'Use the selected credential for this contribution.',
    };
    expect(PluginPermissionGrantRequestActionInputV1Schema.safeParse(request).success).toBe(false);
    expect(PluginPermissionGrantRequestActionInputV1Schema.parse({
      ...request,
      subject: credentialSubject,
    }).subject).toEqual(credentialSubject);
  });
});
