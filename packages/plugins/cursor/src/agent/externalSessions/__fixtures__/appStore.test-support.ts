import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { openSqliteDatabaseSync, type SqliteDatabaseSync } from '@happier-dev/plugin-sdk/fs';

/**
 * Cursor app `state.vscdb` vector. Basis: the structure of a real store
 * captured read-only from Cursor app 3.27.22 (macOS) on 2026-11-11, structure
 * only (see docs/plugin-platform.md, Cursor native conversation stores).
 * Kept: the three tables and their DDL/indexes, the `composerData:<id>` and
 * `bubbleId:<composer>:<bubble>` key families, the header row's JSON field
 * names, `fullConversationHeadersOnly` ordering, `generatingBubbleIds`, and
 * the bubble fields this reader extracts. Replaced: every text, title, path,
 * id and tool argument/result.
 */
export const CURSOR_APP_STORE_DIALECT = 'cursor-app-3.27.22-state-vscdb';

export type CursorAppFixtureBubble = Readonly<{
  id: string; type: number; text?: string; createdAt?: string; simulated?: boolean;
  tool?: Readonly<{ toolCallId: string; name: string; params?: string; result?: string }>;
}>;
export type CursorAppFixtureConversation = Readonly<{
  id: string; name?: string; createdAt?: number; recency?: number; folder?: string; multiRoot?: boolean;
  subagentOf?: string; archived?: boolean; bubbles?: readonly CursorAppFixtureBubble[]; generating?: readonly string[];
}>;

export const cursorAppSampleBubbles = (): CursorAppFixtureBubble[] => [
  { id: 'b-1', type: 1, text: 'replaced user prompt', createdAt: '2026-10-31T10:00:00.000Z' },
  { id: 'b-2', type: 2, createdAt: '2026-10-31T10:00:01.000Z' },
  { id: 'b-3', type: 2, createdAt: '2026-10-31T10:00:02.000Z',
    tool: { toolCallId: 'call-1', name: 'read_file', params: '{"path":"replaced"}', result: '{"contents":"replaced"}' } },
  { id: 'b-4', type: 2, text: 'replaced assistant reply', createdAt: '2026-10-31T10:00:03.000Z' },
  { id: 'b-5', type: 1, text: 'replaced background notice', simulated: true },
];

export type CursorAppFixtureStore = Readonly<{
  db: SqliteDatabaseSync; dbPath: string;
  putConversation(conversation: CursorAppFixtureConversation): void;
}>;

/** Writes `<dataDir>/User/globalStorage/state.vscdb` in WAL mode, like the app. */
export async function writeCursorAppStore(dataDir: string, options: Readonly<{
  conversations?: readonly CursorAppFixtureConversation[]; withoutHeadersTable?: boolean; keepOpen?: boolean;
}> = {}): Promise<CursorAppFixtureStore> {
  const dir = join(dataDir, 'User', 'globalStorage');
  await mkdir(dir, { recursive: true });
  const dbPath = join(dir, 'state.vscdb');
  const db = openSqliteDatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  db.exec('CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  if (!options.withoutHeadersTable) {
    db.exec(`CREATE TABLE IF NOT EXISTS composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER,
      lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, value TEXT, subagentTypeName TEXT)`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_composerHeaders_0 ON composerHeaders (workspaceId, isSubagent, isArchived, recency)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_composerHeaders_1 ON composerHeaders (recency, composerId)');
  }
  const kv = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
  const putConversation = (c: CursorAppFixtureConversation) => {
    const createdAt = c.createdAt ?? 1_790_000_000_000;
    const recency = c.recency ?? createdAt + 1000;
    const bubbles = c.bubbles ?? [];
    const uri = (fsPath: string) => ({ $mid: 1, fsPath, external: `file://${fsPath}`, path: fsPath, scheme: 'file' });
    const workspaceIdentifier = c.multiRoot
      ? { id: 'ws-multi', configPath: uri('/replaced/Cursor/Workspaces/1/workspace.json') }
      : { id: 'ws-folder', uri: uri(c.folder ?? '/replaced/repo') };
    const subagentInfo = c.subagentOf ? { subagentType: 1, parentComposerId: c.subagentOf, rootParentConversationId: c.subagentOf,
      subagentTypeName: 'explore', toolCallId: 'call-0', conversationLengthAtSpawn: 2, additionalData: {} } : undefined;
    const header = { type: 'head', composerId: c.id, createdAt, unifiedMode: 'agent', forceMode: 'edit', hasUnreadMessages: false,
      isArchived: c.archived === true, isDraft: false, workspaceIdentifier,
      ...(c.name ? { name: c.name, subtitle: 'replaced subtitle' } : {}), ...(subagentInfo ? { subagentInfo } : {}) };
    if (!options.withoutHeadersTable) {
      db.prepare(`INSERT OR REPLACE INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent,
        recency, checkpointAt, value, subagentTypeName) VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?)`)
        .run(c.id, workspaceIdentifier.id, createdAt, c.archived ? 1 : 0, c.subagentOf ? 1 : 0, recency, JSON.stringify(header),
          c.subagentOf ? 'explore' : null);
    }
    kv.run(`composerData:${c.id}`, JSON.stringify({ _v: 16, composerId: c.id, name: c.name ?? '', createdAt, lastUpdatedAt: recency,
      status: c.generating?.length ? 'generating' : (bubbles.length ? 'completed' : 'none'), generatingBubbleIds: c.generating ?? [],
      fullConversationHeadersOnly: bubbles.map(b => ({ bubbleId: b.id, type: b.type, ...(b.createdAt ? { createdAt: b.createdAt } : {}),
        grouping: { isRenderable: true, hasText: !!b.text } })),
      conversationMap: {}, conversationState: '~', modelConfig: { modelName: 'replaced-model', maxMode: false },
      ...(subagentInfo ? { subagentInfo } : {}) }));
    for (const b of bubbles) {
      kv.run(`bubbleId:${c.id}:${b.id}`, JSON.stringify({ _v: 3, type: b.type, bubbleId: b.id, text: b.text ?? '', richText: '',
        ...(b.createdAt ? { createdAt: b.createdAt } : {}), isSimulatedMsg: b.simulated === true, modelInfo: { modelName: 'replaced-model' },
        ...(b.tool ? { toolFormerData: { toolCallId: b.tool.toolCallId, name: b.tool.name, status: 'completed', tool: 5,
          params: b.tool.params ?? null, rawArgs: b.tool.params ?? '', result: b.tool.result ?? null } } : {}),
        thinking: b.type === 2 && !b.text && !b.tool ? { text: 'replaced thinking', signature: 'sig' } : undefined,
        lints: [], codebaseContextChunks: [], toolResults: [] }));
    }
  };
  for (const conversation of options.conversations ?? []) putConversation(conversation);
  if (!options.keepOpen) db.close();
  return { db, dbPath, putConversation };
}
