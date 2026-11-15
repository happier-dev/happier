import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as nativeFs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentExternalSessionsListCandidatesRequest, AgentExternalSessionsResult } from '@happier-dev/plugin-sdk/sessions/external';
import { cursorExternalSessionsContribution as contribution } from './contribution.js';
import { cursorFixtureRow, CURSOR_FIXTURE_ID, writeCursorNativeFixture } from './__fixtures__/native.test-support.js';

const nativeDirectoryReads = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: ((path: Parameters<typeof actual.readdir>[0], ...rest: unknown[]) => {
    nativeDirectoryReads.paths.push(String(path));
    return (actual.readdir as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.readdir };
});
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function value<T>(result: AgentExternalSessionsResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return result.value;
}
async function fixture(options: { flat?: boolean; body?: string } = {}) {
  const homeDir = await mkdtemp(join(tmpdir(), 'happier-cursor-reader-')); roots.push(homeDir);
  const native = await writeCursorNativeFixture(homeDir, options);
  // Unused process/API boundaries fail closed; the native reader is file-only.
  const request: AgentExternalSessionsListCandidatesRequest = {
    source: { kind: 'cursorHome', homeDir }, signal: new AbortController().signal,
    maxItems: 10, maxSerializedBytes: 1024 * 1024,
    exec: { run: async () => { throw new Error('No process read'); } } as AgentExternalSessionsListCandidatesRequest['exec'],
    managedEndpointRead: async () => { throw new Error('No API read'); },
    ripgrep: { run: async () => ({ exitCode: 0, stdout: native.transcriptPath + '\0', stderr: '' }) },
  };
  return { ...native, homeDir, request };
}

describe('Cursor native role/content dialect', () => {
  it.each([false, true])('finds full decoded bodies and joins v1 metadata (flat=%s)', async flat => {
    const body = 'x'.repeat(5000) + 'needle "escaped"\n東京 café';
    const f = await fixture({ flat, body });
    const page = value(await contribution.listCandidates({ ...f.request, searchTarget: 'content', searchTerm: 'needle "escaped"\n東京' }));
    expect(page.candidates).toHaveLength(1);
    expect(page.candidates[0]).toMatchObject({ remoteSessionId: CURSOR_FIXTURE_ID, title: 'Ordinary title', cwd: '/repo',
      match: { sourceItemId: expect.any(String), messageIndex: 1, snippet: expect.stringContaining('東京') } });
    const transcript = value(await contribution.pageTranscript({ ...f.request, remoteSessionId: CURSOR_FIXTURE_ID, direction: 'older' }));
    expect(transcript.items.some(item => item.id === page.candidates[0]!.match!.sourceItemId)).toBe(true);
    expect(transcript.items).toContainEqual(expect.objectContaining({ raw: { role: 'agent', content: {
      type: 'acp', agentId: 'cursor', data: { type: 'message', message: body },
    } } }));
  });
  it('does not match tool metadata and reports unknown versions/shapes as partial', async () => {
    const f = await fixture();
    await appendFile(f.transcriptPath, JSON.stringify({ role: 'assistant', message: { content: [{ type: 'tool_use', name: 'secret-tool-needle', input: { text: 'metadata-only' } }] } }) + '\n');
    const page = value(await contribution.listCandidates({ ...f.request, searchTarget: 'content', searchTerm: 'secret-tool-needle' }));
    expect(page.candidates).toEqual([]); expect(page.contentCoverage).toBe('partial');
    await writeFile(f.metadataPath, JSON.stringify({ schemaVersion: 99, cwd: '/repo' }));
    const unknown = value(await contribution.listCandidates({ ...f.request, searchTarget: 'content', searchTerm: 'absent' }));
    expect(unknown.contentCoverage).toBe('partial');
  });
  it('pages with stable locators, appends and rejects a grown prefix rewrite', async () => {
    const f = await fixture();
    const first = value(await contribution.pageTranscript({ ...f.request, remoteSessionId: CURSOR_FIXTURE_ID, direction: 'older', maxItems: 1 }));
    expect(first.nextCursor).toEqual(expect.any(String)); expect(first.tailCursor).toEqual(expect.any(String));
    const older = value(await contribution.pageTranscript({ ...f.request, remoteSessionId: CURSOR_FIXTURE_ID, direction: 'older', maxItems: 1, cursor: first.nextCursor! }));
    expect(older.items).toHaveLength(1); expect(older.items[0]!.id).not.toBe(first.items[0]!.id);
    await appendFile(f.transcriptPath, cursorFixtureRow('user', 'garnet appended message'));
    const after = value(await contribution.readAfterTranscript({ ...f.request, remoteSessionId: CURSOR_FIXTURE_ID, cursor: first.tailCursor! }));
    expect(after.outcome).toBe('advanced'); expect(JSON.stringify(after)).toContain('garnet');
    await writeFile(f.transcriptPath, cursorFixtureRow('user', 'replacement '.repeat(100)));
    expect(value(await contribution.readAfterTranscript({ ...f.request, remoteSessionId: CURSOR_FIXTURE_ID, cursor: first.tailCursor! }))).toMatchObject({ outcome: 'source_replaced' });
  });
  it('yields a source/query-bound continuation at the caller deadline and resumes', async () => {
    const f = await fixture();
    const first = value(await contribution.listCandidates({ ...f.request, searchTarget: 'content', searchTerm: 'café', scanDeadlineAtMs: Date.now() - 1 }));
    expect(first).toMatchObject({ contentCoverage: 'partial', nextCursor: expect.any(String) });
    const next = value(await contribution.listCandidates({ ...f.request, searchTarget: 'content', searchTerm: 'café', cursor: first.nextCursor! }));
    expect(next.candidates).toHaveLength(1); expect(next.nextCursor).toBeNull();
    expect(await contribution.listCandidates({ ...f.request, searchTarget: 'content', searchTerm: 'changed', cursor: first.nextCursor! })).toMatchObject({ ok: false, code: 'invalid_request' });
  });
  it('observes transcript plus metadata and honours lightweight source admission', async () => {
    const f = await fixture();
    const source = value(await contribution.resolveSource(f.request));
    expect(source.accountingSource?.watchFileChanges?.files).toEqual(expect.arrayContaining([
      f.transcriptPath, f.metadataPath,
    ]));
    expect(value(await contribution.resolveSource({ ...f.request, includeAccountingSource: false })).accountingSource).toBeUndefined();
    await writeFile(f.metadataPath, JSON.stringify({ schemaVersion: 1, title: 'Renamed', cwd: '/different', createdAtMs: 1, updatedAtMs: Date.now() }));
    expect(value(await contribution.listCandidates(f.request)).candidates[0]).toMatchObject({ title: 'Renamed', cwd: '/different' });
  });
  it('keeps in-file progress under repeated short budgets and preserves partial coverage', async () => {
    const f = await fixture();
    await writeFile(f.transcriptPath, JSON.stringify({ role: 'assistant', content: [{ type: 'future_block', data: 'ignored' }] }) + '\n'
      + Array.from({ length: 12 }, (_, i) => cursorFixtureRow('user', i === 11 ? 'latebudgetneedle' : 'ordinary text')).join(''));
    let tick = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => ++tick);
    let cursor: string | undefined;
    const seen = new Set<string>();
    let found = false;
    for (let turn = 0; turn < 20; turn++) {
      const result = value(await contribution.listCandidates({ ...f.request, cursor, searchTarget: 'content', searchTerm: 'latebudgetneedle', scanDeadlineAtMs: tick + 5 }));
      if (result.candidates.length) { expect(result.contentCoverage).toBe('partial'); found = true; break; }
      expect(result.nextCursor).toEqual(expect.any(String));
      expect(seen.has(result.nextCursor!)).toBe(false);
      seen.add(result.nextCursor!); cursor = result.nextCursor!;
    }
    expect(found).toBe(true);
  });
  it('retains a torn tail frontier until completion and enforces the caller byte budget', async () => {
    const f = await fixture();
    const original = await readFile(f.transcriptPath, 'utf8');
    await appendFile(f.transcriptPath, '{"role":"user","content":');
    const torn = value(await contribution.pageTranscript({ ...f.request, remoteSessionId: CURSOR_FIXTURE_ID, direction: 'older' }));
    expect(torn.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'required' })]));
    expect(value(await contribution.readAfterTranscript({ ...f.request, remoteSessionId: CURSOR_FIXTURE_ID, cursor: torn.tailCursor! }))).toMatchObject({ outcome: 'already_current' });
    await appendFile(f.transcriptPath, '"finishedtailneedle"}\n');
    expect(value(await contribution.readAfterTranscript({ ...f.request, remoteSessionId: CURSOR_FIXTURE_ID, cursor: torn.tailCursor! }))).toMatchObject({ outcome: 'advanced', items: [expect.any(Object)] });
    await writeFile(f.transcriptPath, original + cursorFixtureRow('user', 'verylarge '.repeat(10000)));
    const bounded = await contribution.pageTranscript({ ...f.request, remoteSessionId: CURSOR_FIXTURE_ID, direction: 'older', maxSerializedBytes: 4096 });
    expect(bounded).toMatchObject({ ok: false, code: 'agent_error' });
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(4096);
  });
  it('verifies an appended transcript prefix once and walks the store once per readAfter', async () => {
    const f = await fixture();
    const first = value(await contribution.pageTranscript({ ...f.request, remoteSessionId: CURSOR_FIXTURE_ID, direction: 'older' }));
    await appendFile(f.transcriptPath, cursorFixtureRow('user', 'garnet appended message'));
    const streams = vi.mocked(nativeFs.createReadStream);
    streams.mockClear();
    const projectsDir = join(f.homeDir, 'projects');
    nativeDirectoryReads.paths.length = 0;
    const after = value(await contribution.readAfterTranscript({ ...f.request, remoteSessionId: CURSOR_FIXTURE_ID, cursor: first.tailCursor! }));
    expect(after.outcome).toBe('advanced');
    // One hash of the previously delivered prefix and one of the grown file bind the new cursor.
    expect(streams.mock.calls.filter(([path]) => String(path) === f.transcriptPath)).toHaveLength(2);
    expect(nativeDirectoryReads.paths.filter((path) => path === projectsDir)).toHaveLength(1);
  });
  it('does not reopen unchanged transcript bodies for a tail observation', async () => {
    const f = await fixture();
    const page = value(await contribution.pageTranscript({ ...f.request, remoteSessionId: CURSOR_FIXTURE_ID, direction: 'older' }));
    // Real OS read boundary: an unchanged tail must settle from its file
    // identity and high-resolution modification witness alone.
    vi.mocked(nativeFs.createReadStream).mockImplementation(() => { throw new Error('Unexpected full transcript reread'); });
    expect(value(await contribution.readAfterTranscript({ ...f.request, remoteSessionId: CURSOR_FIXTURE_ID, cursor: page.tailCursor! }))).toMatchObject({ outcome: 'already_current' });
  });
  it('retires an absent session only when its native source remains available', async () => {
    const f = await fixture();
    const page = value(await contribution.pageTranscript({ ...f.request, remoteSessionId: CURSOR_FIXTURE_ID, direction: 'older' }));
    const request = { ...f.request, remoteSessionId: CURSOR_FIXTURE_ID, cursor: page.tailCursor! };
    await rm(f.transcriptPath);
    expect(value(await contribution.readAfterTranscript(request))).toMatchObject({ outcome: 'source_unavailable' });
    await rm(f.homeDir, { recursive: true });
    expect(await contribution.readAfterTranscript(request)).toMatchObject({ ok: false, code: 'agent_unavailable' });
  });
});
