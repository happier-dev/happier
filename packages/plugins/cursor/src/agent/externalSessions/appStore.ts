import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { canonicalizePath, openSqliteDatabaseSync, resolveConfiguredPath, resolveHomeDirFromEnvironment, type SqliteDatabaseSync } from '@happier-dev/plugin-sdk/fs';
import type {
  AgentExternalSessionCandidate, AgentExternalSessionSource, AgentExternalSessionsListCandidatesRequest,
  AgentExternalSessionsListCandidatesResult, AgentExternalSessionsPageTranscriptRequest, AgentExternalSessionsReadAfterTranscriptRequest,
  AgentExternalSessionsReadAfterTranscriptResult, AgentExternalSessionsResult, AgentExternalSessionsTranscriptPage,
  AgentExternalSessionTranscriptItem,
} from '@happier-dev/plugin-sdk/sessions/external';
import { createAgentExternalSessionsProducerOverflowFailure, isAgentExternalSessionsResultWithinByteBudget } from '@happier-dev/plugin-sdk/sessions/external';
import { createExternalSessionUnsupportedTranscriptItem } from '@happier-dev/plugin-sdk/sessions/file-stores';
import { isRecord } from '@happier-dev/plugin-sdk';
import { decodeCursorCliMessage, readCursorSqliteStoreSignature, type CursorConversationSource } from './cliStore.js';

/**
 * Cursor app (editor) conversations, observed in Cursor 3.27.22 on macOS
 * (undocumented and version-sensitive; see docs/plugin-platform.md, Cursor
 * native conversation stores). One global SQLite `state.vscdb` holds them:
 * - `composerHeaders` table: one row per conversation (title, times,
 *   workspace, subagent relation in `value` JSON). It is the listing index.
 * - `cursorDiskKV(key, value)`: `composerData:<id>` orders the visible
 *   messages in `fullConversationHeadersOnly`; each message is
 *   `bubbleId:<id>:<bubbleId>`. Every read is a key lookup on the table's
 *   unique index; the multi-GB table is never scanned.
 * Opened read-only through the SDK SQLite owner, never `immutable`: the app
 * writes through the WAL while it runs.
 */
export const CURSOR_APP_SOURCE: CursorConversationSource = 'app';
export const CURSOR_APP_STORE_UNSUPPORTED = Object.freeze({
  ok: false as const, code: 'format_unsupported' as const, retryable: false, message: 'cursor_app_store_format_unsupported',
});

class CursorAppStoreFormatError extends Error {
  constructor(readonly reason: string) { super(`Unsupported Cursor app store format: ${reason}`); }
}

export type CursorAppStore = Readonly<{ dataDir: string; dbPath: string; source: AgentExternalSessionSource }>;

/** Electron's `appData` directory for the Cursor app on each platform. */
export function resolveCursorAppDataDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  const home = resolveHomeDirFromEnvironment(env, platform);
  if (platform === 'win32') return win32.join(env.APPDATA?.trim() || win32.join(home, 'AppData', 'Roaming'), 'Cursor');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Cursor');
  return join(env.XDG_CONFIG_HOME?.trim() || join(home, '.config'), 'Cursor');
}

export async function resolveCursorAppStore(source: AgentExternalSessionSource): Promise<CursorAppStore | null> {
  if (source.kind !== 'cursorApp') return null;
  if (source.dataDir != null && (typeof source.dataDir !== 'string' || !source.dataDir.trim())) return null;
  const dataDir = await canonicalizePath(typeof source.dataDir === 'string'
    ? resolveConfiguredPath(source.dataDir) : resolveCursorAppDataDir(process.env));
  return { dataDir, dbPath: join(dataDir, 'User', 'globalStorage', 'state.vscdb'), source: { kind: 'cursorApp', dataDir } };
}

export const cursorAppWatchFiles = (store: CursorAppStore): readonly string[] => [store.dbPath, `${store.dbPath}-wal`];

async function storeExists(store: CursorAppStore): Promise<boolean> {
  try { return (await lstat(store.dbPath)).isFile(); }
  catch (error) { if (isRecord(error) && error.code === 'ENOENT') return false; throw error; }
}

function withStore<T>(store: CursorAppStore, read: (db: SqliteDatabaseSync) => T): T {
  const db = openSqliteDatabaseSync(store.dbPath, { readOnly: true });
  try { return read(db); } finally { db.close(); }
}

const HEADER_COLUMNS = ['composerId', 'createdAt', 'isArchived', 'isSubagent', 'recency', 'value'];
function assertFormat(db: SqliteDatabaseSync): void {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('composerHeaders', 'cursorDiskKV')").all()
    .map(row => isRecord(row) ? row.name : null));
  if (!tables.has('composerHeaders') || !tables.has('cursorDiskKV')) throw new CursorAppStoreFormatError('tables');
  const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('composerHeaders')").all().map(row => isRecord(row) ? row.name : null));
  if (HEADER_COLUMNS.some(column => !columns.has(column))) throw new CursorAppStoreFormatError('composerHeaders columns');
}

type HeaderRow = Readonly<{ composerId: string; createdAt: number; isArchived: number; isSubagent: number; recency: number; value: string }>;
function readHeaderRow(row: unknown): HeaderRow {
  if (!isRecord(row) || typeof row.composerId !== 'string' || !row.composerId || typeof row.value !== 'string'
    || typeof row.createdAt !== 'number' || typeof row.recency !== 'number') throw new CursorAppStoreFormatError('header row');
  return { composerId: row.composerId, createdAt: row.createdAt, recency: row.recency, value: row.value,
    isArchived: row.isArchived === 1 ? 1 : 0, isSubagent: row.isSubagent === 1 ? 1 : 0 };
}

/** Per-row index state: whether this header row's conversation has messages. */
type AppHeadState = Readonly<{ v: 1; kind: 'cursor_app_head'; fingerprint: string; messages: number | null }>;
const fingerprint = (row: HeaderRow) => createHash('sha256').update(`${row.recency}|${row.isArchived}|${row.value}`).digest('base64url');
function previousMessages(previous: unknown, print: string): number | null | undefined {
  return isRecord(previous) && previous.v === 1 && previous.kind === 'cursor_app_head' && previous.fingerprint === print
    && (previous.messages === null || (typeof previous.messages === 'number' && Number.isSafeInteger(previous.messages)))
    ? previous.messages as number | null : undefined;
}

type ListCursor = Readonly<{ v: 1; kind: 'cursorAppCandidates'; dataDir: string; query: string; target: string; after: string; partial: boolean }>;
const encodeJson = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
function decodeJson(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try { const data: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString()); return isRecord(data) ? data : null; }
  catch { return null; }
}

export async function listCursorAppCandidates(store: CursorAppStore, request: AgentExternalSessionsListCandidatesRequest): Promise<AgentExternalSessionsResult<AgentExternalSessionsListCandidatesResult>> {
  const query = request.searchTerm ?? ''; const target = request.searchTarget ?? 'metadata';
  const raw = request.cursor ? decodeJson(request.cursor) : null;
  const previous = raw && raw.v === 1 && raw.kind === 'cursorAppCandidates' && raw.dataDir === store.dataDir && raw.query === query
    && raw.target === target && typeof raw.after === 'string' ? raw as unknown as ListCursor : null;
  if (request.cursor && !previous) return { ok: false, code: 'invalid_request', message: 'Cursor app continuation does not match this source/query.' };
  // A machine without the Cursor app (or before its first run) has no conversations.
  if (!await storeExists(store)) return { ok: true, value: { candidates: [], nextCursor: null } };
  const scan: ListCursor = previous ?? { v: 1, kind: 'cursorAppCandidates', dataDir: store.dataDir, query, target, after: '', partial: false };
  // App conversations are listed by metadata; their bodies are not content-searched.
  const partial = scan.partial || (target === 'content' && !!query);
  const candidates: AgentExternalSessionCandidate[] = [];
  const result = (next: string | null): AgentExternalSessionsResult<AgentExternalSessionsListCandidatesResult> => ({ ok: true, value: {
    candidates, nextCursor: next === null ? null : encodeJson({ ...scan, after: next, partial }),
    ...(target === 'content' ? { contentCoverage: partial || next !== null ? 'partial' : 'complete' } : {}),
    ...(partial || next !== null ? { searchIncomplete: true } : {}),
  } });
  if (target === 'content' && query) return result(null);
  try {
    return withStore(store, (db) => {
      assertFormat(db);
      const rows = db.prepare(`SELECT composerId, createdAt, isArchived, isSubagent, recency, value FROM composerHeaders
        WHERE composerId > ?${request.includeThreads ? '' : ' AND isSubagent = 0'} ORDER BY composerId`).all(scan.after).map(readHeaderRow);
      const messages = db.prepare("SELECT json_array_length(value, '$.fullConversationHeadersOnly') AS n FROM cursorDiskKV WHERE key = ?");
      const linkData = { cursorSource: CURSOR_APP_SOURCE };
      let last = scan.after;
      for (const row of rows) {
        request.signal.throwIfAborted();
        if (candidates.length >= request.maxItems) return result(last);
        const print = fingerprint(row);
        let count = previousMessages(request.readCandidateIndexState?.({ remoteSessionId: row.composerId, linkData }), print);
        if (count === undefined) {
          try {
            const found: unknown = messages.get(`composerData:${row.composerId}`);
            count = isRecord(found) && typeof found.n === 'number' ? found.n : null;
          } catch { count = null; }
        }
        let header: Record<string, unknown>;
        try { const parsed: unknown = JSON.parse(row.value); if (!isRecord(parsed)) throw new Error('header'); header = parsed; }
        catch { throw new CursorAppStoreFormatError('header value'); }
        const previousLast = last; last = row.composerId;
        // An empty conversation (a new-chat tab that never got a message) is not a session.
        if (!count) continue;
        const title = typeof header.name === 'string' && header.name.trim() ? header.name.trim() : null;
        const workspace = isRecord(header.workspaceIdentifier) && isRecord(header.workspaceIdentifier.uri) ? header.workspaceIdentifier.uri : null;
        const cwd = typeof workspace?.fsPath === 'string' && workspace.fsPath ? workspace.fsPath : undefined;
        const parent = isRecord(header.subagentInfo) && typeof header.subagentInfo.parentComposerId === 'string' ? header.subagentInfo.parentComposerId : null;
        if (query && ![title ?? '', cwd ?? '', row.composerId].some(text => text.toLocaleLowerCase().includes(query.toLocaleLowerCase()))) continue;
        const state: AppHeadState = { v: 1, kind: 'cursor_app_head', fingerprint: print, messages: count };
        candidates.push({ remoteSessionId: row.composerId, title: title ?? row.composerId, ...(cwd ? { cwd } : {}),
          createdAtMs: row.createdAt, updatedAtMs: row.recency, ...(row.isArchived ? { archived: true } : {}),
          ...(row.isSubagent ? { thread: { kind: 'subagent' as const, parentRemoteSessionId: parent } } : {}),
          linkData, ...(request.readCandidateIndexState ? { candidateIndexState: state } : {}) });
        if (!isAgentExternalSessionsResultWithinByteBudget(result(row.composerId), request.maxSerializedBytes)) {
          candidates.pop();
          if (!candidates.length) return createAgentExternalSessionsProducerOverflowFailure('Cursor app candidate cannot fit the caller result budget.');
          return result(previousLast);
        }
      }
      return result(null);
    });
  } catch (error) {
    if (error instanceof CursorAppStoreFormatError) return CURSOR_APP_STORE_UNSUPPORTED;
    throw error;
  }
}

type Conversation = Readonly<{ bubbleIds: readonly string[]; settled: number; createdAtMs: number }>;
function readConversation(db: SqliteDatabaseSync, id: string): Conversation | null {
  const row: unknown = db.prepare(`SELECT json_extract(value, '$.fullConversationHeadersOnly') AS headers,
    json_extract(value, '$.generatingBubbleIds') AS generating, json_extract(value, '$.createdAt') AS createdAt
    FROM cursorDiskKV WHERE key = ?`).get(`composerData:${id}`);
  if (!isRecord(row)) return null;
  let headers: unknown; let generating: unknown;
  try {
    headers = typeof row.headers === 'string' ? JSON.parse(row.headers) : null;
    generating = typeof row.generating === 'string' ? JSON.parse(row.generating) : [];
  } catch { throw new CursorAppStoreFormatError('conversation JSON'); }
  if (!Array.isArray(headers) || !Array.isArray(generating)) throw new CursorAppStoreFormatError('conversation headers');
  const bubbleIds = headers.map((header) => {
    if (!isRecord(header) || typeof header.bubbleId !== 'string' || !header.bubbleId) throw new CursorAppStoreFormatError('bubble header');
    return header.bubbleId;
  });
  // A bubble the app is still streaming, and everything after it, is not delivered yet.
  const streaming = new Set(generating.filter((value): value is string => typeof value === 'string'));
  const firstStreaming = bubbleIds.findIndex(bubbleId => streaming.has(bubbleId));
  return { bubbleIds, settled: firstStreaming < 0 ? bubbleIds.length : firstStreaming,
    createdAtMs: typeof row.createdAt === 'number' ? row.createdAt : 0 };
}

const BUBBLE_FIELDS = `SELECT json_extract(value, '$.type') AS type, json_extract(value, '$.text') AS text,
  json_extract(value, '$.createdAt') AS createdAt, json_extract(value, '$.isSimulatedMsg') AS simulated,
  json_extract(value, '$.toolFormerData.toolCallId') AS toolCallId, json_extract(value, '$.toolFormerData.name') AS toolName,
  json_extract(value, '$.toolFormerData.params') AS params, json_extract(value, '$.toolFormerData.result') AS result
  FROM cursorDiskKV WHERE key = ?`;

/**
 * Maps one bubble to the AI-SDK message shape the CLI store uses, so both
 * Cursor sources share `decodeCursorCliMessage`. Thinking-only, empty and
 * app-simulated bubbles are not transcript rows.
 */
function decodeBubble(row: unknown, bubbleId: string, fallbackMs: number): Readonly<{ items: AgentExternalSessionTranscriptItem[]; partial: boolean }> {
  const id = `cursor:app:${bubbleId}`;
  if (!isRecord(row) || (row.type !== 1 && row.type !== 2)) {
    return { partial: true, items: [createExternalSessionUnsupportedTranscriptItem({ agentId: 'cursor', id, createdAtMs: fallbackMs })] };
  }
  const parsedAt = typeof row.createdAt === 'string' ? Date.parse(row.createdAt) : Number.NaN;
  const createdAtMs = Number.isFinite(parsedAt) ? parsedAt : fallbackMs;
  const text = typeof row.text === 'string' && row.text.trim() ? row.text : null;
  const messages: Array<Readonly<{ itemId: string; message: unknown }>> = [];
  if (row.type === 1) {
    if (text && row.simulated !== 1) messages.push({ itemId: id, message: { role: 'user', content: text } });
  } else {
    if (text) messages.push({ itemId: id, message: { role: 'assistant', content: [{ type: 'text', text }] } });
    if (typeof row.toolCallId === 'string' && typeof row.toolName === 'string') {
      let args: unknown = {};
      try { args = typeof row.params === 'string' ? JSON.parse(row.params) : {}; } catch { args = {}; }
      messages.push({ itemId: `${id}:call`, message: { role: 'assistant', content: [{ type: 'tool-call', toolCallId: row.toolCallId,
        toolName: row.toolName, args: isRecord(args) ? args : {} }] } });
      if (typeof row.result === 'string') messages.push({ itemId: `${id}:result`, message: { role: 'tool',
        content: [{ type: 'tool-result', toolCallId: row.toolCallId, result: row.result }] } });
    }
  }
  const items: AgentExternalSessionTranscriptItem[] = []; let partial = false;
  for (const { itemId, message } of messages) {
    const decoded = decodeCursorCliMessage(message, itemId, createdAtMs);
    items.push(...decoded.items); partial ||= decoded.partial;
  }
  return { items, partial };
}

type StoreCursor = Readonly<{ v: 1; kind: 'cursorAppStore'; dataDir: string; id: string; position: number; prefix: string; signature: string }>;
function decodeStoreCursor(raw: string | undefined | null): StoreCursor | null {
  const data = decodeJson(raw);
  if (!data || data.v !== 1 || data.kind !== 'cursorAppStore' || typeof data.dataDir !== 'string' || typeof data.id !== 'string'
    || typeof data.position !== 'number' || !Number.isSafeInteger(data.position) || data.position < 0
    || typeof data.prefix !== 'string' || typeof data.signature !== 'string') return null;
  return data as unknown as StoreCursor;
}
/** Bubble ids are stable, so the id list of a prefix proves that prefix is unchanged. */
const prefixHash = (ids: readonly string[], end: number) => createHash('sha256').update(ids.slice(0, end).join(',')).digest('base64url');

export function resolveCursorAppConversation(store: CursorAppStore, id: string): boolean {
  return withStore(store, db => db.prepare('SELECT 1 AS found FROM cursorDiskKV WHERE key = ?').get(`composerData:${id}`) !== undefined);
}

export async function resolveCursorAppLinkIdentity(store: CursorAppStore, id: string) {
  if (!await storeExists(store) || !resolveCursorAppConversation(store, id)) return { ok: false as const, code: 'candidate_not_found' as const };
  return { ok: true as const, value: { source: store.source, remoteSessionId: id, linkData: { cursorSource: CURSOR_APP_SOURCE } } };
}

export async function pageCursorAppTranscript(store: CursorAppStore, request: AgentExternalSessionsPageTranscriptRequest): Promise<AgentExternalSessionsResult<AgentExternalSessionsTranscriptPage>> {
  const previous = request.cursor ? decodeStoreCursor(request.cursor) : null;
  if (request.cursor && (!previous || previous.dataDir !== store.dataDir || previous.id !== request.remoteSessionId)) return { ok: false, code: 'invalid_request' };
  if (!await storeExists(store)) return { ok: false, code: 'candidate_not_found' };
  try {
    const signature = await readCursorSqliteStoreSignature(store.dbPath);
    return withStore(store, (db) => {
      const conversation = readConversation(db, request.remoteSessionId);
      if (!conversation) return { ok: false, code: 'candidate_not_found' } as const;
      const { bubbleIds, settled: total } = conversation;
      if (previous && (previous.position > total || prefixHash(bubbleIds, previous.position) !== previous.prefix)) return { ok: false, code: 'source_invalid' } as const;
      const bubble = db.prepare(BUBBLE_FIELDS);
      const cursor = (position: number) => encodeJson({ v: 1, kind: 'cursorAppStore', dataDir: store.dataDir, id: request.remoteSessionId,
        position, prefix: prefixHash(bubbleIds, position), signature } satisfies StoreCursor);
      const older = request.direction !== 'newer';
      for (let limit = Math.max(1, request.maxItems); ; limit = Math.max(1, Math.floor(limit / 2))) {
        const end = older ? previous?.position ?? total : Math.min(total, (previous?.position ?? 0) + limit);
        const start = older ? Math.max(0, end - limit) : previous?.position ?? 0;
        const items: AgentExternalSessionTranscriptItem[] = []; let partial = 0;
        for (let index = start; index < end; index += 1) {
          request.signal.throwIfAborted();
          const decoded = decodeBubble(bubble.get(`bubbleId:${request.remoteSessionId}:${bubbleIds[index]}`), bubbleIds[index]!, conversation.createdAtMs);
          items.push(...decoded.items); if (decoded.partial) partial += 1;
        }
        const hasMore = older ? start > 0 : end < total;
        const result = { ok: true as const, value: { items, nextCursor: hasMore ? cursor(older ? start : end) : null, tailCursor: cursor(total), hasMore,
          ...(partial ? { diagnostics: [{ code: 'unsupported_native_record', severity: 'required' as const, count: partial, positions: [] }] } : {}) } };
        if (isAgentExternalSessionsResultWithinByteBudget(result, request.maxSerializedBytes)) return result;
        if (limit === 1) return createAgentExternalSessionsProducerOverflowFailure('Cursor app transcript record exceeds the caller result budget.');
      }
    });
  } catch (error) {
    if (error instanceof CursorAppStoreFormatError) return CURSOR_APP_STORE_UNSUPPORTED;
    throw error;
  }
}

export async function readAfterCursorAppTranscript(
  store: CursorAppStore,
  request: AgentExternalSessionsReadAfterTranscriptRequest,
): Promise<AgentExternalSessionsResult<AgentExternalSessionsReadAfterTranscriptResult>> {
  const done = <T extends object>(value: T) => ({ ok: true as const, value });
  const previous = decodeStoreCursor(request.cursor);
  if (!previous || previous.dataDir !== store.dataDir || previous.id !== request.remoteSessionId) return done({ outcome: 'gap_or_cursor_expired' as const });
  if (!await storeExists(store)) return done({ outcome: 'source_unavailable' as const });
  // No committed app write reached the database or its WAL since this cursor.
  if (await readCursorSqliteStoreSignature(store.dbPath) === previous.signature) return done({ outcome: 'already_current' as const });
  const page = await pageCursorAppTranscript(store, { ...request, direction: 'newer' } as AgentExternalSessionsPageTranscriptRequest);
  if (!page.ok) return page.code === 'source_invalid' ? done({ outcome: 'source_replaced' as const })
    : page.code === 'candidate_not_found' ? done({ outcome: 'source_unavailable' as const }) : page;
  if (!page.value.items.length && decodeStoreCursor(page.value.tailCursor)?.position === previous.position) {
    // Other app state changed; this conversation did not. Nothing is published:
    // the cursor keeps its signature, so the next write re-reads this one row.
    return done({ outcome: 'already_current' as const });
  }
  return done({ outcome: 'advanced' as const, items: page.value.items, nextCursor: page.value.nextCursor ?? page.value.tailCursor!,
    boundary: request.remoteSessionId, hasMore: page.value.hasMore ?? false, diagnostics: page.value.diagnostics });
}

export function describeCursorAppAccountingSource(store: CursorAppStore) {
  return {
    rootPath: store.dataDir, resourceKey: `cursor:app:${createHash('sha256').update(store.dataDir).digest('base64url')}`,
    changeObservation: 'watch_file_changes' as const,
    // The app commits through its WAL; the database and WAL are watched, never polled.
    watchFileChanges: { files: [...cursorAppWatchFiles(store)], topologyDirectories: [join(store.dataDir, 'User', 'globalStorage')] },
  };
}
