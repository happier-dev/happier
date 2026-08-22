import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import axios from 'axios';

import { createAuthenticationHttpStatusError, isAuthenticationStatus } from '@/api/client/httpStatusError';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { SessionMessageContentSchema, type SessionMessageContent } from '../types';
import {
  createSessionTranscriptStoredContentUnavailableError,
  throwIfSessionTranscriptStoredContentUnavailableResponse,
} from './sessionTranscriptStoredContentUnavailable';

export type TranscriptRow = Readonly<{
  seq: number;
  createdAt: number;
  content: SessionMessageContent;
  id?: string;
  localId?: string | null;
}>;

type RawTranscriptRow = Readonly<{
  id?: unknown;
  seq?: unknown;
  localId?: unknown;
  createdAt?: unknown;
  content?: unknown;
}>;

const DEFAULT_TRANSCRIPT_FETCH_TIMEOUT_MS = 10_000;

function resolveTranscriptFetchTimeoutMs(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.trunc(value))
    : DEFAULT_TRANSCRIPT_FETCH_TIMEOUT_MS;
}

export type FetchEncryptedTranscriptRangeResult =
  | Readonly<{ ok: true; rows: TranscriptRow[] }>
  | Readonly<{ ok: false; errorCode: 'window_too_large'; maxMessages: number; requestedMessages: number }>;

function parseTranscriptRows(raw: unknown): TranscriptRow[] {
  if (!Array.isArray(raw)) throw createSessionTranscriptStoredContentUnavailableError();
  const out: TranscriptRow[] = [];
  for (const entry of raw as RawTranscriptRow[]) {
    const seq = typeof entry?.seq === 'number' && Number.isFinite(entry.seq) ? Math.trunc(entry.seq) : null;
    const createdAt =
      typeof entry?.createdAt === 'number' && Number.isFinite(entry.createdAt) ? Math.trunc(entry.createdAt) : null;
    if (
      seq === null
      || createdAt === null
      || (entry.id !== undefined && typeof entry.id !== 'string')
      || (entry.localId !== undefined && entry.localId !== null && typeof entry.localId !== 'string')
    ) {
      throw createSessionTranscriptStoredContentUnavailableError();
    }
    const parsedContent = SessionMessageContentSchema.safeParse(entry?.content);
    if (!parsedContent.success) throw createSessionTranscriptStoredContentUnavailableError();
    const id = typeof entry?.id === 'string' ? entry.id : undefined;
    const localId = typeof entry?.localId === 'string' ? entry.localId : null;
    out.push({
      id,
      localId,
      seq,
      createdAt,
      content: parsedContent.data,
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
}>): Promise<TranscriptRow[]> {
  const serverUrl = resolveServerHttpBaseUrl();
  const response = await axios.get(`${serverUrl}/v1/sessions/${params.sessionId}/messages`, {
    headers: {
      ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    params: { afterSeq: params.afterSeq, limit: params.limit },
    timeout: resolveTranscriptFetchTimeoutMs(params.timeoutMs),
    validateStatus: () => true,
  });

  if (isAuthenticationStatus(response.status)) {
    throw createAuthenticationHttpStatusError(response.status, 'Authentication failed while fetching transcript messages');
  }
  throwIfSessionTranscriptStoredContentUnavailableResponse(response.status, response.data);
  if (response.status !== 200) {
    throw new Error(`Unexpected status from /v1/sessions/:id/messages: ${response.status}`);
  }

  return parseTranscriptRows((response.data as any)?.messages);
}

export async function fetchEncryptedTranscriptPageLatest(params: Readonly<{
  token: string;
  sessionId: string;
  limit: number;
  timeoutMs?: number;
}>): Promise<TranscriptRow[]> {
  const serverUrl = resolveServerHttpBaseUrl();
  const response = await axios.get(`${serverUrl}/v1/sessions/${params.sessionId}/messages`, {
    headers: {
      ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    params: { limit: params.limit },
    timeout: resolveTranscriptFetchTimeoutMs(params.timeoutMs),
    validateStatus: () => true,
  });

  if (isAuthenticationStatus(response.status)) {
    throw createAuthenticationHttpStatusError(response.status, 'Authentication failed while fetching transcript messages');
  }
  throwIfSessionTranscriptStoredContentUnavailableResponse(response.status, response.data);
  if (response.status !== 200) {
    throw new Error(`Unexpected status from /v1/sessions/:id/messages: ${response.status}`);
  }

  return parseTranscriptRows((response.data as any)?.messages);
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
