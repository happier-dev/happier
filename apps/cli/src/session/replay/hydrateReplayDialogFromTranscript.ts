import type { Credentials } from '@/persistence';

import { openSessionDataEncryptionKey } from '@/api/client/openSessionDataEncryptionKey';

import { fetchEncryptedTranscriptMessages } from './fetchEncryptedTranscriptMessages';
import { fetchSessionDataEncryptionKey } from './fetchSessionDataEncryptionKey';
import { decryptTranscriptTextItems } from './decryptTranscriptTextItems';
import type { HappierReplayDialogItem } from './types';

export async function hydrateReplayDialogFromTranscript(params: Readonly<{
  credentials: Credentials;
  previousSessionId: string;
  limit: number;
  maxTextChars?: number;
}>): Promise<{ dialog: HappierReplayDialogItem[] } | null> {
  if (params.credentials.encryption.type !== 'dataKey') {
    return null;
  }

  const encryptedDekBase64 = await fetchSessionDataEncryptionKey({
    token: params.credentials.token,
    sessionId: params.previousSessionId,
  });
  if (!encryptedDekBase64) return null;

  const dek = openSessionDataEncryptionKey({
    credential: params.credentials,
    encryptedDataEncryptionKeyBase64: encryptedDekBase64,
  });
  if (!dek) return null;

  const rows = await fetchEncryptedTranscriptMessages({
    token: params.credentials.token,
    sessionId: params.previousSessionId,
    limit: params.limit,
  });

  const dialog = decryptTranscriptTextItems({
    rows,
    encryptionKey: dek,
    encryptionVariant: 'dataKey',
    maxTextChars: params.maxTextChars,
  });

  return { dialog };
}
