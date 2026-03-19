import type { Credentials } from '@/persistence';

import { openSessionDataEncryptionKey } from '@/api/client/openSessionDataEncryptionKey';
import { findTranscriptEncryptedMessageByLocalId } from '@/api/session/transcriptMessageLookup';
import { configuration } from '@/configuration';
import { fetchSessionByIdCompat } from '@/sessionControl/sessionsHttp';
import { tryDecryptSessionMetadata } from '@/sessionControl/sessionEncryptionContext';
import { readMemorySynopsisPointerV1FromSessionMetadata } from '@/session/memoryArtifacts/memorySynopsisPointerV1';

import type { HappierReplayDialogItem } from './types';
import { fetchEncryptedTranscriptMessages } from './fetchEncryptedTranscriptMessages';
import { decryptTranscriptReplaySlice } from './decryptTranscriptReplaySlice';

type ForkV1 = Readonly<{
  v: 1;
  parentSessionId: string;
  parentCutoffSeqInclusive: number;
}>;

type RawTranscriptRow = Readonly<{
  seq?: unknown;
  createdAt?: unknown;
  content?: unknown;
}>;

async function tryHydrateSynopsisFromMetadataPointer(params: Readonly<{
  credentials: Credentials;
  rawSession: any;
  sessionId: string;
  maxTextChars?: number;
  encryptionKey?: Uint8Array;
  encryptionVariant?: 'dataKey';
}>): Promise<string | null> {
  const metadata = tryDecryptSessionMetadata({ credentials: params.credentials, rawSession: params.rawSession });
  if (!metadata) return null;
  const pointer = readMemorySynopsisPointerV1FromSessionMetadata(metadata);
  if (!pointer) return null;

  const found = await findTranscriptEncryptedMessageByLocalId({
    token: params.credentials.token,
    sessionId: params.sessionId,
    localId: pointer.localId,
  }).catch(() => null);
  if (!found) return null;

  const slice = decryptTranscriptReplaySlice({
    rows: [{ seq: found.seq, createdAt: 0, content: found.content }],
    encryptionKey: params.encryptionKey,
    encryptionVariant: params.encryptionVariant,
    maxTextChars: params.maxTextChars,
    maxDialogItems: 1,
  });
  return slice.latestSynopsisText;
}

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

function readMinSeq(rows: readonly { seq?: unknown }[]): number | null {
  let min = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const seq = typeof row?.seq === 'number' && Number.isFinite(row.seq) ? row.seq : null;
    if (seq === null) continue;
    min = Math.min(min, Math.floor(seq));
  }
  return Number.isFinite(min) ? Math.max(0, min) : null;
}

async function scanOlderPagesForSynopsisText(params: Readonly<{
  token: string;
  sessionId: string;
  initialRows: readonly RawTranscriptRow[];
  maxPages: number;
  pageSize: number;
  decryptLatestSynopsisText: (rows: readonly RawTranscriptRow[]) => string | null;
}>): Promise<string | null> {
  let cursor = readMinSeq(params.initialRows);
  for (let page = 0; page < params.maxPages; page += 1) {
    if (cursor === null || cursor <= 1) break;
    const older = await fetchEncryptedTranscriptMessages({
      token: params.token,
      sessionId: params.sessionId,
      limit: params.pageSize,
      beforeSeq: cursor,
    }).catch(() => null);
    if (!older || older.length === 0) break;
    const synopsis = params.decryptLatestSynopsisText(older);
    if (synopsis) return synopsis;
    cursor = readMinSeq(older);
  }
  return null;
}

export async function hydrateReplayDialogFromForkChain(params: Readonly<{
  credentials: Credentials;
  startingSessionId: string;
  limit: number;
  maxTextChars?: number;
  upToSeqInclusive?: number;
  maxDepth?: number;
  /**
   * When false, do not perform multi-page scanning for `session_synopsis.v1` artifacts.
   * (The newest fetched page may still contain a synopsis, which will be returned.)
   *
   * Callers should set this to true only when they will actually use `synopsisText`
   * (e.g. replay strategy `summary_plus_recent`).
   */
  wantSynopsisText?: boolean;
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

    const rawSession = await fetchSessionByIdCompat({ token: params.credentials.token, sessionId: currentSessionId }).catch(() => null);
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
  const wantSynopsisText = params.wantSynopsisText === true;

  const synopsisScanMaxPages =
    typeof configuration.replaySynopsisScanMaxPages === 'number' && Number.isFinite(configuration.replaySynopsisScanMaxPages)
      ? Math.max(0, Math.min(25, Math.floor(configuration.replaySynopsisScanMaxPages)))
      : 0;
  const synopsisScanPageSize =
    typeof configuration.replaySynopsisScanPageSize === 'number' && Number.isFinite(configuration.replaySynopsisScanPageSize)
      ? Math.max(1, Math.min(500, Math.floor(configuration.replaySynopsisScanPageSize)))
      : 500;

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
      const slice = decryptTranscriptReplaySlice({ rows, maxTextChars: params.maxTextChars, maxDialogItems: params.limit });
      dialogs.push(...slice.dialog);
      if (segment.sessionId === params.startingSessionId) {
        sourceCutoffSeqInclusive = cutoff;
        synopsisText = slice.latestSynopsisText;
      }

      if (wantSynopsisText && segment.sessionId === params.startingSessionId && !synopsisText) {
        synopsisText = await tryHydrateSynopsisFromMetadataPointer({
          credentials: params.credentials,
          rawSession: segment.rawSession,
          sessionId: segment.sessionId,
          maxTextChars: params.maxTextChars,
        });
      }

      if (wantSynopsisText && segment.sessionId === params.startingSessionId && !synopsisText && synopsisScanMaxPages > 0) {
        synopsisText = await scanOlderPagesForSynopsisText({
          token: params.credentials.token,
          sessionId: segment.sessionId,
          initialRows: rows,
          maxPages: synopsisScanMaxPages,
          pageSize: synopsisScanPageSize,
          decryptLatestSynopsisText: (rawRows) => {
            const olderSlice = decryptTranscriptReplaySlice({ rows: rawRows, maxTextChars: params.maxTextChars, maxDialogItems: params.limit });
            return olderSlice.latestSynopsisText;
          },
        });
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
      maxDialogItems: params.limit,
    });
    dialogs.push(...slice.dialog);
    if (segment.sessionId === params.startingSessionId) {
      sourceCutoffSeqInclusive = cutoff;
      synopsisText = slice.latestSynopsisText;
    }

    if (wantSynopsisText && segment.sessionId === params.startingSessionId && !synopsisText) {
      synopsisText = await tryHydrateSynopsisFromMetadataPointer({
        credentials: params.credentials,
        rawSession: segment.rawSession,
        sessionId: segment.sessionId,
        maxTextChars: params.maxTextChars,
        encryptionKey: dek,
        encryptionVariant: 'dataKey',
      });
    }

    if (wantSynopsisText && segment.sessionId === params.startingSessionId && !synopsisText && synopsisScanMaxPages > 0) {
      synopsisText = await scanOlderPagesForSynopsisText({
        token: params.credentials.token,
        sessionId: segment.sessionId,
        initialRows: rows,
        maxPages: synopsisScanMaxPages,
        pageSize: synopsisScanPageSize,
        decryptLatestSynopsisText: (rawRows) => {
          const olderSlice = decryptTranscriptReplaySlice({
            rows: rawRows,
            encryptionKey: dek,
            encryptionVariant: 'dataKey',
            maxTextChars: params.maxTextChars,
            maxDialogItems: params.limit,
          });
          return olderSlice.latestSynopsisText;
        },
      });
    }
  }

  if (dialogs.length === 0) return null;
  dialogs.sort((a, b) => a.createdAt - b.createdAt);
  const dialog = dialogs.length > params.limit ? dialogs.slice(dialogs.length - params.limit) : dialogs;
  return { dialog, sourceCutoffSeqInclusive, synopsisText };
}
