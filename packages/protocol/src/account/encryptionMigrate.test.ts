import { describe, expect, it } from 'vitest';

import {
  AccountEncryptionMigrateBadRequestResponseSchema,
  AccountEncryptionMigrateKeyProofSchema,
  AccountEncryptionMigrateRequestSchema,
  AccountEncryptionMigrateToModeSchema,
} from './encryptionMigrate.js';

describe('account/encryptionMigrate', () => {
  it('parses toMode', () => {
    expect(AccountEncryptionMigrateToModeSchema.parse('plain')).toBe('plain');
    expect(AccountEncryptionMigrateToModeSchema.parse('e2ee')).toBe('e2ee');
  });

  it('accepts a minimal migrate-to-plain request', () => {
    const parsed = AccountEncryptionMigrateRequestSchema.parse({
      toMode: 'plain',
      expectedSettingsVersion: 0,
      settingsContent: { t: 'plain', v: { schemaVersion: 2 } },
      connectedServices: { action: 'assert_empty' },
      automations: { action: 'assert_empty' },
    });
    expect(parsed.toMode).toBe('plain');
  });

  it('parses invalid-params errors with reason codes', () => {
    expect(
      AccountEncryptionMigrateBadRequestResponseSchema.parse({
        error: 'invalid-params',
        reason: 'restore_required',
      }),
    ).toEqual({ error: 'invalid-params', reason: 'restore_required' });
    expect(
      AccountEncryptionMigrateBadRequestResponseSchema.parse({
        error: 'invalid-params',
        reason: 'key_proof_required',
      }),
    ).toEqual({ error: 'invalid-params', reason: 'key_proof_required' });
  });

  it('rejects oversized keyProof fields', () => {
    const tooLong = 'a'.repeat(5000);
    expect(() =>
      AccountEncryptionMigrateKeyProofSchema.parse({
        publicKey: tooLong,
        challenge: tooLong,
        signature: tooLong,
      }),
    ).toThrow();
  });
});
