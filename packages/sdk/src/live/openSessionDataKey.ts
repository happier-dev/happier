import { openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { openSessionDataKeyBundleV0, sealSessionDataKeyBundleV0 } from '@happier-dev/protocol/crypto/sessionDataKeyBundleWebCrypto';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import type { SessionContentEncryption } from '@happier-dev/sync-client';

import { HappierTransportError } from '../errors.js';

/** The viewer envelope is opened with Account content material, never a Machine bootstrap key. */
export function openSessionDataKey(envelope: unknown, contentKey: Uint8Array): Uint8Array {
  let key: Uint8Array | null = null;
  try {
    if (typeof envelope === 'string') key = openEncryptedDataKeyEnvelopeV1({
      envelope: decodeBase64(envelope, 'base64'), recipientSecretKeyOrSeed: contentKey,
    });
  } catch { key = null; }
  if (!key) throw new HappierTransportError('The Session data key could not be opened.', { code: 'session_content_locked' });
  return key;
}

export function createSessionContentEncryption(key: Uint8Array): SessionContentEncryption {
  return {
    encryptRaw: async (value) => encodeBase64(await sealSessionDataKeyBundleV0(value, key), 'base64'),
    decryptRaw: async (value) => {
      const result = await openSessionDataKeyBundleV0(decodeBase64(value, 'base64'), key);
      return result.status === 'authenticated' ? result.value : null;
    },
  };
}
