import { describe, expect, it } from 'vitest';

import * as migrationContract from './encryptionMigrate.js';
import {
  AccountEncryptionMigrateBadRequestResponseSchema,
  AccountEncryptionMigrateKeyProofSchema,
  AccountEncryptionMigrateRequestSchema,
  AccountEncryptionMigrateToModeSchema,
} from './encryptionMigrate.js';

describe('account/encryptionMigrate', () => {
  it('parses the existing one-shot target mode request', () => {
    expect(AccountEncryptionMigrateToModeSchema.parse('plain')).toBe('plain');
    expect(AccountEncryptionMigrateToModeSchema.parse('e2ee')).toBe('e2ee');

    const parsed = AccountEncryptionMigrateRequestSchema.parse({
      toMode: 'plain',
      expectedSettingsVersion: 0,
      settingsContent: { t: 'plain', v: { schemaVersion: 2 } },
      connectedServices: { action: 'assert_empty' },
      automations: { action: 'assert_empty' },
    });
    expect(parsed.toMode).toBe('plain');
    expect(parsed).not.toHaveProperty('sessions');
  });

  it('rejects the contracted one-shot Session reseal topology', () => {
    expect(AccountEncryptionMigrateRequestSchema.safeParse({
      toMode: 'plain',
      expectedSettingsVersion: 0,
      settingsContent: { t: 'plain', v: { schemaVersion: 2 } },
      connectedServices: { action: 'assert_empty' },
      automations: { action: 'assert_empty' },
      sessions: { forbidden: true },
    }).success).toBe(false);
    expect(AccountEncryptionMigrateBadRequestResponseSchema.parse({
      error: 'metadata_privacy_upgrade_required',
    })).toEqual({ error: 'metadata_privacy_upgrade_required' });
  });

  it('carries complete qualified credential and configuration replacements', () => {
    const qualified = {
      ref: {
        service: {
          pluginId: 'example.connected-accounts',
          localId: 'service/path',
        },
        accountId: 'provider/account',
      },
      expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz',
      expectedConfigurationRevision: 'cscr_current',
      authenticationModeId: 'api-key',
      replacementCredentialContentEnvelope: {
        t: 'encrypted',
        c: 'opaque-credential',
      },
      replacementConfigurationContentEnvelope: {
        t: 'encrypted',
        c: 'opaque-configuration',
      },
      metadata: {},
    } as const;
    const baseRequest = {
      toMode: 'e2ee' as const,
      expectedSettingsVersion: 0,
      settingsContent: null,
      connectedServices: {
        action: 'migrate' as const,
        qualifiedCredentials: [qualified],
      },
      automations: { action: 'assert_empty' as const },
      keyProof: {
        publicKey: 'public',
        challenge: 'challenge',
        signature: 'signature',
        contentPublicKey: 'content-public',
        contentPublicKeySig: 'content-signature',
      },
    };
    expect(AccountEncryptionMigrateRequestSchema.parse(baseRequest)
      .connectedServices).toMatchObject({
      action: 'migrate',
      qualifiedCredentials: [qualified],
    });
    expect(AccountEncryptionMigrateRequestSchema.safeParse({
      ...baseRequest,
      connectedServices: {
        action: 'migrate',
        qualifiedCredentials: [{
          ...qualified,
          replacementConfigurationContentEnvelope: undefined,
        }],
      },
    }).success).toBe(false);
    expect(AccountEncryptionMigrateRequestSchema.safeParse({
      ...baseRequest,
      connectedServices: {
        action: 'migrate',
        qualifiedCredentials: [{
          ...qualified,
          replacementCredentialContentEnvelope: {
            t: 'plain',
            v: {},
          },
        }],
      },
    }).success).toBe(false);
  });

  it('parses stable invalid-params reasons and rejects oversized key proofs', () => {
    expect(AccountEncryptionMigrateBadRequestResponseSchema.parse({
      error: 'invalid-params',
      reason: 'restore_required',
    })).toEqual({
      error: 'invalid-params',
      reason: 'restore_required',
    });
    expect(AccountEncryptionMigrateBadRequestResponseSchema.parse({
      error: 'invalid-params',
      reason: 'key_proof_required',
    })).toEqual({
      error: 'invalid-params',
      reason: 'key_proof_required',
    });
    expect(AccountEncryptionMigrateKeyProofSchema.safeParse({
      publicKey: 'p'.repeat(4097),
      challenge: 'challenge',
      signature: 'signature',
    }).success).toBe(false);
  });

  it('requires a complete signed content-key binding for every e2ee migration', () => {
    const request = {
      toMode: 'e2ee',
      expectedSettingsVersion: 0,
      settingsContent: { t: 'encrypted', c: 'ciphertext' },
      connectedServices: { action: 'assert_empty' },
      automations: { action: 'assert_empty' },
      keyProof: {
        publicKey: 'public',
        challenge: 'challenge',
        signature: 'signature',
      },
    };

    const { keyProof: _omittedKeyProof, ...requestWithoutKeyProof } = request;
    expect(
      AccountEncryptionMigrateRequestSchema.safeParse(requestWithoutKeyProof)
        .success,
    ).toBe(false);
    expect(AccountEncryptionMigrateRequestSchema.safeParse(request).success).toBe(false);
    expect(AccountEncryptionMigrateRequestSchema.safeParse({
      ...request,
      keyProof: {
        ...request.keyProof,
        contentPublicKey: 'content-public',
        contentPublicKeySig: 'content-signature',
      },
    }).success).toBe(true);
  });

  it('does not expose the rejected multi-phase rotation topology', () => {
    for (const retired of [
      'AccountEncryptionMigratePrepareBatchRequestSchema',
      'AccountEncryptionMigrateFinalizeRequestSchema',
      'AccountEncryptionMigrateRotationStateV1Schema',
      'AccountEncryptionMigrateServerIngressRequestSchema',
      'createAccountEncryptionMigrateRotationProofChallengeV1',
    ]) {
      expect(migrationContract).not.toHaveProperty(retired);
    }
  });
});
