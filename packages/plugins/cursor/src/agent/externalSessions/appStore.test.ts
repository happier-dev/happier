import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentExternalSessionsListCandidatesRequest, AgentExternalSessionsResult } from '@happier-dev/plugin-sdk/sessions/external';

const sqlite = vi.hoisted(() => ({ opens: 0, keyReads: [] as string[] }));
// Real SQLite underneath; the wrapper only counts read-only opens and keyed reads.
vi.mock('@happier-dev/plugin-sdk/fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/plugin-sdk/fs')>();
  return { ...actual, openSqliteDatabaseSync: (path: string, options?: { readOnly?: boolean }) => {
    const db = actual.openSqliteDatabaseSync(path, options);
    if (!options?.readOnly) return db;
    sqlite.opens += 1;
    return { exec: (sql: string) => db.exec(sql), close: () => db.close(), prepare: (sql: string) => {
      const statement = db.prepare(sql);
      return { ...statement, all: (...params: unknown[]) => statement.all(...params), iterate: (...params: unknown[]) => statement.iterate(...params),
        run: (...params: unknown[]) => statement.run(...params),
        get: (...params: unknown[]) => { if (typeof params[0] === 'string') sqlite.keyReads.push(params[0]); return statement.get(...params); } };
    } };
  } };
});

import { cursorExternalSessionsContribution as contribution } from './contribution.js';
import { resolveCursorAppDataDir } from './appStore.js';
import { cursorAppSampleBubbles, writeCursorAppStore } from './__fixtures__/appStore.test-support.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function value<T>(result: AgentExternalSessionsResult<T>): T {
  if (!result.ok) throw new Error(`${result.code}:${result.message ?? ''}`);
  return result.value;
}
async function app() {
  const dataDir = await mkdtemp(join(tmpdir(), 'happier-cursor-app-')); roots.push(dataDir);
  const base = { source: { kind: 'cursorApp', dataDir }, signal: new AbortController().signal, maxSerializedBytes: 1024 * 1024 };
  const list: AgentExternalSessionsListCandidatesRequest = { ...base, maxItems: 10,
    exec: { run: async () => { throw new Error('No process read'); } } as AgentExternalSessionsListCandidatesRequest['exec'],
    managedEndpointRead: async () => { throw new Error('No API read'); },
    ripgrep: { run: async () => ({ exitCode: 1, stdout: '', stderr: '' }) } };
  return { dataDir, base, list };
}
const reset = () => { sqlite.opens = 0; sqlite.keyReads.length = 0; };

describe('Cursor app state.vscdb conversations', () => {
  it('lists root app conversations with title, cwd and recency, and reuses unchanged rows from the index state', async () => {
    const a = await app();
    await writeCursorAppStore(a.dataDir, { conversations: [
      { id: 'c-1', name: 'App title', createdAt: 1000, recency: 5000, folder: '/replaced/repo', bubbles: cursorAppSampleBubbles() },
      { id: 'c-2', name: 'Multi-root title', createdAt: 2000, recency: 3000, multiRoot: true, bubbles: cursorAppSampleBubbles() },
      { id: 'c-empty', createdAt: 3000 },
      { id: 'c-sub', name: 'Subagent title', subagentOf: 'c-1', bubbles: cursorAppSampleBubbles() },
    ] });
    const states = new Map<string, unknown>();
    const read = { readCandidateIndexState: (candidate: { remoteSessionId: string }) => states.get(candidate.remoteSessionId) as never };
    const listed = value(await contribution.listCandidates({ ...a.list, ...read }));
    expect(listed.candidates.map(row => [row.remoteSessionId, row.title, row.cwd ?? null, row.createdAtMs, row.updatedAtMs, row.linkData])).toEqual([
      ['c-1', 'App title', '/replaced/repo', 1000, 5000, { cursorSource: 'app' }],
      ['c-2', 'Multi-root title', null, 2000, 3000, { cursorSource: 'app' }],
    ]);
    for (const row of listed.candidates) states.set(row.remoteSessionId, row.candidateIndexState);
    reset();
    const again = value(await contribution.listCandidates({ ...a.list, ...read }));
    expect(again.candidates.map(row => row.remoteSessionId)).toEqual(['c-1', 'c-2']);
    expect(sqlite.opens).toBe(1);
    // Unchanged listed rows never re-read their conversation body.
    expect(sqlite.keyReads.filter(key => key === 'composerData:c-1' || key === 'composerData:c-2')).toEqual([]);
    const threads = value(await contribution.listCandidates({ ...a.list, includeThreads: true }));
    expect(threads.candidates.find(row => row.remoteSessionId === 'c-sub')?.thread).toEqual({ kind: 'subagent', parentRemoteSessionId: 'c-1' });
  });

  it('pages newest first in bubble order, follows WAL appends without polling, holds back a generating bubble, and reports rewritten history', async () => {
    const a = await app();
    const bubbles = cursorAppSampleBubbles();
    const store = await writeCursorAppStore(a.dataDir, { keepOpen: true, conversations: [{ id: 'c-1', name: 'App title', bubbles }] });
    try {
      const request = { ...a.base, remoteSessionId: 'c-1', maxItems: 2 };
      const newest = value(await contribution.pageTranscript({ ...request, direction: 'older' }));
      // b-5 is a simulated notice and b-4 the reply: one agent row from the last two bubbles.
      expect(newest.items.map(item => item.messageRole)).toEqual(['agent']);
      expect(newest.hasMore).toBe(true);
      const older = value(await contribution.pageTranscript({ ...request, direction: 'older', cursor: newest.nextCursor! }));
      // b-2 is thinking only; b-3 is a tool call and its result.
      expect(older.items.map(item => [item.messageRole, item.id])).toEqual([
        ['event', 'cursor:app:b-3:call'], ['event', 'cursor:app:b-3:result']]);
      const first = value(await contribution.pageTranscript({ ...request, direction: 'older', cursor: older.nextCursor! }));
      expect(first.items.map(item => item.messageRole)).toEqual(['user']);
      expect(first.items[0]?.createdAtMs).toBe(Date.parse('2026-10-31T10:00:00.000Z'));
      reset();
      expect(value(await contribution.readAfterTranscript({ ...request, cursor: newest.tailCursor! }))).toEqual({ outcome: 'already_current' });
      expect(sqlite.opens).toBe(0);
      // The writer stays open, so these commits live only in the WAL.
      store.putConversation({ id: 'c-1', name: 'App title', generating: ['b-7'], bubbles: [...bubbles,
        { id: 'b-6', type: 1, text: 'replaced follow-up' }, { id: 'b-7', type: 2, text: 'replaced partial stream' }] });
      const after = value(await contribution.readAfterTranscript({ ...request, cursor: newest.tailCursor! }));
      expect(after.outcome === 'advanced' ? after.items.map(item => item.id) : after).toEqual(['cursor:app:b-6']);
      const next = after.outcome === 'advanced' ? after.nextCursor : '';
      store.putConversation({ id: 'c-1', name: 'App title', bubbles: [...bubbles,
        { id: 'b-6', type: 1, text: 'replaced follow-up' }, { id: 'b-7', type: 2, text: 'replaced complete reply' }] });
      const settled = value(await contribution.readAfterTranscript({ ...request, cursor: next }));
      expect(settled.outcome === 'advanced' ? settled.items.map(item => item.id) : settled).toEqual(['cursor:app:b-7']);
      store.putConversation({ id: 'c-1', name: 'App title', bubbles: [{ id: 'b-9', type: 1, text: 'replaced reverted history' }] });
      expect(value(await contribution.readAfterTranscript({ ...request, cursor: next }))).toEqual({ outcome: 'source_replaced' });
    } finally { store.db.close(); }
  });

  it('fails an unrecognised store with the typed unsupported-format code instead of an empty list', async () => {
    const a = await app();
    await writeCursorAppStore(a.dataDir, { withoutHeadersTable: true, conversations: [{ id: 'c-1', bubbles: cursorAppSampleBubbles() }] });
    expect(await contribution.listCandidates(a.list))
      .toMatchObject({ ok: false, code: 'format_unsupported', retryable: false, message: 'cursor_app_store_format_unsupported' });
  });

  it('watches the database and its WAL, links with the app source label, and resolves each platform data root', async () => {
    const a = await app();
    const store = await writeCursorAppStore(a.dataDir, { conversations: [{ id: 'c-1', name: 'App title', bubbles: cursorAppSampleBubbles() }] });
    const resolved = value(await contribution.resolveSource({ ...a.base }));
    expect(resolved.accountingSource?.watchFileChanges?.files).toEqual([store.dbPath, `${store.dbPath}-wal`]);
    expect(resolved.accountingSource?.changeObservation).toBe('watch_file_changes');
    expect(value(await contribution.resolveLinkIdentity({ ...a.base, remoteSessionId: 'c-1' })).linkData).toEqual({ cursorSource: 'app' });
    expect(await contribution.resolveLinkIdentity({ ...a.base, remoteSessionId: 'missing' })).toMatchObject({ ok: false, code: 'candidate_not_found' });
    expect(resolveCursorAppDataDir({ HOME: '/Users/a' }, 'darwin')).toBe(join('/Users/a', 'Library', 'Application Support', 'Cursor'));
    expect(resolveCursorAppDataDir({ HOME: '/home/a' }, 'linux')).toBe(join('/home/a', '.config', 'Cursor'));
    expect(resolveCursorAppDataDir({ HOME: '/home/a', XDG_CONFIG_HOME: '/xdg' }, 'linux')).toBe(join('/xdg', 'Cursor'));
    expect(resolveCursorAppDataDir({ USERPROFILE: 'C:\\Users\\a', APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32'))
      .toBe('C:\\Users\\a\\AppData\\Roaming\\Cursor');
    expect(resolveCursorAppDataDir({ USERPROFILE: 'C:\\Users\\a' }, 'win32')).toBe('C:\\Users\\a\\AppData\\Roaming\\Cursor');
  });
});
