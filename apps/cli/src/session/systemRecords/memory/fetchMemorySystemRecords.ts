import type {
  SessionSummaryShardV1,
  SessionSynopsisV1,
  SessionSystemRecord,
} from '@happier-dev/protocol';

import type {
  SessionEncryptionContext,
  SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import {
  fetchLatestSessionSystemRecord,
  fetchSessionSystemRecordsPage,
  type FetchSessionSystemRecordsPageResult,
} from '@/session/transport/http/sessionSystemRecordsHttp';

import {
  MEMORY_SYSTEM_RECORD_KINDS,
  MEMORY_SYSTEM_RECORD_NAMESPACE,
  type MemorySystemRecordPayload,
  openMemorySystemRecordPayload,
} from './memorySystemRecords';

export type FetchMemorySummaryShardSystemRecordsDeps = Readonly<{
  fetchSessionSystemRecordsPage: typeof fetchSessionSystemRecordsPage;
}>;

export type FetchLatestMemorySynopsisSystemRecordDeps = Readonly<{
  fetchLatestSessionSystemRecord: typeof fetchLatestSessionSystemRecord;
}>;

function isSummaryShardPayload(payload: MemorySystemRecordPayload | null): payload is SessionSummaryShardV1 {
  return Boolean(payload && 'summary' in payload && 'createdAtFromMs' in payload);
}

function isSynopsisPayload(payload: MemorySystemRecordPayload | null): payload is SessionSynopsisV1 {
  return Boolean(payload && 'synopsis' in payload && 'updatedAtMs' in payload);
}

export async function fetchMemorySummaryShardSystemRecords(params: Readonly<{
  token: string;
  sessionId: string;
  mode: SessionStoredContentEncryptionMode;
  ctx?: SessionEncryptionContext;
  limit?: number;
  fetchSessionSystemRecordsPage?: FetchMemorySummaryShardSystemRecordsDeps['fetchSessionSystemRecordsPage'];
}>): Promise<SessionSummaryShardV1[]> {
  const fetchPage = params.fetchSessionSystemRecordsPage ?? fetchSessionSystemRecordsPage;
  const out: SessionSummaryShardV1[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  while (true) {
    const page: FetchSessionSystemRecordsPageResult = await fetchPage({
      token: params.token,
      sessionId: params.sessionId,
      namespace: MEMORY_SYSTEM_RECORD_NAMESPACE,
      kind: MEMORY_SYSTEM_RECORD_KINDS.summaryShard,
      ...(cursor ? { cursor } : {}),
      limit: params.limit ?? 100,
    });

    for (const record of page.records) {
      const payload = openMemorySystemRecordPayload({
        namespace: record.namespace,
        kind: MEMORY_SYSTEM_RECORD_KINDS.summaryShard,
        content: record.content,
        ctx: params.ctx,
      });
      if (isSummaryShardPayload(payload)) {
        out.push(payload);
      }
    }

    if (!page.hasNext || !page.nextCursor) break;
    if (seenCursors.has(page.nextCursor)) break;
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  return out;
}

export async function fetchLatestMemorySynopsisSystemRecord(params: Readonly<{
  token: string;
  sessionId: string;
  mode: SessionStoredContentEncryptionMode;
  ctx?: SessionEncryptionContext;
  fetchLatestSessionSystemRecord?: FetchLatestMemorySynopsisSystemRecordDeps['fetchLatestSessionSystemRecord'];
}>): Promise<SessionSynopsisV1 | null> {
  const fetchLatest = params.fetchLatestSessionSystemRecord ?? fetchLatestSessionSystemRecord;
  const record: SessionSystemRecord | null = await fetchLatest({
    token: params.token,
    sessionId: params.sessionId,
    namespace: MEMORY_SYSTEM_RECORD_NAMESPACE,
    kind: MEMORY_SYSTEM_RECORD_KINDS.synopsis,
  });
  if (!record) return null;
  const payload = openMemorySystemRecordPayload({
    namespace: record.namespace,
    kind: MEMORY_SYSTEM_RECORD_KINDS.synopsis,
    content: record.content,
    ctx: params.ctx,
  });
  return isSynopsisPayload(payload) ? payload : null;
}
