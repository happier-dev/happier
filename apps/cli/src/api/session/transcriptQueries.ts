import axios from 'axios';

import { resolveLatestPermissionIntent } from '@happier-dev/agents';

import { logger } from '@/ui/logger';
import { resolveServerHttpBaseUrl } from '../client/serverHttpBaseUrl';
import { isAuthenticationError } from '../client/httpStatusError';
import { serializeAxiosErrorForLog } from '../client/serializeAxiosErrorForLog';

import { decodeBase64, decrypt } from '../encryption';
import { SessionMessageContentSchema, type PermissionMode } from '../types';
import { extractSemanticTranscriptItem } from '@/session/services/transcript/extractSemanticTranscriptItem';
import type { TranscriptRawRow } from '@/session/services/transcript/semanticTranscriptItem';

export { pageSessionTranscript } from './pageSessionTranscript';
export { readSessionTranscriptAfter } from './readSessionTranscriptAfter';
export { searchSessionTranscript } from './searchSessionTranscript';
export { importSessionTranscript } from './importSessionTranscript';
export {
  DEFAULT_SESSION_TRANSCRIPT_FOLLOW_LEASE_IDLE_TTL_MS,
  createSessionTranscriptFollowLeaseRegistry,
  followSessionTranscript,
  type SessionTranscriptFollowLeaseRegistry,
} from './followSessionTranscript';

type EncryptionVariant = 'legacy' | 'dataKey';

type SessionTranscriptQueryParams = {
  token: string;
  sessionId: string;
  encryptionKey: Uint8Array;
  encryptionVariant: EncryptionVariant;
};

function normalizeTake(value: number | undefined, max: number): number {
  if (typeof value !== 'number' || value <= 0) return max;
  return Math.min(value, max);
}

function logTranscriptQueryFailure(message: string, error: unknown): void {
  logger.debug(message, { error: serializeAxiosErrorForLog(error) });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readMessageCreatedAt(row: unknown): number | null {
  const createdAt = asRecord(row)?.createdAt;
  return typeof createdAt === 'number' && Number.isFinite(createdAt)
    ? Math.trunc(createdAt)
    : null;
}

function readDecryptedMessageRecord(
  row: unknown,
  params: Pick<SessionTranscriptQueryParams, 'encryptionKey' | 'encryptionVariant'>,
): Record<string, unknown> | null {
  const rowRecord = asRecord(row);
  const parsedContent = SessionMessageContentSchema.safeParse(rowRecord?.content);
  if (!parsedContent.success) return null;

  const decrypted: unknown = parsedContent.data.t === 'plain'
    ? parsedContent.data.v
    : decrypt(
      params.encryptionKey,
      params.encryptionVariant,
      decodeBase64(parsedContent.data.c),
    );
  return asRecord(decrypted);
}

function readMessageLocalId(row: unknown, decrypted: Record<string, unknown> | null): string | null {
  return readString(asRecord(row)?.localId) ?? readString(decrypted?.localId);
}

async function fetchTranscriptMessagesForContinuation(
  params: SessionTranscriptQueryParams & { take?: number },
  logMessage: string,
): Promise<ReadonlyArray<unknown> | null> {
  const take = normalizeTake(params.take, 100);
  const serverUrl = resolveServerHttpBaseUrl();

  try {
    const response = await axios.get(`${serverUrl}/v1/sessions/${params.sessionId}/messages`, {
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      params: { limit: take, roles: 'user,agent' },
      timeout: 10_000,
    });

    const data = response?.data as unknown;
    const raw = asRecord(data)?.messages;
    return Array.isArray(raw) ? raw : [];
  } catch (error) {
    if (isAuthenticationError(error)) throw error;
    logTranscriptQueryFailure(logMessage, error);
    return null;
  }
}

type TranscriptTextItem = Readonly<{
  role: 'user' | 'agent';
  text: string;
  createdAt: number;
  row: unknown;
  decrypted: Record<string, unknown> | null;
}>;

function extractContinuationTextItem(
  row: TranscriptRawRow,
  index: number,
  params: Pick<SessionTranscriptQueryParams, 'encryptionKey' | 'encryptionVariant'>,
): TranscriptTextItem | null {
  const extracted = extractSemanticTranscriptItem({
    row,
    index,
    ctx: {
      encryptionKey: params.encryptionKey,
      encryptionVariant: params.encryptionVariant,
    },
    options: {
      mode: 'transcript',
      transcriptRoles: ['user', 'assistant'],
      maxTextChars: null,
    },
  }).item;
  if (!extracted?.text || (extracted.role !== 'user' && extracted.role !== 'assistant')) return null;
  const createdAt = readMessageCreatedAt(row);
  if (createdAt === null) return null;
  return {
    role: extracted.role === 'user' ? 'user' : 'agent',
    text: extracted.text,
    createdAt,
    row,
    decrypted: readDecryptedMessageRecord(row, params),
  };
}

export async function fetchRecentTranscriptTextItemsForAcpImportFromServer(
  params: SessionTranscriptQueryParams & { take?: number },
): Promise<Array<{ role: 'user' | 'agent'; text: string }>> {
  const take = normalizeTake(params.take, 150);
  const serverUrl = resolveServerHttpBaseUrl();

  try {
    const response = await axios.get(`${serverUrl}/v1/sessions/${params.sessionId}/messages`, {
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      params: { limit: take, roles: 'user,agent' },
      timeout: 10_000,
    });

    const data = response?.data as unknown;
    const raw = data && typeof data === 'object' ? (data as Record<string, unknown>).messages : null;
    if (!Array.isArray(raw)) return [];

    const items: Array<{ role: 'user' | 'agent'; text: string; createdAt: number }> = [];

    for (let index = 0; index < raw.length && items.length < take; index += 1) {
      const msg = raw[index];
      const extracted = extractSemanticTranscriptItem({
        row: msg,
        index,
        ctx: {
          encryptionKey: params.encryptionKey,
          encryptionVariant: params.encryptionVariant,
        },
        options: {
          mode: 'transcript',
          transcriptRoles: ['user', 'assistant'],
          maxTextChars: null,
        },
      }).item;
      if (!extracted?.text || (extracted.role !== 'user' && extracted.role !== 'assistant')) continue;
      items.push({
        role: extracted.role === 'user' ? 'user' : 'agent',
        text: extracted.text,
        createdAt: extracted.createdAt,
      });
    }

    // API returns newest first; normalize to chronological.
    items.sort((a, b) => a.createdAt - b.createdAt);
    return items.map((item) => ({ role: item.role, text: item.text }));
  } catch (error) {
    if (isAuthenticationError(error)) throw error;
    logTranscriptQueryFailure('[API] Failed to fetch transcript messages for ACP import', error);
    return [];
  }
}

export async function fetchLatestUserPermissionIntentFromEncryptedTranscript(
  params: SessionTranscriptQueryParams & { take?: number },
): Promise<{ intent: PermissionMode; updatedAt: number } | null> {
  const take = normalizeTake(params.take, 200);
  const serverUrl = resolveServerHttpBaseUrl();

  try {
    const response = await axios.get(`${serverUrl}/v1/sessions/${params.sessionId}/messages`, {
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      params: { limit: take, role: 'user' },
      timeout: 10_000,
    });

    const data = response?.data as unknown;
    const raw = data && typeof data === 'object' ? (data as Record<string, unknown>).messages : null;
    if (!Array.isArray(raw)) return null;

    const sliced = raw.slice(0, take);
    const candidates: Array<{ rawMode: unknown; updatedAt: unknown }> = [];

    for (const msg of sliced) {
      const createdAt = typeof msg?.createdAt === 'number' ? msg.createdAt : null;
      if (createdAt === null) continue;
      const content = msg?.content;
      const parsedContent = SessionMessageContentSchema.safeParse(content);
      if (!parsedContent.success) continue;

      let decrypted: unknown;
      if (parsedContent.data.t === 'plain') {
        decrypted = parsedContent.data.v;
      } else {
        decrypted = decrypt(
          params.encryptionKey,
          params.encryptionVariant,
          decodeBase64(parsedContent.data.c),
        );
      }
      const decryptedObj = decrypted && typeof decrypted === 'object' ? (decrypted as Record<string, unknown>) : null;
      if (decryptedObj?.role !== 'user') continue;
      const body = decryptedObj.content;
      const bodyObj = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
      if (bodyObj?.type !== 'text' || typeof bodyObj.text !== 'string' || bodyObj.text.trim().length === 0) continue;

      const meta = decryptedObj?.meta;
      const rawMode = meta && typeof meta === 'object' ? (meta as Record<string, unknown>).permissionMode : null;
      if (typeof rawMode !== 'string' || rawMode.trim().length === 0) continue;

      candidates.push({ rawMode, updatedAt: createdAt });
    }

    const resolved = resolveLatestPermissionIntent(candidates);
    if (!resolved) return null;
    return { intent: resolved.intent as PermissionMode, updatedAt: resolved.updatedAt };
  } catch (error) {
    if (isAuthenticationError(error)) throw error;
    logTranscriptQueryFailure('[API] Failed to fetch transcript messages for permission intent resolution', error);
    return null;
  }
}

export async function hasCommittedUserMessageAfterMs(params: Readonly<{
  token: string;
  sessionId: string;
  failureAtMs: number;
  take?: number;
}>): Promise<boolean> {
  const take = normalizeTake(params.take, 25);
  const failureAtMs = Number.isFinite(params.failureAtMs)
    ? Math.max(0, Math.trunc(params.failureAtMs))
    : 0;
  const serverUrl = resolveServerHttpBaseUrl();

  try {
    const response = await axios.get(`${serverUrl}/v1/sessions/${params.sessionId}/messages`, {
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      params: { limit: take, role: 'user' },
      timeout: 10_000,
    });

    const data = response?.data as unknown;
    const raw = data && typeof data === 'object' ? (data as Record<string, unknown>).messages : null;
    if (!Array.isArray(raw)) return false;

    return raw.some((msg) => {
      const createdAt = typeof msg?.createdAt === 'number' && Number.isFinite(msg.createdAt)
        ? Math.trunc(msg.createdAt)
        : null;
      return createdAt !== null && createdAt > failureAtMs;
    });
  } catch (error) {
    if (isAuthenticationError(error)) throw error;
    logTranscriptQueryFailure('[API] Failed to fetch transcript messages for continuation recovery suppression', error);
    return false;
  }
}

export type LatestCommittedUserTextBeforeFailure = Readonly<{
  text: string;
  localId: string | null;
  createdAt: number;
  permissionMode: string | null;
  model: string | null;
}>;

export async function fetchLatestCommittedUserTextAtOrBeforeMs(
  params: SessionTranscriptQueryParams & { failureAtMs: number; take?: number },
): Promise<LatestCommittedUserTextBeforeFailure | null> {
  const failureAtMs = Number.isFinite(params.failureAtMs)
    ? Math.max(0, Math.trunc(params.failureAtMs))
    : 0;
  const raw = await fetchTranscriptMessagesForContinuation(
    params,
    '[API] Failed to fetch transcript messages for original user message retry',
  );
  if (!raw) return null;

  const candidates = raw
    .map((row, index) => extractContinuationTextItem(row as TranscriptRawRow, index, params))
    .filter((item): item is TranscriptTextItem => Boolean(item))
    .filter((item) => item.role === 'user' && item.createdAt <= failureAtMs && item.text.trim().length > 0)
    .sort((a, b) => b.createdAt - a.createdAt);
  const latest = candidates[0];
  if (!latest) return null;

  const meta = asRecord(latest.decrypted?.meta);
  return {
    text: latest.text,
    localId: readMessageLocalId(latest.row, latest.decrypted),
    createdAt: latest.createdAt,
    permissionMode: readString(meta?.permissionMode),
    model: readString(meta?.model),
  };
}

export type CommittedProviderActivityAfterUserPromptEvidence =
  | Readonly<{ status: 'activity_found'; userPromptAtMs: number; providerActivityAtMs: number }>
  | Readonly<{ status: 'no_activity_found'; userPromptAtMs: number }>
  | Readonly<{ status: 'unknown' }>;

export async function detectCommittedProviderActivityAfterLatestUserPrompt(
  params: SessionTranscriptQueryParams & { failureAtMs: number; take?: number },
): Promise<CommittedProviderActivityAfterUserPromptEvidence> {
  const failureAtMs = Number.isFinite(params.failureAtMs)
    ? Math.max(0, Math.trunc(params.failureAtMs))
    : 0;
  const raw = await fetchTranscriptMessagesForContinuation(
    params,
    '[API] Failed to fetch transcript messages for continuation provider-activity evidence',
  );
  if (!raw) return { status: 'unknown' };

  const items = raw
    .map((row, index) => extractContinuationTextItem(row as TranscriptRawRow, index, params))
    .filter((item): item is TranscriptTextItem => Boolean(item));
  const latestUser = items
    .filter((item) => item.role === 'user' && item.createdAt <= failureAtMs)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!latestUser) return { status: 'unknown' };

  const providerActivity = items
    .filter((item) => item.role === 'agent' && item.createdAt > latestUser.createdAt)
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  if (!providerActivity) {
    return { status: 'no_activity_found', userPromptAtMs: latestUser.createdAt };
  }
  return {
    status: 'activity_found',
    userPromptAtMs: latestUser.createdAt,
    providerActivityAtMs: providerActivity.createdAt,
  };
}
