import { redactBugReportSensitiveText } from '@happier-dev/protocol/bugs/reports/redaction';
import type { MemoryExternalSnippetV1, MemoryExternalTranscriptSourceV1, MemoryWindowV1 } from '@happier-dev/protocol';
import type { AgentExternalSessionsTranscriptPage } from '@happier-dev/plugin-sdk/sessions/external';

import type { StoredCredentials } from '@/persistence';
import {
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import {
  extractMemoryIndexableTranscriptItem,
} from './transcript/extractIndexableItem';
import { normalizeMemoryContentPolicy, type MemoryContentPolicy } from './transcript/contentPolicy';
import { extractExternalMemoryTranscriptItems } from './externalTranscriptIndex';

import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import type { FetchEncryptedTranscriptMessagesPageResult } from '@/session/replay/fetchEncryptedTranscriptMessages';
import { fetchEncryptedTranscriptMessagesPage } from '@/session/replay/fetchEncryptedTranscriptMessages';
import { configuration } from '@/configuration';

type ExternalMemoryWindowRequest = Readonly<{
  source: MemoryExternalTranscriptSourceV1;
  sourceItemId: string;
  cursor?: string;
  paddingMessages: number;
  contentPolicy?: MemoryContentPolicy | null;
  signal?: AbortSignal;
  fetchExternalTranscriptPage: (request: Readonly<{ source: MemoryExternalTranscriptSourceV1; cursor?: string }>,
    signal?: AbortSignal) => Promise<AgentExternalSessionsTranscriptPage | null>;
}>;

async function getExternalMemoryWindow(params: ExternalMemoryWindowRequest): Promise<MemoryWindowV1> {
  const maxMessages = configuration.memoryMaxTranscriptWindowMessages;
  const padding = Math.min(Math.max(0, Math.trunc(params.paddingMessages)), maxMessages - 1);
  const contentPolicy = normalizeMemoryContentPolicy(params.contentPolicy);
  let cursor = params.cursor;
  const visited = new Set<string>();
  let newerContext: MemoryExternalSnippetV1[] = [];
  let before: MemoryExternalSnippetV1[] = [];
  let target: MemoryExternalSnippetV1 | undefined;
  let after: MemoryExternalSnippetV1[] = [];
  while (true) {
    params.signal?.throwIfAborted();
    const page = await params.fetchExternalTranscriptPage({ source: params.source, ...(cursor ? { cursor } : {}) }, params.signal);
    params.signal?.throwIfAborted();
    if (!page) break;
    const snippets = extractExternalMemoryTranscriptItems(page.items, contentPolicy).map(item => ({
      source: params.source, sourceItemId: item.sourceItemId, ...(cursor ? { cursor } : {}),
      createdAtMs: item.createdAtMs,
      text: `${item.role === 'user' ? 'User' : 'Assistant'}: ${redactBugReportSensitiveText(item.text).trim()}`,
    }));
    if (target) {
      // Readers page older history but return each page in transcript order.
      before = [...snippets.slice(-(padding - before.length)), ...before];
    } else {
      const index = snippets.findIndex(item => item.sourceItemId === params.sourceItemId);
      if (index >= 0) {
        target = snippets[index];
        before = snippets.slice(Math.max(0, index - padding), index);
        after = [...snippets.slice(index + 1, index + 1 + padding), ...newerContext].slice(0, padding);
      } else {
        newerContext = snippets.slice(0, padding);
      }
    }
    if (target && before.length >= padding) break;
    if (page.hasMore === false && page.truncated !== true) break;
    const next = page.nextCursor;
    if (!next) {
      if (page.hasMore === true || page.truncated === true) throw new Error('memory_external_transcript_cursor_missing');
      break;
    }
    if (next === cursor || visited.has(next)) throw new Error('memory_external_transcript_cursor_stalled');
    visited.add(next);
    cursor = next;
  }
  return { v: 1, snippets: [], citations: [], externalSnippets: target
    ? [...before, target, ...after.slice(0, Math.max(0, maxMessages - before.length - 1))] : [] };
}

type SessionMemoryWindowRequest = Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  seqFrom: number;
  seqTo: number;
  paddingMessages: number;
  contentPolicy?: MemoryContentPolicy | null;
  signal?: AbortSignal;
  deps?: Readonly<{
    fetchSessionById: (args: Readonly<{ token: string; sessionId: string; signal?: AbortSignal }>) => Promise<RawSessionRecord | null>;
    fetchEncryptedTranscriptMessagesPage?: (args: Readonly<{
      token: string;
      sessionId: string;
      limit: number;
      afterSeq?: number;
      scope?: 'main' | 'sidechain' | 'all';
      signal?: AbortSignal;
    }>) => Promise<FetchEncryptedTranscriptMessagesPageResult>;
  }>;
}>;

export async function getMemoryWindow(params: SessionMemoryWindowRequest | ExternalMemoryWindowRequest): Promise<MemoryWindowV1> {
  if ('source' in params) return await getExternalMemoryWindow(params);
  const fetchSession = params.deps?.fetchSessionById ?? fetchSessionById;
  const fetchPage = params.deps?.fetchEncryptedTranscriptMessagesPage ?? fetchEncryptedTranscriptMessagesPage;

  const sessionId = String(params.sessionId ?? '').trim();
  const seqFrom = Math.max(0, Math.trunc(params.seqFrom));
  const seqTo = Math.max(0, Math.trunc(params.seqTo));
  const padding = Math.max(0, Math.trunc(params.paddingMessages));

  const paddedFrom = Math.max(0, seqFrom - padding);
  const paddedTo = seqTo + padding;
  const maxMessages = configuration.memoryMaxTranscriptWindowMessages;
  const requestedMessages = paddedTo >= paddedFrom ? paddedTo - paddedFrom + 1 : 0;

  const effectiveFrom = paddedFrom;
  const effectiveTo = requestedMessages > maxMessages ? Math.max(effectiveFrom, effectiveFrom + maxMessages - 1) : paddedTo;

  params.signal?.throwIfAborted();
  const rawSession = await fetchSession({ token: params.credentials.token, sessionId, ...(params.signal ? { signal: params.signal } : {}) });
  params.signal?.throwIfAborted();
  if (!rawSession) {
    return {
      v: 1,
      snippets: [],
      citations: [{ sessionId, seqFrom, seqTo }],
    };
  }

  const ctx = resolveSessionEncryptionContextFromCredentials(params.credentials, rawSession);
  if (resolveSessionStoredContentEncryptionMode(rawSession) === 'e2ee' && !ctx) {
    throw Object.assign(new Error('Session encryption material is unavailable'), {
      code: 'encryption_material_unavailable',
    });
  }
  const page = await fetchPage({
    token: params.credentials.token,
    sessionId,
    afterSeq: Math.max(0, effectiveFrom - 1),
    limit: Math.max(1, effectiveTo - effectiveFrom + 1),
    scope: 'main',
    ...(params.signal ? { signal: params.signal } : {}),
  });
  params.signal?.throwIfAborted();
  const rows = page.messages.filter((row) => {
    const seq = typeof row.seq === 'number' && Number.isFinite(row.seq) ? Math.trunc(row.seq) : null;
    return seq !== null && seq >= effectiveFrom && seq <= effectiveTo;
  });
  const lines: string[] = [];
  const itemCreatedAtMs: number[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const item = extractMemoryIndexableTranscriptItem({
      sessionId,
      row,
      index,
      ctx,
      contentPolicy: params.contentPolicy,
    });
    if (!item) continue;
    const prefix = item.role === 'user' ? 'User' : 'Assistant';
    lines.push(`${prefix}: ${redactBugReportSensitiveText(item.text).trim()}`);
    itemCreatedAtMs.push(item.createdAtMs);
  }

  const createdAtFromMs = itemCreatedAtMs.length > 0 ? itemCreatedAtMs[0]! : 0;
  const createdAtToMs = itemCreatedAtMs.length > 0 ? itemCreatedAtMs[itemCreatedAtMs.length - 1]! : 0;
  const text = lines.join('\n');

  return {
    v: 1,
    snippets: text
      ? [
          {
            sessionId,
            seqFrom: effectiveFrom,
            seqTo: effectiveTo,
            createdAtFromMs,
            createdAtToMs,
            text,
          },
        ]
      : [],
    citations: [{ sessionId, seqFrom, seqTo }],
  };
}
