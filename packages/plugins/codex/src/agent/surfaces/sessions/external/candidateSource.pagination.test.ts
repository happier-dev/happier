import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import { ExternalSessionCandidateV1Schema } from '@happier-dev/protocol/sessions/external/daemonRpcV1';

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
  onCreate: null as ((params: Readonly<{ transport?: unknown; signal?: AbortSignal }>) => void | Promise<void>) | null,
}));

const rolloutFsProbe = vi.hoisted(() => ({
  nativeProxyAvailable: true,
  statPaths: [] as string[],
  onStat: null as (() => void) | null,
  onOpen: null as ((filePath: unknown) => void) | null,
}));

// The Codex native app-server is a spawned provider process reached over JSON-RPC:
// a genuine system boundary. Everything below it — merge ordering, cursor
// arithmetic, rollout discovery — stays the real implementation.
vi.mock('../../../runtime/appServer/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../runtime/appServer/client.js')>();
  return {
    ...actual,
    createCodexNativeAppServerClient: async (params: Readonly<{ transport?: unknown; signal?: AbortSignal }>) => {
      appServerProbe.transports.push(params.transport);
      await appServerProbe.onCreate?.(params);
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
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      rolloutFsProbe.onOpen?.(args[0]);
      return handle;
    },
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const filePath = args[0];
      // Native RPC is a process boundary fixture; give it a matching socket
      // presence without requiring a vendor server on the test machine.
      if (String(filePath).endsWith(join('app-server-control', 'app-server-control.sock')) && rolloutFsProbe.nativeProxyAvailable) {
        return actual.stat(tmpdir());
      }
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
  it('reports native history unavailable without starting a vendor server when its proxy is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-content-native-caller-budget-'));
    const controller = new AbortController();
    try {
      const startedAtMs = Date.now();
      rolloutFsProbe.nativeProxyAvailable = false;
      appServerProbe.threads = [{ id: 'native-only', updatedAt: 2_000_000_000 }];
      appServerProbe.onCreate = async () => { throw new Error('App-server proxy socket is absent'); };
      const source = { kind: 'codexHome' as const, home: 'user' as const, homePath: root };
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: root } });
      const result = await contribution.listCandidates({
        source, searchMode: 'full', searchTerm: 'native', maxItems: 10,
        searchTarget: 'content', deadlineAtMs: startedAtMs + 30_000,
        maxSerializedBytes: 1024 * 1024, exec: {} as ExecService,
        ripgrep: { run: async () => { throw new Error('An empty rollout corpus needs no ripgrep process'); } },
        signal: controller.signal,
      });
      expect(appServerProbe.transports).toEqual([]);
      expect(result).toMatchObject({ ok: false, code: 'agent_unavailable', retryable: true });
      expect(appServerProbe.calls).toEqual([]);
    } finally {
      rolloutFsProbe.nativeProxyAvailable = true;
      controller.abort();
      appServerProbe.onCreate = null;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('shares canonical root-family discovery across the content page so every hit fits the host deadline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-content-family-work-'));
    try {
      const sessions = join(root, 'sessions', '2026', '07', '23');
      await mkdir(sessions, { recursive: true });
      const ids = Array.from({ length: 12 }, (_, index) => `aaaaaaaa-1111-1111-1111-${String(index).padStart(12, '0')}`);
      const unrelated = new Set<string>();
      await Promise.all(ids.map(async (id, index) => {
        const path = join(sessions, `rollout-2026-07-23T10-00-${String(index).padStart(2, '0')}-${id}.jsonl`);
        if (index < 10) unrelated.add(path);
        await writeFile(path, [
          { type: 'session_meta', payload: { id, cwd: '/repo' } },
          { type: 'event_msg', payload: { type: 'agent_message', message: 'family inventory needle' } },
        ].map((row) => JSON.stringify(row)).join('\n') + '\n');
        await utimes(path, new Date(1000 + index), new Date(1000 + index));
      }));
      let nowMs = 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
      // Opening unrelated metadata is genuine discovery cost. Repeating the
      // whole home for the second hit exhausts this same invocation budget.
      rolloutFsProbe.onOpen = (path) => { if (typeof path === 'string' && unrelated.has(path)) nowMs += 1000; };
      const deadlineAtMs = nowMs + 15000;
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: root } });
      const result = await contribution.listCandidates({
        source: { kind: 'codexHome', home: 'user', homePath: root },
        searchTarget: 'content', searchTerm: 'family inventory needle', maxItems: 2,
        signal: new AbortController().signal, deadlineAtMs, exec: {} as ExecService,
        ripgrep: { run: async ({ paths }) => ({ stdout: paths.join('\0') + '\0', stderr: '', exitCode: 0 }) },
      });
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
      expect(result.value.candidates.map((candidate) => candidate.remoteSessionId).sort()).toEqual([ids[10], ids[11]]);
      expect(result.value.candidates.every((candidate) => candidate.match?.snippet === 'family inventory needle')).toBe(true);
      expect(nowMs).toBeLessThan(deadlineAtMs);
      expect(result.value.nextCursor).toEqual(expect.any(String));
    } finally {
      rolloutFsProbe.onOpen = null;
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns a title-search window within the requested page work budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-search-page-work-'));
    try {
      const sessions = join(root, 'sessions', '2026', '07', '23');
      await mkdir(sessions, { recursive: true });
      const ids = Array.from({ length: 12 }, (_, index) => `aaaaaaaa-1111-1111-1111-${String(index).padStart(12, '0')}`);
      await Promise.all(ids.map(async (id, index) => {
        const path = join(sessions, `rollout-2026-07-23T10-00-${String(index).padStart(2, '0')}-${id}.jsonl`);
        await writeFile(path, [
          { type: 'session_meta', payload: { id, cwd: '/repo' } },
          { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `searched window needle ${index}` }] } },
        ].map((row) => JSON.stringify(row)).join('\n') + '\n');
      }));
      let nowMs = 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
      // The filesystem clock models expensive title heads. Discovery of rows
      // outside the requested page must not consume the host invocation.
      rolloutFsProbe.onOpen = () => { nowMs += 50; };
      const deadlineAtMs = nowMs + 1000;
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: root } });
      const result = await contribution.listCandidates({
        source: { kind: 'codexHome', home: 'user', homePath: root },
        searchTerm: 'searched window needle', searchMode: 'fast', maxItems: 2,
        signal: new AbortController().signal, deadlineAtMs, exec: {} as ExecService,
        ripgrep: { run: async () => ({ stdout: '', stderr: '', exitCode: 1 }) },
      });
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
      expect(nowMs).toBeLessThan(deadlineAtMs);
      expect(result.value.nextCursor).toEqual(expect.any(String));
      expect(result.value.candidates).toHaveLength(2);
    } finally {
      rolloutFsProbe.onOpen = null;
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('yields during first-page discovery and resumes the unfinished source within the host budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-content-discovery-deadline-'));
    try {
      const sessions = join(root, 'sessions', '2026', '07', '23');
      await mkdir(sessions, { recursive: true });
      const id = 'ffffffff-1111-1111-1111-111111111111';
      await writeFile(join(sessions, `rollout-2026-07-23T10-00-00-${id}.jsonl`), [
        { type: 'session_meta', payload: { id, cwd: '/repo' } },
        ...Array.from({ length: 1500 }, (_, index) => ({ type: 'event_msg', payload: {
          type: 'agent_message', message: index === 1499 ? 'First discovery deadline needle' : `ordinary ${index} `.repeat(40),
        } })),
      ].map((row) => JSON.stringify(row)).join('\n') + '\n');
      appServerProbe.threads = [];
      let nowMs = 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
      rolloutFsProbe.onOpen = () => { nowMs += 3000; };
      const ripgrep = { run: async ({ args, paths, signal }: { args: readonly string[]; paths: readonly string[]; signal?: AbortSignal }) => {
        const launcher = fileURLToPath(new URL('../../../../../../../../apps/cli/scripts/ripgrep_launcher.cjs', import.meta.url));
        const result = await promisify(execFile)(process.execPath, [launcher, JSON.stringify([...args, '--', ...paths])], { signal });
        return { ...result, exitCode: 0 };
      } };
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: root } });
      const request = {
        source: { kind: 'codexHome' as const, home: 'user' as const, homePath: root },
        searchTarget: 'content' as const, searchTerm: 'First discovery deadline needle', maxItems: 1,
        maxSerializedBytes: 1024 * 1024, exec: {} as ExecService, ripgrep, signal: new AbortController().signal,
      };
      const deadlineAtMs = nowMs + 15000;
      // The caller supplies separate cooperative and hard deadlines. NI27 no
      // longer predicts an earlier yield from a previous 3s filesystem step.
      const first = await contribution.listCandidates({ ...request, deadlineAtMs, scanDeadlineAtMs: deadlineAtMs - 3000 });
      expect(first).toMatchObject({ ok: true });
      if (!first.ok) throw new Error(`${first.code}: ${first.message}`);
      expect(nowMs).toBeLessThan(deadlineAtMs);
      expect(first.value).toMatchObject({ candidates: [], contentCoverage: 'partial', nextCursor: expect.any(String) });
      rolloutFsProbe.onOpen = null;
      const next = await contribution.listCandidates({ ...request, deadlineAtMs: nowMs + 15000, cursor: first.value.nextCursor! });
      if (!next.ok) throw new Error(`${next.code}: ${next.message}`);
      expect(next.value.candidates[0]?.match).toMatchObject({ snippet: 'First discovery deadline needle', messageIndex: 1499 });
      expect(next.value.contentCoverage).toBe('complete');
      expect(next.value.nextCursor).toBeNull();
    } finally {
      rolloutFsProbe.onOpen = null;
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each([false, true])('resumes root-family preparation without re-opening its completed prefix (nested=%s)', async (nested) => {
    const root = await mkdtemp(join(tmpdir(), 'codex-content-family-resume-'));
    try {
      const day = join(root, 'sessions', '2026', '07', '23');
      await mkdir(day, { recursive: true });
      const target = 'ffffffff-1111-1111-1111-111111111111';
      const unrelated = new Set<string>();
      for (let index = 0; index < 12; index += 1) {
        const directory = nested ? join(day, index < 6 ? 'a' : 'a.jsonl') : day;
        await mkdir(directory, { recursive: true });
        const path = join(directory, `rollout-2026-07-23T00-00-${String(index).padStart(2, '0')}-aaaaaaaa-1111-1111-1111-${String(index).padStart(12, '0')}.jsonl`);
        unrelated.add(path);
        await writeFile(path, JSON.stringify({ type: 'session_meta', payload: { id: `unrelated-${index}` } }) + '\n');
      }
      await writeFile(join(day, `rollout-2026-07-23T23-00-00-${target}.jsonl`), [
        { type: 'session_meta', payload: { id: target } },
        { type: 'event_msg', payload: { type: 'agent_message', message: 'harbor family resume' } },
      ].map(row => JSON.stringify(row)).join('\n') + '\n');
      let nowMs = 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
      const opens = new Map<string, number>();
      rolloutFsProbe.onOpen = path => {
        if (typeof path !== 'string' || !unrelated.has(path)) return;
        opens.set(path, (opens.get(path) ?? 0) + 1);
        nowMs += 1000;
      };
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: root } });
      let cursor: string | undefined;
      let hit: string | undefined;
      for (let page = 0; page < unrelated.size + 1 && !hit; page += 1) {
        const deadlineAtMs = nowMs + 5000;
        const result = await contribution.listCandidates({
          source: { kind: 'codexHome', home: 'user', homePath: root },
          searchTarget: 'content', searchTerm: 'harbor', maxItems: 1,
          maxSerializedBytes: 1024 * 1024, exec: {} as ExecService,
          signal: new AbortController().signal, deadlineAtMs, scanDeadlineAtMs: deadlineAtMs - 1000, cursor,
          ripgrep: { run: async ({ paths }) => ({ stdout: paths.join('\0') + '\0', stderr: '', exitCode: 0 }) },
        });
        if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
        expect(nowMs).toBeLessThan(deadlineAtMs);
        hit = result.value.candidates[0]?.remoteSessionId;
        if (!hit) {
          expect(result.value.contentCoverage).toBe('partial');
          expect(result.value.nextCursor).toBeTruthy();
          expect(result.value.nextCursor).not.toBe(cursor);
          cursor = result.value.nextCursor!;
        }
      }
      expect(hit).toBe(target);
      expect([...opens.values()]).toEqual(Array.from({ length: unrelated.size }, () => 1));
    } finally {
      rolloutFsProbe.onOpen = null;
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects replacement of a retained root-family member before returning a resumed hit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-content-family-replacement-'));
    try {
      const day = join(root, 'sessions', '2026', '07', '23');
      await mkdir(day, { recursive: true });
      const target = 'ffffffff-1111-1111-1111-111111111111';
      const childDirectory = join(day, 'a');
      await mkdir(childDirectory);
      const childPath = join(childDirectory, 'rollout-child.jsonl');
      const childText = JSON.stringify({ type: 'session_meta', payload: { id: 'child', session_id: target } }) + '\n';
      await writeFile(childPath, childText);
      await writeFile(join(day, `rollout-2026-07-23T23-00-00-${target}.jsonl`), [
        { type: 'session_meta', payload: { id: target } },
        { type: 'event_msg', payload: { type: 'agent_message', message: 'harbor replacement' } },
      ].map(row => JSON.stringify(row)).join('\n') + '\n');
      const slowPath = join(childDirectory, 'rollout-unrelated.jsonl');
      await writeFile(slowPath, JSON.stringify({ type: 'session_meta', payload: { id: 'unrelated' } }) + '\n');
      let nowMs = 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
      rolloutFsProbe.onOpen = path => { if (path === slowPath) nowMs += 3000; };
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: root } });
      const request = { source: { kind: 'codexHome' as const, home: 'user' as const, homePath: root },
        searchTarget: 'content' as const, searchTerm: 'harbor', maxItems: 1,
        maxSerializedBytes: 1024 * 1024, exec: {} as ExecService, signal: new AbortController().signal,
        ripgrep: { run: async ({ paths }: { paths: readonly string[] }) => ({ stdout: paths.join('\0') + '\0', stderr: '', exitCode: 0 }) } };
      const first = await contribution.listCandidates({ ...request, deadlineAtMs: nowMs + 5000, scanDeadlineAtMs: nowMs + 3000 });
      if (!first.ok) throw new Error(`${first.code}: ${first.message}`);
      expect(first.value).toMatchObject({ candidates: [], nextCursor: expect.any(String), contentCoverage: 'partial' });
      await rename(childPath, `${childPath}.old`);
      await writeFile(childPath, childText);
      rolloutFsProbe.onOpen = null;
      const resumed = await contribution.listCandidates({ ...request, cursor: first.value.nextCursor!, deadlineAtMs: nowMs + 5000 });
      expect(resumed).toMatchObject({ ok: false, code: 'source_invalid' });
    } finally {
      rolloutFsProbe.onOpen = null;
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('finishes content continuation while the active day gains a newer rollout between every page', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-content-live-day-'));
    try {
      const dayDir = join(root, 'sessions', '2026', '07', '23');
      await mkdir(dayDir, { recursive: true });
      const writeRollout = async (hour: string, id: string) => {
        await writeFile(join(dayDir, `rollout-2026-07-23T${hour}-00-00-${id}.jsonl`), [
          { type: 'session_meta', payload: { id, cwd: '/repo' } },
          { type: 'event_msg', payload: { type: 'agent_message', message: 'harbor continuation needle' } },
        ].map((row) => JSON.stringify(row)).join('\n') + '\n');
      };
      const ids = [
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        '33333333-3333-3333-3333-333333333333',
      ];
      for (const [index, id] of ids.entries()) await writeRollout(`0${index + 7}`, id);
      appServerProbe.threads = [];
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: root } });
      const request = {
        source: { kind: 'codexHome' as const, home: 'user' as const, homePath: root },
        searchTarget: 'content' as const, searchTerm: 'harbor', maxItems: 1,
        maxSerializedBytes: 1024 * 1024, exec: {} as ExecService,
        ripgrep: { run: async ({ args, paths, signal }: { args: readonly string[]; paths: readonly string[]; signal?: AbortSignal }) => {
          const launcher = fileURLToPath(new URL('../../../../../../../../apps/cli/scripts/ripgrep_launcher.cjs', import.meta.url));
          const result = await promisify(execFile)(process.execPath, [launcher, JSON.stringify([...args, '--', ...paths])], { signal });
          return { ...result, exitCode: 0 };
        } },
        signal: new AbortController().signal,
      };
      const observed: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < ids.length; page += 1) {
        const result = await contribution.listCandidates({ ...request, deadlineAtMs: Date.now() + 30_000,
          ...(cursor ? { cursor } : {}) });
        if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
        expect(result.value.candidates).toHaveLength(1);
        expect(result.value.candidates[0]?.match?.snippet).toBe('harbor continuation needle');
        observed.push(...result.value.candidates.map(({ remoteSessionId }) => remoteSessionId));
        if (page < ids.length - 1) {
          expect(result.value.nextCursor).toBeTruthy();
          expect(result.value.nextCursor).not.toBe(cursor);
          cursor = result.value.nextCursor!;
          await writeRollout(`${10 + page}`, `aaaaaaaa-1111-1111-1111-${String(page).padStart(12, '0')}`);
          await utimes(dayDir, new Date(`2026-07-${24 + page}`), new Date(`2026-07-${24 + page}`));
        } else {
          expect(result.value.nextCursor).toBeNull();
          expect(result.value.contentCoverage).toBe('complete');
        }
      }
      expect(observed).toEqual([...ids].reverse());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resumes both native sources after preparation consumes the first page budget', async () => {
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
      const first = await contribution.listCandidates({ ...request, deadlineAtMs, scanDeadlineAtMs: deadlineAtMs - 2500 });
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
  it.each([false, true])('reports a retryable native failure instead of an unchanged cursor with nonempty rollout=%s', async (withRollout) => {
    const root = await mkdtemp(join(tmpdir(), 'codex-content-native-unavailable-'));
    try {
      const id = 'eeeeeeee-1111-1111-1111-111111111111';
      if (withRollout) {
        const sessions = join(root, 'sessions', '2026', '07', '23');
        await mkdir(sessions, { recursive: true });
        await writeFile(join(sessions, `rollout-2026-07-23T10-00-00-${id}.jsonl`), [
          { type: 'session_meta', payload: { id } },
          { type: 'event_msg', payload: { type: 'agent_message', message: 'native budget needle' } },
        ].map((record) => JSON.stringify(record)).join('\n') + '\n');
      }
      appServerProbe.threads = [];
      appServerProbe.onCreate = () => { throw new Error('Native provider is unavailable'); };
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: root } });
      const request = { source: { kind: 'codexHome' as const, home: 'user' as const, homePath: root },
        searchTarget: 'content' as const, searchTerm: 'native budget needle', maxItems: 1,
        maxSerializedBytes: 1024 * 1024, exec: {} as ExecService,
        ripgrep: { run: async ({ paths }: { paths: readonly string[] }) => ({ stdout: `${paths.join('\0')}\0`, stderr: '', exitCode: 0 }) },
        signal: new AbortController().signal, deadlineAtMs: Date.now() + 30_000 };
      let cursor: string | undefined;
      const hits: string[] = [];
      let failure: Awaited<ReturnType<typeof contribution.listCandidates>> | undefined;
      for (let page = 0; page < 3; page += 1) {
        const result = await contribution.listCandidates({ ...request, ...(cursor ? { cursor } : {}) });
        if (!result.ok) { failure = result; break; }
        hits.push(...result.value.candidates.map(candidate => candidate.remoteSessionId));
        expect(result.value.contentCoverage).toBe('partial');
        expect(result.value.nextCursor).toBeTruthy();
        expect(result.value.nextCursor).not.toBe(cursor);
        cursor = result.value.nextCursor!;
      }
      expect(failure).toMatchObject({ ok: false, code: 'agent_unavailable', retryable: true });
      expect(hits).toEqual(withRollout ? [id] : []);
      appServerProbe.onCreate = null;
      const recovered = await contribution.listCandidates({ ...request, ...(cursor ? { cursor } : {}) });
      if (!recovered.ok) throw new Error(`${recovered.code}: ${recovered.message}`);
      const candidates = recovered.value.candidates.map((candidate) => ExternalSessionCandidateV1Schema.parse({
        ...candidate, agentId: 'codex', source: request.source,
      }));
      // Recovery resumes the unserved native stream, without replaying the
      // rollout hit that survived its earlier failure.
      expect(candidates).toEqual([]);
      expect(recovered.value).toMatchObject({ nextCursor: null, contentCoverage: 'complete' });
    } finally {
      appServerProbe.onCreate = null;
      await rm(root, { recursive: true, force: true });
    }
  });
  it('finishes remaining rollout hits when already-completed native streams become unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-content-native-complete-'));
    try {
      const sessions = join(root, 'sessions', '2026', '07', '23');
      await mkdir(sessions, { recursive: true });
      const ids = ['eeeeeeee-1111-1111-1111-111111111111', 'ffffffff-1111-1111-1111-111111111111'];
      await Promise.all(ids.map((id, index) => writeFile(join(sessions, `rollout-2026-07-23T10-00-0${index}-${id}.jsonl`), [
        { type: 'session_meta', payload: { id } },
        { type: 'event_msg', payload: { type: 'agent_message', message: 'native complete needle' } },
      ].map((record) => JSON.stringify(record)).join('\n') + '\n')));
      appServerProbe.threads = [];
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: root } });
      const request = { source: { kind: 'codexHome' as const, home: 'user' as const, homePath: root },
        searchTarget: 'content' as const, searchTerm: 'native complete needle', maxItems: 1,
        maxSerializedBytes: 1024 * 1024, exec: {} as ExecService,
        ripgrep: { run: async ({ paths }: { paths: readonly string[] }) => ({ stdout: `${paths.join('\0')}\0`, stderr: '', exitCode: 0 }) },
        signal: new AbortController().signal, deadlineAtMs: Date.now() + 30_000 };
      const first = await contribution.listCandidates(request);
      if (!first.ok || !first.value.nextCursor) throw new Error('Expected the first rollout hit and continuation');
      appServerProbe.onCreate = () => { throw new Error('Native provider is unavailable'); };
      const second = await contribution.listCandidates({ ...request, cursor: first.value.nextCursor });
      if (!second.ok) throw new Error(`${second.code}: ${second.message}`);
      const candidates = [...first.value.candidates, ...second.value.candidates].map((candidate) => ExternalSessionCandidateV1Schema.parse({
        ...candidate, agentId: 'codex', source: request.source,
      }));
      expect(candidates.map((candidate) => candidate.remoteSessionId)).toEqual([...ids].reverse());
      expect(second.value).toMatchObject({ nextCursor: null, contentCoverage: 'complete' });
    } finally {
      appServerProbe.onCreate = null;
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each([false, true])('returns completed content hits and resumes remaining rollouts once (cheaper later rows=%s)', async (cheaperLaterRows) => {
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
        nowMs += cheaperLaterRows && searchedPaths.length > 1 ? 1000 : 8000;
        return { ...result, exitCode: 0 };
      } };
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: root } });
      const found: string[] = [];
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex <= ids.length; pageIndex += 1) {
        const deadlineAtMs = nowMs + 15000;
        const page = await contribution.listCandidates({
          source: { kind: 'codexHome', home: 'user', homePath: root },
          searchTarget: 'content', searchTerm: 'deadline needle', maxItems: 10,
          maxSerializedBytes: 1024 * 1024, exec: {} as ExecService, ripgrep,
          signal: new AbortController().signal, deadlineAtMs,
          scanDeadlineAtMs: cheaperLaterRows ? deadlineAtMs : deadlineAtMs - 7000, cursor,
        });
        if (!page.ok) throw new Error(`${page.code}: ${page.message}`);
        expect(nowMs).toBeLessThan(deadlineAtMs);
        // At the exact cooperative deadline the native phase commits its
        // continuation; decoding that first hit resumes on the next page.
        expect(page.value.candidates).toHaveLength(cheaperLaterRows ? ids.length : pageIndex === 0 ? 0 : 1);
        for (const candidate of page.value.candidates) expect(candidate.match).toMatchObject({ messageIndex: 1000 });
        found.push(...page.value.candidates.map((candidate) => candidate.remoteSessionId));
        expect(page.value.contentCoverage).toBe(!cheaperLaterRows && pageIndex < ids.length ? 'partial' : 'complete');
        cursor = page.value.nextCursor ?? undefined;
        expect(Boolean(cursor)).toBe(!cheaperLaterRows && pageIndex < ids.length);
        if (cheaperLaterRows) break;
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
  it.each(['append', 'rewrite', 'replace'] as const)('keeps a captured native transcript searchable across %s with truthful coverage', async (change) => {
    const root = await mkdtemp(join(tmpdir(), 'codex-content-changing-native-'));
    try {
      const sessions = join(root, 'sessions', '2026', '07', '23');
      await mkdir(sessions, { recursive: true });
      const id = 'abababab-1111-1111-1111-111111111111';
      const file = join(sessions, `rollout-2026-07-23T10-00-00-${id}.jsonl`);
      const text = [
        { type: 'session_meta', payload: { id } },
        { type: 'event_msg', payload: { type: 'agent_message', message: 'harbor needle in the captured history' } },
      ].map(record => JSON.stringify(record)).join('\n') + '\n';
      await writeFile(file, text);
      appServerProbe.threads = [];
      let changed = false;
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: root } });
      const page = await contribution.listCandidates({
        source: { kind: 'codexHome', home: 'user', homePath: root },
        searchTarget: 'content', searchTerm: 'harbor needle', maxItems: 10,
        signal: new AbortController().signal, exec: {} as ExecService,
        ripgrep: { async run({ paths }) {
          if (!changed) {
            changed = true;
            if (change === 'append') await appendFile(file, JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'a newer native reply' } }) + '\n');
            else if (change === 'rewrite') await writeFile(file, text.replace('harbor needle', 'edited needle'));
            else { await rename(file, `${file}.old`); await writeFile(file, text); }
          }
          return { stdout: paths.join('\0') + '\0', stderr: '', exitCode: 0 };
        } },
      });
      if (change === 'append') {
        expect(page).toMatchObject({ ok: true, value: { candidates: [{ remoteSessionId: id,
          match: { snippet: 'harbor needle in the captured history', messageIndex: 0 } }], contentCoverage: 'partial' } });
      } else expect(page).toMatchObject({ ok: false, code: 'source_invalid' });
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
