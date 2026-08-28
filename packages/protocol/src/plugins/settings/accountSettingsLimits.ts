import { getAccountScopedBlobCiphertextBase64LengthV1 } from '../../crypto/accountScopedCipherEnvelope.js';

/** Settings owns these limits; Account KV has a distinct data contract. */
const PLUGIN_ACCOUNT_SETTINGS_MAXIMUM_RECORD_ENCODED_BYTES_V1 = 512 * 1024;

export const PLUGIN_ACCOUNT_SETTINGS_LIMITS_V1 = Object.freeze({
  maximumFields: 256,
  maximumFieldEncodedBytes: 64 * 1024,
  maximumRecordEncodedBytes: PLUGIN_ACCOUNT_SETTINGS_MAXIMUM_RECORD_ENCODED_BYTES_V1,
  maximumEncryptedCiphertextUtf8Bytes: getAccountScopedBlobCiphertextBase64LengthV1(
    PLUGIN_ACCOUNT_SETTINGS_MAXIMUM_RECORD_ENCODED_BYTES_V1,
  ),
  maximumJsonDepth: 12,
} as const);
