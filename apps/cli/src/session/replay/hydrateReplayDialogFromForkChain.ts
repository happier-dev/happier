import type { Credentials } from '@/persistence';

import { openSessionDataEncryptionKey } from '@/api/client/openSessionDataEncryptionKey';
import { fetchSessionById } from '@/sessionControl/sessionsHttp';
import { tryDecryptSessionMetadata } from '@/sessionControl/sessionEncryptionContext';

import type { HappierReplayDialogItem } from './types';
import { fetchEncryptedTranscriptMessages } from './fetchEncryptedTranscriptMessages';
import { decryptTranscriptReplaySlice } from './decryptTranscriptReplaySlice';

type ForkV1 = Readonly<{
  v: 1;
  parentSessionId: string;
  parentCutoffSeqInclusive: number;
}>;

function readForkV1FromMetadata(metadata: Record<string, unknown>): ForkV1 | null {
  const fork = (metadata as any)?.forkV1;
  if (!fork || typeof fork !== 'object') return null;
  if ((fork as any).v !== 1) return null;
  const parentSessionId = typeof (fork as any).parentSessionId === 'string' ? String((fork as any).parentSessionId).trim() : '';
  const cutoffRaw = (fork as any).parentCutoffSeqInclusive;
  const cutoff = typeof cutoffRaw === 'number' && Number.isFinite(cutoffRaw) ? Math.max(0, Math.floor(cutoffRaw)) : NaN;
  if (!parentSessionId) return null;
  if (!Number.isFinite(cutoff)) return null;
  return { v: 1, parentSessionId, parentCutoffSeqInclusive: cutoff };
}

export async function hydrateReplayDialogFromForkChain(params: Readonly<{
  credentials: Credentials;
  startingSessionId: string;
  limit: number;
  maxTextChars?: number;
  upToSeqInclusive?: number;
  maxDepth?: number;
}>): Promise<{ dialog: HappierReplayDialogItem[]; sourceCutoffSeqInclusive: number; synopsisText?: string | null } | null> {
  const maxDepth =
    typeof params.maxDepth === 'number' && Number.isFinite(params.maxDepth)
      ? Math.max(1, Math.min(25, Math.floor(params.maxDepth)))
      : 10;

  const visited = new Set<string>();
  const segments: Array<{ sessionId: string; rawSession: any; upToSeqInclusive?: number }> = [];

  let currentSessionId = String(params.startingSessionId ?? '').trim();
  let currentUpToSeqInclusive = params.upToSeqInclusive;

  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (!currentSessionId) break;
    if (visited.has(currentSessionId)) break;
    visited.add(currentSessionId);

    const rawSession = await fetchSessionById({ token: params.credentials.token, sessionId: currentSessionId }).catch(() => null);
    if (!rawSession) break;

    segments.push({
      sessionId: currentSessionId,
      rawSession,
      ...(typeof currentUpToSeqInclusive === 'number' && Number.isFinite(currentUpToSeqInclusive)
        ? { upToSeqInclusive: Math.max(0, Math.floor(currentUpToSeqInclusive)) }
        : {}),
    });

    const metadata = tryDecryptSessionMetadata({ credentials: params.credentials, rawSession });
    if (!metadata) break;
    const fork = readForkV1FromMetadata(metadata);
    if (!fork) break;

    currentSessionId = fork.parentSessionId;
    currentUpToSeqInclusive = fork.parentCutoffSeqInclusive;
  }

  if (segments.length === 0) return null;

  const dialogs: HappierReplayDialogItem[] = [];
  let sourceCutoffSeqInclusive = 0;
  let synopsisText: string | null = null;

  // Iterate oldest-first so createdAt ordering stays stable before the final sort.
  for (const segment of [...segments].reverse()) {
    const sessionSeq =
      typeof (segment.rawSession as any)?.seq === 'number' && Number.isFinite((segment.rawSession as any).seq)
        ? Math.max(0, Math.floor((segment.rawSession as any).seq))
        : 0;

    const cutoff =
      typeof segment.upToSeqInclusive === 'number' && Number.isFinite(segment.upToSeqInclusive)
        ? Math.max(0, Math.floor(segment.upToSeqInclusive))
        : sessionSeq;

    const beforeSeq = Math.max(0, Math.floor(cutoff) + 1);
    const rows = await fetchEncryptedTranscriptMessages({
      token: params.credentials.token,
      sessionId: segment.sessionId,
      limit: params.limit,
      ...(typeof beforeSeq === 'number' ? { beforeSeq } : {}),
    }).catch(() => null);
    if (!rows) continue;

    const encryptionMode = (segment.rawSession as any)?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
    if (encryptionMode === 'plain') {
      const slice = decryptTranscriptReplaySlice({ rows, maxTextChars: params.maxTextChars });
      dialogs.push(...slice.dialog);
      if (segment.sessionId === params.startingSessionId) {
        sourceCutoffSeqInclusive = cutoff;
        synopsisText = slice.latestSynopsisText;
      }
      continue;
    }

    if (params.credentials.encryption.type !== 'dataKey') {
      continue;
    }

    const encryptedDekBase64 = typeof (segment.rawSession as any)?.dataEncryptionKey === 'string'
      ? String((segment.rawSession as any).dataEncryptionKey).trim()
      : null;
    if (!encryptedDekBase64) continue;

    const dek = openSessionDataEncryptionKey({
      credential: params.credentials,
      encryptedDataEncryptionKeyBase64: encryptedDekBase64,
    });
    if (!dek) continue;

    const slice = decryptTranscriptReplaySlice({
      rows,
      encryptionKey: dek,
      encryptionVariant: 'dataKey',
      maxTextChars: params.maxTextChars,
    });
    dialogs.push(...slice.dialog);
    if (segment.sessionId === params.startingSessionId) {
      sourceCutoffSeqInclusive = cutoff;
      synopsisText = slice.latestSynopsisText;
    }
  }

  if (dialogs.length === 0) return null;
  dialogs.sort((a, b) => a.createdAt - b.createdAt);
  const dialog = dialogs.length > params.limit ? dialogs.slice(dialogs.length - params.limit) : dialogs;
  return { dialog, sourceCutoffSeqInclusive, synopsisText };
}
