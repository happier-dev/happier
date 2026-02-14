import type { Credentials } from '@/persistence';

import { openSessionDataEncryptionKey } from '@/api/client/openSessionDataEncryptionKey';
import { encodeBase64 } from '@/api/encryption';
import { fetchSessionDataEncryptionKey } from '@/session/replay/fetchSessionDataEncryptionKey';

export async function resolveExistingSessionEncryptionKeyBase64(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
}>): Promise<string | null> {
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
  if (!sessionId) return null;
  if (params.credentials.encryption.type !== 'dataKey') {
    return null;
  }

  const encryptedDekBase64 = await fetchSessionDataEncryptionKey({
    token: params.credentials.token,
    sessionId,
  });
  if (!encryptedDekBase64) return null;

  const dek = openSessionDataEncryptionKey({
    credential: params.credentials,
    encryptedDataEncryptionKeyBase64: encryptedDekBase64,
  });
  if (!dek) return null;

  return encodeBase64(dek, 'base64');
}
