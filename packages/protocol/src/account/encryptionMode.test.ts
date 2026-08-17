import { describe, expect, it } from 'vitest';

import {
  AccountEncryptionCurrentnessResponseSchema,
  AccountEncryptionModeResponseSchema,
  AccountEncryptionModeUpdateRequestSchema,
} from './encryptionMode.js';

describe('account/encryptionMode', () => {
  it('parses GET /v1/account/encryption response payloads', () => {
    const parsed = AccountEncryptionModeResponseSchema.safeParse({
      mode: 'plain',
      updatedAt: 123,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.mode).toBe('plain');
    expect(AccountEncryptionModeResponseSchema.safeParse({
      mode: 'plain',
      version: 7,
      updatedAt: 123,
    }).success).toBe(false);
    expect(AccountEncryptionCurrentnessResponseSchema.parse({
      mode: 'plain',
      version: 7,
      signingKeyFingerprint: 'aemk1_signing',
      contentKeyFingerprint: null,
      updatedAt: 123,
    }).version).toBe(7);
  });

  it('rejects invalid account encryption mode updates', () => {
    const parsed = AccountEncryptionModeUpdateRequestSchema.safeParse({
      mode: 'nope',
    });
    expect(parsed.success).toBe(false);
  });
});
