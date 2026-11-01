import { appendFile, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentExternalSessionTranscriptRawRecordSchema, type AgentExternalSessionsInvocation } from '@happier-dev/plugin-sdk/sessions/external';
import { activate } from '../../activate.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import { kimiAnswer, kimiMetadata, kimiUser, kimiWire, writeKimiFixture } from './__fixtures__/kimiCode.test-support.js';

// Prepare the public SDK registration graph during collection, outside a
// transcript workload's test deadline.
const { createPluginTestkit } = await import('@happier-dev/plugin-sdk/testing');

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const unavailable = async (): Promise<never> => { throw new Error('Read-only history must not start a process or vendor server'); };
const invocation = (): AgentExternalSessionsInvocation => ({ signal: new AbortController().signal,
  exec: { run: unavailable, spawn: unavailable, agentCli: { checkReadiness: unavailable },
    systemTools: { resolve: unavailable }, clients: { open: unavailable } }, managedEndpointRead: unavailable,
  // OS ripgrep boundary admits every fixture: real decoded matching remains authoritative.
  ripgrep: { run: async ({ paths }) => ({ exitCode: 0, stdout: paths.join('\0') + '\0', stderr: '', stdoutTruncated: true }) } });
const source = { kind: 'kimiCodeHome' };
async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'happier-kimi-reader-')); dirs.push(home);
  vi.stubEnv('KIMI_CODE_HOME', home);
  const files = await writeKimiFixture(home);
  const runtime = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
  const reader = runtime.registration('agents', 'kimi')?.externalSessions;
  expect(reader, 'registered Kimi file reader').toBeTruthy();
  if (!reader) throw new Error('Missing registered reader');
  return { home, files, runtime, reader, request: { ...invocation(), source, maxItems: 10, maxSerializedBytes: 100_000 } };
}

describe('registered Kimi Code protocol 1.4 history reader', () => {
  it('advertises the native content-search source', () => {
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.surfaces?.externalSession?.sources)
      .toContainEqual(expect.objectContaining({ sourceKind: 'kimiCodeHome', contentSearch: true }));
  });
  it('finds full decoded assistant bodies, excludes injection and tool-input metadata, and pages exact locators', async () => {
    const { reader, request, runtime } = await setup();
    try {
      for (const query of ['body-only phrase', '你好 café\n"quoted"']) {
        const result = await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: query });
        expect(result).toMatchObject({ ok: true, value: { contentCoverage: 'complete', candidates: [
          { remoteSessionId: 'session_fixture', cwd: '/fixture', match: { snippet: expect.stringContaining(query), sourceItemId: expect.any(String), messageIndex: 1 } },
        ] } });
        const page = await reader.pageTranscript({ ...request, remoteSessionId: 'session_fixture', direction: 'older' });
        expect(page.ok).toBe(true);
        if (!page.ok || !result.ok) throw new Error('Expected readable transcript');
        expect(page.value.items.find(item => item.id === result.value.candidates[0]?.match?.sourceItemId)?.raw)
          .toMatchObject({ role: 'agent', content: { type: 'acp', data: { type: 'message', message: expect.stringContaining('x'.repeat(500)) } } });
        page.value.items.forEach(item => expect(AgentExternalSessionTranscriptRawRecordSchema.safeParse(item.raw).success).toBe(true));
        expect(page.value.items).toContainEqual(expect.objectContaining({ raw: { role: 'agent', content: {
          type: 'acp', agentId: 'kimi', data: expect.objectContaining({ type: 'tool-result', callId: 'call-1', output: 'visible tool output' }),
        } } }));
      }
      for (const searchTerm of ['metadata-only needle', 'injected-only needle']) {
        expect(await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm })).toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'complete' } });
      }
      const latest = await reader.pageTranscript({ ...request, maxItems: 1, remoteSessionId: 'session_fixture', direction: 'older' });
      expect(latest).toMatchObject({ ok: true, value: { nextCursor: expect.any(String), tailCursor: expect.any(String), hasMore: true } });
      if (!latest.ok || !latest.value.nextCursor) throw new Error('Expected older cursor');
      const older = await reader.pageTranscript({ ...request, remoteSessionId: 'session_fixture', direction: 'older', cursor: latest.value.nextCursor });
      expect(older.ok && older.value.items.every(item => item.id !== latest.value.items[0]?.id)).toBe(true);
    } finally { await runtime.dispose(); }
  });

  it('reads wire-only append and detects undo, rewrite, deletion and future formats', async () => {
    const { reader, request, runtime, files } = await setup();
    try {
      const first = await reader.pageTranscript({ ...request, remoteSessionId: 'session_fixture', direction: 'older' });
      if (!first.ok || !first.value.tailCursor) throw new Error('Expected tail');
      await appendFile(files.wirePath, kimiWire([kimiUser('garnet appended'), ...kimiAnswer('new answer', 'step-2')]));
      const next = await reader.readAfterTranscript({ ...request, remoteSessionId: 'session_fixture', cursor: first.value.tailCursor });
      expect(next).toMatchObject({ ok: true, value: { outcome: 'advanced', hasMore: false, items: [expect.objectContaining({ raw: { role: 'user', content: { type: 'text', text: 'garnet appended' } } }), expect.anything()] } });
      await appendFile(files.wirePath, kimiWire([{ type: 'context.undo', count: 1 }]));
      if (!next.ok || next.value.outcome !== 'advanced') throw new Error('Expected append');
      expect(await reader.readAfterTranscript({ ...request, remoteSessionId: 'session_fixture', cursor: next.value.nextCursor }))
        .toMatchObject({ ok: true, value: { outcome: 'source_replaced' } });
      expect(await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'garnet appended' })).toMatchObject({ ok: true, value: { candidates: [] } });
      await writeFile(files.wirePath, kimiWire([kimiMetadata, kimiUser('replacement')]));
      expect(await reader.readAfterTranscript({ ...request, remoteSessionId: 'session_fixture', cursor: first.value.tailCursor })).toMatchObject({ ok: true, value: { outcome: 'source_replaced' } });
      await writeFile(files.wirePath, kimiWire([{ ...kimiMetadata, protocol_version: '9.0' }, kimiUser('future')]));
      expect(await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'future' })).toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'unsupported' } });
      expect(await reader.pageTranscript({ ...request, remoteSessionId: 'session_fixture', direction: 'older' })).toMatchObject({ ok: false, code: 'unsupported' });
      await rm(files.wirePath);
      expect(await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'future' })).toMatchObject({ ok: true, value: { contentCoverage: 'partial' } });
      expect(await reader.listCandidates(request)).toMatchObject({ ok: true, value: { searchIncomplete: true } });
    } finally { await runtime.dispose(); }
  });

  it('continues a partial source scan under the caller deadline, binds query and honours cancellation', async () => {
    const { reader, request, runtime, home } = await setup();
    try {
      await writeKimiFixture(home, 'session_second');
      const first = await reader.listCandidates({ ...request, maxItems: 1, scanDeadlineAtMs: 0, searchTarget: 'content', searchTerm: 'body-only phrase' });
      expect(first).toMatchObject({ ok: true, value: { contentCoverage: 'partial', nextCursor: expect.any(String) } });
      if (!first.ok || !first.value.nextCursor) throw new Error('Expected continuation');
      const next = await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'body-only phrase', cursor: first.value.nextCursor });
      expect(next).toMatchObject({ ok: true, value: { contentCoverage: 'complete', nextCursor: null } });
      expect(new Set([...first.value.candidates, ...(next.ok ? next.value.candidates : [])].map(item => item.remoteSessionId)).size).toBe(2);
      expect(await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'other', cursor: first.value.nextCursor })).toMatchObject({ ok: false, code: 'invalid_request' });
      expect(await reader.listCandidates({ ...request, signal: AbortSignal.abort() })).toMatchObject({ ok: false, code: 'cancelled' });
    } finally { await runtime.dispose(); }
  });

  it('preserves compacted history while undo stops at the summary and clear boundary', async () => {
    const { reader, request, runtime, files } = await setup();
    try {
      await writeFile(files.wirePath, kimiWire([kimiMetadata, kimiUser('ancient visible history'),
        ...kimiAnswer('prefix answer'), { type: 'context.apply_compaction', compactedCount: 2, summary: 'compact summary', tokensBefore: 120, tokensAfter: 40 },
        kimiUser('abandoned turn'), ...kimiAnswer('abandoned answer', 'step-new'), { type: 'context.undo', count: 2 },
        { type: 'context.clear' }, kimiUser('clear boundary turn'), { type: 'context.undo', count: 2 }]));
      expect(await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'ancient visible history' }))
        .toMatchObject({ ok: true, value: { candidates: [expect.anything()], contentCoverage: 'complete' } });
      for (const searchTerm of ['abandoned turn', 'abandoned answer', 'clear boundary turn']) {
        expect(await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm })).toMatchObject({ ok: true, value: { candidates: [] } });
      }
      await appendFile(files.wirePath, kimiWire([{ type: 'context.future_splice', start: 0 }]));
      expect(await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'ancient visible history' }))
        .toMatchObject({ ok: true, value: { contentCoverage: 'partial' } });
    } finally { await runtime.dispose(); }
  });

  it('yields within one valid multi-record replay and retries it without publishing an undone hit', async () => {
    const { reader, request, runtime, files } = await setup();
    try {
      await writeFile(files.wirePath, kimiWire([kimiMetadata,
        ...Array.from({ length: 2000 }, (_, index) => kimiUser(`ordinary ${index}`)),
        kimiUser('deadline needle abandoned'), { type: 'context.undo', count: 1 }, kimiUser('deadline needle retained')]));
      // The clock is the system boundary. Parsing, replay, undo and matching
      // remain real; a read deadline must interrupt inside this one Session.
      let clock = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => ++clock);
      const first = await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'deadline needle', scanDeadlineAtMs: 20 });
      expect(first).toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'partial', nextCursor: expect.any(String) } });
      if (!first.ok || !first.value.nextCursor) throw new Error('Expected interrupted native replay');
      const next = await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'deadline needle', cursor: first.value.nextCursor });
      expect(next).toMatchObject({ ok: true, value: { contentCoverage: 'complete', nextCursor: null, candidates: [
        { match: { snippet: 'deadline needle retained', messageIndex: 2000 } },
      ] } });
    } finally { await runtime.dispose(); }
  });

  it('marks future fields and damaged records incomplete while preserving readable bodies', async () => {
    const { reader, request, runtime, files } = await setup();
    try {
      const baseline = await reader.pageTranscript({ ...request, remoteSessionId: 'session_fixture', direction: 'older' });
      if (!baseline.ok || !baseline.value.tailCursor) throw new Error('Expected initial native frontier');
      await appendFile(files.wirePath, kimiWire([{ type: 'context.future_splice' }]));
      expect(await reader.readAfterTranscript({ ...request, remoteSessionId: 'session_fixture', cursor: baseline.value.tailCursor }))
        .toMatchObject({ ok: true, value: { outcome: 'read_failed' } });
      await writeFile(files.wirePath, kimiWire([kimiMetadata,
        { ...kimiUser('opal readable body'), future_semantics: true }]));
      expect(await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'opal' }))
        .toMatchObject({ ok: true, value: { contentCoverage: 'partial', candidates: [expect.anything()] } });
      await appendFile(files.wirePath, '{broken json}\n' + kimiWire([kimiUser('quartz after damage')]));
      const page = await reader.pageTranscript({ ...request, remoteSessionId: 'session_fixture', direction: 'older' });
      expect(page).toMatchObject({ ok: true, value: { truncated: true, diagnostics: [expect.objectContaining({ severity: 'required' })] } });
      expect(await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'quartz after damage' }))
        .toMatchObject({ ok: true, value: { contentCoverage: 'partial', candidates: [expect.anything()] } });
      await writeFile(files.wirePath, kimiWire([kimiMetadata, { type: 'context.append_message', message: {
        role: 'user', content: [{ type: 'text', text: 'readable prefix' }, { type: 'future_media', payload: 'untrusted unknown payload' }],
      } }]));
      const unknown = await reader.pageTranscript({ ...request, remoteSessionId: 'session_fixture', direction: 'older' });
      expect(unknown).toMatchObject({ ok: true, value: { truncated: true, items: [
        expect.objectContaining({ raw: { role: 'user', content: { type: 'text', text: 'readable prefix' } } }),
        expect.objectContaining({ raw: { role: 'agent', content: { type: 'acp', agentId: 'kimi', data: { type: 'message', message: expect.any(String) } } } }),
      ] } });
      expect(JSON.stringify(unknown)).not.toContain('untrusted unknown payload');
    } finally { await runtime.dispose(); }
  });

  it('observes native sidecars, ignores embedded absolute homedir and refuses escaped wire files', async () => {
    const { reader, request, runtime, home, files } = await setup();
    const outside = await mkdtemp(join(tmpdir(), 'happier-kimi-outside-')); dirs.push(outside);
    try {
      const resolved = await reader.resolveSource(request);
      expect(resolved).toMatchObject({ ok: true, value: { accountingSource: { changeObservation: 'watch_file_changes',
        watchFileChanges: { files: expect.arrayContaining([files.statePath, files.wirePath, join(home, 'session_index.jsonl')]) } } } });
      const admitted = await reader.resolveSource({ ...request, includeAccountingSource: false });
      expect(admitted.ok && admitted.value).not.toHaveProperty('accountingSource');
      await writeFile(files.statePath, JSON.stringify({ agents: { main: { type: 'main', homedir: outside } } }));
      expect(await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'body-only phrase' }))
        .toMatchObject({ ok: true, value: { candidates: [expect.anything()] } });
      await writeFile(join(outside, 'wire.jsonl'), kimiWire([kimiMetadata, kimiUser('private outside body')]));
      await rm(files.wirePath);
      await symlink(join(outside, 'wire.jsonl'), files.wirePath);
      expect(await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'private outside body' }))
        .toMatchObject({ ok: false, code: 'source_invalid' });
    } finally { await runtime.dispose(); }
  });
});
