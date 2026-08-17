import { describe, expect, it } from 'vitest';

import { getAccountScopedBlobCiphertextBase64LengthV1 } from '../../crypto/accountScopedCipher.js';
import { ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES } from './catalog/accountSettingBounds.js';
import {
  ACCOUNT_SETTINGS_MAX_ENCRYPTED_CIPHERTEXT_UTF8_BYTES,
  AccountSettingsStoredContentEnvelopeSchema,
} from './accountSettingsStoredContentEnvelope.js';
import {
  AccountSettingsV2UpdateRequestAdmissionSchema,
  AccountSettingsV2UpdateRequestSchema,
  AccountSettingsV2UpdateResponseSchema,
} from './accountSettingsApiV2.js';

function plainEnvelopeWithDocumentUtf8Bytes(documentUtf8Bytes: number) {
  const emptyDocument = JSON.stringify({ payload: '' });
  const emptyDocumentUtf8Bytes = new TextEncoder().encode(emptyDocument).byteLength;
  return {
    t: 'plain' as const,
    v: { payload: 'x'.repeat(documentUtf8Bytes - emptyDocumentUtf8Bytes) },
  };
}

describe('AccountSettingsStoredContentEnvelopeSchema', () => {
  it('accepts plain envelope without adding effective defaults', () => {
    const parsed = AccountSettingsStoredContentEnvelopeSchema.safeParse({ t: 'plain', v: {} });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.v).toEqual({});
  });

  it('accepts encrypted envelope', () => {
    const parsed = AccountSettingsStoredContentEnvelopeSchema.safeParse({ t: 'encrypted', c: 'ciphertext' });
    expect(parsed.success).toBe(true);
  });

  it('keeps oversized encrypted snapshots readable while bounding V2 writes from the canonical cipher length', () => {
    expect(ACCOUNT_SETTINGS_MAX_ENCRYPTED_CIPHERTEXT_UTF8_BYTES).toBe(
      getAccountScopedBlobCiphertextBase64LengthV1(ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES),
    );
    expect(AccountSettingsV2UpdateRequestSchema.safeParse({
      expectedVersion: 0,
      content: {
        t: 'encrypted',
        c: 'x'.repeat(ACCOUNT_SETTINGS_MAX_ENCRYPTED_CIPHERTEXT_UTF8_BYTES),
      },
    }).success).toBe(true);
    const oversizedCiphertext = 'x'.repeat(ACCOUNT_SETTINGS_MAX_ENCRYPTED_CIPHERTEXT_UTF8_BYTES + 1);
    expect(AccountSettingsStoredContentEnvelopeSchema.safeParse({
      t: 'encrypted',
      c: oversizedCiphertext,
    }).success).toBe(true);
    expect(AccountSettingsV2UpdateRequestAdmissionSchema.safeParse({
      expectedVersion: 0,
      content: { t: 'encrypted', c: oversizedCiphertext },
    }).success).toBe(true);
    expect(AccountSettingsV2UpdateRequestSchema.safeParse({
      expectedVersion: 0,
      content: { t: 'encrypted', c: oversizedCiphertext },
    }).success).toBe(false);
  });

  it('bounds canonical plain document writes while retaining oversized plain snapshots for migration reads', () => {
    const maximumPlainEnvelope = plainEnvelopeWithDocumentUtf8Bytes(
      ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES,
    );
    const oversizedPlainEnvelope = plainEnvelopeWithDocumentUtf8Bytes(
      ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES + 1,
    );

    expect(new TextEncoder().encode(JSON.stringify(maximumPlainEnvelope.v)).byteLength).toBe(
      ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES,
    );
    expect(AccountSettingsV2UpdateRequestSchema.safeParse({
      expectedVersion: 0,
      content: maximumPlainEnvelope,
    }).success).toBe(true);
    expect(AccountSettingsStoredContentEnvelopeSchema.safeParse(oversizedPlainEnvelope).success).toBe(true);
    expect(AccountSettingsV2UpdateRequestAdmissionSchema.safeParse({
      expectedVersion: 0,
      content: oversizedPlainEnvelope,
    }).success).toBe(true);
    expect(AccountSettingsV2UpdateRequestSchema.safeParse({
      expectedVersion: 0,
      content: oversizedPlainEnvelope,
    }).success).toBe(false);
  });

  it('publishes the typed too-large V2 mutation refusal', () => {
    expect(AccountSettingsV2UpdateResponseSchema.safeParse({
      success: false,
      error: 'invalid',
      reason: 'tooLarge',
    }).success).toBe(true);
  });

  it('rejects unknown envelope', () => {
    const parsed = AccountSettingsStoredContentEnvelopeSchema.safeParse({ t: 'nope', v: {} });
    expect(parsed.success).toBe(false);
  });
});
