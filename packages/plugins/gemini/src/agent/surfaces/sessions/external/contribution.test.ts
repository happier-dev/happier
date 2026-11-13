import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { AgentExternalSessionsContribution, AgentExternalSessionsInvocation } from '@happier-dev/plugin-sdk/sessions/external';
import { AgentExternalSessionTranscriptRawRecordSchema } from '@happier-dev/plugin-sdk/sessions/external';
import { resolveTranscriptBodySemanticEvent } from '@happier-dev/protocol/sessions/messages/sessionMessageRole';
import { GEMINI_PLUGIN } from '../../../../manifest.js';
import { body, gemini, header, jsonl, records, sessionId, user } from './__fixtures__/gemini064.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'happier-gemini-reader-'));
  roots.push(root);
  const geminiDir = join(root, '.gemini');
  const chats = join(geminiDir, 'tmp', 'project', 'chats');
  await mkdir(chats, { recursive: true });
  await writeFile(join(geminiDir, 'projects.json'), JSON.stringify({ projects: { '/repo': 'project' } }));
  const path = join(chats, 'session-2026-10-20T10-00-8b6e1959.jsonl');
  await writeFile(path, jsonl());
  const kit = await createPluginTestkit({ manifest: GEMINI_PLUGIN.manifest, module: { activate: GEMINI_PLUGIN.activate } });
  const reader = kit.registration('agents', 'gemini')?.externalSessions;
  // The missing production registration is the first RED, before any native read.
  if (!reader) await kit.dispose();
  expect(reader, 'Gemini must register its native transcript reader').toBeDefined();
  const request = {
    source: { kind: 'geminiConfigDir', configDir: geminiDir }, signal: new AbortController().signal,
    maxItems: 100, maxSerializedBytes: 1024 * 1024,
    managedEndpointRead: async () => { throw new Error('No Gemini server may be started'); },
    // Unused process boundary: a file reader must never execute the vendor.
    exec: {} as AgentExternalSessionsInvocation['exec'],
    ripgrep: { run: vi.fn(async () => ({ exitCode: 0, stdout: path + '\0', stderr: '' })) },
  };
  return { reader: reader as AgentExternalSessionsContribution, request, path, chats, kit };
}

describe('Gemini v0.64 native conversation reader', () => {
  it('projects only assistant prose from native thought and tool-call content', async () => {
    const { reader, request, path, kit } = await fixture();
    try {
      // Synthetic v0.64 / GenAI Part schema fixture; no recorded native thought
      // capture is available in gemini064.ts.
      await writeFile(path, jsonl([{ ...header, summary: 'internal session summary', memoryScratchpad: 'internal memory' }, {
        ...gemini('mixed', ''), thoughts: [{ subject: 'internal thoughts', description: 'internal reasoning' }],
        content: [
          { text: 'internal thought part', thought: true },
          { functionCall: { id: 'call', name: 'read_file', args: { path: 'internal tool input' } } },
          { text: 'Visible assistant answer', thoughtSignature: 'opaque signature' },
        ],
      }]));
      const page = await reader.pageTranscript({ ...request, remoteSessionId: sessionId, direction: 'older' });
      expect(page).toMatchObject({ ok: true, value: { items: [{ id: 'mixed', raw: {
        content: { data: { type: 'message', message: 'Visible assistant answer' } },
      } }] } });
      if (!page.ok) throw new Error(page.code);
      expect(page.value.items).toHaveLength(1);
      expect(await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'internal' }))
        .toMatchObject({ ok: true, value: { candidates: [] } });
    } finally { await kit.dispose(); }
  });

  it('yields within a patch replay before publishing a subsequently rewound hit', async () => {
    const { reader, request, path, kit } = await fixture();
    try {
      await writeFile(path, jsonl([header,
        ...Array.from({ length: 2000 }, (_, index) => user(`ordinary-${index}`, `ordinary ${index}`)),
        user('abandoned', 'deadline needle abandoned'), { $rewindTo: 'abandoned' }, user('retained', 'deadline needle retained')]));
      let clock = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => ++clock);
      const first = await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'deadline needle', scanDeadlineAtMs: 20 });
      expect(first).toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'partial', nextCursor: expect.any(String) } });
      if (!first.ok || !first.value.nextCursor) throw new Error('Expected interrupted patch replay');
      const next = await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'deadline needle', cursor: first.value.nextCursor });
      expect(next).toMatchObject({ ok: true, value: { contentCoverage: 'complete', nextCursor: null, candidates: [
        { match: { sourceItemId: 'retained', snippet: 'deadline needle retained', messageIndex: 2000 } },
      ] } });
    } finally { await kit.dispose(); }
  });
  it('searches decoded full bodies and excludes tool inputs, with real registration and strict rows', async () => {
    const { reader, request, path, kit } = await fixture();
    try {
      for (const query of ['sapphire', '"quoted"\n東京 café', 'long visible body']) {
        const page = await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: query });
        expect(page).toMatchObject({ ok: true, value: { contentCoverage: 'complete', candidates: [
          { remoteSessionId: sessionId, cwd: '/repo', match: { sourceItemId: 'a1', messageIndex: 1 } },
        ] } });
      }
      expect(await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'metadata-only topaz' }))
        .toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'complete' } });
      const page = await reader.pageTranscript({ ...request, remoteSessionId: sessionId, direction: 'older' });
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      expect(page.value.items.map(item => item.id)).toEqual(['u1', 'a1', 'tools:tool:call']);
      for (const item of page.value.items) {
        expect(AgentExternalSessionTranscriptRawRecordSchema.safeParse(item.raw).success).toBe(true);
        const role = item.raw.role === 'user' ? 'user' : resolveTranscriptBodySemanticEvent({ protocol: 'acp', body: item.raw.content })?.role;
        expect(item.messageRole ?? role).toBe(role);
      }
      expect(page.value.items[1]?.raw).toMatchObject({ content: { data: { message: body } } });
      await appendFile(path, jsonl([{ ...user('display', 'injected invisible preamble'), displayContent: 'visible cyan' }]));
      expect(await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'injected invisible preamble' }))
        .toMatchObject({ ok: true, value: { candidates: [] } });
      expect(await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'visible cyan' }))
        .toMatchObject({ ok: true, value: { candidates: [{ match: { sourceItemId: 'display' } }] } });
      await appendFile(path, jsonl([{ ...gemini('parts', ''), content: [{ text: 'joined opal' }, { text: 'mercury body' }] }]));
      // The OS prefilter correctly finds no contiguous raw JSON spelling.
      // Search must nevertheless match the native visible concatenation.
      request.ripgrep.run.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });
      expect(await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'opalmercury' }))
        .toMatchObject({ ok: true, value: { candidates: [{ match: { sourceItemId: 'parts' } }] } });
    } finally { await kit.dispose(); }
  });

  it('replays patches, checkpoint/order/remove and rewind before matching, and reads legacy JSON', async () => {
    const { reader, request, path, chats, kit } = await fixture();
    try {
      await appendFile(path, jsonl([{ $patch: { updates: [{ id: 'a1', content: 'replacement ruby' }], removeIds: ['tools'], orderIds: ['a1', 'u1'] } }]));
      expect(await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'sapphire' }))
        .toMatchObject({ ok: true, value: { candidates: [] } });
      expect(await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'ruby' }))
        .toMatchObject({ ok: true, value: { candidates: [{ match: { sourceItemId: 'a1', messageIndex: 0 } }] } });
      await appendFile(path, jsonl([{ $set: { messages: [user('checkpoint', 'checkpoint quartz'), gemini('discard', 'abandoned garnet')] } },
        { $rewindTo: 'discard' }, gemini('replacement', 'current amber')]));
      const page = await reader.pageTranscript({ ...request, remoteSessionId: sessionId, direction: 'older' });
      expect(page).toMatchObject({ ok: true, value: { items: [{ id: 'checkpoint' }, { id: 'replacement' }] } });
      expect(await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'garnet' }))
        .toMatchObject({ ok: true, value: { candidates: [] } });
      await rm(path);
      const legacyPath = join(chats, 'session-legacy.json');
      await writeFile(legacyPath, JSON.stringify({ ...header, messages: records.slice(1) }));
      request.ripgrep.run.mockResolvedValue({ exitCode: 0, stdout: legacyPath + '\0', stderr: '' });
      expect(await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'sapphire' }))
        .toMatchObject({ ok: true, value: { candidates: [{ remoteSessionId: sessionId }] } });
    } finally { await kit.dispose(); }
  });

  it('pages stable locators, appends after the tail, and invalidates rewritten history', async () => {
    const { reader, request, path, kit } = await fixture();
    try {
      const page = await reader.pageTranscript({ ...request, maxItems: 1, remoteSessionId: sessionId, direction: 'older' });
      expect(page).toMatchObject({ ok: true, value: { hasMore: true, nextCursor: expect.any(String), tailCursor: expect.any(String) } });
      if (!page.ok) return;
      const older = await reader.pageTranscript({ ...request, maxItems: 1, remoteSessionId: sessionId, direction: 'older', cursor: page.value.nextCursor! });
      expect(older).toMatchObject({ ok: true, value: { items: [{ id: 'a1' }], hasMore: true } });
      const first = await reader.pageTranscript({ ...request, maxItems: 1, remoteSessionId: sessionId, direction: 'newer' });
      expect(first).toMatchObject({ ok: true, value: { items: [{ id: 'u1' }], hasMore: true } });
      if (first.ok) expect(await reader.pageTranscript({ ...request, maxItems: 1, remoteSessionId: sessionId,
        direction: 'newer', cursor: first.value.nextCursor! })).toMatchObject({ ok: true, value: { items: [{ id: 'a1' }] } });
      await appendFile(path, jsonl([user('append', 'appended emerald')]));
      expect(await reader.readAfterTranscript({ ...request, remoteSessionId: sessionId, cursor: page.value.tailCursor! }))
        .toMatchObject({ ok: true, value: { outcome: 'advanced', items: [{ id: 'append' }], hasMore: false } });
      await appendFile(path, jsonl([{ $rewindTo: 'a1' }, user('new', 'new branch')]));
      expect(await reader.readAfterTranscript({ ...request, remoteSessionId: sessionId, cursor: page.value.tailCursor! }))
        .toMatchObject({ ok: true, value: { outcome: 'source_replaced' } });
    } finally { await kit.dispose(); }
  });

  it('distinguishes confirmed deletion from unavailable storage and cannot retire an unknown dialect', async () => {
    const { reader, request, path, chats, kit } = await fixture();
    try {
      const page = await reader.pageTranscript({ ...request, remoteSessionId: sessionId, direction: 'older' });
      if (!page.ok) throw new Error('Expected initial native page');
      const read = () => reader.readAfterTranscript({ ...request, remoteSessionId: sessionId, cursor: page.value.tailCursor! });
      await rename(chats, chats + '-unavailable');
      // A missing chats directory in an otherwise enumerated source is a
      // native session deletion, rather than an empty successful append.
      expect(await read()).toMatchObject({ ok: true, value: { outcome: 'source_unavailable' } });
      await rename(chats + '-unavailable', chats);
      await writeFile(path, jsonl([{ ...header, version: 999 }]));
      expect(await read()).toMatchObject({ ok: false, code: 'unsupported' });
      await rename(request.source.configDir, request.source.configDir + '-unavailable');
      expect(await read()).toMatchObject({ ok: false, code: 'source_unreachable' });
    } finally { await kit.dispose(); }
  });

  it('observes native files and legacy replacements, and reports unknown formats and torn tails truthfully', async () => {
    const { reader, request, path, chats, kit } = await fixture();
    try {
      const source = await reader.resolveSource(request);
      expect(source).toMatchObject({ ok: true, value: { accountingSource: { changeObservation: 'watch_file_changes', watchFileChanges: { files: expect.arrayContaining([path]) } } } });
      await writeFile(join(chats, 'session-future.jsonl'), jsonl([{ ...header, sessionId: 'future', version: 999 }, user('f', 'future secret')]));
      const future = await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'future secret' });
      expect(future).toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'partial', searchIncomplete: true } });
      await appendFile(path, '{"id":"torn');
      expect(await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'sapphire' }))
        .toMatchObject({ ok: true, value: { candidates: [{ remoteSessionId: sessionId }], contentCoverage: 'partial' } });
      expect(await reader.pageTranscript({ ...request, remoteSessionId: 'future', direction: 'older' }))
        .toMatchObject({ ok: false, code: 'unsupported' });
      await rm(join(chats, 'session-future.jsonl'));
      await writeFile(path, jsonl([...records, { $patch: { updates: [{ id: 'a1', content: body, futureProjection: true }] } }]));
      expect(await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'sapphire' }))
        .toMatchObject({ ok: true, value: { candidates: [{ remoteSessionId: sessionId }], contentCoverage: 'partial', searchIncomplete: true } });
      for (const message of [
        { ...gemini('a1', ''), content: [{ text: body, futureProjection: true }] },
        { ...gemini('a1', body), toolCalls: [{ id: 'call', name: 'shell', args: {}, status: 'success',
          timestamp: header.startTime, result: 'visible output', futureProjection: true }] },
      ]) {
        await writeFile(path, jsonl([header, message]));
        expect(await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'sapphire' }))
          .toMatchObject({ ok: true, value: { candidates: [{ remoteSessionId: sessionId }], contentCoverage: 'partial' } });
      }
      await writeFile(path, jsonl([header, { ...gemini('a1', ''), content: [{ text: body, thoughtSignature: 'opaque' }] }]));
      expect(await reader.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'sapphire' }))
        .toMatchObject({ ok: true, value: { contentCoverage: 'complete' } });
    } finally { await kit.dispose(); }
  });

  it('retains progress on deadline, binds cursors to queries, and honors cancellation', async () => {
    const { reader, request, chats, kit } = await fixture();
    try {
      await writeFile(join(chats, 'session-second.jsonl'), jsonl([{ ...header, sessionId: 'second' }, user('u', 'sapphire second')]));
      const page = await reader.listCandidates({ ...request, maxItems: 1, searchTarget: 'content', searchTerm: 'sapphire', scanDeadlineAtMs: Date.now() - 1 });
      expect(page).toMatchObject({ ok: true, value: { contentCoverage: 'partial', nextCursor: expect.any(String), candidates: [] } });
      if (!page.ok) return;
      expect(await reader.listCandidates({ ...request, cursor: page.value.nextCursor!, searchTarget: 'content', searchTerm: 'sapphire' }))
        .toMatchObject({ ok: true, value: { candidates: [{ remoteSessionId: sessionId }, { remoteSessionId: 'second' }], contentCoverage: 'complete', nextCursor: null } });
      expect(await reader.listCandidates({ ...request, cursor: page.value.nextCursor!, searchTarget: 'content', searchTerm: 'different' }))
        .toMatchObject({ ok: false, code: 'invalid_request' });
      expect(await reader.listCandidates({ ...request, signal: AbortSignal.abort(), searchTarget: 'content', searchTerm: 'sapphire' }))
        .toMatchObject({ ok: false, code: 'cancelled' });
    } finally { await kit.dispose(); }
  });
});
