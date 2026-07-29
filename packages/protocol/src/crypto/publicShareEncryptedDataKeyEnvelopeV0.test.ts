import { describe, expect, it } from 'vitest';

import {
  parsePublicShareEncryptedDataKeyEnvelopeV0,
  PUBLIC_SHARE_ENCRYPTED_DATA_KEY_CURRENT_V0_BYTES,
  PUBLIC_SHARE_ENCRYPTED_DATA_KEY_LEGACY_V0_BYTES,
} from './publicShareEncryptedDataKeyEnvelopeV0.js';

describe('parsePublicShareEncryptedDataKeyEnvelopeV0', () => {
  it('accepts the deployed legacy/current SecretBox lengths and rejects generic Box', () => {
    expect(parsePublicShareEncryptedDataKeyEnvelopeV0(
      new Uint8Array(PUBLIC_SHARE_ENCRYPTED_DATA_KEY_LEGACY_V0_BYTES),
    )?.format).toBe('legacy-json');
    expect(parsePublicShareEncryptedDataKeyEnvelopeV0(
      new Uint8Array(PUBLIC_SHARE_ENCRYPTED_DATA_KEY_CURRENT_V0_BYTES),
    )?.format).toBe('serialized-json-v1');
    expect(parsePublicShareEncryptedDataKeyEnvelopeV0(new Uint8Array(105))).toBeNull();
  });
});
