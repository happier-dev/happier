import { describe, expect, it } from 'vitest';

import {
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
  });

  it('rejects invalid account encryption mode updates', () => {
    const parsed = AccountEncryptionModeUpdateRequestSchema.safeParse({
      mode: 'nope',
    });
    expect(parsed.success).toBe(false);
  });
});

