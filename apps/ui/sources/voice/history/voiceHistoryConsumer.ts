import {
  readConversationTurnOriginV1FromMessageMeta,
  type ConversationTurnOriginV1,
} from '@happier-dev/protocol';

import type { Message } from '@/sync/domains/messages/messageTypes';
import type { SessionDeleteResult } from '@/sync/ops/sessions';
import { compareTranscriptMessagesOldestFirst } from '@/sync/domains/messages/transcriptOrdering';
import type { TranscriptOlderPageLoadResult } from '@/sync/domains/messages/transcriptOlderPageLoad';

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
  /**
   * The serialized JSON document, produced lazily in order.
   *
   * Export is "all of it": there is no page, row or byte ceiling, so the whole
   * document can be larger than anything worth holding twice. Platform targets
   * stream these chunks straight into their sink (a `Blob` part list on web, an
   * appending file write on native) instead of concatenating one giant string
   * and then copying it again.
   */
  chunks: () => Iterable<string>;
  rowCount: number;
  range: 'loaded' | 'all';
}>;

export class VoiceHistoryOperationSupersededError extends Error {
  readonly code = 'voice_history_operation_superseded';

  constructor() {
    super('Voice History operation was superseded by a newer operation');
    this.name = 'VoiceHistoryOperationSupersededError';
  }
}

export function isVoiceHistoryOperationSupersededError(error: unknown): boolean {
  return error instanceof VoiceHistoryOperationSupersededError
    || (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'voice_history_operation_superseded'
    );
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

export type VoiceHistoryPageResult = TranscriptOlderPageLoadResult;

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
  /**
   * Per-session message revision, from the canonical message owner.
   *
   * The projection cannot be keyed on the identity of what `readMessages`
   * returns: the canonical reader materializes a fresh array on every call
   * (`readStoredSessionMessages`), so an identity key invalidated the memo on
   * every read and re-projected the whole loaded slice for each keystroke.
   */
  readMessagesRevision(sessionId: string): string | number;
  /** Changes when provider labels/projections can change without new messages. */
  readProjectionRevision?(): string | number;
  /**
   * Notifies when a source behind {@link getVoiceHistoryRevision} may have
   * changed — the message store, the provider registry, or the active scope.
   * The consumer republishes it as its own revision, so an open History
   * observes live writes instead of showing whatever the last read returned.
   */
  subscribeHistorySources(listener: () => void): () => void;
  resolveProviderLabel(source: VoiceHistoryProviderSource | null): string;
  deleteSession(
    sessionId: string,
    scope: TScope,
  ): Promise<SessionDeleteResult>;
  canDeleteSession(sessionId: string): boolean;
  retireLocalSession(sessionId: string): void;
  runCarrierOperation<T>(operation: () => Promise<T>): Promise<T>;
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
  return filterVoiceHistoryRows(Object.freeze(rows), query);
}

function filterVoiceHistoryRows(
  rows: readonly VoiceHistoryRow[],
  query: string,
): readonly VoiceHistoryRow[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return rows;
  return Object.freeze(rows.filter((row) => (
    row.text.toLocaleLowerCase().includes(normalizedQuery)
    || row.providerLabel.toLocaleLowerCase().includes(normalizedQuery)
  )));
}

function buildExportFileName(now: Date): string {
  return `happier-voice-history-${now.toISOString().replace(/[:.]/gu, '-')}.json`;
}

function* serializeVoiceHistoryExport(input: Readonly<{
  exportedAt: string;
  range: 'loaded' | 'all';
  rows: readonly VoiceHistoryRow[];
}>): Generator<string> {
  yield (
    `{\n  "version": 1,\n  "exportedAt": ${JSON.stringify(input.exportedAt)},`
    + `\n  "range": ${JSON.stringify(input.range)},\n  "entries": [`
  );
  let index = 0;
  for (const row of input.rows) {
    const entry = JSON.stringify({
      id: row.id,
      role: row.role,
      text: row.text,
      createdAt: row.createdAt,
      provider: row.providerLabel,
      source: row.source,
    }, null, 2).replace(/^/gmu, '    ');
    yield `${index === 0 ? '' : ','}\n${entry}`;
    index += 1;
  }
  yield '\n  ]\n}';
}

export type VoiceHistoryConsumer = Readonly<{
  open(query?: string): Promise<VoiceHistorySnapshot>;
  read(query?: string): VoiceHistorySnapshot;
  loadOlder(query?: string): Promise<VoiceHistorySnapshot>;
  exportHistory(input: Readonly<{ range: 'loaded' | 'all' }>): Promise<VoiceHistoryExportArtifact>;
  clear(): Promise<Readonly<{ cleared: boolean }>>;
  /**
   * External-store pair for the rendered History snapshot. `getRevision`
   * changes exactly when a further `read()` could answer differently — the
   * bound session, its message revision, provider projections, the pagination
   * ceiling, or the active scope — so an open screen re-reads on a live write
   * and ignores every unrelated one.
   */
  subscribe(listener: () => void): () => void;
  getRevision(): string;
}>;

export function createVoiceHistoryConsumer<
  TScope extends VoiceHistoryCapturedScope,
>(deps: VoiceHistoryConsumerDeps<TScope>): VoiceHistoryConsumer {
  let sessionId: string | null = null;
  let scopeKey: string | null = null;
  let capturedScope: TScope | null = null;
  let hasMore: boolean | null = null;
  let operationEpoch = 0;
  let deferredExportProjectionEpoch: number | null = null;
  let projectedSessionId: string | null = null;
  let projectedMessagesRevision: string | number | null = null;
  let projectedRevision: string | number | null = null;
  let projectedRows: readonly VoiceHistoryRow[] = Object.freeze([]);
  const listeners = new Set<() => void>();

  /*
   * Emitted only from an operation's own continuation, never from `read()`.
   * `read()` runs inside the screen's render (it is the external-store read),
   * and its scope check can retire a stale binding; notifying from there would
   * publish a store change while React is rendering.
   */
  const emit = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const resetProjection = (): void => {
    projectedSessionId = null;
    projectedMessagesRevision = null;
    projectedRevision = null;
    projectedRows = Object.freeze([]);
  };

  const publishProjection = (): void => {
    resetProjection();
    emit();
  };

  const resetBinding = () => {
    sessionId = null;
    scopeKey = null;
    capturedScope = null;
    hasMore = null;
    resetProjection();
  };

  const beginOperation = (): number => {
    operationEpoch += 1;
    // A newer operation owns its own current projection. It must not inherit
    // an interrupted export's read suppression.
    deferredExportProjectionEpoch = null;
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
    const messagesRevision = deps.readMessagesRevision(sessionId);
    const revision = deps.readProjectionRevision?.() ?? 0;
    const projectionIsDeferredForExport = deferredExportProjectionEpoch !== null;
    if (
      projectedSessionId !== sessionId
      || (!projectionIsDeferredForExport && (
        projectedMessagesRevision !== messagesRevision
        || projectedRevision !== revision
      ))
    ) {
      projectedSessionId = sessionId;
      projectedMessagesRevision = messagesRevision;
      projectedRevision = revision;
      projectedRows = projectVoiceHistoryRows(
        deps.readMessages(sessionId),
        deps.resolveProviderLabel,
      );
    }
    return {
      sessionId,
      rows: filterVoiceHistoryRows(projectedRows, query),
      loadedRowCount: projectedRows.length,
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
    emit();
    return sessionId;
  };

  const pageOnce = async (
    epoch: number,
    expectedSessionId: string,
    publish = true,
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
    if (result.status === 'retryable_error') {
      // The canonical pager ATTEMPTED the read and it FAILED, retaining rows and
      // the older cursor so the same read can be retried. Returning it as an
      // ordinary unchanged page made "Load older" look like a successful no-op
      // and silently truncated an all-history export. Nothing changed, so the
      // pagination ceiling and the projection are left exactly as they were.
      throw new Error('Voice History could not load an older page');
    }
    hasMore = result.hasMore;
    // The canonical message owner may append into its existing array while
    // paging. This operation is the mutation boundary, so invalidate here
    // without imposing a second message-version owner on History.
    if (publish) publishProjection();
    return result;
  };

  return Object.freeze({
    subscribe(listener: () => void) {
      listeners.add(listener);
      const unsubscribeSources = deps.subscribeHistorySources(listener);
      return () => {
        listeners.delete(listener);
        unsubscribeSources();
      };
    },
    getRevision() {
      return [
        deps.readScopeKey() ?? '',
        sessionId ?? '',
        sessionId ? deps.readMessagesRevision(sessionId) : '',
        deps.readProjectionRevision?.() ?? 0,
        hasMore === null ? '' : String(hasMore),
      ].join('\u0001');
    },
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
      resetProjection();
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
        // "All" means all of it. There is no page, row or byte ceiling: a
        // ceiling turned a large history into no artifact at all, while the
        // only export action the screen offers asks for the whole range.
        let hasDeferredPagePublication = false;
        deferredExportProjectionEpoch = epoch;
        try {
          while (true) {
            // A mounted external-store reader otherwise projects the growing
            // prefix after every page. Export owns these pages, so it publishes
            // once after the final accumulated history is ready.
            const page = await pageOnce(epoch, expectedSessionId, false);
            if (!page) break;
            hasDeferredPagePublication = true;
            assertOperationCurrent(epoch);
            if (page.status === 'no_more' || page.hasMore === false) break;
            if (page.status === 'not_ready' || page.status === 'in_flight') {
              throw new Error(`Voice History pagination is ${page.status}`);
            }
            // `loaded` is the canonical count of rows the pager applied, so it
            // reports cursor progress without projecting the growing slice.
            if (page.loaded === 0) {
              throw new Error('Voice History pagination made no progress');
            }
          }
        } catch (error) {
          // A completed earlier page still belongs to the current History
          // binding. Publish it before surfacing a later pager failure, while
          // never reviving a superseded operation or scope.
          const shouldPublishDeferredProjection = (
            hasDeferredPagePublication
            && operationEpoch === epoch
            && sessionId === expectedSessionId
            && isScopeCurrent()
          );
          if (deferredExportProjectionEpoch === epoch) {
            deferredExportProjectionEpoch = null;
          }
          if (shouldPublishDeferredProjection) {
            publishProjection();
          }
          throw error;
        }
        const shouldPublishDeferredProjection = (
          hasDeferredPagePublication
          && operationEpoch === epoch
          && sessionId === expectedSessionId
          && isScopeCurrent()
        );
        if (deferredExportProjectionEpoch === epoch) {
          deferredExportProjectionEpoch = null;
        }
        if (shouldPublishDeferredProjection) {
          publishProjection();
        }
      }
      assertOperationCurrent(epoch);
      // Exactly one projection, after the last page. Reading per page re-sorted
      // and re-labelled the whole accumulated history for every page fetched.
      const rows = read().rows;
      const now = deps.now();
      return {
        fileName: buildExportFileName(now),
        mimeType: 'application/json',
        chunks: () => serializeVoiceHistoryExport({
          exportedAt: now.toISOString(),
          range: input.range,
          rows,
        }),
        rowCount: rows.length,
        range: input.range,
      };
    },
    async clear() {
      const epoch = beginOperation();
      return await deps.runCarrierOperation(async () => {
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
        // `session_absent` is the server confirming that this exact carrier is
        // gone or was never ours, so it joins the deleted path: the binding and
        // its decrypted rows must be retired even when no socket deletion update
        // ever reaches this device. Every other failure — a lost delete
        // condition above all — leaves the carrier alive and retryable, so local
        // history is preserved rather than discarded on a transient conflict.
        if (!result.success && result.code !== 'session_absent') {
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
            emit();
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
      });
    },
  });
}
