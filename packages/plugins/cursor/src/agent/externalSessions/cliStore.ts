import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { openSqliteDatabaseSync } from '@happier-dev/plugin-sdk/fs';
import type { AgentExternalSessionTranscriptItem } from '@happier-dev/plugin-sdk/sessions/external';
import { createExternalSessionUnsupportedTranscriptItem } from '@happier-dev/plugin-sdk/sessions/file-stores';
import { isRecord } from '@happier-dev/plugin-sdk';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';

/**
 * Cursor keeps conversations in more than one native store. Each source has
 * its own reader and labels its rows: `cli` is the Cursor CLI's per-chat
 * `store.db`; `app` is the Cursor editor's `state.vscdb` (see `appStore.ts`),
 * which is its own `cursorApp` source.
 */
export type CursorConversationSource = 'cli' | 'app';
export const CURSOR_CLI_SOURCE: CursorConversationSource = 'cli';

/**
 * Cursor CLI chat store, observed in CLI 2026.11.05-86047df (undocumented and
 * version-sensitive; see docs/plugin-platform.md, Cursor CLI store):
 * - `meta(key TEXT, value TEXT)`: key `0` holds hex-encoded JSON
 *   `{agentId, name, createdAt, latestRootBlobId, mode, subagentInfo?, ...}`.
 * - `blobs(id TEXT, data BLOB)`: content-addressed (id = SHA-256 hex). The root
 *   blob is a protobuf whose repeated field 1 lists the conversation's message
 *   blob ids in order; each message blob is JSON `{role, content, id?}`.
 * Readers open the database read-only (never `immutable`: live data sits in the
 * WAL until Cursor checkpoints it). They never write the database or its WAL;
 * like any SQLite reader they take WAL read marks in `-shm` and create empty
 * `-wal`/`-shm` files when absent, which does not block Cursor's writer.
 */
export class CursorCliStoreFormatError extends Error {
  readonly code = 'cursor_cli_store_format_unsupported';
  constructor(readonly reason: string) { super(`Unsupported Cursor CLI store format: ${reason}`); }
}

export type CursorCliStoreConversation = Readonly<{
  id: string;
  storePath: string;
  /** `chat` is an interactive CLI chat; `acp` a session created through `agent acp`. */
  origin: 'chat' | 'acp';
  metadataPath: string;
}>;

export type CursorCliStoreHead = Readonly<{
  agentId: string;
  title: string | null;
  createdAtMs: number;
  rootBlobId: string;
  subagentOf: string | null;
}>;

export type CursorCliStoreHeadState = Readonly<{
  v: 1; kind: 'cursor_cli_store_head'; signature: string;
  agentId: string; title: string | null; createdAtMs: number; rootBlobId: string; subagentOf: string | null;
}>;

async function directoryEntries(path: string) {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) return [];
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return [];
    throw error;
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try { const info = await lstat(path); return info.isFile() && !info.isSymbolicLink(); }
  catch (error) { if (isRecord(error) && error.code === 'ENOENT') return false; throw error; }
}

/** Store files: interactive chats under `chats/<workspace-md5>/<id>` and ACP sessions under `acp-sessions/<id>`. */
export async function discoverCursorCliStores(homeDir: string, signal: AbortSignal): Promise<Readonly<{
  conversations: readonly CursorCliStoreConversation[]; directories: readonly string[];
}>> {
  const conversations: CursorCliStoreConversation[] = [];
  const directories: string[] = [join(homeDir, 'acp-sessions')];
  const consider = async (dir: string, origin: CursorCliStoreConversation['origin']) => {
    signal.throwIfAborted();
    directories.push(dir);
    const storePath = join(dir, 'store.db');
    if (await isRegularFile(storePath)) conversations.push({ id: basename(dir), storePath, origin, metadataPath: join(dir, 'meta.json') });
  };
  for (const workspace of await directoryEntries(join(homeDir, 'chats'))) {
    if (!workspace.isDirectory()) continue;
    for (const chat of await directoryEntries(join(homeDir, 'chats', workspace.name))) {
      if (chat.isDirectory()) await consider(join(homeDir, 'chats', workspace.name, chat.name), 'chat');
    }
  }
  for (const session of await directoryEntries(join(homeDir, 'acp-sessions'))) {
    if (session.isDirectory()) await consider(join(homeDir, 'acp-sessions', session.name), 'acp');
  }
  conversations.sort((a, b) => a.storePath < b.storePath ? -1 : a.storePath > b.storePath ? 1 : 0);
  return { conversations, directories };
}

/** The database and its WAL: every committed Cursor write changes one of them. */
export function cursorCliStoreWatchFiles(conversation: CursorCliStoreConversation): readonly string[] {
  return [conversation.storePath, `${conversation.storePath}-wal`];
}

export async function readCursorCliStoreSignature(conversation: CursorCliStoreConversation): Promise<string> {
  return readCursorSqliteStoreSignature(conversation.storePath);
}

/** Identity of a Cursor SQLite store and its WAL; shared by the CLI and app readers. */
export async function readCursorSqliteStoreSignature(storePath: string): Promise<string> {
  const db = await stat(storePath, { bigint: true });
  let wal = 'none';
  try {
    const info = await stat(`${storePath}-wal`, { bigint: true });
    // An empty WAL holds no commits; SQLite readers create one when it is absent.
    if (info.size > 0n) wal = `${info.ino}:${info.size}:${info.mtimeNs}`;
  } catch (error) { if (!isRecord(error) || error.code !== 'ENOENT') throw error; }
  return `${db.dev}:${db.ino}:${db.size}:${db.mtimeNs}|${wal}`;
}

function withReadOnlyStore<T>(storePath: string, read: (db: ReturnType<typeof openSqliteDatabaseSync>) => T): T {
  const db = openSqliteDatabaseSync(storePath, { readOnly: true });
  try { return read(db); } finally { db.close(); }
}

function parseHead(value: unknown): CursorCliStoreHead {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(value)) throw new CursorCliStoreFormatError('meta value is not hex');
  let data: unknown;
  try { data = JSON.parse(Buffer.from(value, 'hex').toString('utf8')); } catch { throw new CursorCliStoreFormatError('meta value is not JSON'); }
  if (!isRecord(data) || typeof data.agentId !== 'string' || !data.agentId
    || typeof data.latestRootBlobId !== 'string' || !/^[0-9a-f]{64}$/.test(data.latestRootBlobId)
    || typeof data.createdAt !== 'number' || !Number.isFinite(data.createdAt)
    || (data.name !== undefined && typeof data.name !== 'string')) throw new CursorCliStoreFormatError('meta fields');
  const subagent = isRecord(data.subagentInfo) && typeof data.subagentInfo.rootParentAgentId === 'string'
    ? data.subagentInfo.rootParentAgentId : null;
  const title = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : null;
  return { agentId: data.agentId, title, createdAtMs: data.createdAt, rootBlobId: data.latestRootBlobId, subagentOf: subagent };
}

function readHeadRow(db: ReturnType<typeof openSqliteDatabaseSync>): CursorCliStoreHead {
  let row: unknown;
  try { row = db.prepare("SELECT value FROM meta WHERE key = '0'").get(); }
  catch { throw new CursorCliStoreFormatError('meta table'); }
  if (!isRecord(row)) throw new CursorCliStoreFormatError('meta row');
  return parseHead(row.value);
}

/** Reuses an unchanged store's head from the host's per-row checkpoint. */
export async function readCursorCliStoreHead(conversation: CursorCliStoreConversation, previous: unknown): Promise<Readonly<{
  head: CursorCliStoreHead; state: CursorCliStoreHeadState;
}>> {
  const signature = await readCursorCliStoreSignature(conversation);
  if (isRecord(previous) && previous.v === 1 && previous.kind === 'cursor_cli_store_head' && previous.signature === signature
    && typeof previous.agentId === 'string' && typeof previous.rootBlobId === 'string' && typeof previous.createdAtMs === 'number'
    && (previous.title === null || typeof previous.title === 'string')
    && (previous.subagentOf === null || typeof previous.subagentOf === 'string')) {
    const head = { agentId: previous.agentId, title: previous.title, createdAtMs: previous.createdAtMs,
      rootBlobId: previous.rootBlobId, subagentOf: previous.subagentOf };
    return { head, state: previous as CursorCliStoreHeadState };
  }
  const head = withReadOnlyStore(conversation.storePath, readHeadRow);
  return { head, state: { v: 1, kind: 'cursor_cli_store_head', signature, ...head } };
}

/** The chat's own `meta.json` may carry its working directory; it is optional. */
export async function readCursorCliStoreWorkingDirectory(conversation: CursorCliStoreConversation): Promise<string | undefined> {
  try {
    const data: unknown = JSON.parse(await readFile(conversation.metadataPath, 'utf8'));
    return isRecord(data) && typeof data.cwd === 'string' && data.cwd.trim() ? data.cwd : undefined;
  } catch { return undefined; }
}

function readVarint(bytes: Uint8Array, start: number): readonly [number, number] {
  let value = 0; let shift = 0; let index = start;
  while (index < bytes.length && shift <= 49) {
    const byte = bytes[index++]!;
    value += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) return [value, index];
    shift += 7;
  }
  throw new CursorCliStoreFormatError('root blob varint');
}

/** Ordered message blob ids: the root protobuf's repeated field 1, 32 bytes each. */
export function readCursorCliRootMessageIds(root: Uint8Array): readonly string[] {
  const ids: string[] = [];
  let index = 0;
  while (index < root.length) {
    const [key, afterKey] = readVarint(root, index);
    const field = Math.floor(key / 8); const wire = key % 8;
    index = afterKey;
    if (wire === 0) { index = readVarint(root, index)[1]; continue; }
    if (wire === 1) { index += 8; continue; }
    if (wire === 5) { index += 4; continue; }
    if (wire !== 2) throw new CursorCliStoreFormatError('root blob wire type');
    const [length, afterLength] = readVarint(root, index);
    const end = afterLength + length;
    if (end > root.length) throw new CursorCliStoreFormatError('root blob length');
    if (field === 1) {
      if (length !== 32) throw new CursorCliStoreFormatError('message reference length');
      ids.push(Buffer.from(root.subarray(afterLength, end)).toString('hex'));
    }
    index = end;
  }
  if (index !== root.length) throw new CursorCliStoreFormatError('root blob trailing bytes');
  return ids;
}

export type CursorCliStoreMessages = Readonly<{ head: CursorCliStoreHead; messageIds: readonly string[]; messages: readonly unknown[] }>;

/** Reads the conversation at its latest root in one read-only transaction-free pass. */
export function readCursorCliStoreMessages(conversation: CursorCliStoreConversation): CursorCliStoreMessages {
  return withReadOnlyStore(conversation.storePath, (db) => {
    const head = readHeadRow(db);
    const blob = db.prepare('SELECT data FROM blobs WHERE id = ?');
    const readBlob = (id: string): Uint8Array => {
      const row: unknown = blob.get(id);
      if (!isRecord(row) || !(row.data instanceof Uint8Array)) throw new CursorCliStoreFormatError('missing blob');
      return row.data;
    };
    const messageIds = readCursorCliRootMessageIds(readBlob(head.rootBlobId));
    const messages = messageIds.map((id) => {
      try { return JSON.parse(Buffer.from(readBlob(id)).toString('utf8')) as unknown; } catch { return undefined; }
    });
    return { head, messageIds, messages };
  });
}

export type CursorCliDecodedMessage = Readonly<{ items: readonly AgentExternalSessionTranscriptItem[]; text: string | null; partial: boolean }>;

/**
 * Maps one AI-SDK style message. System prompts and reasoning are not
 * transcript body text; any other unknown shape becomes an unsupported row.
 */
export function decodeCursorCliMessage(value: unknown, itemId: string, createdAtMs: number): CursorCliDecodedMessage {
  const unsupported = (): CursorCliDecodedMessage => ({ partial: true, text: null,
    items: [createExternalSessionUnsupportedTranscriptItem({ agentId: 'cursor', id: itemId, createdAtMs })] });
  if (!isRecord(value) || typeof value.role !== 'string') return unsupported();
  if (value.role === 'system') return { items: [], text: null, partial: false };
  const parts: readonly unknown[] = typeof value.content === 'string' ? [{ type: 'text', text: value.content }]
    : Array.isArray(value.content) ? value.content : [];
  if (!Array.isArray(value.content) && typeof value.content !== 'string') return unsupported();
  const items: AgentExternalSessionTranscriptItem[] = [];
  const texts: string[] = [];
  let partial = false;
  parts.forEach((part, index) => {
    const id = parts.length === 1 ? itemId : `${itemId}:${index}`;
    if (!isRecord(part) || typeof part.type !== 'string') { partial = true; items.push(...unsupported().items.map((item) => ({ ...item, id }))); return; }
    if (part.type === 'text' && typeof part.text === 'string' && (value.role === 'user' || value.role === 'assistant')) {
      texts.push(part.text);
      items.push(value.role === 'user'
        ? { id, createdAtMs, messageRole: 'user', raw: { role: 'user', content: { type: 'text', text: part.text } } }
        : { id, createdAtMs, messageRole: 'agent', raw: { role: 'agent', content: { type: 'acp', agentId: 'cursor', data: { type: 'message', message: part.text } } } });
      return;
    }
    if (part.type === 'reasoning' && value.role === 'assistant') return;
    if (part.type === 'tool-call' && value.role === 'assistant' && typeof part.toolCallId === 'string' && typeof part.toolName === 'string') {
      items.push({ id, createdAtMs, messageRole: 'event', raw: { role: 'agent', content: { type: 'acp', agentId: 'cursor',
        data: { type: 'tool-call', callId: part.toolCallId, name: part.toolName, input: isRecord(part.args) ? projectNativeJsonValueForTransport(part.args) : {} } } } });
      return;
    }
    if (part.type === 'tool-result' && value.role === 'tool' && typeof part.toolCallId === 'string' && typeof part.result === 'string') {
      items.push({ id, createdAtMs, messageRole: 'event', raw: { role: 'agent', content: { type: 'acp', agentId: 'cursor',
        data: { type: 'tool-result', callId: part.toolCallId, output: part.result } } } });
      return;
    }
    partial = true;
    items.push(...unsupported().items.map((item) => ({ ...item, id })));
  });
  return { items, text: texts.length ? texts.join('\n') : null, partial };
}
