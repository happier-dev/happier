import { describe, expect, it } from 'vitest';

import {
  AccountEncryptionMigrateBadRequestResponseSchema,
  AccountEncryptionMigrateKeyProofSchema,
  AccountEncryptionMigrateRequestSchema,
  AccountEncryptionMigrateToModeSchema,
  AccountEncryptionMigrateSuccessResponseSchema,
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

  it('accepts closed new-session draft migration coverage and keeps it optional for old clients', () => {
    const base = {
      toMode: 'plain',
      expectedSettingsVersion: 0,
      settingsContent: null,
      connectedServices: { action: 'assert_empty' },
      automations: { action: 'assert_empty' },
    } as const;
    expect(AccountEncryptionMigrateRequestSchema.parse(base).sessionDrafts).toBeUndefined();
    const parsed = AccountEncryptionMigrateRequestSchema.parse({
      ...base,
      sessionDrafts: {
        items: [{
          address: { kind: 'newSession', draftId: '00000000-0000-4000-8000-000000000001' },
          expectedRevision: 3,
          content: {
            t: 'plain',
            v: {
              v: 1,
              address: { kind: 'newSession', draftId: '00000000-0000-4000-8000-000000000001' },
              document: {
                v: 1,
                composer: {
                  text: { mutationId: '00000000-0000-4000-8000-000000000002', value: '' },
                  mentions: { mutationId: '00000000-0000-4000-8000-000000000002', value: [] },
                  attachments: { mutationId: '00000000-0000-4000-8000-000000000002', value: [] },
                },
                target: { kind: 'newSession', authoring: {} },
                extensions: {},
              },
            },
          },
        }],
      },
    });
    expect(parsed.sessionDrafts?.items).toHaveLength(1);
  });

  it('returns authoritative post-CAS draft records to capable migration callers', () => {
    const parsed = AccountEncryptionMigrateSuccessResponseSchema.parse({
      success: true,
      mode: 'plain',
      settingsVersion: 1,
      sessionDrafts: { records: [] },
    });
    expect(parsed.sessionDrafts?.records).toEqual([]);
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
