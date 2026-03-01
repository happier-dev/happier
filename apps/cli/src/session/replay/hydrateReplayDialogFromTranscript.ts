import type { Credentials } from '@/persistence';

import { openSessionDataEncryptionKey } from '@/api/client/openSessionDataEncryptionKey';
import { fetchSessionById } from '@/sessionControl/sessionsHttp';

import { fetchEncryptedTranscriptMessages } from './fetchEncryptedTranscriptMessages';
import { decryptTranscriptReplaySlice } from './decryptTranscriptReplaySlice';
import type { HappierReplayDialogItem } from './types';

export async function hydrateReplayDialogFromTranscript(params: Readonly<{
  credentials: Credentials;
  previousSessionId: string;
  limit: number;
  maxTextChars?: number;
  upToSeqInclusive?: number;
}>): Promise<{ dialog: HappierReplayDialogItem[]; sourceCutoffSeqInclusive: number; synopsisText?: string | null } | null> {
  const session = await fetchSessionById({ token: params.credentials.token, sessionId: params.previousSessionId });
  if (!session) return null;

  const sessionSeq =
    typeof (session as any)?.seq === 'number' && Number.isFinite((session as any).seq) ? Math.max(0, Math.floor((session as any).seq)) : 0;

  const sourceCutoffSeqInclusive =
    typeof params.upToSeqInclusive === 'number' && Number.isFinite(params.upToSeqInclusive)
      ? Math.max(0, Math.floor(params.upToSeqInclusive))
      : sessionSeq;

  const beforeSeq =
    typeof sourceCutoffSeqInclusive === 'number' ? Math.max(0, Math.floor(sourceCutoffSeqInclusive) + 1) : undefined;

  const rows = await fetchEncryptedTranscriptMessages({
    token: params.credentials.token,
    sessionId: params.previousSessionId,
    limit: params.limit,
    ...(typeof beforeSeq === 'number' ? { beforeSeq } : {}),
  });

  const encryptionMode = (session as any)?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
  if (encryptionMode === 'plain') {
    const slice = decryptTranscriptReplaySlice({ rows, maxTextChars: params.maxTextChars });
    return { dialog: slice.dialog, sourceCutoffSeqInclusive, synopsisText: slice.latestSynopsisText };
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

  const slice = decryptTranscriptReplaySlice({
    rows,
    encryptionKey: dek,
    encryptionVariant: 'dataKey',
    maxTextChars: params.maxTextChars,
  });

  return { dialog: slice.dialog, sourceCutoffSeqInclusive, synopsisText: slice.latestSynopsisText };
}
