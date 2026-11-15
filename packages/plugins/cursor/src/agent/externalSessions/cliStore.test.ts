import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentExternalSessionsListCandidatesRequest, AgentExternalSessionsResult } from '@happier-dev/plugin-sdk/sessions/external';

const sqliteOpens = vi.hoisted(() => ({ paths: [] as string[] }));
// Real SQLite underneath; the wrapper only counts native store opens.
vi.mock('@happier-dev/plugin-sdk/fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/plugin-sdk/fs')>();
  return { ...actual, openSqliteDatabaseSync: (path: string, options?: { readOnly?: boolean }) => {
    if (options?.readOnly) sqliteOpens.paths.push(path);
    return actual.openSqliteDatabaseSync(path, options);
  } };
});

import { cursorExternalSessionsContribution as contribution } from './contribution.js';
import { cursorCliSampleMessages, writeCursorCliStore } from './__fixtures__/cliStore.test-support.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function value<T>(result: AgentExternalSessionsResult<T>): T {
  if (!result.ok) throw new Error(`${result.code}:${result.message ?? ''}`);
  return result.value;
}
async function home() {
  const homeDir = await mkdtemp(join(tmpdir(), 'happier-cursor-cli-store-')); roots.push(homeDir);
  const base = { source: { kind: 'cursorHome', homeDir }, signal: new AbortController().signal, maxSerializedBytes: 1024 * 1024 };
  const list: AgentExternalSessionsListCandidatesRequest = { ...base, maxItems: 10,
    exec: { run: async () => { throw new Error('No process read'); } } as AgentExternalSessionsListCandidatesRequest['exec'],
    managedEndpointRead: async () => { throw new Error('No API read'); },
    ripgrep: { run: async () => ({ exitCode: 1, stdout: '', stderr: '' }) } };
  return { homeDir, base, list };
}

describe('Cursor CLI store.db conversations', () => {
  it('lists root CLI chats and ACP sessions, not subagents, and reuses unchanged heads from the index state', async () => {
    const h = await home();
    await writeCursorCliStore(join(h.homeDir, 'chats', 'ws-md5', 'chat-1'), { id: 'chat-1', name: 'CLI chat title', createdAt: 1000,
      metaJson: { schemaVersion: 1, createdAtMs: 1000, updatedAtMs: 2000, hasConversation: true, cwd: '/repo' } });
    await writeCursorCliStore(join(h.homeDir, 'acp-sessions', 'acp-1'), { id: 'acp-1', name: 'ACP title', createdAt: 900 });
    await writeCursorCliStore(join(h.homeDir, 'chats', 'ws-md5', 'sub-1'), { id: 'sub-1', subagentOf: 'acp-1' });
    const states = new Map<string, unknown>();
    const listed = value(await contribution.listCandidates({ ...h.list,
      readCandidateIndexState: (candidate) => states.get(candidate.remoteSessionId) as never }));
    expect(listed.candidates.map(row => [row.remoteSessionId, row.title, row.cwd ?? null, row.createdAtMs, row.linkData]).sort()).toEqual([
      ['acp-1', 'ACP title', null, 900, { cursorSource: 'cli' }],
      ['chat-1', 'CLI chat title', '/repo', 1000, { cursorSource: 'cli' }],
    ]);
    for (const row of listed.candidates) states.set(row.remoteSessionId, row.candidateIndexState);
    sqliteOpens.paths.length = 0;
    const again = value(await contribution.listCandidates({ ...h.list,
      readCandidateIndexState: (candidate) => states.get(candidate.remoteSessionId) as never }));
    expect(again.candidates.map(row => row.title).sort()).toEqual(['ACP title', 'CLI chat title']);
    // Only the subagent store, which is never a row, is reopened.
    expect(sqliteOpens.paths.filter(path => !path.includes('sub-1'))).toEqual([]);
  });

  it('pages newest first, follows uncheckpointed WAL appends, and reports a rewritten history as replaced', async () => {
    const h = await home();
    const store = await writeCursorCliStore(join(h.homeDir, 'acp-sessions', 'acp-1'), { id: 'acp-1', keepOpen: true });
    try {
      const request = { ...h.base, remoteSessionId: 'acp-1', maxItems: 2 };
      const newest = value(await contribution.pageTranscript({ ...request, direction: 'older' }));
      expect(newest.items.map(item => item.messageRole)).toEqual(['event', 'user']);
      expect(newest.hasMore).toBe(true);
      const older = value(await contribution.pageTranscript({ ...request, direction: 'older', cursor: newest.nextCursor! }));
      // System prompt and reasoning are not transcript rows.
      expect(older.items.map(item => item.messageRole)).toEqual(['user', 'agent', 'event']);
      sqliteOpens.paths.length = 0;
      expect(value(await contribution.readAfterTranscript({ ...request, cursor: newest.tailCursor! }))).toEqual({ outcome: 'already_current' });
      expect(sqliteOpens.paths).toEqual([]);
      // The writer stays open, so the append lives only in the WAL.
      store.setMessages([...cursorCliSampleMessages(), { role: 'user', content: 'replaced appended message' }]);
      const after = value(await contribution.readAfterTranscript({ ...request, cursor: newest.tailCursor! }));
      expect(after).toMatchObject({ outcome: 'advanced' });
      expect(after.outcome === 'advanced' ? after.items.map(item => item.messageRole) : null).toEqual(['user']);
      store.setMessages([{ role: 'user', content: 'replaced different history' }]);
      expect(value(await contribution.readAfterTranscript({ ...request, cursor: newest.tailCursor! }))).toEqual({ outcome: 'source_replaced' });
    } finally { store.db.close(); }
  });

  it('keeps an unrecognised store visible and fails its open with a typed unsupported-format code', async () => {
    const h = await home();
    await writeCursorCliStore(join(h.homeDir, 'chats', 'ws-md5', 'chat-x'), { id: 'chat-x', rawMeta: 'not hex json' });
    const listed = value(await contribution.listCandidates(h.list));
    expect(listed.candidates.map(row => row.remoteSessionId)).toEqual(['chat-x']);
    expect(await contribution.pageTranscript({ ...h.base, remoteSessionId: 'chat-x', direction: 'older', maxItems: 10 }))
      .toMatchObject({ ok: false, code: 'format_unsupported', retryable: false, message: 'cursor_cli_store_format_unsupported' });
  });

  it('watches each store database and its WAL for follow', async () => {
    const h = await home();
    const store = await writeCursorCliStore(join(h.homeDir, 'acp-sessions', 'acp-1'), { id: 'acp-1' });
    const resolved = value(await contribution.resolveSource({ ...h.base }));
    expect(resolved.accountingSource?.watchFileChanges?.files).toEqual(expect.arrayContaining([store.storePath, `${store.storePath}-wal`]));
    expect(value(await contribution.resolveLinkIdentity({ ...h.base, remoteSessionId: 'acp-1' })).linkData).toEqual({ cursorSource: 'cli' });
  });
});
