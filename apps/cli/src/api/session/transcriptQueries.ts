import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import axios from 'axios';

import { resolveLatestPermissionIntent } from '@happier-dev/agents';
import { isAgentThreadTextConversationTurnMeta } from '@happier-dev/protocol';

import { logger } from '@/ui/logger';
import { resolveServerHttpBaseUrl } from '../client/serverHttpBaseUrl';
import { isAuthenticationError } from '../client/httpStatusError';
import { serializeAxiosErrorForLog } from '../client/serializeAxiosErrorForLog';

import { decodeBase64, decrypt } from '../encryption';
import { SessionMessageContentSchema, type PermissionMode, type SessionMessageContent } from '../types';
import { extractSemanticTranscriptItem } from '@/session/services/transcript/extractSemanticTranscriptItem';
import {
  createSessionTranscriptStoredContentUnavailableError,
  resolveSessionTranscriptStoredContentUnavailableError,
  throwIfSessionTranscriptStoredContentUnavailableResponse,
} from './sessionTranscriptStoredContentUnavailable';

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

type SessionTranscriptQueryParams = Readonly<{
  token: string;
  sessionId: string;
}> & (
  | Readonly<{
      encryptionMode: 'plain';
      encryptionKey?: never;
      encryptionVariant?: never;
    }>
  | Readonly<{
      encryptionMode: 'e2ee';
      encryptionKey: Uint8Array;
      encryptionVariant: EncryptionVariant;
    }>
);

function normalizeTake(value: number | undefined, max: number): number {
  if (typeof value !== 'number' || value <= 0) return max;
  return Math.min(value, max);
}

function logTranscriptQueryFailure(message: string, error: unknown): void {
  logger.debug(message, { error: serializeAxiosErrorForLog(error) });
}

type AvailableTranscriptRow = Readonly<{
  row: Record<string, unknown>;
  content: SessionMessageContent;
}>;

function requireAvailableTranscriptRows(raw: unknown): AvailableTranscriptRow[] {
  if (!Array.isArray(raw)) {
    throw createSessionTranscriptStoredContentUnavailableError();
  }
  const available: AvailableTranscriptRow[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw createSessionTranscriptStoredContentUnavailableError();
    }
    const record = row as Record<string, unknown>;
    const content = SessionMessageContentSchema.safeParse(record.content);
    if (!content.success) throw createSessionTranscriptStoredContentUnavailableError();
    available.push({ row: record, content: content.data });
  }
  return available;
}

function rethrowUnavailableTranscriptQueryError(error: unknown): void {
  const unavailable = resolveSessionTranscriptStoredContentUnavailableError(error);
  if (unavailable) throw unavailable;
}


export async function fetchRecentTranscriptTextItemsForAcpImportFromServer(
  params: SessionTranscriptQueryParams & { take?: number },
): Promise<Array<{ role: 'user' | 'agent'; text: string }>> {
  const take = normalizeTake(params.take, 150);
  const serverUrl = resolveServerHttpBaseUrl();

  try {
    const response = await axios.get(`${serverUrl}/v1/sessions/${params.sessionId}/messages`, {
      headers: {
        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      params: { limit: take, roles: 'user,agent' },
      timeout: 10_000,
    });
    throwIfSessionTranscriptStoredContentUnavailableResponse(response.status, response.data);

    const data = response?.data as unknown;
    const raw = data && typeof data === 'object' ? (data as Record<string, unknown>).messages : null;
    const rows = requireAvailableTranscriptRows(raw);

    const items: Array<{ role: 'user' | 'agent'; text: string; createdAt: number }> = [];

    for (let index = 0; index < rows.length && items.length < take; index += 1) {
      const msg = rows[index].row;
      const extracted = extractSemanticTranscriptItem({
        row: msg,
        index,
        ctx: params.encryptionMode === 'plain'
          ? null
          : {
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
      if (!isAgentThreadTextConversationTurnMeta({
        happier: {
          conversationTurnOriginV1: extracted.origin,
        },
      })) continue;
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
    rethrowUnavailableTranscriptQueryError(error);
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
        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      params: { limit: take, role: 'user' },
      timeout: 10_000,
    });
    throwIfSessionTranscriptStoredContentUnavailableResponse(response.status, response.data);

    const data = response?.data as unknown;
    const raw = data && typeof data === 'object' ? (data as Record<string, unknown>).messages : null;
    const rows = requireAvailableTranscriptRows(raw);

    const sliced = rows.slice(0, take);
    const candidates: Array<{ rawMode: unknown; updatedAt: unknown }> = [];

    for (const { row: msg, content } of sliced) {
      const createdAt = typeof msg?.createdAt === 'number' ? msg.createdAt : null;
      if (createdAt === null) continue;

      let decrypted: unknown;
      if (content.t === 'plain') {
        if (params.encryptionMode !== 'plain') continue;
        decrypted = content.v;
      } else {
        if (params.encryptionMode === 'plain') continue;
        decrypted = decrypt(
          params.encryptionKey,
          params.encryptionVariant,
          decodeBase64(content.c),
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
    rethrowUnavailableTranscriptQueryError(error);
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
        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      params: { limit: take, role: 'user' },
      timeout: 10_000,
    });
    throwIfSessionTranscriptStoredContentUnavailableResponse(response.status, response.data);

    const data = response?.data as unknown;
    const raw = data && typeof data === 'object' ? (data as Record<string, unknown>).messages : null;
    const rows = requireAvailableTranscriptRows(raw);

    return rows.some(({ row: msg }) => {
      const createdAt = typeof msg?.createdAt === 'number' && Number.isFinite(msg.createdAt)
        ? Math.trunc(msg.createdAt)
        : null;
      return createdAt !== null && createdAt > failureAtMs;
    });
  } catch (error) {
    if (isAuthenticationError(error)) throw error;
    rethrowUnavailableTranscriptQueryError(error);
    logTranscriptQueryFailure('[API] Failed to fetch transcript messages for continuation recovery suppression', error);
    throw error;
  }
}
