import {
  fetchTranscriptSemanticPage,
  type FetchTranscriptRawPage,
} from '@/session/services/transcript/fetchTranscriptSemanticPage';
import type { SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionEncryptionContext';

import { normalizeMemoryContentPolicy, type MemoryContentPolicy } from './contentPolicy';
import { mapSemanticTranscriptItemToMemoryIndexable } from './extractIndexableItem';
import type { MemoryIndexableTranscriptItem } from './indexableItem';

export type FetchMemorySemanticTranscriptPageResult = Readonly<{
  items: readonly MemoryIndexableTranscriptItem[];
  nextCursor: string | null;
  hasMore: boolean;
  diagnostics: Readonly<{
    rawRowsScanned: number;
    pagesFetched: number;
    scanLimitReached: boolean;
    payloadTruncations: number;
    semanticRowsFound: number;
  }>;
}>;

export async function fetchMemorySemanticTranscriptPage(params: Readonly<{
  token: string;
  sessionId: string;
  contentContext: SessionStoredContentCryptoContext;
  limit: number;
  rawPageLimit: number;
  maxRawRowsToScan: number;
  direction: 'before' | 'after';
  beforeSeq?: number;
  afterSeq?: number;
  scope?: 'main' | 'sidechain' | 'all';
  sidechainId?: string | null;
  contentPolicy?: MemoryContentPolicy | null;
  fetchPage?: FetchTranscriptRawPage;
  signal?: AbortSignal;
}>): Promise<FetchMemorySemanticTranscriptPageResult> {
  const policy = normalizeMemoryContentPolicy(params.contentPolicy);
  // Home includes legacy unclassified (null-role) rows in any role filter that
  // contains `user` (`buildRequestedMessageRoleWhere`), so this one read also
  // carries released clients' rows; event rows stay excluded.
  const page = await fetchTranscriptSemanticPage({
    token: params.token,
    sessionId: params.sessionId,
    contentContext: params.contentContext,
    limit: params.limit,
    rawPageLimit: params.rawPageLimit,
    maxRawRowsToScan: params.maxRawRowsToScan,
    direction: params.direction,
    ...(params.direction === 'before' && typeof params.beforeSeq === 'number' ? { cursor: String(params.beforeSeq) } : {}),
    ...(params.direction === 'after' && typeof params.afterSeq === 'number' ? { cursor: String(params.afterSeq) } : {}),
    scope: params.scope ?? 'main',
    ...(params.sidechainId ? { sidechainId: params.sidechainId } : {}),
    serverRoles: ['user', 'agent'],
    mode: 'transcript',
    transcriptRoles: ['user', 'assistant'],
    includeReasoning: policy.includeReasoning,
    includeTools: policy.includeToolSummaries || policy.includeToolOutputs,
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.fetchPage ? { fetchPage: params.fetchPage } : {}),
  });
  const items = page.items
    .map((item) => mapSemanticTranscriptItemToMemoryIndexable({
      sessionId: params.sessionId,
      item,
      contentPolicy: params.contentPolicy,
    }))
    .filter((item): item is MemoryIndexableTranscriptItem => item !== null);

  return {
    items,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    diagnostics: {
      ...page.diagnostics,
      semanticRowsFound: items.length,
    },
  };
}
