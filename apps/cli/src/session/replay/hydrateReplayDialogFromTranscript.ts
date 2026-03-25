import type { Credentials } from '@/persistence';

import { openSessionDataEncryptionKey } from '@/api/client/openSessionDataEncryptionKey';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { resolveSessionStoredContentEncryptionMode } from '@/session/transport/encryption/sessionEncryptionContext';

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

  const rawSession = session as Readonly<{
    seq?: unknown;
    encryptionMode?: unknown;
    dataEncryptionKey?: unknown;
  }>;

  const sessionSeq =
    typeof rawSession.seq === 'number' && Number.isFinite(rawSession.seq) ? Math.max(0, Math.floor(rawSession.seq)) : 0;

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

  const encryptionMode = resolveSessionStoredContentEncryptionMode(rawSession);
  if (encryptionMode === 'plain') {
    const slice = decryptTranscriptReplaySlice({
      rows,
      maxTextChars: params.maxTextChars,
      maxDialogItems: params.limit,
    });
    return { dialog: slice.dialog, sourceCutoffSeqInclusive, synopsisText: slice.latestSynopsisText };
  }

  if (params.credentials.encryption.type !== 'dataKey') {
    return null;
  }

  const encryptedDekBase64 = typeof rawSession.dataEncryptionKey === 'string'
    ? String(rawSession.dataEncryptionKey).trim()
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
    maxDialogItems: params.limit,
  });

  return { dialog: slice.dialog, sourceCutoffSeqInclusive, synopsisText: slice.latestSynopsisText };
}
