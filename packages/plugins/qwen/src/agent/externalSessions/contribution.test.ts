import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { ExternalSessionCandidateV1Schema } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import { resolveTranscriptBodySemanticEvent } from '@happier-dev/protocol/sessions/messages/sessionMessageRole';
import { renderSessionInputContextPromptV1 } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import type { AgentExternalSessionsContribution, AgentExternalSessionsInvocation } from '@happier-dev/plugin-sdk/sessions/external';
import { AgentExternalSessionTranscriptRawRecordSchema } from '@happier-dev/plugin-sdk/sessions/external';
import { activate, PLUGIN_MANIFEST } from '../../manifest.js';
import { body, jsonl, record, records, sessionId } from './__fixtures__/qwen0253.js';
import { createQwenExternalSessionsContribution } from './contribution.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'happier-qwen-reader-')); roots.push(root);
  const chats = join(root, 'projects', '-repo', 'chats'); await mkdir(chats, { recursive: true });
  const path = join(chats, `${sessionId}.jsonl`); await writeFile(path, jsonl());
  // Native stat timestamps carry sub-millisecond precision, unlike the wire.
  await utimes(path, 1_792_488_000.12345, 1_792_488_000.12345);
  const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
  const reader = kit.registration('agents', 'qwen')?.externalSessions;
  expect(reader, 'Qwen must register its native transcript reader').toBeDefined();
  const request = { source: { kind: 'qwenRuntimeDir', runtimeDir: root }, signal: new AbortController().signal,
    maxItems: 100, maxSerializedBytes: 1_048_576,
    exec: {} as AgentExternalSessionsInvocation['exec'],
    ripgrep: { run: vi.fn(async () => ({ exitCode: 0, stdout: path + '\0', stderr: '' })) },
  };
  return { root, chats, path, kit, reader: reader as AgentExternalSessionsContribution, request };
}

describe('Qwen v0.25.3 native reader', () => {
  it('projects prompt-derived titles without delivery metadata and preserves native custom titles', async () => {
    const f = await fixture();
    try {
      const prompt = renderSessionInputContextPromptV1({ inputProvenance: { v: 1, kind: 'host', producer: 'sessionAction' },
        transformedUserText: 'Find the missing allowance' });
      const user = record('u1', null, 'user', { message: { role: 'user', parts: [{ text: prompt }] } });
      await writeFile(f.path, jsonl([user]));
      expect(await f.reader.listCandidates(f.request)).toMatchObject({ ok: true,
        value: { candidates: [{ title: 'Find the missing allowance' }] } });
      await appendFile(f.path, jsonl([record('custom', 'u1', 'system', {
        subtype: 'custom_title', systemPayload: { title: 'A native custom title' },
      })]));
      expect(await f.reader.listCandidates(f.request)).toMatchObject({ ok: true,
        value: { candidates: [{ title: 'A native custom title' }] } });
    } finally { await f.kit.dispose(); }
  });
  it('honors native runtime-root precedence and keeps the admitted source pinned', async () => {
    const f = await fixture();
    try {
      const reader = createQwenExternalSessionsContribution({ env: { QWEN_RUNTIME_DIR: f.root, QWEN_HOME: join(f.root, 'other') } });
      const resolved = await reader.resolveSource({ ...f.request, source: { kind: 'qwenRuntimeDir' }, includeAccountingSource: false });
      expect(resolved).toEqual({ ok: true, value: { source: f.request.source } });
      expect(await createQwenExternalSessionsContribution({ env: { QWEN_HOME: f.root } }).resolveSource({ ...f.request, source: { kind: 'qwenRuntimeDir' }, includeAccountingSource: false }))
        .toEqual({ ok: true, value: { source: f.request.source } });
      expect(await reader.resolveSource({ ...f.request, includeAccountingSource: false })).toEqual(resolved);
    } finally { await f.kit.dispose(); }
  });
  it('registers a body search with decoded Unicode, long bodies and stable locators, excluding metadata and compression', async () => {
    const f = await fixture();
    try {
      const transcript = await f.reader.pageTranscript({ ...f.request, remoteSessionId: sessionId, direction: 'older' });
      expect(transcript.ok).toBe(true); if (!transcript.ok) return;
      expect(transcript.value.items.map(item => item.id)).toEqual(['u1', 'a1', 'tools:tool:call', 'result']);
      for (const item of transcript.value.items) {
        expect(AgentExternalSessionTranscriptRawRecordSchema.safeParse(item.raw).success).toBe(true);
        const derivedRole = item.raw.role === 'user' ? 'user'
          : resolveTranscriptBodySemanticEvent({ protocol: 'acp', body: item.raw.content })?.role;
        expect(derivedRole).toBeDefined();
        if (item.messageRole !== undefined && item.messageRole !== null) expect(item.messageRole).toBe(derivedRole);
      }
      expect(transcript.value.items[1]?.raw).toMatchObject({ content: { data: { message: body } } });
      for (const searchTerm of ['sapphire', '"quotes"\n東京 café', 'long visible body', 'visible tool emerald']) {
        const page = await f.reader.listCandidates({ ...f.request, searchTarget: 'content', searchTerm });
        expect(page).toMatchObject({ ok: true, value: { contentCoverage: 'complete', candidates: [{ remoteSessionId: sessionId,
          match: { snippet: expect.stringContaining(searchTerm), sourceItemId: expect.any(String) } }] } });
        if (page.ok) {
          expect(ExternalSessionCandidateV1Schema.safeParse(page.value.candidates[0]).success).toBe(true);
          expect(transcript.value.items[page.value.candidates[0]!.match!.messageIndex]?.id).toBe(page.value.candidates[0]!.match!.sourceItemId);
        }
      }
      for (const searchTerm of ['metadata-only topaz', 'model-only compression secret']) expect(await f.reader.listCandidates({ ...f.request, searchTarget: 'content', searchTerm }))
        .toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'complete' } });
      await writeFile(f.path, jsonl([records[0], record('split', 'u1', 'assistant', { message: { role: 'model', parts: [
        { text: 'spanning ' }, { text: 'quartz' },
      ] } })]));
      // A real raw-text prefilter cannot see the phrase across JSON parts.
      // Matching must remain authoritative on the already-decoded body.
      expect(await f.reader.listCandidates({ ...f.request, searchTarget: 'content', searchTerm: 'spanning quartz',
        ripgrep: { run: async () => ({ exitCode: 1, stdout: '', stderr: '' }) } }))
        .toMatchObject({ ok: true, value: { candidates: [{ match: { sourceItemId: 'split', snippet: expect.stringContaining('spanning quartz') } }] } });
    } finally { await f.kit.dispose(); }
  });

  it('pages and appends with stable ids, but rewinds and same-UUID edits require source replacement', async () => {
    const f = await fixture();
    try {
      const page = await f.reader.pageTranscript({ ...f.request, remoteSessionId: sessionId, direction: 'older', maxItems: 1 });
      expect(page).toMatchObject({ ok: true, value: { items: [{ id: 'result' }], hasMore: true, nextCursor: expect.any(String), tailCursor: expect.any(String) } });
      if (!page.ok) return;
      expect(await f.reader.pageTranscript({ ...f.request, remoteSessionId: sessionId, direction: 'older', maxItems: 1, cursor: page.value.nextCursor! }))
        .toMatchObject({ ok: true, value: { items: [{ id: 'tools:tool:call' }] } });
      await appendFile(f.path, jsonl([record('append', 'result', 'user', { message: { role: 'user', parts: [{ text: 'appended ruby' }] } })]));
      expect(await f.reader.readAfterTranscript({ ...f.request, remoteSessionId: sessionId, cursor: page.value.tailCursor! }))
        .toMatchObject({ ok: true, value: { outcome: 'advanced', items: [{ id: 'append' }], hasMore: false } });
      await appendFile(f.path, jsonl([record('rewind', 'u1', 'system', { subtype: 'rewind', systemPayload: { truncatedCount: 4 } }),
        record('new', 'rewind', 'assistant', { message: { role: 'model', parts: [{ text: 'current amber' }] } })]));
      expect(await f.reader.readAfterTranscript({ ...f.request, remoteSessionId: sessionId, cursor: page.value.tailCursor! }))
        .toMatchObject({ ok: true, value: { outcome: 'source_replaced' } });
      expect(await f.reader.listCandidates({ ...f.request, searchTarget: 'content', searchTerm: 'sapphire' }))
        .toMatchObject({ ok: true, value: { candidates: [] } });
      const current = await f.reader.pageTranscript({ ...f.request, remoteSessionId: sessionId, direction: 'older' });
      expect(current).toMatchObject({ ok: true, value: { items: [{ id: 'u1' }, { id: 'new' }] } });
      if (!current.ok) return;
      await writeFile(f.path, (await readFile(f.path, 'utf8')).replace('ordinary title', 'changed title'));
      expect(await f.reader.readAfterTranscript({ ...f.request, remoteSessionId: sessionId, cursor: current.value.tailCursor! }))
        .toMatchObject({ ok: true, value: { outcome: 'source_replaced' } });
    } finally { await f.kit.dispose(); }
  });

  it('aggregates native assistant fragments and reads archives without mutating their state', async () => {
    const f = await fixture();
    try {
      await writeFile(f.path, jsonl([records[0], record('stream', 'u1', 'assistant', { message: { role: 'model', parts: [{ text: 'fragment ' }] } }),
        record('stream', 'u1', 'assistant', { message: { role: 'model', parts: [{ text: 'joined amber' }] } })]));
      expect(await f.reader.listCandidates({ ...f.request, searchTarget: 'content', searchTerm: 'fragment joined amber' }))
        .toMatchObject({ ok: true, value: { candidates: [{ match: { sourceItemId: 'stream' } }] } });
      const archive = join(f.chats, 'archive'); await mkdir(archive);
      const archivedId = '5b11e49d-35ef-4adf-b533-096a427e7af5';
      await writeFile(join(archive, `${archivedId}.jsonl`), jsonl(records.map(r => ({ ...r, sessionId: archivedId }))));
      const page = await f.reader.listCandidates({ ...f.request, searchTarget: 'content', searchTerm: 'sapphire', ripgrep: undefined! });
      expect(page).toMatchObject({ ok: true, value: { candidates: [{ remoteSessionId: archivedId, archived: true }] } });
      expect(await f.reader.resolveLinkIdentity({ ...f.request, remoteSessionId: archivedId })).toMatchObject({ ok: true, value: { remoteSessionId: archivedId } });
    } finally { await f.kit.dispose(); }
  });

  it('observes source files and topology, rejects unknown versions, and reports torn sources as partial', async () => {
    const f = await fixture();
    try {
      expect(await f.reader.resolveSource(f.request)).toMatchObject({ ok: true, value: { accountingSource: { rootPath: f.root,
        rootField: 'runtimeDir', changeObservation: 'watch_file_changes', watchFileChanges: { files: [f.path] } } } });
      expect(await f.reader.resolveSource({ ...f.request, includeAccountingSource: false })).toEqual({ ok: true, value: { source: f.request.source } });
      await writeFile(f.path, jsonl(records.map(r => ({ ...r, version: '99.0.0' }))));
      expect(await f.reader.listCandidates({ ...f.request, searchTarget: 'content', searchTerm: 'sapphire' }))
        .toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'partial', searchIncomplete: true } });
      expect(await f.reader.pageTranscript({ ...f.request, remoteSessionId: sessionId, direction: 'older' }))
        .toMatchObject({ ok: false, code: 'unsupported' });
      await writeFile(f.path, jsonl([records[0], record('unknown', 'u1', 'assistant', { message: { futureBody: 'private unparsed ruby' } })]));
      expect(await f.reader.listCandidates({ ...f.request, searchTarget: 'content', searchTerm: 'private unparsed ruby' }))
        .toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'partial' } });
      const unsupported = await f.reader.pageTranscript({ ...f.request, remoteSessionId: sessionId, direction: 'older' });
      expect(unsupported)
        .toMatchObject({ ok: true, value: { truncated: true, items: [{ id: 'u1' }, { id: 'unknown', raw: { content: { data: {
          message: expect.any(String),
        } } } }] } });
      expect(JSON.stringify(unsupported)).not.toContain('private unparsed ruby');
      await writeFile(f.path, jsonl([records[0], record('known', 'u1', 'assistant', {
        daemonPromptId: 'prompt', gitBranch: 'main', usageMetadata: { totalTokenCount: 7 },
        agentRunId: 'run', forkedFrom: { sessionId: 'parent', messageUuid: 'known' },
        message: { role: 'model', parts: [{ text: 'known sapphire body', thoughtSignature: 'opaque' }] },
      })]));
      expect(await f.reader.listCandidates({ ...f.request, searchTarget: 'content', searchTerm: 'sapphire' }))
        .toMatchObject({ ok: true, value: { contentCoverage: 'complete', candidates: [{ remoteSessionId: sessionId }] } });
      for (const fields of [
        { futureNativeMetadata: 'unparsed top-level ruby', message: { role: 'model', parts: [{ text: 'known sapphire body' }] } },
        { message: { role: 'model', parts: [{ text: 'known sapphire body' }], futureBody: 'unparsed message ruby' } },
        { message: { role: 'model', parts: [{ text: 'known sapphire body', futurePart: 'unparsed part ruby' }] } },
      ]) {
        await writeFile(f.path, jsonl([records[0], record('future', 'u1', 'assistant', fields)]));
        expect(await f.reader.listCandidates({ ...f.request, searchTarget: 'content', searchTerm: 'sapphire' }))
          .toMatchObject({ ok: true, value: { contentCoverage: 'partial', candidates: [{ remoteSessionId: sessionId }] } });
        const future = await f.reader.pageTranscript({ ...f.request, remoteSessionId: sessionId, direction: 'older' });
        expect(future).toMatchObject({ ok: true, value: { truncated: true } });
        expect(JSON.stringify(future)).not.toContain('unparsed');
      }
      await writeFile(f.path, jsonl() + '{"uuid":"torn');
      expect(await f.reader.listCandidates({ ...f.request, searchTarget: 'content', searchTerm: 'sapphire' }))
        .toMatchObject({ ok: true, value: { contentCoverage: 'partial', candidates: [{ remoteSessionId: sessionId }] } });
    } finally { await f.kit.dispose(); }
  });

  it('continues cooperative deadline pages without losing or repeating a match', async () => {
    const f = await fixture();
    try {
      let clock = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => ++clock);
      let cursor: string | undefined; let sawPartial = false; const hits: string[] = [];
      for (let round = 0; round < 30; round += 1) {
        const page = await f.reader.listCandidates({ ...f.request, searchTarget: 'content', searchTerm: 'sapphire', scanDeadlineAtMs: clock + 3,
          ...(cursor ? { cursor } : {}) });
        expect(page.ok).toBe(true); if (!page.ok) return;
        sawPartial ||= page.value.contentCoverage === 'partial'; hits.push(...page.value.candidates.map(c => c.remoteSessionId));
        if (!page.value.nextCursor) { cursor = undefined; break; }
        expect(page.value.nextCursor).not.toBe(cursor); cursor = page.value.nextCursor;
      }
      expect(sawPartial).toBe(true); expect(hits).toEqual([sessionId]); expect(cursor).toBeUndefined();
    } finally { await f.kit.dispose(); }
  });

  it('confines native paths and ids, and preserves cancellation', async () => {
    const f = await fixture();
    try {
      expect(await f.reader.pageTranscript({ ...f.request, remoteSessionId: '../escape', direction: 'older' })).toMatchObject({ ok: false, code: 'invalid_request' });
      await rm(f.path); await symlink(join(tmpdir(), 'foreign-qwen.jsonl'), f.path);
      expect(await f.reader.listCandidates(f.request)).toMatchObject({ ok: false, code: 'source_invalid' });
      const outside = await mkdtemp(join(tmpdir(), 'happier-qwen-outside-')); roots.push(outside);
      await mkdir(join(outside, 'project', 'chats'), { recursive: true });
      await writeFile(join(outside, 'project', 'chats', `${sessionId}.jsonl`), jsonl());
      await rm(join(f.root, 'projects'), { recursive: true });
      await symlink(outside, join(f.root, 'projects'), 'dir');
      expect(await f.reader.resolveSource(f.request)).toMatchObject({ ok: false, code: 'source_invalid' });
      const controller = new AbortController(); controller.abort();
      expect(await f.reader.listCandidates({ ...f.request, signal: controller.signal })).toMatchObject({ ok: false, code: 'cancelled' });
    } finally { await f.kit.dispose(); }
  });

  it('distinguishes confirmed session removal from an unavailable source store', async () => {
    const f = await fixture();
    try {
      const page = await f.reader.pageTranscript({ ...f.request, remoteSessionId: sessionId, direction: 'older' });
      expect(page.ok).toBe(true); if (!page.ok) return;
      await rm(f.path);
      expect(await f.reader.readAfterTranscript({ ...f.request, remoteSessionId: sessionId, cursor: page.value.tailCursor! }))
        .toMatchObject({ ok: true, value: { outcome: 'source_unavailable' } });
      await rm(join(f.root, 'projects'), { recursive: true });
      expect(await f.reader.readAfterTranscript({ ...f.request, remoteSessionId: sessionId, cursor: page.value.tailCursor! }))
        .toMatchObject({ ok: false, code: 'agent_unavailable' });
    } finally { await f.kit.dispose(); }
  });
});
