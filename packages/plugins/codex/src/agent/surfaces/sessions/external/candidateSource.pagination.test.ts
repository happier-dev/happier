import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';

type AppServerThread = { id: string; updatedAt: number; cwd?: string };

const appServerProbe = vi.hoisted(() => ({
  threads: [] as AppServerThread[],
  pages: new Map<string, Readonly<{
    data: AppServerThread[];
    nextCursor: string | null;
  }>>(),
  calls: [] as Array<Readonly<{ archived: boolean; cursor: string | null }>>,
  failCursor: null as string | null,
  loadedIds: new Set<string>(),
  transports: [] as unknown[],
  onCreate: null as (() => void) | null,
}));

const rolloutFsProbe = vi.hoisted(() => ({
  statPaths: [] as string[],
  onStat: null as (() => void) | null,
}));

// The Codex native app-server is a spawned provider process reached over JSON-RPC:
// a genuine system boundary. Everything below it — merge ordering, cursor
// arithmetic, rollout discovery — stays the real implementation.
vi.mock('../../../runtime/appServer/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../runtime/appServer/client.js')>();
  return {
    ...actual,
    createCodexNativeAppServerClient: async (params: Readonly<{ transport?: unknown }>) => {
      appServerProbe.transports.push(params.transport);
      appServerProbe.onCreate?.();
      return ({
      launchFeatures: {
        realtimeConversationAdvertised: false,
      },
      request: async (method: string, params?: unknown) => {
        if (method === 'thread/loaded/list') {
          return { data: [...appServerProbe.loadedIds].map((id) => ({ id })) };
        }
        if (method !== 'thread/list') return {};
        const request = params as { archived?: boolean; cursor?: string } | undefined;
        const archived = Boolean(request?.archived);
        const cursor = typeof request?.cursor === 'string' ? request.cursor : null;
        appServerProbe.calls.push({ archived, cursor });
        if (appServerProbe.failCursor !== null && cursor === appServerProbe.failCursor) {
          throw new Error(`unexpected native cursor request: ${cursor}`);
        }
        const page = appServerProbe.pages.get(`${archived ? 'archived' : 'active'}:${cursor ?? ''}`);
        return {
          data: page?.data ?? (archived ? [] : appServerProbe.threads),
          nextCursor: page?.nextCursor ?? null,
        };
      },
      notify: async () => {},
      registerRequestHandler: () => () => {},
      registerNotificationHandler: () => () => {},
      onExit: () => () => {},
      dispose: async () => {},
      });
    },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const filePath = args[0];
      if (typeof filePath === 'string' && filePath.endsWith('.jsonl')) {
        rolloutFsProbe.statPaths.push(filePath);
        rolloutFsProbe.onStat?.();
      }
      return actual.stat(...args);
    },
  };
});

import { listCodexSessionCandidates } from './candidateSource.js';
import { pageCodexExternalSessionTranscript } from './transcriptSource.js';
import { createCodexExternalSessionsContribution } from './contribution.js';

describe('Codex candidate conversation search', () => {
  it('defers a native probe that cannot fit its existing budget, preserving both sources for continuation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-content-native-deadline-'));
    try {
      const sessions = join(root, 'sessions', '2026', '07', '23');
      await mkdir(sessions, { recursive: true });
      const id = 'eeeeeeee-1111-1111-1111-111111111111';
      await writeFile(join(sessions, `rollout-2026-07-23T10-00-00-${id}.jsonl`), [
        { type: 'session_meta', payload: { id, cwd: '/repo' } },
        { type: 'event_msg', payload: { type: 'agent_message', message: 'native budget needle' } },
      ].map((row) => JSON.stringify(row)).join('\n') + '\n');
      appServerProbe.threads = [{ id: 'native-only', updatedAt: 2000000000 }];
      let nowMs = 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
      rolloutFsProbe.onStat = () => { nowMs += 12500; rolloutFsProbe.onStat = null; };
      appServerProbe.onCreate = () => { nowMs += 3000; };
      const ripgrep = { run: async ({ args, paths, signal }: { args: readonly string[]; paths: readonly string[]; signal?: AbortSignal }) => {
        const launcher = fileURLToPath(new URL('../../../../../../../../apps/cli/scripts/ripgrep_launcher.cjs', import.meta.url));
        const result = await promisify(execFile)(process.execPath, [launcher, JSON.stringify([...args, '--', ...paths])], { signal });
        return { ...result, exitCode: 0 };
      } };
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: root } });
      const request = {
        source: { kind: 'codexHome' as const, home: 'user' as const, homePath: root },
        searchTarget: 'content' as const, searchTerm: 'native budget needle', maxItems: 10,
        maxSerializedBytes: 1024 * 1024, exec: {} as ExecService, ripgrep,
        signal: new AbortController().signal,
      };
      const deadlineAtMs = nowMs + 15000;
      const first = await contribution.listCandidates({ ...request, deadlineAtMs });
      if (!first.ok) throw new Error(`${first.code}: ${first.message}`);
      expect(first.value.candidates).toEqual([]);
      expect(first.value.contentCoverage).toBe('partial');
      expect(first.value.nextCursor).toBeTruthy();
      expect(nowMs).toBeLessThan(deadlineAtMs);
      const next = await contribution.listCandidates({ ...request, deadlineAtMs: nowMs + 15000, cursor: first.value.nextCursor! });
      if (!next.ok) throw new Error(`${next.code}: ${next.message}`);
      expect(next.value.candidates.map((candidate) => candidate.remoteSessionId)).toEqual(['native-only', id]);
      expect(next.value.candidates[0]?.match).toBeUndefined();
      expect(next.value.candidates[1]?.match).toMatchObject({ snippet: 'native budget needle' });
      expect(next.value.contentCoverage).toBe('partial');
      expect(next.value.nextCursor).toBeNull();
    } finally {
      appServerProbe.onCreate = null;
      rolloutFsProbe.onStat = null;
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('returns completed content hits before the host deadline and resumes every remaining rollout once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-content-deadline-'));
    try {
      const sessions = join(root, 'sessions', '2026', '07', '23');
      await mkdir(sessions, { recursive: true });
      const ids = Array.from({ length: 4 }, (_, index) => `dddddddd-1111-1111-1111-${String(index).padStart(12, '0')}`);
      await Promise.all(ids.map(async (id, index) => {
        const file = join(sessions, `rollout-2026-07-23T10-00-0${index}-${id}.jsonl`);
        await writeFile(file, [
          { type: 'session_meta', payload: { id, cwd: '/repo' } },
          ...Array.from({ length: 1000 }, (_, message) => ({ type: 'event_msg', payload: { type: 'agent_message', message: `ordinary body ${message}` } })),
          { type: 'event_msg', payload: { type: 'agent_message', message: `deadline needle ${id}` } },
        ].map((row) => JSON.stringify(row)).join('\n') + '\n');
        await utimes(file, new Date(1000 + index * 1000), new Date(1000 + index * 1000));
      }));
      appServerProbe.threads = [];
      let nowMs = 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
      const searchedPaths: string[] = [];
      const ripgrep = { run: async ({ args, paths, signal }: { args: readonly string[]; paths: readonly string[]; signal?: AbortSignal }) => {
        const launcher = fileURLToPath(new URL('../../../../../../../../apps/cli/scripts/ripgrep_launcher.cjs', import.meta.url));
        const result = await promisify(execFile)(process.execPath, [launcher, JSON.stringify([...args, '--', ...paths])], { signal });
        searchedPaths.push(...paths);
        // Clock is the injected boundary; ripgrep and the transcript codec are real.
        nowMs += 8000;
        return { ...result, exitCode: 0 };
      } };
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: root } });
      const found: string[] = [];
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex < ids.length; pageIndex += 1) {
        const deadlineAtMs = nowMs + 15000;
        const page = await contribution.listCandidates({
          source: { kind: 'codexHome', home: 'user', homePath: root },
          searchTarget: 'content', searchTerm: 'deadline needle', maxItems: 10,
          maxSerializedBytes: 1024 * 1024, exec: {} as ExecService, ripgrep,
          signal: new AbortController().signal, deadlineAtMs, cursor,
        });
        if (!page.ok) throw new Error(`${page.code}: ${page.message}`);
        expect(nowMs).toBeLessThan(deadlineAtMs);
        expect(page.value.candidates).toHaveLength(1);
        expect(page.value.candidates[0]?.match).toMatchObject({ messageIndex: 1000 });
        found.push(...page.value.candidates.map((candidate) => candidate.remoteSessionId));
        expect(page.value.contentCoverage).toBe(pageIndex < ids.length - 1 ? 'partial' : 'complete');
        cursor = page.value.nextCursor ?? undefined;
        expect(Boolean(cursor)).toBe(pageIndex < ids.length - 1);
      }
      expect(found).toEqual([...ids].reverse());
      expect(new Set(searchedPaths).size).toBe(ids.length);
      expect(searchedPaths).toHaveLength(ids.length);
    } finally { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); }
  });
  it('finds an unescaped Unicode query whose decoded lowercase differs from ripgrep folding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-content-unicode-'));
    try {
      const sessions = join(root, 'sessions', '2026', '07', '23');
      await mkdir(sessions, { recursive: true });
      const id = 'cccccccc-1111-1111-1111-111111111111';
      await writeFile(join(sessions, `rollout-2026-07-23T10-00-00-${id}.jsonl`), [
        { type: 'session_meta', payload: { id, cwd: '/repo' } },
        { type: 'event_msg', payload: { type: 'agent_message', message: 'İstanbul' } },
      ].map((row) => JSON.stringify(row)).join('\n') + '\n');
      appServerProbe.threads = [];
      const ripgrep = { run: async ({ args, paths }: { args: readonly string[]; paths: readonly string[] }) => {
        const launcher = fileURLToPath(new URL('../../../../../../../../apps/cli/scripts/ripgrep_launcher.cjs', import.meta.url));
        try {
          const result = await promisify(execFile)(process.execPath, [launcher, JSON.stringify([...args, '--', ...paths])]);
          return { ...result, exitCode: 0 };
        } catch (error) {
          if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1) return { exitCode: 1, stdout: '', stderr: '' };
          throw error;
        }
      } };
      const page = await listCodexSessionCandidates({ source: { kind: 'codexHome', home: 'user', homePath: root },
        env: {}, exec: {} as ExecService, searchTarget: 'content', searchTerm: 'İstanbul', ripgrep, limit: 10 });
      expect(page.candidates[0]?.match).toMatchObject({ snippet: 'İstanbul', messageIndex: 0 });
      expect(page.contentCoverage).toBe('complete');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('re-matches decoded rollout text, excludes tool metadata, and identifies native-only gaps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-content-'));
    try {
      const sessions = join(root, 'sessions', '2026', '07', '23');
      await mkdir(sessions, { recursive: true });
      const id = 'aaaaaaaa-1111-1111-1111-111111111111';
      const file = join(sessions, `rollout-2026-07-23T10-00-00-${id}.jsonl`);
      await writeFile(file, [
        { type: 'session_meta', payload: { id, cwd: '/repo' } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Ordinary title' }] } },
        { type: 'event_msg', payload: { type: 'agent_message', message: 'Body-only café\nwith "quotes"' } },
        { type: 'response_item', payload: { type: 'function_call', call_id: 'call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'metadata phrase' }) } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'abandoned question' }] } },
        { type: 'event_msg', payload: { type: 'agent_message', message: 'abandoned phrase' } },
        { type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } },
      ].map((row) => JSON.stringify(row).replace(/é/g, '\\u00e9')).join('\n') + '\n');
      appServerProbe.threads = [{ id: 'native-only', updatedAt: 123 }];
      const ripgrep = { run: vi.fn(async ({ args, paths }: { args: readonly string[]; paths: readonly string[]; signal?: AbortSignal }) => {
        const patterns = args.flatMap((arg, index) => arg === '-e' ? [args[index + 1]!] : []);
        const matches = [];
        for (const path of paths) {
          const text = (await readFile(path, 'utf8')).toLowerCase();
          if (patterns.some((pattern) => text.includes(pattern.toLowerCase()))) matches.push(path);
        }
        return { exitCode: matches.length ? 0 : 1, stdout: matches.map((path) => path + '\0').join(''), stderr: '' };
      }) };
      const params = { source: { kind: 'codexHome' as const, home: 'user' as const, homePath: root }, env: {}, exec: {} as ExecService, searchTarget: 'content' as const, ripgrep, limit: 10 };
      const transcriptItems = [];
      let transcriptCursor: string | undefined;
      for (let index = 0; index < 20; index += 1) {
        const transcript = await pageCodexExternalSessionTranscript({ ...params, remoteSessionId: id, direction: 'older', maxBytes: 1024 * 1024, maxItems: 1, cursor: transcriptCursor });
        transcriptItems.push(...transcript.items);
        if (!transcript.hasMore || !transcript.nextCursor) break;
        transcriptCursor = transcript.nextCursor;
      }
      expect(JSON.stringify(transcriptItems)).not.toContain('abandoned phrase');
      expect(JSON.stringify(transcriptItems)).toContain('Body-only');
      expect(JSON.stringify(transcriptItems)).toContain('Ordinary title');
      const page = await listCodexSessionCandidates({ ...params, searchTerm: 'café\nwith "quotes"' });
      expect(page.candidates.find((candidate) => candidate.remoteSessionId === id)?.match).toEqual({ snippet: 'Body-only café\nwith "quotes"', sourceItemId: expect.stringMatching(/^codex:/), messageIndex: 1 });
      expect(page.candidates.find((candidate) => candidate.remoteSessionId === 'native-only')?.match).toBeUndefined();
      expect(page.candidates.some((candidate) => candidate.remoteSessionId === 'native-only')).toBe(true);
      expect(page.contentCoverage).toBe('partial');
      const first = await listCodexSessionCandidates({ ...params, searchTerm: 'Body-only', limit: 1 });
      expect(first.nextCursor).toBeTruthy();
      for (const change of [{ searchTerm: 'other' }, { searchTarget: 'metadata' as const }]) {
        await expect(listCodexSessionCandidates({ ...params, searchTerm: 'Body-only', cursor: first.nextCursor!, ...change })).rejects.toThrow(/source changed/i);
      }
      const metadata = await listCodexSessionCandidates({ ...params, searchTerm: 'metadata phrase' });
      expect(metadata.candidates.filter((candidate) => candidate.match)).toEqual([]);
      const abandoned = await listCodexSessionCandidates({ ...params, searchTerm: 'abandoned phrase' });
      expect(abandoned.candidates.filter((candidate) => candidate.match)).toEqual([]);
      const controller = new AbortController();
      ripgrep.run.mockImplementationOnce(async ({ signal }) => {
        expect(signal).toBe(controller.signal);
        controller.abort();
        signal?.throwIfAborted();
        return { exitCode: 1, stdout: '', stderr: '' };
      });
      await expect(listCodexSessionCandidates({ ...params, signal: controller.signal, searchTerm: 'Body-only' })).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('keeps a large decoded body hit within the invocation payload budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-content-large-'));
    try {
      const sessions = join(root, 'sessions', '2026', '07', '23');
      await mkdir(sessions, { recursive: true });
      const id = 'bbbbbbbb-1111-1111-1111-111111111111';
      const file = join(sessions, `rollout-2026-07-23T10-00-00-${id}.jsonl`);
      const query = '  large café\n"needle"  ';
      const text = 'distant-prefix ' + 'İ😀before '.repeat(2000) + 'first-context ' + query + ' nearby-first😀 ' + ' after😀'.repeat(2000) + ' second-context ' + query + ' distant-tail';
      await writeFile(file, jsonl({ type: 'session_meta', payload: { id, cwd: '/repo' } }) + jsonl({ type: 'event_msg', payload: { type: 'agent_message', message: text } }));
      const ripgrep = { run: async () => ({ exitCode: 0, stdout: file + '\0', stderr: '' }) };
      const page = await listCodexSessionCandidates({ source: { kind: 'codexHome', home: 'user', homePath: root }, env: {}, exec: {} as ExecService, searchTarget: 'content', searchTerm: query, ripgrep, limit: 1 });
      const snippet = page.candidates[0]?.match?.snippet;
      expect(snippet).toContain(query);
      expect(snippet).toContain('first-context');
      expect(snippet).toContain('nearby-first😀');
      expect(snippet).not.toMatch(/distant-prefix|second-context|distant-tail/);
      expect(snippet?.length).toBeLessThan(1000);
      expect(snippet).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
      expect(page.candidates[0]?.match).toMatchObject({ sourceItemId: expect.stringMatching(/^codex:/), messageIndex: 0 });
      const maxSerializedBytes = 4096;
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: root } });
      const invocation = {
        source: { kind: 'codexHome', home: 'user', homePath: root }, maxItems: 1, searchTarget: 'content', searchTerm: query,
        signal: new AbortController().signal, deadlineAtMs: Date.now() + 30_000, maxSerializedBytes,
        ripgrep,
        // The app-server process is the real system boundary mocked above.
        exec: {} as ExecService,
      } as const;
      const result = await contribution.listCandidates(invocation);
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
      expect(result.value.candidates).toHaveLength(1);
      expect(result.value.candidates[0]?.match?.snippet).toContain(query);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(maxSerializedBytes);
      expect(result.value.contentCoverage).toBe('complete');
      const packedSnippet = result.value.candidates[0]?.match?.snippet;
      if (typeof packedSnippet !== 'string') throw new Error('Expected a decoded hit.');
      const narrowerBytes = Buffer.byteLength(JSON.stringify(result)) - Buffer.byteLength(JSON.stringify(packedSnippet)) + Buffer.byteLength(JSON.stringify(query)) + 64;
      const narrower = await contribution.listCandidates({ ...invocation, maxSerializedBytes: narrowerBytes });
      if (!narrower.ok) throw new Error(`${narrower.code}: ${narrower.message}`);
      expect(narrower.value.candidates[0]?.match?.snippet).toContain(query);
      expect(narrower.value.candidates[0]?.match?.snippet).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
      expect(Buffer.byteLength(JSON.stringify(narrower))).toBeLessThanOrEqual(narrowerBytes);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

function jsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

afterEach(() => {
  vi.restoreAllMocks();
  appServerProbe.threads = [];
  appServerProbe.pages.clear();
  appServerProbe.calls = [];
  appServerProbe.failCursor = null;
  appServerProbe.loadedIds.clear();
  appServerProbe.transports = [];
  rolloutFsProbe.statPaths = [];
});

describe('Codex external-session candidate pagination', () => {
  it('drains a mixed app-server and rollout corpus exactly once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-candidate-pagination-'));
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      await mkdir(sessionsDir, { recursive: true });

      // Six rollout-backed sessions, newest first by mtime.
      const rolloutIds: string[] = [];
      for (let index = 0; index < 6; index += 1) {
        const remoteSessionId = `${String(index).repeat(8)}-1111-1111-1111-111111111111`;
        rolloutIds.push(remoteSessionId);
        const filePath = join(sessionsDir, `rollout-2026-07-23T10-0${index}-00-${remoteSessionId}.jsonl`);
        await writeFile(
          filePath,
          jsonl({
            type: 'session_meta',
            timestamp: '2026-07-23T10:00:00.000Z',
            payload: { id: remoteSessionId, timestamp: '2026-07-23T10:00:00.000Z', cwd: '/repo' },
          }),
          'utf8',
        );
        // Newest rollout first: index 0 is the most recently updated.
        const mtime = new Date(Date.parse('2026-07-23T12:00:00.000Z') - index * 60_000);
        await utimes(filePath, mtime, mtime);
      }

      // Two app-server threads that interleave with the rollout ordering.
      appServerProbe.threads = [
        { id: 'app-server-newest', updatedAt: Date.parse('2026-07-23T13:00:00.000Z') / 1000, cwd: '/repo' },
        { id: 'app-server-oldest', updatedAt: Date.parse('2026-07-23T11:00:00.000Z') / 1000, cwd: '/repo' },
      ];
      appServerProbe.loadedIds.add('app-server-newest');

      const request = {
        source: { kind: 'codexHome', home: 'user' },
        activeServerDir: join(root, 'active-server'),
        env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
        exec: {
          systemTools: { resolve: async () => ({ executable: { kind: 'path', path: '/usr/bin/codex' } }) },
        } as unknown as ExecService,
        limit: 2,
        searchMode: 'full',
        // The merged native+rollout ordering is the searched browse owner; an
        // unsearched browse selects the bounded chunk/preparation mode.
        searchTerm: '/repo',
      } as const;

      const drained: string[] = [];
      let daemonDescriptor: unknown;
      const cursors: (string | null)[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 12; page += 1) {
        const result = await listCodexSessionCandidates({
          ...request,
          ...(cursor ? { cursor } : {}),
        });
        drained.push(...result.candidates.map((candidate) => candidate.remoteSessionId));
        daemonDescriptor ??= result.candidates.find(
          (candidate) => candidate.remoteSessionId === 'app-server-newest',
        )?.details?.runtimeDescriptorV1;
        cursors.push(result.nextCursor);
        if (!result.nextCursor) break;
        // A cursor that repeats itself is an infinite page loop, not progress.
        expect(cursors.filter((value) => value === result.nextCursor)).toHaveLength(1);
        cursor = result.nextCursor;
      }

      expect(cursors.at(-1)).toBeNull();
      expect(new Set(drained).size).toBe(drained.length);
      expect([...drained].sort()).toEqual(
        [...rolloutIds, 'app-server-newest', 'app-server-oldest'].sort(),
      );
      expect(appServerProbe.transports[0]).toEqual({ kind: 'daemonProxy' });
      expect(daemonDescriptor).toMatchObject({
        agent: { appServerTransport: 'daemonProxy' },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('keeps an identity that both halves report in one stable merged position while paging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-candidate-overlap-'));
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      await mkdir(sessionsDir, { recursive: true });

      // Six rollout sessions, newest first. The fourth one is ALSO an app-server
      // thread, and the app-server reports it as the newest session of all — the
      // real shape when a live thread has already flushed a rollout file.
      const rolloutIds: string[] = [];
      for (let index = 0; index < 6; index += 1) {
        const remoteSessionId = `${String(index + 1).repeat(8)}-1111-1111-1111-111111111111`;
        rolloutIds.push(remoteSessionId);
        const filePath = join(sessionsDir, `rollout-2026-07-23T10-0${index}-00-${remoteSessionId}.jsonl`);
        await writeFile(
          filePath,
          jsonl({
            type: 'session_meta',
            timestamp: '2026-07-23T10:00:00.000Z',
            payload: { id: remoteSessionId, timestamp: '2026-07-23T10:00:00.000Z', cwd: '/repo' },
          }),
          'utf8',
        );
        const mtime = new Date(Date.parse('2026-07-23T12:00:00.000Z') - index * 3_600_000);
        await utimes(filePath, mtime, mtime);
      }
      const overlappingId = rolloutIds[3]!;

      appServerProbe.threads = [
        { id: overlappingId, updatedAt: Date.parse('2026-07-23T12:30:00.000Z') / 1000, cwd: '/repo' },
      ];

      const request = {
        source: { kind: 'codexHome', home: 'user' },
        activeServerDir: join(root, 'active-server'),
        env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
        exec: {
          systemTools: { resolve: async () => ({ executable: { kind: 'path', path: '/usr/bin/codex' } }) },
        } as unknown as ExecService,
        limit: 2,
        searchMode: 'full',
        searchTerm: '/repo',
      } as const;

      const drained: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 12; page += 1) {
        const result = await listCodexSessionCandidates({
          ...request,
          ...(cursor ? { cursor } : {}),
        });
        drained.push(...result.candidates.map((candidate) => candidate.remoteSessionId));
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }

      // The overlapping identity must be served exactly once (a prefix-depth
      // change must not move it across the cursor)...
      expect(drained.filter((id) => id === overlappingId)).toHaveLength(1);
      // ...and displacing it must not push a neighbour behind the cursor.
      expect([...drained].sort()).toEqual([...rolloutIds].sort());

      // The complete half owns the merged row for an identity both halves
      // report, so its runtime descriptor survives into link data.
      const first = await listCodexSessionCandidates(request);
      const overlapping = first.candidates.find((c) => c.remoteSessionId === overlappingId);
      expect(overlapping?.details?.codexBackendMode).toBe('appServer');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('serves every identity once when an overlapping app-server row sorts older than its rollout row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-candidate-overlap-older-'));
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      await mkdir(sessionsDir, { recursive: true });

      // Six rollout sessions, newest first by mtime (12:00 down to 07:00).
      const rolloutIds: string[] = [];
      for (let index = 0; index < 6; index += 1) {
        const remoteSessionId = `${String(index + 1).repeat(8)}-1111-1111-1111-111111111111`;
        rolloutIds.push(remoteSessionId);
        const filePath = join(sessionsDir, `rollout-2026-07-23T10-0${index}-00-${remoteSessionId}.jsonl`);
        await writeFile(
          filePath,
          jsonl({
            type: 'session_meta',
            timestamp: '2026-07-23T10:00:00.000Z',
            payload: { id: remoteSessionId, timestamp: '2026-07-23T10:00:00.000Z', cwd: '/repo' },
          }),
          'utf8',
        );
        const mtime = new Date(Date.parse('2026-07-23T12:00:00.000Z') - index * 3_600_000);
        await utimes(filePath, mtime, mtime);
      }
      // The second-newest rollout is also a live app-server thread whose recorded
      // `updatedAt` is OLDER than every rollout mtime — the real shape when the
      // rollout file is touched after the thread record was last written. The
      // app-server row wins the merge, so this identity's ordering key drops to
      // the bottom of whatever rollout prefix the page happens to have read.
      const overlappingId = rolloutIds[1]!;
      appServerProbe.threads = [
        { id: overlappingId, updatedAt: Date.parse('2026-07-23T06:00:00.000Z') / 1000, cwd: '/repo' },
      ];

      const request = {
        source: { kind: 'codexHome', home: 'user' },
        activeServerDir: join(root, 'active-server'),
        env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
        exec: {
          systemTools: { resolve: async () => ({ executable: { kind: 'path', path: '/usr/bin/codex' } }) },
        } as unknown as ExecService,
        limit: 2,
        searchMode: 'full',
        searchTerm: '/repo',
      } as const;

      const drained: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 12; page += 1) {
        const result = await listCodexSessionCandidates({
          ...request,
          ...(cursor ? { cursor } : {}),
        });
        drained.push(...result.candidates.map((candidate) => candidate.remoteSessionId));
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }

      // Direction 1: no identity is served twice.
      expect(drained.filter((id) => id === overlappingId)).toHaveLength(1);
      expect(new Set(drained).size).toBe(drained.length);
      // Direction 2: nothing the displaced row shifted past is omitted.
      expect([...drained].sort()).toEqual([...rolloutIds].sort());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('bounds full native listing, then resumes both archived and unarchived cursors on the next page', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-native-cursor-page-'));
    try {
      const codexHome = join(root, 'codex-home');
      await mkdir(codexHome, { recursive: true });
      const timestamp = Date.parse('2026-08-25T12:00:00.000Z') / 1000;
      appServerProbe.pages.set('active:', {
        data: [{ id: 'active-one', updatedAt: timestamp + 4, cwd: '/repo/active-one' }],
        nextCursor: 'active-next',
      });
      appServerProbe.pages.set('archived:', {
        data: [{ id: 'archived-one', updatedAt: timestamp + 3, cwd: '/repo/archived-one' }],
        nextCursor: 'archived-next',
      });
      appServerProbe.pages.set('active:active-next', {
        data: [{ id: 'active-two', updatedAt: timestamp + 2, cwd: '/repo/active-two' }],
        nextCursor: null,
      });
      appServerProbe.pages.set('archived:archived-next', {
        data: [{ id: 'archived-two', updatedAt: timestamp + 1, cwd: '/repo/archived-two' }],
        nextCursor: null,
      });
      const request = {
        source: { kind: 'codexHome', home: 'user' },
        activeServerDir: join(root, 'active-server'),
        env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
        exec: {
          systemTools: { resolve: async () => ({ executable: { kind: 'path', path: '/usr/bin/codex' } }) },
        } as unknown as ExecService,
        limit: 10,
        searchMode: 'full' as const,
        searchTerm: '/repo',
      };

      const first = await listCodexSessionCandidates(request);

      expect(appServerProbe.calls).toHaveLength(2);
      expect(appServerProbe.calls).toEqual(expect.arrayContaining([
        { archived: false, cursor: null },
        { archived: true, cursor: null },
      ]));
      expect(first.nextCursor).toEqual(expect.any(String));
      expect(first.candidates.map((candidate) => candidate.remoteSessionId).sort()).toEqual([
        'active-one',
        'archived-one',
      ]);

      const second = await listCodexSessionCandidates({
        ...request,
        cursor: first.nextCursor ?? undefined,
      });

      expect(appServerProbe.calls).toHaveLength(4);
      expect(appServerProbe.calls.slice(2)).toEqual(expect.arrayContaining([
        { archived: false, cursor: 'active-next' },
        { archived: true, cursor: 'archived-next' },
      ]));
      expect(second.candidates.map((candidate) => candidate.remoteSessionId).sort()).toEqual([
        'active-two',
        'archived-two',
      ]);
      expect(second.nextCursor).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('holds a rollout row behind the native frontier until a later native page resolves its ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-native-frontier-'));
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '08', '25');
      await mkdir(sessionsDir, { recursive: true });
      const overlappingId = '77777777-7777-7777-7777-777777777777';
      const nativeOwnedId = '88888888-8888-8888-8888-888888888888';
      const rolloutPath = join(
        sessionsDir,
        `rollout-2026-08-25T10-00-00-${overlappingId}.jsonl`,
      );
      await writeFile(rolloutPath, jsonl({
        type: 'session_meta',
        timestamp: '2026-08-25T10:00:00.000Z',
        payload: { id: overlappingId, timestamp: '2026-08-25T10:00:00.000Z', cwd: '/repo' },
      }), 'utf8');
      const rolloutUpdatedAt = new Date('2026-08-25T10:00:00.000Z');
      await utimes(rolloutPath, rolloutUpdatedAt, rolloutUpdatedAt);
      const nativeOwnedRolloutPath = join(
        sessionsDir,
        `rollout-2026-08-25T08-00-00-${nativeOwnedId}.jsonl`,
      );
      await writeFile(nativeOwnedRolloutPath, jsonl({
        type: 'session_meta',
        timestamp: '2026-08-25T08:00:00.000Z',
        payload: { id: nativeOwnedId, timestamp: '2026-08-25T08:00:00.000Z', cwd: '/repo' },
      }), 'utf8');
      const nativeOwnedRolloutUpdatedAt = new Date('2026-08-25T08:00:00.000Z');
      await utimes(nativeOwnedRolloutPath, nativeOwnedRolloutUpdatedAt, nativeOwnedRolloutUpdatedAt);

      appServerProbe.pages.set('active:', {
        data: [{ id: 'native-newer', updatedAt: Date.parse('2026-08-25T12:00:00.000Z') / 1000, cwd: '/repo' }],
        nextCursor: 'active-later',
      });
      // This later native row names the already-visible rollout identity but is
      // older than the rollout. A bounded listing must not emit the rollout on
      // page one and then emit this native duplicate on page two.
      appServerProbe.pages.set('active:active-later', {
        data: [
          { id: nativeOwnedId, updatedAt: Date.parse('2026-08-25T11:00:00.000Z') / 1000, cwd: '/repo' },
          { id: overlappingId, updatedAt: Date.parse('2026-08-25T09:00:00.000Z') / 1000, cwd: '/repo' },
        ],
        nextCursor: null,
      });
      const request = {
        source: { kind: 'codexHome', home: 'user' },
        activeServerDir: join(root, 'active-server'),
        env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
        exec: {
          systemTools: { resolve: async () => ({ executable: { kind: 'path', path: '/usr/bin/codex' } }) },
        } as unknown as ExecService,
        limit: 10,
        searchMode: 'full' as const,
        searchTerm: '/repo',
      };

      const first = await listCodexSessionCandidates(request);
      expect(first.candidates.map((candidate) => candidate.remoteSessionId)).toEqual(['native-newer']);
      expect(first.nextCursor).toEqual(expect.any(String));

      const second = await listCodexSessionCandidates({
        ...request,
        cursor: first.nextCursor ?? undefined,
      });
      expect(second.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([
        nativeOwnedId,
        overlappingId,
      ]);
      expect(second.candidates[0]?.details?.codexBackendMode).toBe('appServer');
      expect(second.nextCursor).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('rejects a repeated native continuation without issuing it a third time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-native-cursor-repeat-'));
    try {
      const codexHome = join(root, 'codex-home');
      await mkdir(codexHome, { recursive: true });
      appServerProbe.pages.set('active:', {
        data: [{ id: 'repeat-thread', updatedAt: Date.now() / 1000 }],
        nextCursor: 'repeat-native-cursor',
      });
      appServerProbe.pages.set('active:repeat-native-cursor', {
        data: [],
        nextCursor: 'repeat-native-cursor',
      });

      const first = await listCodexSessionCandidates({
        source: { kind: 'codexHome', home: 'user' },
        activeServerDir: join(root, 'active-server'),
        env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
        exec: {
          systemTools: { resolve: async () => ({ executable: { kind: 'path', path: '/usr/bin/codex' } }) },
        } as unknown as ExecService,
        limit: 10,
        searchMode: 'full',
        searchTerm: 'repeat-thread',
      });
      expect(first.nextCursor).toEqual(expect.any(String));

      await expect(listCodexSessionCandidates({
        source: { kind: 'codexHome', home: 'user' },
        activeServerDir: join(root, 'active-server'),
        env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
        exec: {
          systemTools: { resolve: async () => ({ executable: { kind: 'path', path: '/usr/bin/codex' } }) },
        } as unknown as ExecService,
        limit: 10,
        searchMode: 'full',
        searchTerm: 'repeat-thread',
        cursor: first.nextCursor ?? undefined,
      })).rejects.toThrow(/candidate source changed/i);

      expect(appServerProbe.calls).toContainEqual({ archived: false, cursor: null });
      expect(appServerProbe.calls.filter((call) => (
        call.archived === false && call.cursor === 'repeat-native-cursor'
      ))).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('bounds one full-search request to the searched-window budget instead of walking the corpus', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-search-window-'));
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      await mkdir(sessionsDir, { recursive: true });

      // Six rollout sessions — more than the searched window this request is
      // allowed to consume.
      for (let index = 0; index < 6; index += 1) {
        const remoteSessionId = `${String(index).repeat(8)}-2222-2222-2222-222222222222`;
        const filePath = join(sessionsDir, `rollout-2026-07-23T11-0${index}-00-${remoteSessionId}.jsonl`);
        await writeFile(
          filePath,
          jsonl({
            type: 'session_meta',
            timestamp: '2026-07-23T11:00:00.000Z',
            payload: { id: remoteSessionId, timestamp: '2026-07-23T11:00:00.000Z', cwd: '/repo' },
          }),
          'utf8',
        );
        const mtime = new Date(Date.parse('2026-07-23T12:00:00.000Z') - index * 60_000);
        await utimes(filePath, mtime, mtime);
      }

      const result = await listCodexSessionCandidates({
        source: { kind: 'codexHome', home: 'user' },
        activeServerDir: join(root, 'active-server'),
        env: {
          CODEX_HOME: codexHome,
          HAPPIER_CODEX_EXTERNAL_SESSIONS_FULL_SEARCH_CANDIDATE_LIMIT: '2',
        } as NodeJS.ProcessEnv,
        exec: {
          systemTools: { resolve: async () => ({ executable: { kind: 'path', path: '/usr/bin/codex' } }) },
        } as unknown as ExecService,
        limit: 2,
        searchMode: 'full',
        searchTerm: '/repo',
      });

      // The page is still a correct merged page...
      expect(result.candidates).toHaveLength(2);
      expect(result.searchIncomplete).toBe(true);
      // ...but one request must consume only its searched-window budget of the
      // source: a whole-corpus walk stats every rollout file behind one
      // request, while the bounded chunk touches only the rows it serves
      // (consumption plus the per-row title read — two distinct files).
      expect(new Set(rolloutFsProbe.statPaths).size).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('advances a full search past the searched window without repeating or losing rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-search-continuation-'));
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      await mkdir(sessionsDir, { recursive: true });

      // Four rollout sessions, newest first by mtime. The searched-window
      // budget below (2) holds only half of them, so a correct second page can
      // only exist if continuation resumes the corpus scan past the first
      // window instead of restarting it from the corpus head.
      const rolloutIds: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        const remoteSessionId = `${String(index).repeat(8)}-3333-3333-3333-333333333333`;
        rolloutIds.push(remoteSessionId);
        const filePath = join(sessionsDir, `rollout-2026-07-23T10-0${index}-00-${remoteSessionId}.jsonl`);
        await writeFile(
          filePath,
          jsonl({
            type: 'session_meta',
            timestamp: '2026-07-23T10:00:00.000Z',
            payload: { id: remoteSessionId, timestamp: '2026-07-23T10:00:00.000Z', cwd: '/repo' },
          }),
          'utf8',
        );
        const mtime = new Date(Date.parse('2026-07-23T12:00:00.000Z') - index * 60_000);
        await utimes(filePath, mtime, mtime);
      }

      const request = {
        source: { kind: 'codexHome', home: 'user' },
        activeServerDir: join(root, 'active-server'),
        env: {
          CODEX_HOME: codexHome,
          HAPPIER_CODEX_EXTERNAL_SESSIONS_FULL_SEARCH_CANDIDATE_LIMIT: '2',
        } as NodeJS.ProcessEnv,
        exec: {
          systemTools: { resolve: async () => ({ executable: { kind: 'path', path: '/usr/bin/codex' } }) },
        } as unknown as ExecService,
        limit: 2,
        searchMode: 'full',
        searchTerm: '/repo',
      } as const;

      const first = await listCodexSessionCandidates(request);
      expect(first.candidates.map((candidate) => candidate.remoteSessionId).sort())
        .toEqual([rolloutIds[2], rolloutIds[3]].sort());
      expect(first.searchIncomplete).toBe(true);
      // The window was not the corpus, so the search must stay continuable.
      expect(first.nextCursor).toEqual(expect.any(String));

      const second = await listCodexSessionCandidates({
        ...request,
        cursor: first.nextCursor ?? undefined,
      });

      // Continuation serves the rows past the first window — never page one's
      // rows again, and none of the corpus behind the window is skipped.
      expect(second.candidates.map((candidate) => candidate.remoteSessionId).sort())
        .toEqual([rolloutIds[0], rolloutIds[1]].sort());
      expect(second.nextCursor).toBeNull();
      // The corpus is fully covered, so the final page is not incomplete.
      expect(second.searchIncomplete).toBeUndefined();
      // Native streams that reached a terminal state on page one are not
      // re-requested by continuation.
      expect(appServerProbe.calls).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
