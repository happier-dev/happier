import { configuration } from '@/configuration';
import { fetchEncryptedTranscriptMessagesPage } from '@/session/replay/fetchEncryptedTranscriptMessages';
import { SessionMessageContentSchema, type SessionMessageContent } from '../types';

export type TranscriptRow = Readonly<{
  seq: number;
  createdAt: number;
  content: SessionMessageContent;
  id?: string;
  localId?: string | null;
  sidechainId?: string | null;
}>;

type RawTranscriptRow = Readonly<{
  id?: unknown;
  seq?: unknown;
  localId?: unknown;
  createdAt?: unknown;
  content?: unknown;
  sidechainId?: unknown;
}>;

export type FetchEncryptedTranscriptRangeResult =
  | Readonly<{ ok: true; rows: TranscriptRow[] }>
  | Readonly<{ ok: false; errorCode: 'window_too_large'; maxMessages: number; requestedMessages: number }>;

function parseTranscriptRows(raw: unknown): TranscriptRow[] {
  if (!Array.isArray(raw)) throw new Error('Invalid transcript messages');
  const out: TranscriptRow[] = [];
  for (const entry of raw as RawTranscriptRow[]) {
    const seq = typeof entry?.seq === 'number' && Number.isSafeInteger(entry.seq) && entry.seq >= 0 ? entry.seq : null;
    const createdAt =
      typeof entry?.createdAt === 'number' && Number.isFinite(entry.createdAt) ? Math.trunc(entry.createdAt) : null;
    if (seq === null || createdAt === null) throw new Error('Invalid transcript message row');
    const parsedContent = SessionMessageContentSchema.safeParse(entry?.content);
    if (!parsedContent.success) throw new Error('Invalid transcript message content');
    const id = typeof entry?.id === 'string' ? entry.id : undefined;
    const localId = typeof entry?.localId === 'string' ? entry.localId : null;
    out.push({
      id,
      localId,
      seq,
      createdAt,
      content: parsedContent.data,
      ...(typeof entry.sidechainId === 'string' ? { sidechainId: entry.sidechainId } : {}),
    });
  }
  return out;
}

export async function fetchEncryptedTranscriptPageAfterSeq(params: Readonly<{
  token: string;
  sessionId: string;
  afterSeq: number;
  limit: number;
  timeoutMs?: number;
  deadlineAtMs?: number;
  signal?: AbortSignal;
}>): Promise<TranscriptRow[]> {
  return parseTranscriptRows((await fetchEncryptedTranscriptMessagesPage(params)).messages);
}

export async function fetchEncryptedTranscriptPageLatest(params: Readonly<{
  token: string;
  sessionId: string;
  limit: number;
  timeoutMs?: number;
  deadlineAtMs?: number;
  signal?: AbortSignal;
}>): Promise<TranscriptRow[]> {
  return parseTranscriptRows((await fetchEncryptedTranscriptMessagesPage(params)).messages);
}

export async function fetchEncryptedTranscriptPageBeforeSeq(params: Readonly<{
  token: string;
  sessionId: string;
  beforeSeq: number;
  limit: number;
  deadlineAtMs?: number;
  signal?: AbortSignal;
}>): Promise<Readonly<{ rows: TranscriptRow[]; hasMore: boolean; nextBeforeSeq: number | null }>> {
  const page = await fetchEncryptedTranscriptMessagesPage(params);
  return { rows: parseTranscriptRows(page.messages), hasMore: page.hasMore, nextBeforeSeq: page.nextBeforeSeq };
}

export async function fetchEncryptedTranscriptRange(params: Readonly<{
  token: string;
  sessionId: string;
  seqFrom: number;
  seqTo: number;
}>): Promise<FetchEncryptedTranscriptRangeResult> {
  const seqFrom = Math.max(0, Math.trunc(params.seqFrom));
  const seqTo = Math.max(0, Math.trunc(params.seqTo));
  const requestedMessages = seqTo >= seqFrom ? (seqTo - seqFrom + 1) : 0;
  const maxMessages = configuration.memoryMaxTranscriptWindowMessages;

  if (requestedMessages <= 0) {
    return { ok: true, rows: [] };
  }

  if (requestedMessages > maxMessages) {
    return { ok: false, errorCode: 'window_too_large', maxMessages, requestedMessages };
  }

  const afterSeq = Math.max(0, seqFrom - 1);
  const limit = requestedMessages;
  const rows = await fetchEncryptedTranscriptPageAfterSeq({
    token: params.token,
    sessionId: params.sessionId,
    afterSeq,
    limit,
  });
  return { ok: true, rows };
}
