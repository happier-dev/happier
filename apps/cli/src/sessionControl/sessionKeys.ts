import type { Credentials } from '@/persistence';

import { decodeBase64, decrypt } from '@/api/encryption';
import { openSessionDataEncryptionKey } from '@/api/client/openSessionDataEncryptionKey';

export function openSessionKeyOrThrow(params: { credentials: Credentials; rawSession: { dataEncryptionKey?: unknown } }): Uint8Array {
  if (params.credentials.encryption.type !== 'dataKey') {
    throw new Error('Legacy credentials cannot decrypt session keys; reconnect terminal with V2 provisioning.');
  }
  const encryptedDekBase64 =
    typeof params.rawSession.dataEncryptionKey === 'string' ? String(params.rawSession.dataEncryptionKey).trim() : '';
  const key = openSessionDataEncryptionKey({
    credential: params.credentials,
    encryptedDataEncryptionKeyBase64: encryptedDekBase64 || null,
  });
  if (!key) {
    throw new Error('Failed to open session dataEncryptionKey. Reconnect your terminal with V2 provisioning.');
  }
  return key;
}

export function tryDecryptSessionMetadata(params: {
  credentials: Credentials;
  rawSession: { metadata?: unknown; dataEncryptionKey?: unknown };
}): Record<string, unknown> | null {
  const encryptedMetadataBase64 = typeof params.rawSession.metadata === 'string' ? String(params.rawSession.metadata).trim() : '';
  if (!encryptedMetadataBase64) return null;

  if (params.credentials.encryption.type !== 'dataKey') return null;
  const encryptedDekBase64 = typeof params.rawSession.dataEncryptionKey === 'string' ? String(params.rawSession.dataEncryptionKey).trim() : '';

  const opened = openSessionDataEncryptionKey({
    credential: params.credentials,
    encryptedDataEncryptionKeyBase64: encryptedDekBase64 || null,
  });
  const sessionKey = opened ?? params.credentials.encryption.machineKey;

  try {
    const decrypted = decrypt(sessionKey, 'dataKey', decodeBase64(encryptedMetadataBase64));
    if (!decrypted || typeof decrypted !== 'object' || Array.isArray(decrypted)) return null;
    return decrypted as Record<string, unknown>;
  } catch {
    return null;
  }
}

