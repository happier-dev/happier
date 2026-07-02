import {
  fetchTranscriptSemanticPage,
  type FetchTranscriptRawPage,
} from '@/session/services/transcript/fetchTranscriptSemanticPage';
import { fetchEncryptedTranscriptMessagesPage } from '@/session/replay/fetchEncryptedTranscriptMessages';

import type { MemoryContentPolicy } from './contentPolicy';
import { mapSemanticTranscriptItemToMemoryIndexable } from './extractIndexableItem';
import type { MemoryIndexableTranscriptItem } from './indexableItem';
import { isLegacyUnclassifiedTranscriptRow } from './legacyUnclassifiedTranscriptRows';

type MemorySemanticTranscriptContext = Readonly<{
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
}>;

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
  ctx: MemorySemanticTranscriptContext;
  limit: number;
  rawPageLimit: number;
  maxRawRowsToScan: number;
  direction: 'before' | 'after';
  beforeSeq?: number;
  afterSeq?: number;
  scope?: 'main' | 'sidechain' | 'all';
  sidechainId?: string | null;
  contentPolicy?: MemoryContentPolicy | null;
  includeLegacyUnknownRoleFallback?: boolean;
  fetchPage?: FetchTranscriptRawPage;
}>): Promise<FetchMemorySemanticTranscriptPageResult> {
  const fetchSemanticPage = async (
    serverRoles: readonly ['user', 'agent'] | undefined,
    fetchPage: FetchTranscriptRawPage | undefined = params.fetchPage,
  ) => await fetchTranscriptSemanticPage({
    token: params.token,
    sessionId: params.sessionId,
    ctx: params.ctx,
    limit: params.limit,
    rawPageLimit: params.rawPageLimit,
    maxRawRowsToScan: params.maxRawRowsToScan,
    direction: params.direction,
    ...(params.direction === 'before' && typeof params.beforeSeq === 'number' ? { cursor: String(params.beforeSeq) } : {}),
    ...(params.direction === 'after' && typeof params.afterSeq === 'number' ? { cursor: String(params.afterSeq) } : {}),
    scope: params.scope ?? 'main',
    ...(params.sidechainId ? { sidechainId: params.sidechainId } : {}),
    ...(serverRoles ? { serverRoles } : {}),
    mode: 'transcript',
    transcriptRoles: ['user', 'assistant'],
    includeReasoning: params.contentPolicy?.includeReasoning === true,
    includeTools: params.contentPolicy?.includeToolSummaries === true,
    ...(fetchPage ? { fetchPage } : {}),
  });

  const page = await fetchSemanticPage(['user', 'agent']);
  const mapItems = (rawItems: typeof page.items): readonly MemoryIndexableTranscriptItem[] => rawItems
    .map((item) => mapSemanticTranscriptItemToMemoryIndexable({
      sessionId: params.sessionId,
      item,
      contentPolicy: params.contentPolicy,
    }))
    .filter((item): item is MemoryIndexableTranscriptItem => item !== null);
  let items = mapItems(page.items);
  let diagnostics = page.diagnostics;
  let nextCursor = page.nextCursor;
  let hasMore = page.hasMore;

  if (params.includeLegacyUnknownRoleFallback !== false) {
    const fetchRawPage = params.fetchPage ?? (async (args) => await fetchEncryptedTranscriptMessagesPage({
      token: args.token,
      sessionId: args.sessionId,
      limit: args.limit,
      ...(typeof args.beforeSeq === 'number' ? { beforeSeq: args.beforeSeq } : {}),
      ...(typeof args.afterSeq === 'number' ? { afterSeq: args.afterSeq } : {}),
      scope: args.scope,
      ...(args.sidechainId ? { sidechainId: args.sidechainId } : {}),
    }));
    const fetchLegacyNullRolePage: FetchTranscriptRawPage = async (args) => {
      const rawPage = await fetchRawPage(args);
      return {
        ...rawPage,
        messages: rawPage.messages.filter(isLegacyUnclassifiedTranscriptRow),
      };
    };
    const fallback = await fetchSemanticPage(undefined, fetchLegacyNullRolePage);
    const fallbackItems = mapItems(fallback.items);
    if (fallbackItems.length > 0) {
      const bySeq = new Map<number, MemoryIndexableTranscriptItem>();
      for (const item of [...items, ...fallbackItems]) bySeq.set(item.seq, item);
      items = [...bySeq.values()].sort((left, right) => left.seq - right.seq);
      nextCursor = nextCursor ?? fallback.nextCursor;
      hasMore = hasMore || fallback.hasMore;
    }
    diagnostics = {
      rawRowsScanned: diagnostics.rawRowsScanned + fallback.diagnostics.rawRowsScanned,
      pagesFetched: diagnostics.pagesFetched + fallback.diagnostics.pagesFetched,
      scanLimitReached: diagnostics.scanLimitReached || fallback.diagnostics.scanLimitReached,
      payloadTruncations: diagnostics.payloadTruncations + fallback.diagnostics.payloadTruncations,
    };
  }

  return {
    items,
    nextCursor,
    hasMore,
    diagnostics: {
      ...diagnostics,
      semanticRowsFound: items.length,
    },
  };
}
