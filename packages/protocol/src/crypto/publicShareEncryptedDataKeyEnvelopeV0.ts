import tweetnacl from 'tweetnacl';

import { stringifySerializedJsonValue } from './serializedJsonValue.js';

export const PUBLIC_SHARE_DATA_ENCRYPTION_KEY_BYTES = 32;
const DATA_KEY_BASE64_LENGTH = Math.ceil(PUBLIC_SHARE_DATA_ENCRYPTION_KEY_BYTES / 3) * 4;
const DATA_KEY_BASE64_PLACEHOLDER = 'A'.repeat(DATA_KEY_BASE64_LENGTH);
const SECRETBOX_OVERHEAD_BYTES = tweetnacl.secretbox.nonceLength + tweetnacl.secretbox.overheadLength;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export const PUBLIC_SHARE_ENCRYPTED_DATA_KEY_LEGACY_V0_BYTES =
  SECRETBOX_OVERHEAD_BYTES + utf8Length(JSON.stringify({ v: 0, keyB64: DATA_KEY_BASE64_PLACEHOLDER }));
export const PUBLIC_SHARE_ENCRYPTED_DATA_KEY_CURRENT_V0_BYTES =
  SECRETBOX_OVERHEAD_BYTES + utf8Length(
    stringifySerializedJsonValue({ v: 0, keyB64: DATA_KEY_BASE64_PLACEHOLDER }),
  );

export type PublicShareEncryptedDataKeyEnvelopeV0 = Readonly<{
  format: 'legacy-json' | 'serialized-json-v1';
  encryptedDataKey: Uint8Array<ArrayBuffer>;
}>;

export function parsePublicShareEncryptedDataKeyEnvelopeV0(
  bytes: Uint8Array,
): PublicShareEncryptedDataKeyEnvelopeV0 | null {
  const encryptedDataKey = new Uint8Array(bytes.byteLength);
  encryptedDataKey.set(bytes);
  if (bytes.byteLength === PUBLIC_SHARE_ENCRYPTED_DATA_KEY_CURRENT_V0_BYTES) {
    return { format: 'serialized-json-v1', encryptedDataKey };
  }
  if (bytes.byteLength === PUBLIC_SHARE_ENCRYPTED_DATA_KEY_LEGACY_V0_BYTES) {
    return { format: 'legacy-json', encryptedDataKey };
  }
  return null;
}
