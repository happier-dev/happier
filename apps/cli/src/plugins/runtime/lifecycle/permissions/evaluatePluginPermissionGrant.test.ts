import { describe, expect, it } from 'vitest';

import {
  CredentialAccessDeclarationDigestSchema,
  CredentialAccessSelectedAuthorityDigestSchema,
  CredentialAccessSelectedRawAccessDigestSchema,
  GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
  PluginCredentialAccessSlotIdSchema,
  PluginInstallReviewPrincipalDigestSchema,
  PluginPermissionInstalledGenerationIdSchema,
  type PluginPermissionGrantAuthoritySourceV1,
  type PluginPermissionGrantV1,
  type PluginPermissionSubjectV1,
} from '@happier-dev/protocol';

import { evaluatePluginPermissionGrant } from './evaluatePluginPermissionGrant';

const currentPrincipal = PluginInstallReviewPrincipalDigestSchema.parse('a'.repeat(64));

const machineA = {
  kind: 'machine_installation',
  machineId: 'machine-1',
  installationId: 'installation-1',
} as const satisfies PluginPermissionGrantAuthoritySourceV1;
const machineB = {
  kind: 'machine_installation',
  machineId: 'machine-2',
  installationId: 'installation-2',
} as const satisfies PluginPermissionGrantAuthoritySourceV1;
const replacedInstallationOnMachineA = {
  kind: 'machine_installation',
  machineId: 'machine-1',
  installationId: 'installation-2',
} as const satisfies PluginPermissionGrantAuthoritySourceV1;

function grant(
  subject: PluginPermissionSubjectV1,
  authoritySource: PluginPermissionGrantAuthoritySourceV1 = machineA,
): PluginPermissionGrantV1 {
  return {
    v: 1,
    id: 'grant-1',
    accountId: 'account-1',
    pluginId: 'happier.voice.openai',
    capability: subject.kind === 'general'
      ? 'reviews.comments.write.direct'
      : 'credentials.materialize.raw',
    targetScope: { kind: 'account' },
    subject,
    authoritySource,
    status: 'active',
    grantedByUserId: 'user-1',
    grantedAt: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

const credentialSubject = {
  kind: 'credential_access_disclosure',
  contribution: { pluginId: 'happier.voice.openai', localId: 'openai-realtime' },
  credentialSlotId: PluginCredentialAccessSlotIdSchema.parse('api-key'),
  purpose: 'voice-session',
  accessDeclarationDigest: CredentialAccessDeclarationDigestSchema.parse('b'.repeat(64)),
  selectedAuthorityDigest: CredentialAccessSelectedAuthorityDigestSchema.parse('c'.repeat(64)),
  selectedRawAccessDigest: CredentialAccessSelectedRawAccessDigestSchema.parse('d'.repeat(64)),
  installedGenerationId: PluginPermissionInstalledGenerationIdSchema.parse('generation-1'),
  installReviewPrincipalDigest: currentPrincipal,
} as const satisfies PluginPermissionSubjectV1;

describe('plugin permission grant evaluator', () => {
  it('matches ordinary general grants without install-principal coupling', () => {
    const existing = grant(GENERAL_PLUGIN_PERMISSION_SUBJECT_V1);
    expect(evaluatePluginPermissionGrant({
      grant: existing,
      pluginId: existing.pluginId,
      capability: existing.capability,
      targetScope: existing.targetScope,
      subject: GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
      currentAuthoritySource: machineA,
    })).toBe(true);
  });

  it('requires exact credential subject and the current install-review principal', () => {
    const existing = grant(credentialSubject);
    const base = {
      grant: existing,
      pluginId: existing.pluginId,
      capability: existing.capability,
      targetScope: existing.targetScope,
      subject: credentialSubject,
      currentInstallReviewPrincipalDigest: currentPrincipal,
      currentAuthoritySource: machineA,
    } as const;

    expect(evaluatePluginPermissionGrant(base)).toBe(true);
    expect(evaluatePluginPermissionGrant({
      ...base,
      currentInstallReviewPrincipalDigest: PluginInstallReviewPrincipalDigestSchema.parse('c'.repeat(64)),
    })).toBe(false);
    expect(evaluatePluginPermissionGrant({
      ...base,
      subject: {
        ...credentialSubject,
        accessDeclarationDigest: CredentialAccessDeclarationDigestSchema.parse('d'.repeat(64)),
      },
    })).toBe(false);
    expect(evaluatePluginPermissionGrant({
      ...base,
      subject: {
        ...credentialSubject,
        selectedAuthorityDigest: CredentialAccessSelectedAuthorityDigestSchema.parse('e'.repeat(64)),
      },
    })).toBe(false);
    expect(evaluatePluginPermissionGrant({
      ...base,
      subject: {
        ...credentialSubject,
        selectedRawAccessDigest: CredentialAccessSelectedRawAccessDigestSchema.parse('f'.repeat(64)),
      },
    })).toBe(false);
    expect(evaluatePluginPermissionGrant({
      ...base,
      subject: {
        ...credentialSubject,
        installedGenerationId: PluginPermissionInstalledGenerationIdSchema.parse('generation-2'),
      },
    })).toBe(false);
  });

  it('refuses a grant approved under another machine or a replaced installation', () => {
    const approvedOnMachineA = grant(credentialSubject, machineA);
    const base = {
      grant: approvedOnMachineA,
      pluginId: approvedOnMachineA.pluginId,
      capability: approvedOnMachineA.capability,
      targetScope: approvedOnMachineA.targetScope,
      subject: credentialSubject,
      currentInstallReviewPrincipalDigest: currentPrincipal,
    } as const;

    expect(evaluatePluginPermissionGrant({ ...base, currentAuthoritySource: machineA })).toBe(true);
    expect(evaluatePluginPermissionGrant({ ...base, currentAuthoritySource: machineB })).toBe(false);
    expect(evaluatePluginPermissionGrant({
      ...base,
      currentAuthoritySource: replacedInstallationOnMachineA,
    })).toBe(false);
    expect(evaluatePluginPermissionGrant({ ...base, currentAuthoritySource: null })).toBe(false);
    expect(evaluatePluginPermissionGrant({
      ...base,
      currentAuthoritySource: { kind: 'bundled' },
    })).toBe(false);
    expect(evaluatePluginPermissionGrant({
      grant: grant(credentialSubject, { kind: 'bundled' }),
      pluginId: approvedOnMachineA.pluginId,
      capability: approvedOnMachineA.capability,
      targetScope: approvedOnMachineA.targetScope,
      subject: credentialSubject,
      currentInstallReviewPrincipalDigest: currentPrincipal,
      currentAuthoritySource: machineA,
    })).toBe(false);
  });

  it('binds general grants to the approving machine installation too', () => {
    const existing = grant(GENERAL_PLUGIN_PERMISSION_SUBJECT_V1, machineA);
    const base = {
      grant: existing,
      pluginId: existing.pluginId,
      capability: existing.capability,
      targetScope: existing.targetScope,
      subject: GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
    } as const;

    expect(evaluatePluginPermissionGrant({ ...base, currentAuthoritySource: machineA })).toBe(true);
    expect(evaluatePluginPermissionGrant({ ...base, currentAuthoritySource: machineB })).toBe(false);
    expect(evaluatePluginPermissionGrant({ ...base, currentAuthoritySource: null })).toBe(false);
  });
});
