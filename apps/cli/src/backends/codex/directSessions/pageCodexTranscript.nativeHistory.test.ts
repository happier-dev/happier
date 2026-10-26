import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { loadDirectSessionTranscriptItems } from '@/api/directSessions/import/loadDirectSessionTranscriptItems';
import { DirectSessionsProviderUnavailableError } from '@/backends/directSessions/providerOps';
import { createCodexAppServerProcessEnv, writeFakeCodexAppServerThreadListScript } from '../appServer/testkit/fakeCodexAppServer';
import { pageCodexTranscript } from './pageCodexTranscript';
import { readAfterCodexTranscript } from './readAfterCodexTranscript';

// Native startup locks are per OS user; keep fixture processes separate from live Agents.
const startupHome = vi.hoisted(() => ({ path: '' }));
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, userInfo: () => ({ ...actual.userInfo(), homedir: startupHome.path || actual.userInfo().homedir }) };
});
beforeAll(async () => { startupHome.path = await mkdtemp(join(tmpdir(), 'codex-history-startup-test-')); });
afterAll(async () => { await rm(startupHome.path, { recursive: true, force: true }); });

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function message(id: string, text: string, role: 'user' | 'agent') {
  return { turnId: `turn-${id}`, startedAtMs: 1_000, completedAtMs: 2_000,
    item: role === 'user' ? { id, type: 'userMessage', content: [{ type: 'text', text }] }
      : { id, type: 'agentMessage', text } };
}

async function fixture(items: readonly unknown[] | null) {
  const root = await mkdtemp(join(tmpdir(), 'happier-codex-native-history-'));
  roots.push(root);
  const codexHome = join(root, 'home');
  await mkdir(codexHome);
  const nativeItemsPath = join(root, 'items.json');
  const requestsPath = join(root, 'requests.jsonl');
  await writeFile(nativeItemsPath, JSON.stringify(items ?? []));
  const server = await writeFakeCodexAppServerThreadListScript({ dir: root,
    ...(items === null ? {} : { nativeItemsPath }), requestsPath,
    nonArchivedThreads: [{ id: 'thread-native', name: 'A title is not history', updatedAt: 2 }],
  });
  return { root, codexHome, nativeItemsPath, requestsPath, params: {
    source: { kind: 'codexHome' as const, home: 'user' as const },
    activeServerDir: join(root, 'server'),
    env: createCodexAppServerProcessEnv(server, { CODEX_HOME: codexHome }),
    remoteSessionId: 'thread-native', maxItems: 2, maxBytes: 64 * 1024,
  } };
}

describe('Codex native paginated direct history (0.162.1 contract)', () => {
  it('imports native reasoning as thinking between the user and answer, without exposing encrypted content', async () => {
    const f = await fixture([message('u1', 'question', 'user'),
      { turnId: 'turn-a1', startedAtMs: 1_000, completedAtMs: 2_000,
        item: { id: 'r1', type: 'reasoning', content: [], summary: ['Check the boundary', 'Then verify'], encrypted_content: 'opaque-private-reasoning' } },
      { turnId: 'turn-a1', startedAtMs: 1_000, completedAtMs: 2_000,
        item: { id: 'r2', type: 'reasoning', content: [], summary: [], encrypted_content: 'opaque-private-reasoning' } },
      message('a1', 'answer', 'agent')]);
    const items = await loadDirectSessionTranscriptItems({ readPage: cursor => pageCodexTranscript({
      ...f.params, maxItems: 1, direction: 'older', cursor,
    }) });
    expect(items.map(item => item.raw)).toMatchObject([
      { role: 'user', content: { type: 'text', text: 'question' } },
      { role: 'agent', content: { type: 'codex', data: { type: 'thinking', text: 'Check the boundary\n\nThen verify' } } },
      { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'answer' } } },
    ]);
    expect(JSON.stringify(items)).not.toContain('opaque-private-reasoning');
  });

  it('imports every native history page instead of importing the list preview, without resuming the thread', async () => {
    const f = await fixture([message('u1', 'question one', 'user'), message('a1', 'answer one', 'agent'),
      message('u2', 'question two', 'user'), message('a2', 'answer two', 'agent')]);
    const items = await loadDirectSessionTranscriptItems({ readPage: cursor => pageCodexTranscript({
      ...f.params, direction: 'older', cursor,
    }) });
    expect(items.map(item => item.raw.role)).toEqual(['user', 'agent', 'user', 'agent']);
    expect(JSON.stringify(items)).toContain('answer one');
    expect(JSON.stringify(items)).not.toContain('A title is not history');
    const methods = (await readFile(f.requestsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line).method);
    expect(methods).toContain('thread/items/list');
    expect(methods.filter(method => !['initialize', 'initialized', 'thread/items/list'].includes(method))).toEqual([]);
  });

  it('fails explicitly when neither rollout history nor a readable native history API is available', async () => {
    const f = await fixture(null);
    await expect(pageCodexTranscript({ ...f.params, direction: 'older' })).rejects.toBeInstanceOf(DirectSessionsProviderUnavailableError);
    await expect(readAfterCodexTranscript({ ...f.params, cursor: 'tail' })).rejects.toBeInstanceOf(DirectSessionsProviderUnavailableError);
  });

  it('follows native appends from the captured tail and preserves stable message identities', async () => {
    const initial = [message('u1', 'original', 'user'), message('a1', 'original answer', 'agent')];
    const f = await fixture(initial);
    const page = await pageCodexTranscript({ ...f.params, direction: 'older' });
    expect(page.tailCursor).toBeTruthy();
    const idle = await readAfterCodexTranscript({ ...f.params, cursor: page.tailCursor! });
    expect(idle.items).toEqual([]);
    await writeFile(f.nativeItemsPath, JSON.stringify([...initial, message('u2', 'new question', 'user'), message('a2', 'new answer', 'agent')]));
    const appended = await readAfterCodexTranscript({ ...f.params, cursor: idle.nextCursor! });
    const remainder = await readAfterCodexTranscript({ ...f.params, cursor: appended.nextCursor! });
    expect([...appended.items, ...remainder.items].map(item => item.raw.role)).toEqual(['user', 'agent']);
    const reread = await pageCodexTranscript({ ...f.params, direction: 'older' });
    expect([...appended.items, ...remainder.items].map(item => item.id)).toEqual(reread.items.map(item => item.id));
    expect((await readAfterCodexTranscript({ ...f.params, cursor: remainder.nextCursor! })).items).toEqual([]);
  });

  it('retains both halves of a native tool item across a one-message page budget', async () => {
    const f = await fixture([{ turnId: 'turn-tool', startedAtMs: 1_000, completedAtMs: 2_000,
      item: { id: 'command-1', type: 'commandExecution', command: 'pwd', cwd: '/project',
        status: 'completed', aggregatedOutput: '/project', exitCode: 0 } }]);
    const items = await loadDirectSessionTranscriptItems({ readPage: cursor => pageCodexTranscript({
      ...f.params, maxItems: 1, direction: 'older', cursor,
    }) });
    expect(items).toHaveLength(2);
    expect(items.map(item => (item.raw.content as { data: { type: string } }).data.type)).toEqual(['tool-call', 'tool-call-result']);
    expect(new Set(items.map(item => item.id)).size).toBe(2);
    expect(items[1]?.raw).toMatchObject({ content: { data: { output: { stdout: '/project', exitCode: 0 } } } });
  });

  it('rejects native mixed media instead of importing only its text as complete history', async () => {
    const f = await fixture([{ ...message('mixed', 'question with image', 'user'), item: { id: 'mixed', type: 'userMessage',
      content: [{ type: 'text', text: 'question with image' }, { type: 'image', url: 'https://example.invalid/image.png' }] } }]);
    await expect(loadDirectSessionTranscriptItems({ readPage: cursor => pageCodexTranscript({
      ...f.params, direction: 'older', cursor,
    }) })).rejects.toBeInstanceOf(DirectSessionsProviderUnavailableError);
  });

  it('distinguishes confirmed empty native history from unavailable history', async () => {
    const f = await fixture([]);
    const page = await pageCodexTranscript({ ...f.params, direction: 'older' });
    expect(page).toMatchObject({ items: [], hasMore: false, nextCursor: null });
    expect(page.tailCursor).toBeTruthy();
    await writeFile(f.nativeItemsPath, JSON.stringify([message('first', 'first later message', 'user')]));
    expect((await readAfterCodexTranscript({ ...f.params, cursor: page.tailCursor! })).items).toHaveLength(1);
  });

  it('uses native history for a paginated rollout instead of declaring its local segment complete', async () => {
    const f = await fixture([message('ancestor', 'inherited question', 'user'), message('local', 'local answer', 'agent')]);
    const sessions = join(f.codexHome, 'sessions');
    await mkdir(sessions);
    await writeFile(join(sessions, 'rollout-2026-01-02T00-00-00-thread-native.jsonl'),
      JSON.stringify({ type: 'session_meta', payload: { id: 'thread-native', history_mode: 'paginated',
        history_base: { thread_id: 'ancestor-thread', end_byte_offset: 100, end_ordinal_exclusive: 2 } } }) + '\n');
    const page = await pageCodexTranscript({ ...f.params, direction: 'older' });
    expect(page.items).toHaveLength(2);
    expect(JSON.stringify(page.items)).toContain('inherited question');
    await writeFile(f.nativeItemsPath, '[]');
    await expect(pageCodexTranscript({ ...f.params, direction: 'older' })).rejects.toBeInstanceOf(DirectSessionsProviderUnavailableError);
  });

  it('keeps a native cursor on its source when a legacy rollout appears later', async () => {
    const f = await fixture([message('original', 'native original', 'user')]);
    const page = await pageCodexTranscript({ ...f.params, direction: 'older' });
    const sessions = join(f.codexHome, 'sessions');
    await mkdir(sessions);
    await writeFile(join(sessions, 'rollout-2026-01-02T00-00-00-thread-native.jsonl'),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'different rollout history' }] } }) + '\n');
    expect((await readAfterCodexTranscript({ ...f.params, cursor: page.tailCursor! })).items).toEqual([]);
  });
});
