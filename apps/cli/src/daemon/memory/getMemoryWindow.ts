import { redactBugReportSensitiveText, type MemoryWindowV1 } from '@happier-dev/protocol';

import type { StoredCredentials } from '@/persistence';
import {
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import {
  extractMemoryIndexableTranscriptItem,
} from './transcript/extractIndexableItem';
import type { MemoryContentPolicy } from './transcript/contentPolicy';

import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import type { FetchEncryptedTranscriptMessagesPageResult } from '@/session/replay/fetchEncryptedTranscriptMessages';
import { fetchEncryptedTranscriptMessagesPage } from '@/session/replay/fetchEncryptedTranscriptMessages';
import { configuration } from '@/configuration';

export async function getMemoryWindow(params: Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  seqFrom: number;
  seqTo: number;
  paddingMessages: number;
  contentPolicy?: MemoryContentPolicy | null;
  deps?: Readonly<{
    fetchSessionById: (args: Readonly<{ token: string; sessionId: string }>) => Promise<RawSessionRecord | null>;
    fetchEncryptedTranscriptMessagesPage?: (args: Readonly<{
      token: string;
      sessionId: string;
      limit: number;
      afterSeq?: number;
      scope?: 'main' | 'sidechain' | 'all';
    }>) => Promise<FetchEncryptedTranscriptMessagesPageResult>;
  }>;
}>): Promise<MemoryWindowV1> {
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

  const rawSession = await fetchSession({ token: params.credentials.token, sessionId });
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
  });
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
