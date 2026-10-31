import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentExternalSessionTranscriptRawRecordSchema } from '@happier-dev/plugin-sdk/sessions/external';
import type { AgentExternalSessionsContribution } from '@happier-dev/plugin-sdk/sessions/external';

import { COPILOT_PLUGIN } from '../../manifest.js';

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'happier-copilot-reader-'));
  directories.push(directory);
  const homeDir = join(directory, '.copilot');
  const file = join(homeDir, 'session-state', 'native', 'events.jsonl');
  await mkdir(join(homeDir, 'session-state', 'native'), { recursive: true });
  const body = await readFile(new URL('./__fixtures__/copilot-v1-events.jsonl', import.meta.url), 'utf8');
  await writeFile(file, body);
  let registered: AgentExternalSessionsContribution | undefined;
  await COPILOT_PLUGIN.activate({ agents: { register() {}, registerExternalSessions(_id: string, contribution: AgentExternalSessionsContribution) {
    registered = contribution;
  } } } as never);
  expect(registered).toBeDefined();
  const reader = registered!;
  const request = { source: { kind: 'copilotHome', homeDir }, signal: new AbortController().signal,
    maxItems: 100, maxSerializedBytes: 1024 * 1024,
    exec: {} as never, managedEndpointRead: async () => { throw new Error('No vendor server is part of this reader'); },
    // The packaged process is the only controlled boundary. Real decoding and
    // matching must still reject metadata and decode escaped body text.
    ripgrep: { run: async ({ paths }: { paths: readonly string[] }) => ({ exitCode: 0, stdout: paths.join('\0') + '\0', stderr: '' }) } };
  return { directory, file, homeDir, reader, request, body };
}
function row(id: string, text: string) {
  return JSON.stringify({ type: 'user.message', id, timestamp: '2026-10-20T10:00:00Z', data: { content: text } }) + '\n';
}

describe('Copilot native event history contribution', () => {

  it.each(['page', 'follow'] as const)('preserves an actionable record-limit failure for %s reads', async operation => {
    const { reader, request, file } = await fixture();
    const initial = await reader.pageTranscript({ ...request, remoteSessionId: 'native', direction: 'older' });
    if (!initial.ok || !initial.value.tailCursor) throw new Error(JSON.stringify(initial));
    await appendFile(file, JSON.stringify({ type: 'user.message', id: 'oversized', timestamp: '2026-10-20T10:00:00Z', data: { content: 'after' }, padding: 'x'.repeat(9 * 1024 * 1024) }) + '\n');
    const result = operation === 'page' ? await reader.pageTranscript({ ...request, remoteSessionId: 'native', direction: 'older' })
      : await reader.readAfterTranscript({ ...request, remoteSessionId: 'native', cursor: initial.value.tailCursor });
    expect(result).toMatchObject({ ok: false, code: 'agent_error', retryable: false, message: expect.stringContaining('JSONL') });
  });
  it('finds decoded body phrases, tool output and long Unicode text, excluding metadata and deltas', async () => {
    const { reader, request, file } = await fixture();
    const metadata = await reader.listCandidates(request);
    if (!metadata.ok) throw new Error(metadata.code);
    expect(metadata.value.candidates).toHaveLength(1);
    for (const candidate of metadata.value.candidates) {
      expect(Number.isSafeInteger(candidate.updatedAtMs)).toBe(true);
      expect(Number.isSafeInteger(candidate.createdAtMs)).toBe(true);
    }
    for (const query of ['body-only phrase', '"quotes"\n東京', 'settled tool output']) {
      const result = await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: query });
      expect(result).toMatchObject({ ok: true, value: { contentCoverage: 'complete', candidates: [{ remoteSessionId: 'native', match: { snippet: expect.stringContaining(query) } }] } });
    }
    for (const query of ['metadata-only phrase', 'delta-only duplicate', 'model-only transformed input', 'internal compaction summary']) {
      expect(await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: query })).toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'complete' } });
    }
    await appendFile(file, row('long', 'x'.repeat(100_000) + ' long body 東京 end'));
    expect(await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'long body 東京 end' })).toMatchObject({ ok: true, value: { candidates: [{ match: { sourceItemId: 'long', snippet: expect.stringContaining('long body 東京 end') } }] } });
  });

  it('pages stable source locators, appends after compaction/resume once and refuses rewritten history', async () => {
    const { reader, request, file } = await fixture();
    const page = await reader.pageTranscript({ ...request, remoteSessionId: 'native', direction: 'older' });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.items.map(item => item.id)).toEqual(['user', 'answer', 'result']);
    for (const item of page.value.items) expect(AgentExternalSessionTranscriptRawRecordSchema.safeParse(item.raw).success).toBe(true);
    const cursor = page.value.tailCursor!;
    expect(await reader.readAfterTranscript({ ...request, remoteSessionId: 'native', cursor })).toMatchObject({ ok: true, value: { outcome: 'already_current' } });
    await appendFile(file, row('appended', 'garnet appended native message'));
    const after = await reader.readAfterTranscript({ ...request, remoteSessionId: 'native', cursor });
    expect(after).toMatchObject({ ok: true, value: { outcome: 'advanced', items: [{ id: 'appended' }], hasMore: false } });
    if (!after.ok || after.value.outcome !== 'advanced') return;
    expect(await reader.readAfterTranscript({ ...request, remoteSessionId: 'native', cursor: after.value.nextCursor })).toMatchObject({ ok: true, value: { outcome: 'already_current' } });
    const body = await readFile(file, 'utf8');
    await writeFile(file, body.replace('body-only phrase', 'rewritten phrase'));
    expect(await reader.readAfterTranscript({ ...request, remoteSessionId: 'native', cursor: after.value.nextCursor })).toMatchObject({ ok: true, value: { outcome: 'source_replaced' } });
    expect(await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'body-only phrase' })).toMatchObject({ ok: true, value: { candidates: [] } });
  });

  it('retains honest partials for unknown schema/content and a torn record completed later', async () => {
    const { reader, request, file, body } = await fixture();
    await writeFile(file, body.replace('"version":1', '"version":99'));
    expect(await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'body-only phrase' })).toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'partial' } });
    const unknown = await reader.pageTranscript({ ...request, remoteSessionId: 'native', direction: 'older' });
    expect(unknown).toMatchObject({ ok: true, value: { diagnostics: [{ severity: 'required' }] } });
    await writeFile(file, body + '{"type":"user.message","id":"torn","data":{"content":');
    expect(await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'unwritten suffix', scanDeadlineAtMs: Date.now() + 100 }))
      .toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'partial' } });
    const page = await reader.pageTranscript({ ...request, remoteSessionId: 'native', direction: 'older' });
    if (!page.ok) throw new Error('Expected readable history before torn tail');
    expect(page.value.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'required' })]));
    expect(await reader.readAfterTranscript({ ...request, remoteSessionId: 'native', cursor: page.value.tailCursor! }))
      .toMatchObject({ ok: true, value: { outcome: 'advanced', items: [], hasMore: false, diagnostics: [{ severity: 'required' }] } });
    await appendFile(file, '"completed sapphire"}}\n');
    expect(await reader.readAfterTranscript({ ...request, remoteSessionId: 'native', cursor: page.value.tailCursor! })).toMatchObject({ ok: true, value: { outcome: 'advanced', items: [{ id: 'torn' }] } });
  });

  it('yields advancing query-bound continuations and does not lose a slow file prefix', async () => {
    const { reader, request, file } = await fixture();
    await appendFile(file, row('last', 'late-only needle'));
    let cursor: string | undefined;
    let found = false;
    const seen = new Set<string>();
    for (let iteration = 0; iteration < 20 && !found; iteration += 1) {
      const result = await reader.listCandidates({ ...request, maxItems: 1, searchTarget: 'content', searchTerm: 'late-only needle',
        scanDeadlineAtMs: Date.now() - 1, ...(cursor ? { cursor } : {}) });
      if (!result.ok) throw new Error(result.code);
      found = result.value.candidates.some(item => item.match?.sourceItemId === 'last');
      if (!found) {
        expect(result.value.contentCoverage).toBe('partial');
        expect(result.value.nextCursor).toBeTruthy();
        expect(seen.has(result.value.nextCursor!)).toBe(false);
        seen.add(result.value.nextCursor!); cursor = result.value.nextCursor!;
      }
    }
    expect(found).toBe(true);
    expect(await reader.listCandidates({ ...request, cursor, searchTarget: 'content', searchTerm: 'other query' })).toMatchObject({ ok: false, code: 'source_invalid' });
  });

  it('observes the source and refuses absent, escaped and cancelled reads', async () => {
    const { reader, request, file, directory, homeDir } = await fixture();
    expect(await reader.resolveSource(request)).toMatchObject({ ok: true, value: { accountingSource: { changeObservation: 'watch_file_changes', watchFileChanges: { files: [file] } } } });
    expect(await reader.resolveSource({ ...request, includeAccountingSource: false })).toEqual({ ok: true, value: { source: request.source } });
    expect(await reader.pageTranscript({ ...request, remoteSessionId: '../outside', direction: 'older' })).toMatchObject({ ok: false, code: 'source_invalid' });
    expect(await reader.pageTranscript({ ...request, remoteSessionId: 'native', direction: 'older', cursor: 'malformed' })).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(await reader.listCandidates({ ...request, cursor: 'malformed' })).toMatchObject({ ok: false, code: 'invalid_request' });
    const outside = join(directory, 'outside'); await mkdir(outside);
    await writeFile(join(outside, 'events.jsonl'), await readFile(file));
    await symlink(outside, join(homeDir, 'session-state', 'escaped'), 'dir');
    expect(await reader.pageTranscript({ ...request, remoteSessionId: 'escaped', direction: 'older' })).toMatchObject({ ok: false, code: 'source_invalid' });
    const abort = new AbortController(); abort.abort();
    expect(await reader.listCandidates({ ...request, signal: abort.signal })).toMatchObject({ ok: false, code: 'cancelled' });
    const prior = await reader.pageTranscript({ ...request, remoteSessionId: 'native', direction: 'older' });
    if (!prior.ok) throw new Error(prior.code);
    await rm(homeDir, { recursive: true });
    expect(await reader.listCandidates(request)).toMatchObject({ ok: false, code: 'unavailable' });
    expect(await reader.readAfterTranscript({ ...request, remoteSessionId: 'native', cursor: prior.value.tailCursor! }))
      .toMatchObject({ ok: false, code: 'unavailable' });
  });
});
