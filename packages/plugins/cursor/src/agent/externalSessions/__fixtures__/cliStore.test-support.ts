import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openSqliteDatabaseSync, type SqliteDatabaseSync } from '@happier-dev/plugin-sdk/fs';

/**
 * Cursor CLI `store.db` vector. Basis: a real store captured read-only from
 * Cursor CLI 2026.11.05-86047df on 2026-11-11 (an `agent acp` session).
 * Kept: table DDL, the meta key and its JSON key set, content-addressed blob
 * ids, the root protobuf's field layout (repeated field 1 = ordered 32-byte
 * message ids, plus other fields this reader skips), and the message JSON
 * shapes. Replaced: all conversation text, tool arguments and results, ids
 * and the blob encryption key.
 */
export const CURSOR_CLI_STORE_DIALECT = 'cursor-cli-2026.11.05-store-db';

export type CursorCliFixtureMessage = Record<string, unknown>;

export const cursorCliSampleMessages = (): CursorCliFixtureMessage[] => [
  { role: 'system', content: 'replaced system prompt' },
  { role: 'user', content: 'replaced first user message' },
  { id: 'm-1', role: 'assistant', content: [
    { type: 'reasoning', text: 'replaced reasoning', signature: 'sig', providerOptions: { cursor: { modelName: 'model' } } },
    { type: 'text', text: 'replaced assistant reply' },
    { type: 'tool-call', toolCallId: 'call-1', toolName: 'Shell', args: { command: 'replaced', description: 'replaced' } },
  ] },
  { id: 'm-2', role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'Shell', result: 'replaced output',
    experimental_content: [{ type: 'text', text: 'replaced output' }] }] },
  { role: 'user', content: [{ type: 'text', text: 'replaced second user message' }] },
];

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) { bytes.push((rest % 0x80) | 0x80); rest = Math.floor(rest / 0x80); }
  bytes.push(rest);
  return Buffer.from(bytes);
}
const lengthDelimited = (field: number, value: Buffer) => Buffer.concat([varint(field * 8 + 2), varint(value.length), value]);
const varintField = (field: number, value: number) => Buffer.concat([varint(field * 8), varint(value)]);

export type CursorCliFixtureStore = Readonly<{ db: SqliteDatabaseSync; storePath: string; setMessages(messages: CursorCliFixtureMessage[]): void }>;

export async function writeCursorCliStore(dir: string, options: Readonly<{
  id: string; name?: string; createdAt?: number; messages?: CursorCliFixtureMessage[]; subagentOf?: string;
  metaJson?: Record<string, unknown>; rawMeta?: string; keepOpen?: boolean;
}>): Promise<CursorCliFixtureStore> {
  await mkdir(dir, { recursive: true });
  if (options.metaJson) await writeFile(join(dir, 'meta.json'), JSON.stringify(options.metaJson));
  const storePath = join(dir, 'store.db');
  const db = openSqliteDatabaseSync(storePath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
  const insertBlob = db.prepare('INSERT OR REPLACE INTO blobs (id, data) VALUES (?, ?)');
  const setMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  const put = (data: Buffer) => { const id = createHash('sha256').update(data).digest('hex'); insertBlob.run(id, data); return id; };
  const setMessages = (messages: CursorCliFixtureMessage[]) => {
    const ids = messages.map(message => put(Buffer.from(JSON.stringify(message))));
    // Field layout follows the captured root: message ids, then skipped fields.
    const root = Buffer.concat([
      ...ids.map(id => lengthDelimited(1, Buffer.from(id, 'hex'))),
      lengthDelimited(5, Buffer.alloc(32, 1)), varintField(10, 1),
      lengthDelimited(16, Buffer.concat([lengthDelimited(1, Buffer.from('k')), lengthDelimited(2, Buffer.from('v'))])),
      varintField(26, 3), varintField(46, 0),
    ]);
    const rootId = put(root);
    const meta = { agentId: options.id, latestRootBlobId: rootId, name: options.name ?? 'Replaced title',
      createdAt: options.createdAt ?? 1_794_213_953_388, mode: 'default', isRunEverything: false,
      ...(options.subagentOf ? { subagentInfo: { parentAgentId: options.subagentOf, rootParentAgentId: options.subagentOf,
        toolCallId: 'call-0', typeName: 'generalPurpose' } } : {}),
      blobEncryptionKey: 'replaced' };
    setMeta.run('0', options.rawMeta ?? Buffer.from(JSON.stringify(meta)).toString('hex'));
  };
  setMessages(options.messages ?? cursorCliSampleMessages());
  if (!options.keepOpen) db.close();
  return { db, storePath, setMessages };
}
