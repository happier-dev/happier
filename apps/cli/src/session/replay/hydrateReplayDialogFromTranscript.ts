import { requireEncryptionCredentials, type Credentials } from '@/persistence';

import { isAuthenticationError } from '@/api/client/httpStatusError';
import { openSessionDataEncryptionKey } from '@/api/client/openSessionDataEncryptionKey';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { fetchLatestMemorySynopsisSystemRecord } from '@/session/systemRecords/memory/fetchMemorySystemRecords';
import {
  resolveSessionStoredContentEncryptionMode,
  type SessionEncryptionContext,
  type SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';

import { fetchEncryptedTranscriptMessages } from './fetchEncryptedTranscriptMessages';
import { decryptTranscriptReplaySlice } from './decryptTranscriptReplaySlice';
import type { HappierReplayDialogItem } from './types';

async function tryHydrateSynopsisFromSystemRecord(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  mode: SessionStoredContentEncryptionMode;
  ctx?: SessionEncryptionContext;
}>): Promise<string | null> {
  const synopsis = await fetchLatestMemorySynopsisSystemRecord({
    token: params.credentials.token,
    sessionId: params.sessionId,
    mode: params.mode,
    ...(params.mode === 'e2ee' && params.ctx ? { ctx: params.ctx } : {}),
  }).catch((error) => {
    if (isAuthenticationError(error)) throw error;
    return null;
  });
  const text = typeof synopsis?.synopsis === 'string' ? synopsis.synopsis.trim() : '';
  return text.length > 0 ? text : null;
}

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
    const systemRecordSynopsis = await tryHydrateSynopsisFromSystemRecord({
      credentials: params.credentials,
      sessionId: params.previousSessionId,
      mode: 'plain',
    });
    const slice = decryptTranscriptReplaySlice({
      rows,
      maxTextChars: params.maxTextChars,
      maxDialogItems: params.limit,
    });
    return {
      dialog: slice.dialog,
      sourceCutoffSeqInclusive,
      synopsisText: systemRecordSynopsis ?? slice.latestSynopsisText,
    };
  }

  requireEncryptionCredentials(params.credentials);
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

  const ctx = { encryptionKey: dek, encryptionVariant: 'dataKey' as const };
  const systemRecordSynopsis = await tryHydrateSynopsisFromSystemRecord({
    credentials: params.credentials,
    sessionId: params.previousSessionId,
    mode: 'e2ee',
    ctx,
  });

  const slice = decryptTranscriptReplaySlice({
    rows,
    encryptionKey: ctx.encryptionKey,
    encryptionVariant: ctx.encryptionVariant,
    maxTextChars: params.maxTextChars,
    maxDialogItems: params.limit,
  });

  return {
    dialog: slice.dialog,
    sourceCutoffSeqInclusive,
    synopsisText: systemRecordSynopsis ?? slice.latestSynopsisText,
  };
}
