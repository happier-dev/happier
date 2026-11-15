import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginJsonRpcClient } from '@happier-dev/plugin-sdk/exec/protocol-clients';
import type {
  AgentExternalSessionCandidate, AgentExternalSessionSource, AgentExternalSessionTranscriptItem,
  AgentExternalSessionsContribution, AgentExternalSessionsInvocation, AgentExternalSessionsResult,
  AgentExternalSessionsReadAfterTranscriptResult, AgentExternalSessionsTranscriptPage,
} from '@happier-dev/plugin-sdk/sessions/external';
import { createAgentExternalSessionsProducerOverflowFailure, getAgentExternalSessionsInvocationFailure,
  isAgentExternalSessionsResultWithinByteBudget, readSessionInputPromptUserTextV1 } from '@happier-dev/plugin-sdk/sessions/external';
import { projectExternalSessionCandidateTitle } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import { createMuseEventProjection, readMuseRecord } from './events.js';
import { openMuseMsp, type MuseMsp } from './msp.js';

type NativeMessage = Readonly<{ method: string; params?: JsonValue }>;
type ReadClient = Pick<PluginJsonRpcClient, 'request'>;
type NativePage = Readonly<{ events: readonly NativeMessage[]; nextCursor: string | null }>;

function malformed(): never {
  throw new PluginError({ code: 'PLUGIN_EXEC_PROTOCOL_ERROR', message: 'Muse returned invalid native history.' });
}

/** Native v1 publishes a 1000-event page maximum. Cursors remain opaque. */
export async function readMuseViewPage(client: ReadClient, request: Readonly<{
  sessionId: string; cursor?: string; direction?: 'forward' | 'backward'; limit?: number; maxBytes?: number;
}>, signal?: AbortSignal): Promise<NativePage> {
  const value = readMuseRecord(await client.request('view/page', {
    ...request, limit: Math.min(request.limit ?? 1000, 1000),
  }, { signal }));
  if (!Array.isArray(value.events) || (value.nextCursor !== null && typeof value.nextCursor !== 'string')) malformed();
  const events = value.events.map(value => {
    const message = readMuseRecord(value);
    if (typeof message.method !== 'string') malformed();
    return { method: message.method, ...(message.params === undefined ? {} : { params: message.params }) };
  });
  return { events, nextCursor: value.nextCursor };
}

/** Lifecycle resume and external reads consume this same demanded page owner. */
export async function replayMusePagedHistory(client: ReadClient, request: Readonly<{
  sessionId: string; signal?: AbortSignal; replay(message: NativeMessage): Promise<void>;
}>): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await readMuseViewPage(client, { sessionId: request.sessionId, ...(cursor ? { cursor } : {}) }, request.signal);
    for (const event of page.events) await request.replay(event);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
}

function nativeErrorKind(error: unknown): string | undefined {
  // SDK owns JSON-RPC response correlation; branch only on the native open enum.
  if (!(error instanceof Error) || error.name !== 'JsonRpcApplicationError' || !('data' in error)) return;
  const data = error.data;
  return data !== null && typeof data === 'object' && 'kind' in data && typeof data.kind === 'string' ? data.kind : undefined;
}

export function mapMuseExternalHistoryError(error: unknown): AgentExternalSessionsResult<never> {
  const kind = nativeErrorKind(error);
  if (kind === 'sessionNotFound' || kind === 'notFound') return { ok: false, code: 'candidate_not_found' };
  if (kind === 'invalidParams') return { ok: false, code: 'invalid_request' };
  if (kind === 'agent_unavailable') return { ok: false, code: 'agent_unavailable',
    ...(error instanceof Error && error.message ? { message: error.message } : {}), retryable: true };
  return { ok: false, code: 'source_unreachable', retryable: true };
}

function failed(error: unknown): AgentExternalSessionsResult<never> {
  return mapMuseExternalHistoryError(error);
}

function bounded<T>(value: T, request: AgentExternalSessionsInvocation): AgentExternalSessionsResult<T> {
  const result = { ok: true, value } as const;
  return isAgentExternalSessionsResultWithinByteBudget(result, request.maxSerializedBytes)
    ? result : createAgentExternalSessionsProducerOverflowFailure('Muse history exceeds the admitted result byte bound.');
}

async function withRead<T>(request: AgentExternalSessionsInvocation & { source: AgentExternalSessionSource },
  read: (msp: MuseMsp, source: AgentExternalSessionSource) => Promise<AgentExternalSessionsResult<T>>,
  sourceChanged?: () => AgentExternalSessionsResult<T>,
): Promise<AgentExternalSessionsResult<T>> {
  const stopped = getAgentExternalSessionsInvocationFailure(request);
  if (stopped) return stopped;
  if (request.source.kind !== 'museNative') return { ok: false, code: 'source_invalid' };
  let msp: MuseMsp | undefined;
  try {
    msp = await openMuseMsp({ exec: request.exec, launch: { executable: { kind: 'systemTool', id: 'muse-cli' } }, signal: request.signal });
    const home = readMuseRecord(msp.initializeResult).museHome;
    if (typeof home !== 'string' || home.length === 0) malformed();
    // A selected home is evidence, never a request to redirect an isolated CLI.
    if (typeof request.source.museHome === 'string' && request.source.museHome !== home) return sourceChanged?.() ?? { ok: false, code: 'source_unreachable' };
    return await read(msp, { kind: 'museNative', museHome: home });
  } catch (error) {
    return getAgentExternalSessionsInvocationFailure(request) ?? failed(error);
  } finally { await msp?.dispose(); }
}

function timestamp(value: JsonValue | undefined): number {
  if (typeof value !== 'string') malformed();
  const result = Date.parse(value);
  if (!Number.isFinite(result)) malformed();
  return result;
}

async function metadata(msp: MuseMsp, sessionId: string, signal: AbortSignal, excludeItems: boolean) {
  const result = readMuseRecord(await msp.client.request('session/read', { sessionId, excludeItems }, { signal }));
  const session = readMuseRecord(result.session);
  if (session.sessionId !== sessionId) malformed();
  return { result, session };
}

export function readMuseHistoryItems(historyValue: JsonValue | undefined): readonly JsonValue[] | undefined {
  const history = readMuseRecord(historyValue);
  if (history.mode === 'inline' && Array.isArray(history.items)) return history.items;
  const snapshot = readMuseRecord(history.snapshot);
  const state = readMuseRecord(snapshot.state);
  // Native snapshot v1 is the complete folded state, not a page handle.
  if ((history.mode === 'snapshot' || history.mode === 'anchoredSnapshot') && snapshot.schemaVersion === 1 && Array.isArray(state.items)) return state.items;
  return undefined;
}

function transcriptProjection() {
  const projection = createMuseEventProjection({});
  const items: AgentExternalSessionTranscriptItem[] = [];
  const positions = new Map<string, { index: number; event?: NativeMessage }>();
  let nativeEvent: NativeMessage | undefined;
  function put(item: AgentExternalSessionTranscriptItem) {
    const position = positions.get(item.id);
    if (position === undefined) { positions.set(item.id, { index: items.length, event: nativeEvent }); items.push(item); }
    else items[position.index] = item;
  }
  let native = readMuseRecord(undefined);
  projection.watch(event => {
    const id = typeof native.itemId === 'string' ? native.itemId : undefined;
    if (!id) return;
    // recordedAt belongs to this native revision, not the Tool call's creation.
    // Completed Items re-emit the same call on later pages. Muse supplies no
    // original call timestamp, so leave it absent rather than change a stable row.
    const common = event.kind === 'tool-call' || event.kind === 'tool-progress'
      ? {} : { createdAtMs: timestamp(native.recordedAt) };
    if (event.kind === 'transcript-message-committed') {
      put(event.role === 'user'
        ? { ...common, id: `${id}:message`, localId: id, messageRole: 'user', userProjection: 'source_fact',
          raw: { role: 'user', content: { type: 'text', text: event.text } } }
        : { ...common, id: `${id}:message`, messageRole: event.role === 'reasoning' ? 'event' : 'agent', raw: { role: 'agent', content: {
          type: 'acp', agentId: 'muse', data: { type: event.role === 'reasoning' ? 'reasoning' : 'message', message: event.text },
        } } });
    } else if (event.kind === 'tool-call' || event.kind === 'tool-result') {
      put({ ...common, id: `${id}:${event.kind}`, messageRole: 'event', raw: { role: 'agent', content: {
        type: 'acp', agentId: 'muse', data: event.kind === 'tool-call'
          ? { type: 'tool-call', callId: event.toolCallId, name: event.toolName, input: event.input }
          : { type: 'tool-result', callId: event.toolCallId, output: event.output, isError: event.isError ?? false },
      } } });
    } else if (event.kind === 'tool-progress') {
      const progress = readMuseRecord(event.progress);
      if (typeof progress.toolName !== 'string' || progress.rawInput === undefined) return;
      put({ ...common, id: `${id}:tool-call`, messageRole: 'event', raw: { role: 'agent', content: {
        type: 'acp', agentId: 'muse', data: { type: 'tool-call', callId: event.toolCallId,
          name: progress.toolName, input: progress.rawInput },
      } } });
    }
  });
  return {
    items,
    eventFor(id: string) { return positions.get(id)?.event; },
    async replayItems(values: readonly JsonValue[]) {
      for (const value of values) { native = readMuseRecord(value); await projection.replayItems([value]); }
    },
    async replayEvent(event: NativeMessage) {
      nativeEvent = event;
      native = readMuseRecord(readMuseRecord(event.params).item);
      await projection.replayHistoryEvent(event);
    },
    dispose: projection.dispose,
  };
}

function endCursor(page: NativePage): string | undefined {
  const cursor = readMuseRecord(page.events.at(-1)?.params).viewCursor;
  return typeof cursor === 'string' ? cursor : undefined;
}

type TranscriptRead = AgentExternalSessionsInvocation & Readonly<{ remoteSessionId: string; maxItems: number }>;
type PartialItemCursor = Readonly<{ before: string | null; event: string; position: number }>;
const PARTIAL_ITEM_CURSOR_PREFIX = 'muse-view:';

function partialItemCursor(cursor: string | undefined): PartialItemCursor | undefined {
  if (!cursor?.startsWith(PARTIAL_ITEM_CURSOR_PREFIX)) return;
  const value: unknown = JSON.parse(cursor.slice(PARTIAL_ITEM_CURSOR_PREFIX.length));
  if (!value || typeof value !== 'object' || !('before' in value) || !('event' in value) || !('position' in value)
    || value.before !== null && typeof value.before !== 'string' || typeof value.event !== 'string'
    || typeof value.position !== 'number' || !Number.isSafeInteger(value.position) || value.position <= 0) malformed();
  return { before: value.before, event: value.event, position: value.position };
}

function encodePartialItemCursor(value: PartialItemCursor): string {
  // Only native view boundaries and an outward row position are retained.
  // Native text, Tool input/output and folded Item payloads stay in Muse.
  return `${PARTIAL_ITEM_CURSOR_PREFIX}${JSON.stringify(value)}`;
}

function eventCursor(event: NativeMessage | undefined): string {
  const cursor = readMuseRecord(event?.params).viewCursor;
  if (typeof cursor !== 'string') malformed();
  return cursor;
}

async function projectEvent(event: NativeMessage): Promise<readonly AgentExternalSessionTranscriptItem[]> {
  const projection = transcriptProjection();
  try { await projection.replayEvent(event); return projection.items; }
  finally { projection.dispose(); }
}

async function previousCursor(msp: MuseMsp, request: TranscriptRead, page: NativePage, index: number,
  input: string | undefined, direction: 'forward' | 'backward'): Promise<string | null> {
  if (index > 0) return eventCursor(page.events[index - 1]);
  if (direction === 'forward' && input) return input;
  const before = await readMuseViewPage(msp.client, { sessionId: request.remoteSessionId,
    cursor: eventCursor(page.events[index]), direction: 'backward', limit: 1, maxBytes: request.maxSerializedBytes }, request.signal);
  return endCursor(before) ?? null;
}

async function projectBoundedPage(msp: MuseMsp, request: TranscriptRead, page: NativePage,
  input: string | undefined, direction: 'forward' | 'backward') {
  const projection = transcriptProjection();
  try {
    for (const event of page.events) await projection.replayEvent(event);
    if (projection.items.length <= request.maxItems) return { items: projection.items, nextCursor: page.nextCursor };
    const forward = direction === 'forward';
    const items = forward ? projection.items.slice(0, request.maxItems) : projection.items.slice(-request.maxItems);
    const omitted = projection.items[forward ? request.maxItems : projection.items.length - request.maxItems - 1]!;
    const event = projection.eventFor(omitted.id);
    if (!event) malformed();
    const index = page.events.indexOf(event);
    const eventItems = await projectEvent(event);
    const selected = new Set(items.map(item => item.id));
    const position = forward ? eventItems.findIndex(item => !selected.has(item.id))
      : eventItems.findIndex(item => selected.has(item.id));
    if (position > 0 && position < eventItems.length) {
      return { items, nextCursor: encodePartialItemCursor({
        before: await previousCursor(msp, request, page, index, input, direction), event: eventCursor(event), position,
      }) };
    }
    // A whole native event remains unread. Reuse its observed exclusive native
    // boundary; the position carrier is needed only when one Item is split.
    const nextCursor = forward ? await previousCursor(msp, request, page, index, input, direction)
      : eventCursor(page.events[index + 1]);
    if (!nextCursor) malformed();
    return { items, nextCursor };
  } finally { projection.dispose(); }
}

async function readPartialItem(msp: MuseMsp, request: TranscriptRead, cursor: PartialItemCursor,
  direction: 'forward' | 'backward') {
  const page = await readMuseViewPage(msp.client, { sessionId: request.remoteSessionId, direction: 'forward', limit: 1,
    ...(cursor.before === null ? {} : { cursor: cursor.before }), maxBytes: request.maxSerializedBytes }, request.signal);
  if (page.events.length !== 1 || eventCursor(page.events[0]) !== cursor.event) return;
  const all = await projectEvent(page.events[0]!);
  if (cursor.position >= all.length) return;
  const forward = direction === 'forward';
  const position = forward ? Math.min(all.length, cursor.position + request.maxItems) : Math.max(0, cursor.position - request.maxItems);
  const items = forward ? all.slice(cursor.position, position) : all.slice(position, cursor.position);
  const remains = forward ? position < all.length : position > 0;
  const nextCursor = remains ? encodePartialItemCursor({ ...cursor, position })
    : (forward ? page.nextCursor !== null : cursor.before !== null) ? cursor.event : null;
  return { items, nextCursor, boundary: cursor.event };
}

export const museExternalSessionsContribution: AgentExternalSessionsContribution = {
  resolveSource(request) {
    return withRead(request, async (_msp, source) => bounded({ source }, request));
  },
  listCandidates(request) {
    return withRead(request, async (msp, source) => {
      if (request.searchTarget === 'content') return bounded({ candidates: [], nextCursor: null, contentCoverage: 'unsupported' as const }, request);
      const listed = readMuseRecord(await msp.client.request('session/list', {
        limit: Math.min(request.maxItems, 200), ...(request.cursor ? { cursor: request.cursor } : {}),
        ...(request.updatedAfterMs === undefined ? {} : { updatedAfter: new Date(request.updatedAfterMs).toISOString() }),
        ...(request.searchTerm ? { filter: { text: { fields: ['name', 'title'], allOf: request.searchTerm.split(/\s+/u).filter(Boolean) } } } : {}),
      }, { signal: request.signal }));
      if (!Array.isArray(listed.sessions) || (listed.nextCursor !== null && typeof listed.nextCursor !== 'string')) malformed();
      const candidates: AgentExternalSessionCandidate[] = listed.sessions.map(value => {
        const session = readMuseRecord(value);
        if (typeof session.sessionId !== 'string') malformed();
        const name = typeof session.name === 'string' ? session.name.trim() : '';
        const prompt = typeof session.firstUserPrompt === 'string' && session.firstUserPrompt.trim()
          ? session.firstUserPrompt : typeof session.title === 'string' ? session.title : '';
        const title = name ? projectExternalSessionCandidateTitle(name)
          : projectExternalSessionCandidateTitle(readSessionInputPromptUserTextV1(prompt), { source: 'prompt' });
        return { remoteSessionId: session.sessionId, updatedAtMs: timestamp(session.updatedAt), createdAtMs: timestamp(session.createdAt),
          ...(request.includeTitles === false || !title ? {} : { title }),
          ...(typeof session.workspaceRoot === 'string' ? { cwd: session.workspaceRoot } : {}),
          linkData: { museHome: source.museHome!, sessionId: session.sessionId, ...(typeof session.path === 'string' ? { path: session.path } : {}) },
        };
      });
      return bounded({ candidates, nextCursor: listed.nextCursor }, request);
    });
  },
  resolveLinkIdentity(request) {
    return withRead(request, async (msp, source) => {
      const { session } = await metadata(msp, request.remoteSessionId, request.signal, true);
      return bounded({ source, remoteSessionId: request.remoteSessionId, linkData: {
        museHome: source.museHome!, sessionId: request.remoteSessionId,
        ...(typeof session.path === 'string' ? { path: session.path } : {}),
      } }, request);
    });
  },
  resolveLinkedIdentity(request) {
    if (request.linkData.sessionId !== request.remoteSessionId || request.linkData.museHome !== request.source.museHome) {
      return Promise.resolve({ ok: false, code: 'source_invalid' });
    }
    return museExternalSessionsContribution.resolveLinkIdentity(request);
  },
  pageTranscript(request) {
    return withRead(request, async (msp) => {
      const direction = request.direction === 'older' ? 'backward' : 'forward';
      const partial = partialItemCursor(request.cursor);
      if (partial) {
        const page = await readPartialItem(msp, request, partial, direction);
        return page ? bounded({ items: page.items, nextCursor: page.nextCursor, hasMore: page.nextCursor !== null }, request)
          : { ok: false, code: 'source_unreachable', message: 'Muse retained history boundary is unavailable.' };
      }
      const projection = transcriptProjection();
      try {
        if (!request.cursor) {
          const { result } = await metadata(msp, request.remoteSessionId, request.signal, false);
          const values = readMuseHistoryItems(result.history);
          if (values) {
            await projection.replayItems(values);
            const value: AgentExternalSessionsTranscriptPage = { items: projection.items, nextCursor: null,
              tailCursor: typeof result.viewCursor === 'string' ? result.viewCursor : null, hasMore: false };
            if (projection.items.length <= request.maxItems && isAgentExternalSessionsResultWithinByteBudget({ ok: true, value }, request.maxSerializedBytes)) return bounded(value, request);
          }
        }
      } finally { projection.dispose(); }
      // A caller-bounded window uses the native view cursor, never an offset in
      // a locally sliced folded array (which cannot establish a native tail).
      const events: NativeMessage[] = [];
      let cursor = request.cursor;
      let nextCursor: string | null = null;
      let tailCursor: string | undefined;
      do {
        const page = await readMuseViewPage(msp.client, { sessionId: request.remoteSessionId,
          direction: request.direction === 'older' ? 'backward' : 'forward', limit: request.maxItems - events.length,
          ...(cursor ? { cursor } : {}), maxBytes: request.maxSerializedBytes,
        }, request.signal);
        tailCursor ??= endCursor(page);
        if (request.direction === 'older') events.unshift(...page.events); else events.push(...page.events);
        nextCursor = page.nextCursor;
        cursor = nextCursor ?? undefined;
      } while (cursor !== undefined && events.length < request.maxItems);
      const window = await projectBoundedPage(msp, request, { events, nextCursor }, request.cursor, direction);
      return bounded({ ...window, hasMore: window.nextCursor !== null,
        ...(!request.cursor && request.direction === 'older' ? { tailCursor: tailCursor ?? null } : {}) }, request);
    });
  },
  async readAfterTranscript(request) {
    const result = await withRead<AgentExternalSessionsReadAfterTranscriptResult>(request, async msp => {
      try {
        const partial = partialItemCursor(request.cursor);
        if (partial) {
          const page = await readPartialItem(msp, request, partial, 'forward');
          return page ? bounded({ outcome: 'advanced', items: page.items, nextCursor: page.nextCursor ?? partial.event,
            boundary: page.boundary, hasMore: page.nextCursor !== null }, request)
            : bounded({ outcome: 'gap_or_cursor_expired' }, request);
        }
        const page = await readMuseViewPage(msp.client, { sessionId: request.remoteSessionId, cursor: request.cursor,
          direction: 'forward', limit: request.maxItems, maxBytes: request.maxSerializedBytes }, request.signal);
        if (page.events.length === 0) return bounded({ outcome: 'already_current' }, request);
        const cursor = endCursor(page);
        const boundary = readMuseRecord(page.events[0]?.params).viewCursor;
        if (!cursor || typeof boundary !== 'string') malformed();
        const projection = await projectBoundedPage(msp, request, page, request.cursor, 'forward');
        return bounded({ outcome: 'advanced', items: projection.items, nextCursor: projection.nextCursor ?? cursor, boundary,
          hasMore: projection.nextCursor !== null,
          ...(projection.items.length === 0 ? { diagnostics: [{ code: 'muse_native_nonvisual_events',
            severity: 'benign' as const, count: page.events.length, positions: [] }] } : {}),
        }, request);
      } catch (error) {
        const kind = nativeErrorKind(error);
        if (kind === 'viewTruncated' || kind === 'boundaryPruned' || kind === 'boundaryUnusable' || kind === 'noBoundary') return bounded({ outcome: 'gap_or_cursor_expired' }, request);
        if (kind === 'sessionNotFound') return bounded({ outcome: 'source_unavailable' }, request);
        if (kind === 'sessionStreamMismatch') return bounded({ outcome: 'source_replaced' }, request);
        const stopped = getAgentExternalSessionsInvocationFailure(request);
        return stopped ?? bounded({ outcome: 'read_failed' }, request);
      }
    }, () => bounded({ outcome: 'source_replaced' }, request));
    return !result.ok && result.code === 'source_unreachable' ? bounded({ outcome: 'source_unavailable' }, request) : result;
  },
};
