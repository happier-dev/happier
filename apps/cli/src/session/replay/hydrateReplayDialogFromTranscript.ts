import type { Credentials } from '@/persistence';

import { openSessionDataEncryptionKey } from '@/api/client/openSessionDataEncryptionKey';
import { fetchSessionById } from '@/sessionControl/sessionsHttp';

import { fetchEncryptedTranscriptMessages } from './fetchEncryptedTranscriptMessages';
import { decryptTranscriptTextItems } from './decryptTranscriptTextItems';
import type { HappierReplayDialogItem } from './types';

export async function hydrateReplayDialogFromTranscript(params: Readonly<{
  credentials: Credentials;
  previousSessionId: string;
  limit: number;
  maxTextChars?: number;
}>): Promise<{ dialog: HappierReplayDialogItem[] } | null> {
  const session = await fetchSessionById({ token: params.credentials.token, sessionId: params.previousSessionId });
  if (!session) return null;

  const rows = await fetchEncryptedTranscriptMessages({
    token: params.credentials.token,
    sessionId: params.previousSessionId,
    limit: params.limit,
  });

  const encryptionMode = (session as any)?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
  if (encryptionMode === 'plain') {
    const dialog = decryptTranscriptTextItems({ rows, maxTextChars: params.maxTextChars });
    return { dialog };
  }

  if (params.credentials.encryption.type !== 'dataKey') {
    return null;
  }

  const encryptedDekBase64 = typeof (session as any)?.dataEncryptionKey === 'string'
    ? String((session as any).dataEncryptionKey).trim()
    : null;
  if (!encryptedDekBase64) return null;

  const dek = openSessionDataEncryptionKey({
    credential: params.credentials,
    encryptedDataEncryptionKeyBase64: encryptedDekBase64,
  });
  if (!dek) return null;

  const dialog = decryptTranscriptTextItems({
    rows,
    encryptionKey: dek,
    encryptionVariant: 'dataKey',
    maxTextChars: params.maxTextChars,
  });

  return { dialog };
}
