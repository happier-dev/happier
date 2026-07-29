import {
  readConversationTurnOriginV1FromMessageMeta,
  type ConversationTurnOriginV1,
} from '@happier-dev/protocol';

import type { Message } from '@/sync/domains/messages/messageTypes';
import { compareTranscriptMessagesOldestFirst } from '@/sync/domains/messages/transcriptOrdering';

export type VoiceHistoryProviderSource = NonNullable<ConversationTurnOriginV1['source']>;

export type VoiceHistoryRow = Readonly<{
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
  providerLabel: string;
  source: VoiceHistoryProviderSource | null;
}>;

export type VoiceHistorySnapshot = Readonly<{
  sessionId: string | null;
  rows: readonly VoiceHistoryRow[];
  loadedRowCount: number;
  hasMore: boolean | null;
}>;

export type VoiceHistoryExportArtifact = Readonly<{
  fileName: string;
  mimeType: 'application/json';
  content: string;
  rowCount: number;
  range: 'loaded' | 'all';
}>;

export const VOICE_HISTORY_EXPORT_LIMITS = Object.freeze({
  maxPages: 64,
  maxRows: 5_000,
  maxBytes: 8 * 1024 * 1024,
});

export type VoiceHistoryExportLimit = 'pages' | 'rows' | 'bytes';

export class VoiceHistoryExportLimitError extends Error {
  readonly code = 'voice_history_export_limit_exceeded';

  constructor(
    readonly limit: VoiceHistoryExportLimit,
    readonly maximum: number,
  ) {
    super(`Voice History export exceeded its ${limit} limit (${maximum})`);
    this.name = 'VoiceHistoryExportLimitError';
  }
}

export class VoiceHistoryOperationSupersededError extends Error {
  readonly code = 'voice_history_operation_superseded';

  constructor() {
    super('Voice History operation was superseded by a newer operation');
    this.name = 'VoiceHistoryOperationSupersededError';
  }
}

export class VoiceHistoryClearActiveCallError extends Error {
  readonly code = 'voice_history_clear_active_call';

  constructor() {
    super('Voice History cannot be cleared during an active standalone call');
    this.name = 'VoiceHistoryClearActiveCallError';
  }
}

export function isVoiceHistoryClearActiveCallError(error: unknown): boolean {
  return error instanceof VoiceHistoryClearActiveCallError
    || (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'voice_history_clear_active_call'
    );
}

export type VoiceHistoryPageResult = Readonly<{
  loaded: number;
  hasMore: boolean;
  status: 'loaded' | 'no_more' | 'not_ready' | 'in_flight';
}>;

export type VoiceHistoryCapturedScope = Readonly<{
  key: string;
}>;

export type VoiceHistoryConsumerDeps<
  TScope extends VoiceHistoryCapturedScope = VoiceHistoryCapturedScope,
> = Readonly<{
  readScopeKey(): string | null;
  captureScope(): Promise<TScope | null>;
  discoverHistorySession(scope: TScope): Promise<string | null>;
  refreshSessionMessages(sessionId: string, scope: TScope): Promise<void>;
  loadOlderMessages(sessionId: string, scope: TScope): Promise<VoiceHistoryPageResult>;
  readMessages(sessionId: string): readonly Message[];
  resolveProviderLabel(source: VoiceHistoryProviderSource | null): string;
  deleteSession(
    sessionId: string,
    scope: TScope,
  ): Promise<Readonly<{ success: boolean; message?: string }>>;
  canDeleteSession(sessionId: string): boolean;
  retireLocalSession(sessionId: string): void;
  now(): Date;
}>;

export function projectVoiceHistoryRows(
  messages: readonly Message[],
  resolveProviderLabel: VoiceHistoryConsumerDeps['resolveProviderLabel'],
  query = '',
): readonly VoiceHistoryRow[] {
  const rows = [...messages]
    .sort(compareTranscriptMessagesOldestFirst)
    .flatMap((message): VoiceHistoryRow[] => {
      if (message.kind !== 'user-text' && message.kind !== 'agent-text') return [];
      if (message.kind === 'agent-text' && message.isThinking === true) return [];
      const origin = readConversationTurnOriginV1FromMessageMeta(message.meta);
      if (
        origin?.channel !== 'realtime_conversation'
        || origin.modality !== 'voice'
      ) {
        return [];
      }
      const source = origin.source ?? null;
      return [{
        id: message.id,
        role: message.kind === 'user-text' ? 'user' : 'assistant',
        text: message.text,
        createdAt: message.createdAt,
        providerLabel: resolveProviderLabel(source),
        source,
      }];
    });
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return Object.freeze(rows);
  return Object.freeze(rows.filter((row) => (
    row.text.toLocaleLowerCase().includes(normalizedQuery)
    || row.providerLabel.toLocaleLowerCase().includes(normalizedQuery)
  )));
}

function buildExportFileName(now: Date): string {
  return `happier-voice-history-${now.toISOString().replace(/[:.]/gu, '-')}.json`;
}

function assertExportRowLimit(rowCount: number): void {
  if (rowCount > VOICE_HISTORY_EXPORT_LIMITS.maxRows) {
    throw new VoiceHistoryExportLimitError(
      'rows',
      VOICE_HISTORY_EXPORT_LIMITS.maxRows,
    );
  }
}

function buildExportContent(input: Readonly<{
  exportedAt: string;
  range: 'loaded' | 'all';
  rows: readonly VoiceHistoryRow[];
}>): string {
  assertExportRowLimit(input.rows.length);
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let byteLength = 0;
  const append = (chunk: string) => {
    byteLength += encoder.encode(chunk).byteLength;
    if (byteLength > VOICE_HISTORY_EXPORT_LIMITS.maxBytes) {
      throw new VoiceHistoryExportLimitError(
        'bytes',
        VOICE_HISTORY_EXPORT_LIMITS.maxBytes,
      );
    }
    chunks.push(chunk);
  };

  append(
    `{\n  "version": 1,\n  "exportedAt": ${JSON.stringify(input.exportedAt)},`
    + `\n  "range": ${JSON.stringify(input.range)},\n  "entries": [`,
  );
  input.rows.forEach((row, index) => {
    const entry = JSON.stringify({
      id: row.id,
      role: row.role,
      text: row.text,
      createdAt: row.createdAt,
      provider: row.providerLabel,
      source: row.source,
    }, null, 2).replace(/^/gmu, '    ');
    append(`${index === 0 ? '' : ','}\n${entry}`);
  });
  append('\n  ]\n}');
  return chunks.join('');
}

export function createVoiceHistoryConsumer<
  TScope extends VoiceHistoryCapturedScope,
>(deps: VoiceHistoryConsumerDeps<TScope>): Readonly<{
  open(query?: string): Promise<VoiceHistorySnapshot>;
  read(query?: string): VoiceHistorySnapshot;
  loadOlder(query?: string): Promise<VoiceHistorySnapshot>;
  exportHistory(input: Readonly<{ range: 'loaded' | 'all' }>): Promise<VoiceHistoryExportArtifact>;
  clear(): Promise<Readonly<{ cleared: boolean }>>;
}> {
  let sessionId: string | null = null;
  let scopeKey: string | null = null;
  let capturedScope: TScope | null = null;
  let hasMore: boolean | null = null;
  let operationEpoch = 0;

  const resetBinding = () => {
    sessionId = null;
    scopeKey = null;
    capturedScope = null;
    hasMore = null;
  };

  const beginOperation = (): number => {
    operationEpoch += 1;
    return operationEpoch;
  };

  const assertOperationCurrent = (epoch: number): void => {
    if (epoch !== operationEpoch) {
      throw new VoiceHistoryOperationSupersededError();
    }
  };

  const empty = (): VoiceHistorySnapshot => ({
    sessionId: null,
    rows: [],
    loadedRowCount: 0,
    hasMore: null,
  });

  const isScopeCurrent = (): boolean => {
    if (!scopeKey || deps.readScopeKey() !== scopeKey) {
      if (scopeKey || sessionId || hasMore !== null) {
        operationEpoch += 1;
        resetBinding();
      }
      return false;
    }
    return true;
  };

  const read = (query = ''): VoiceHistorySnapshot => {
    if (!sessionId || !isScopeCurrent()) return empty();
    const messages = deps.readMessages(sessionId);
    const loadedRows = projectVoiceHistoryRows(messages, deps.resolveProviderLabel);
    return {
      sessionId,
      rows: query.trim()
        ? projectVoiceHistoryRows(messages, deps.resolveProviderLabel, query)
        : loadedRows,
      loadedRowCount: loadedRows.length,
      hasMore,
    };
  };

  const discover = async (epoch: number): Promise<string | null> => {
    const nextScope = await deps.captureScope();
    if (!nextScope) {
      assertOperationCurrent(epoch);
      resetBinding();
      return null;
    }
    const discoveredSessionId = String(await deps.discoverHistorySession(nextScope) ?? '').trim();
    assertOperationCurrent(epoch);
    if (deps.readScopeKey() !== nextScope.key) {
      resetBinding();
      throw new VoiceHistoryOperationSupersededError();
    }
    scopeKey = nextScope.key;
    capturedScope = nextScope;
    sessionId = discoveredSessionId || null;
    hasMore = null;
    return sessionId;
  };

  const pageOnce = async (
    epoch: number,
    expectedSessionId: string,
  ): Promise<VoiceHistoryPageResult | null> => {
    assertOperationCurrent(epoch);
    if (sessionId !== expectedSessionId || !capturedScope || !isScopeCurrent()) return null;
    const operationScope = capturedScope;
    const result = await deps.loadOlderMessages(expectedSessionId, operationScope);
    assertOperationCurrent(epoch);
    if (sessionId !== expectedSessionId) {
      throw new VoiceHistoryOperationSupersededError();
    }
    if (!isScopeCurrent()) return null;
    hasMore = result.hasMore;
    return result;
  };

  return Object.freeze({
    async open(query = '') {
      const epoch = beginOperation();
      const discoveredSessionId = await discover(epoch);
      if (!discoveredSessionId) return empty();
      if (!capturedScope) return empty();
      await deps.refreshSessionMessages(discoveredSessionId, capturedScope);
      assertOperationCurrent(epoch);
      if (sessionId !== discoveredSessionId) {
        throw new VoiceHistoryOperationSupersededError();
      }
      if (!isScopeCurrent()) return empty();
      return read(query);
    },
    read,
    async loadOlder(query = '') {
      const epoch = beginOperation();
      const expectedSessionId = sessionId;
      if (!expectedSessionId || !isScopeCurrent()) return read(query);
      await pageOnce(epoch, expectedSessionId);
      assertOperationCurrent(epoch);
      return read(query);
    },
    async exportHistory(input) {
      const epoch = beginOperation();
      const expectedSessionId = sessionId;
      if (input.range === 'all' && expectedSessionId && isScopeCurrent()) {
        let fetchedPages = 0;
        while (true) {
          if (fetchedPages >= VOICE_HISTORY_EXPORT_LIMITS.maxPages) {
            throw new VoiceHistoryExportLimitError(
              'pages',
              VOICE_HISTORY_EXPORT_LIMITS.maxPages,
            );
          }
          const beforeCount = read().loadedRowCount;
          assertExportRowLimit(beforeCount);
          const page = await pageOnce(epoch, expectedSessionId);
          if (!page) break;
          fetchedPages += 1;
          assertOperationCurrent(epoch);
          const afterCount = read().loadedRowCount;
          assertExportRowLimit(afterCount);
          if (page.status === 'no_more' || page.hasMore === false) break;
          if (page.status === 'not_ready' || page.status === 'in_flight') {
            throw new Error(`Voice History pagination is ${page.status}`);
          }
          if (page.loaded === 0 && afterCount === beforeCount) {
            throw new Error('Voice History pagination made no progress');
          }
        }
      }
      assertOperationCurrent(epoch);
      const snapshot = read();
      const now = deps.now();
      const content = buildExportContent({
        exportedAt: now.toISOString(),
        range: input.range,
        rows: snapshot.rows,
      });
      return {
        fileName: buildExportFileName(now),
        mimeType: 'application/json',
        content,
        rowCount: snapshot.rows.length,
        range: input.range,
      };
    },
    async clear() {
      const epoch = beginOperation();
      if (!sessionId) {
        await discover(epoch);
      }
      assertOperationCurrent(epoch);
      if (!sessionId || !capturedScope || !isScopeCurrent()) return { cleared: false };
      const deletingSessionId = sessionId;
      const deletingScope = capturedScope;
      if (!deps.canDeleteSession(deletingSessionId)) {
        throw new VoiceHistoryClearActiveCallError();
      }
      const result = await deps.deleteSession(deletingSessionId, deletingScope);
      if (!result.success) {
        assertOperationCurrent(epoch);
        throw new Error(result.message || 'Voice History could not be cleared');
      }
      const isExactDeletedBindingCurrent = () => (
        sessionId === deletingSessionId
        && scopeKey === deletingScope.key
        && capturedScope?.key === deletingScope.key
        && deps.readScopeKey() === deletingScope.key
      );
      const retireExactDeletedBinding = (): boolean => {
        if (!isExactDeletedBindingCurrent()) return false;
        try {
          deps.retireLocalSession(deletingSessionId);
        } finally {
          if (isExactDeletedBindingCurrent()) {
            resetBinding();
          }
        }
        return true;
      };

      if (epoch !== operationEpoch) {
        retireExactDeletedBinding();
        assertOperationCurrent(epoch);
      }
      if (deps.readScopeKey() !== deletingScope.key) {
        resetBinding();
        return { cleared: true };
      }
      // The server-side carrier is already gone. Never retain authority to
      // page, export, or delete that exact id if local cache cleanup fails.
      retireExactDeletedBinding();
      return { cleared: true };
    },
  });
}
