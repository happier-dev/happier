import { appendFile, chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentExternalSessionsContribution, AgentExternalSessionsInvocation } from '@happier-dev/plugin-sdk/sessions/external';
import { AgentExternalSessionTranscriptRawRecordSchema } from '@happier-dev/plugin-sdk/sessions/external';
import { activate, PLUGIN_MANIFEST } from '../../manifest.js';
import { createGrokNativeHistoryFixture } from './__fixtures__/grokNative.test-support.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'happier-grok-reader-')); roots.push(home);
  const f = await createGrokNativeHistoryFixture(home);
  vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home); vi.stubEnv('GROK_HOME', join(home, '.grok'));
  const registered: AgentExternalSessionsContribution[] = [];
  await activate({ connectedAccounts: { register: () => {} }, agents: { register: () => {}, registerExternalSessions: (_id: string, reader: AgentExternalSessionsContribution) => registered.push(reader) } } as Parameters<typeof activate>[0]);
  expect(registered, 'Grok native reader must be registered through activate').toHaveLength(1);
  const invocation = { signal: new AbortController().signal, maxSerializedBytes: 1_048_576,
    exec: { run: async () => { throw new Error('No vendor command'); } },
    managedEndpointRead: async () => { throw new Error('No vendor server'); },
    ripgrep: { run: async () => { throw new Error('Decoded source is the search authority'); } },
  } as AgentExternalSessionsInvocation;
  return { ...f, reader: registered[0]!, request: { ...invocation, source: { kind: 'grokHome' }, maxItems: 100 } };
}

describe('registered Grok native history', () => {
  it('searches complete decoded prose, preserves literal tags, excludes tool input and lands on stable transcript locators', async () => {
    const f = await setup();
    const page = await f.reader.pageTranscript({ ...f.request, remoteSessionId: f.id, direction: 'older' });
    expect(page.ok).toBe(true); if (!page.ok) return;
    expect(page.value.items.every(item => AgentExternalSessionTranscriptRawRecordSchema.safeParse(item.raw).success)).toBe(true);
    for (const searchTerm of ['body-only phrase', '"quotes"\n東京', 'distantbody', '<user_query>literal tags</user_query>']) {
      const result = await f.reader.listCandidates({ ...f.request, searchTarget: 'content', searchTerm });
      expect(result).toMatchObject({ ok: true, value: { candidates: [{ remoteSessionId: f.id, match: { snippet: expect.stringContaining(searchTerm) } }], contentCoverage: 'complete' } });
      if (result.ok) expect(page.value.items[result.value.candidates[0]!.match!.messageIndex]!.id).toBe(result.value.candidates[0]!.match!.sourceItemId);
    }
    expect(await f.reader.listCandidates({ ...f.request, searchTarget: 'content', searchTerm: 'metadata-only secret' }))
      .toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'complete' } });
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.surfaces?.externalSession?.sources[0]?.contentSearch).toBe(true);
  });

  it('observes transcripts and summary sidecars source-wide, and skips inventory for admission-only reads', async () => {
    const f = await setup();
    expect(await f.reader.resolveSource(f.request)).toMatchObject({ ok: true, value: { accountingSource: {
      rootPath: f.root, changeObservation: 'watch_file_changes', watchFileChanges: {
        files: expect.arrayContaining([f.historyPath, f.summaryPath]), topologyDirectories: expect.arrayContaining([f.root, f.dir]),
      },
    } } });
    expect(await f.reader.resolveSource({ ...f.request, includeAccountingSource: false })).toEqual({ ok: true, value: { source: f.request.source } });
    expect(await f.reader.resolveLinkIdentity({ ...f.request, remoteSessionId: f.id })).toMatchObject({ ok: true, value: { remoteSessionId: f.id, source: f.request.source } });
    await rm(f.root, { recursive: true });
    expect(await f.reader.resolveSource({ ...f.request, includeAccountingSource: false })).toEqual({ ok: true, value: { source: f.request.source } });
    expect(await f.reader.resolveSource(f.request)).toMatchObject({ ok: false });
  });

  it('pages, follows append, detects rewind and same-size edits, and binds source and session identity', async () => {
    const f = await setup();
    const first = await f.reader.pageTranscript({ ...f.request, maxItems: 1, remoteSessionId: f.id, direction: 'older' });
    expect(first.ok).toBe(true); if (!first.ok) return;
    const older = await f.reader.pageTranscript({ ...f.request, maxItems: 1, remoteSessionId: f.id, direction: 'older', cursor: first.value.nextCursor! });
    expect(older.ok && older.value.items.length).toBe(1);
    await appendFile(f.historyPath, JSON.stringify({ type: 'assistant', content: 'appended garnet', timestamp: '2026-10-01T10:02:00Z' }) + '\n');
    expect(await f.reader.readAfterTranscript({ ...f.request, remoteSessionId: f.id, cursor: first.value.tailCursor! }))
      .toMatchObject({ ok: true, value: { outcome: 'advanced', items: [{ raw: { content: { data: { message: 'appended garnet' } } } }] } });
    await f.writeRecords(f.records.slice(0, 1));
    expect(await f.reader.readAfterTranscript({ ...f.request, remoteSessionId: f.id, cursor: first.value.tailCursor! }))
      .toMatchObject({ ok: true, value: { outcome: 'gap_or_cursor_expired' } });
    expect(await f.reader.listCandidates({ ...f.request, searchTarget: 'content', searchTerm: 'distantbody' }))
      .toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'complete' } });
    expect(await f.reader.pageTranscript({ ...f.request, remoteSessionId: '../escape', direction: 'older' })).toMatchObject({ ok: false, code: 'invalid_request' });
    await f.writeRecords([{ ...f.records[0], content: 'replacement prose' }]);
    expect(await f.reader.pageTranscript({ ...f.request, remoteSessionId: f.id, direction: 'older', cursor: first.value.nextCursor! })).toMatchObject({ ok: false, code: 'source_invalid' });
  });

  it('returns explicit partial coverage for unknown dialects, unknown records and unreadable history', async () => {
    const f = await setup();
    await f.writeRecords([...f.records, { type: 'future_history_rewrite', content: 'hidden phrase' }]);
    expect(await f.reader.listCandidates({ ...f.request, searchTarget: 'content', searchTerm: 'missing' }))
      .toMatchObject({ ok: true, value: { contentCoverage: 'partial' } });
    const page = await f.reader.pageTranscript({ ...f.request, remoteSessionId: f.id, direction: 'older' });
    expect(page.ok && page.value.truncated).toBe(true);
    await writeFile(f.summaryPath, JSON.stringify({ ...f.summary, version: 'future-v99' }));
    expect(await f.reader.listCandidates({ ...f.request, searchTarget: 'content', searchTerm: 'body-only' }))
      .toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'partial' } });
    await writeFile(f.summaryPath, JSON.stringify(f.summary)); await rm(f.historyPath);
    expect(await f.reader.listCandidates({ ...f.request, searchTarget: 'content', searchTerm: 'missing' }))
      .toMatchObject({ ok: true, value: { contentCoverage: 'partial' } });
  });

  it('retains progress under equal caller deadlines and rejects a changed query or source', async () => {
    const f = await setup(); let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => ++now);
    let cursor: string | undefined; let hit = false; let partial = false;
    for (let round = 0; round < 20; round++) {
      const page = await f.reader.listCandidates({ ...f.request, searchTarget: 'content', searchTerm: 'distantbody', scanDeadlineAtMs: now + 1, ...(cursor ? { cursor } : {}) });
      expect(page.ok).toBe(true); if (!page.ok) return;
      partial ||= page.value.contentCoverage === 'partial'; hit ||= page.value.candidates.length > 0;
      if (!page.value.nextCursor) { cursor = undefined; break; }
      expect(await f.reader.listCandidates({ ...f.request, searchTarget: 'content', searchTerm: 'other', cursor: page.value.nextCursor })).toMatchObject({ ok: false, code: 'source_invalid' });
      const nativeHome = process.env.GROK_HOME;
      vi.stubEnv('GROK_HOME', join(f.dir, 'different-native-home'));
      expect(await f.reader.listCandidates({ ...f.request, searchTarget: 'content', searchTerm: 'distantbody', cursor: page.value.nextCursor })).toMatchObject({ ok: false, code: 'source_invalid' });
      vi.stubEnv('GROK_HOME', nativeHome);
      expect(page.value.nextCursor).not.toBe(cursor); cursor = page.value.nextCursor;
    }
    expect(partial).toBe(true); expect(hit).toBe(true); expect(cursor).toBeUndefined();
    const controller = new AbortController(); controller.abort();
    expect(await f.reader.listCandidates({ ...f.request, signal: controller.signal })).toMatchObject({ ok: false, code: 'cancelled' });
  });

  it('pages candidate and transcript replies within the caller byte budget without dropping remaining candidates', async () => {
    const f = await setup();
    for (let index = 2; index <= 6; index++) await createGrokNativeHistoryFixture(join(f.root, '..', '..'), `11111111-1111-4111-8111-11111111111${index}`);
    let cursor: string | undefined; const ids: string[] = [];
    for (let round = 0; round < 10; round++) {
      const page = await f.reader.listCandidates({ ...f.request, maxSerializedBytes: 1000, ...(cursor ? { cursor } : {}) });
      expect(page.ok).toBe(true); if (!page.ok) return;
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1000);
      ids.push(...page.value.candidates.map(item => item.remoteSessionId));
      if (!page.value.nextCursor) break;
      cursor = page.value.nextCursor;
    }
    expect(ids).toHaveLength(6); expect(new Set(ids).size).toBe(6);
    await f.writeRecords(Array.from({ length: 20 }, (_, index) => ({ type: 'user', content: `message ${index}`, timestamp: '2026-10-01T10:01:00Z' })));
    // Cursor bytes include the platform's temporary root. Use the actual
    // one-item envelope rather than a path-length-dependent byte guess.
    const single = await f.reader.pageTranscript({ ...f.request, maxItems: 1, remoteSessionId: f.id, direction: 'older' });
    expect(single.ok).toBe(true);
    const maxSerializedBytes = Buffer.byteLength(JSON.stringify(single));
    const page = await f.reader.pageTranscript({ ...f.request, maxSerializedBytes, remoteSessionId: f.id, direction: 'older' });
    expect(page).toMatchObject({ ok: true, value: { hasMore: true } });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(maxSerializedBytes);
  });

  it('rejects same-size prefix rewrites and physical path escapes', async () => {
    const f = await setup();
    const page = await f.reader.pageTranscript({ ...f.request, remoteSessionId: f.id, direction: 'older' });
    expect(page.ok).toBe(true); if (!page.ok) return;
    await f.writeRecords([{ ...f.records[0], content: [{ type: 'text', text: 'A body-only PHRASE with "quotes"\n東京 café' }] }, ...f.records.slice(1)]);
    expect(await f.reader.readAfterTranscript({ ...f.request, remoteSessionId: f.id, cursor: page.value.tailCursor! }))
      .toMatchObject({ ok: true, value: { outcome: 'gap_or_cursor_expired' } });
    await rm(f.historyPath); await symlink(join(f.dir, '..', '..', '..'), f.historyPath);
    expect(await f.reader.pageTranscript({ ...f.request, remoteSessionId: f.id, direction: 'older' })).toMatchObject({ ok: false, code: 'source_invalid' });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('does not turn an unreadable retained source into authoritative disappearance', async () => {
    const f = await setup();
    const page = await f.reader.pageTranscript({ ...f.request, remoteSessionId: f.id, direction: 'older' });
    expect(page.ok).toBe(true); if (!page.ok) return;
    await chmod(f.summaryPath, 0);
    expect(await f.reader.readAfterTranscript({ ...f.request, remoteSessionId: f.id, cursor: page.value.tailCursor! }))
      .toMatchObject({ ok: false, code: 'source_unreachable' });
  });

  it('preserves the retained source when its summary or entire storage root is unavailable', async () => {
    const f = await setup();
    const page = await f.reader.pageTranscript({ ...f.request, remoteSessionId: f.id, direction: 'older' });
    expect(page.ok).toBe(true); if (!page.ok) return;
    await rm(f.summaryPath);
    expect(await f.reader.readAfterTranscript({ ...f.request, remoteSessionId: f.id, cursor: page.value.tailCursor! }))
      .toMatchObject({ ok: false, code: 'source_unreachable' });
    await rm(f.root, { recursive: true });
    expect(await f.reader.readAfterTranscript({ ...f.request, remoteSessionId: f.id, cursor: page.value.tailCursor! }))
      .toMatchObject({ ok: false, code: 'source_unreachable' });
  });

  it('counts the exact terminal coverage envelope at the reply-byte boundary', async () => {
    const f = await setup();
    for (let index = 2; index <= 6; index++) {
      const other = await createGrokNativeHistoryFixture(join(f.root, '..', '..'), `11111111-1111-4111-8111-11111111111${index}`);
      // The last valid native candidate must exceed cursor overhead; otherwise
      // the earlier page's continuation closes the page before the boundary.
      if (index === 6) await writeFile(other.summaryPath, JSON.stringify({ ...other.summary, generated_title: 'A renamed native conversation '.repeat(30) }));
    }
    const complete = await f.reader.listCandidates(f.request);
    expect(complete).toMatchObject({ ok: true, value: { nextCursor: null, searchIncomplete: false } });
    const maxSerializedBytes = Buffer.byteLength(JSON.stringify(complete)) - 1;
    const page = await f.reader.listCandidates({ ...f.request, maxSerializedBytes });
    expect(page).toMatchObject({ ok: true, value: { nextCursor: expect.any(String) } });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(maxSerializedBytes);
  });
});
