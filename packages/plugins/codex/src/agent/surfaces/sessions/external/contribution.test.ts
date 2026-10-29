// Load the real Workflow schema owner before the contribution's cyclic SDK graph.
import '@happier-dev/protocol/workflows/workflowV1';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';

import type {
  ExecService,
  PluginProcessResult,
} from '@happier-dev/plugin-sdk/exec';
import type {
  PluginJsonRpcClient,
  PluginProtocolClientHandle,
} from '@happier-dev/plugin-sdk/exec/protocol-clients';

import { createCodexExternalSessionsContribution } from './contribution.js';
import { AgentExternalSessionTranscriptRawRecordSchema } from '@happier-dev/plugin-sdk/sessions/external';
import { ExternalSessionRefreshReadDiagnosticV1Schema } from '@happier-dev/protocol/sessions/external/secureRefreshV1';
import { ExternalSessionCandidateV1Schema, ExternalSessionCandidateMatchV1Schema } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import { parseCodexContentSearchProgress } from './transcriptSource.js';
import { decodeCodexExternalSessionIndexCursor } from './candidates.js';
import { parseCodexRolloutPreparationState } from '../../../rollout/discovery/preparation.js';

// Native startup locks are per OS user; keep fixture processes separate from live Agents.
const startupHome = vi.hoisted(() => ({ path: '' }));
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, userInfo: () => ({ ...actual.userInfo(), homedir: startupHome.path || actual.userInfo().homedir }) };
});
beforeAll(async () => { startupHome.path = await mkdtemp(join(tmpdir(), 'codex-history-startup-test-')); });
afterAll(async () => { await rm(startupHome.path, { recursive: true, force: true }); });

const contentReadClock = vi.hoisted(() => ({ advance: null as (() => void) | null,
  nativeProxyAvailable: true,
  onDirectoryRead: null as (() => void) | null,
  onMetadataRead: null as (() => void) | null,
  slowOffset: 64 * 1024,
  onRead: null as ((position: number, length: number) => Promise<void>) | null }));
// Native filesystem and clock are the only substituted boundaries.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, stat: async (...args: Parameters<typeof actual.stat>) => {
    // The native protocol fixture replaces the vendor process. Mirror its
    // control-socket presence at the filesystem boundary as well.
    if (String(args[0]).endsWith(join('app-server-control', 'app-server-control.sock')) && contentReadClock.nativeProxyAvailable) {
      return actual.stat(startupHome.path);
    }
    const metadata = await actual.stat(...args);
    contentReadClock.onMetadataRead?.();
    return metadata;
  }, readdir: async (...args: Parameters<typeof actual.readdir>) => {
    const entries = await actual.readdir(...args);
    contentReadClock.onDirectoryRead?.();
    return entries;
  }, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    return new Proxy(handle, { get(target, property) {
      if (property === 'read') return async (...readArgs: Parameters<typeof target.read>) => {
        const result = await Reflect.apply(target.read, target, readArgs);
        if (typeof readArgs[3] === 'number' && typeof readArgs[2] === 'number') await contentReadClock.onRead?.(readArgs[3], readArgs[2]);
        if (typeof readArgs[3] === 'number' && readArgs[3] >= contentReadClock.slowOffset) contentReadClock.advance?.();
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
});

function jsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function processResult(stdout: string): PluginProcessResult {
  return {
    termination: {
      observed: { kind: 'exit', exitCode: 0 },
      requestedBy: { kind: 'none' },
    },
    stdout: new TextEncoder().encode(stdout),
    stderr: new Uint8Array(),
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function createThreadListingExec(
  requests: string[],
  threads: readonly Readonly<{
    id: string;
    name: string;
    createdAt: number;
    updatedAt: number;
    cwd: string;
  }>[] = [{
    id: '33333333-3333-3333-3333-333333333333',
    name: 'Native app-server thread',
    createdAt: 1_768_000_000,
    updatedAt: 1_768_000_100,
    cwd: '/repo/native',
  }],
  nativeHistory?: { items: Record<string, unknown>[]; onLaunch?: (spec: unknown) => void; readFailure?: Error; onThreadRead?: (threadId: string, includeTurns: unknown) => void; threadReadFailure?: Error; threadReadResult?: unknown },
): ExecService {
  const never = new Promise<PluginProcessResult>(() => undefined);
  const client: PluginJsonRpcClient = {
    async request(method, value) {
      requests.push(method);
      if (method === 'thread/items/list' && nativeHistory) {
        if (nativeHistory.readFailure) throw nativeHistory.readFailure;
        const args = value as { sortDirection: string; limit: number; cursor?: string };
        const anchor = args.cursor ? JSON.parse(args.cursor) as { index: number; inclusive: boolean } : null;
        const desc = args.sortDirection === 'desc';
        const all = nativeHistory.items.map((entry, index) => ({ entry, index })).filter(({ index }) => !anchor || (desc
          ? (anchor.inclusive ? index <= anchor.index : index < anchor.index)
          : (anchor.inclusive ? index >= anchor.index : index > anchor.index)));
        if (desc) all.reverse();
        const page = all.slice(0, args.limit);
        return { data: page.map(row => row.entry), nextCursor: all.length > page.length
          ? JSON.stringify({ index: page.at(-1)!.index, inclusive: false }) : null,
          backwardsCursor: page.length ? JSON.stringify({ index: page[0]!.index, inclusive: true }) : null };
      }
      if (method === 'thread/read') {
        const input = value as { threadId: string; includeTurns?: boolean };
        nativeHistory?.onThreadRead?.(input.threadId, input.includeTurns);
        if (nativeHistory?.threadReadFailure) throw nativeHistory.threadReadFailure;
        return nativeHistory?.threadReadResult ?? { thread: threads.find((thread) => thread.id === input.threadId) ?? { id: input.threadId } };
      }
      if (method === 'thread/list') {
        return { data: threads };
      }
      return {};
    },
    async notify() {},
    onNotification: () => ({ dispose: () => undefined }),
    onNotificationReceived: () => ({ dispose: () => undefined }),
    onRequest: () => ({ dispose: () => undefined }),
    dispose: async () => undefined,
  };
  const handle: PluginProtocolClientHandle<'jsonRpc'> = {
    client,
    process: {
      pid: 123,
      write: async () => undefined,
      closeStdin: async () => undefined,
      wait: () => never,
      onOutput: () => ({ dispose: () => undefined }),
      dispose: async () => undefined,
    },
    wait: () => never,
    dispose: async () => undefined,
  };
  return {
    agentCli: { checkReadiness: async () => ({ launchable: [] }) },
    systemTools: {
      resolve: async () => ({
        executable: { kind: 'systemTool', id: 'codex-cli' },
        executablePath: '/fixture/codex',
      }),
    },
    run: vi.fn(async (request: Parameters<ExecService['run']>[0]) => (
      request.args?.[0] === '--version'
        ? processResult('codex-cli 0.145.0\n')
        : processResult('realtime_conversation                under development  false\n')
    )),
    spawn: vi.fn(async () => {
      throw new Error('The native app-server path must use exec.clients.spawn');
    }),
    clients: {
      spawn: async (spec: unknown) => { nativeHistory?.onLaunch?.(spec); return handle; },
    },
  } as unknown as ExecService;
}

const emptyThreadListingExec = createThreadListingExec([], []);

function invocation(overrides: Readonly<{
  signal?: AbortSignal;
  deadlineAtMs?: number;
  maxSerializedBytes?: number;
  exec?: ExecService;
}> = {}) {
  return {
    signal: overrides.signal ?? new AbortController().signal,
    deadlineAtMs: overrides.deadlineAtMs ?? Date.now() + 30_000,
    maxSerializedBytes: overrides.maxSerializedBytes ?? 64 * 1024,
    exec: overrides.exec ?? emptyThreadListingExec,
    ripgrep: { run: async () => ({ exitCode: 1, stdout: '', stderr: '' }) },
  };
}

describe('Codex public Agent External Sessions contribution', () => {
  it('hydrates only selected native names through one existing proxy and falls back freshly after failure', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codex-selected-native-names-'));
    try {
      const source = { kind: 'codexHome' as const, home: 'user' as const, homePath: home };
      const threads = Array.from({ length: 120 }, (_, index) => ({ id: `thread-${index}`, name: `Native ${index}`,
        createdAt: 1_768_000_000, updatedAt: 1_768_000_100, cwd: '/repo/native' }));
      const candidates = [threads[119]!, threads[117]!].map((thread) => ({ remoteSessionId: thread.id,
        title: `Fallback ${thread.id}`, updatedAtMs: thread.updatedAt * 1000, linkData: { source } }));
      const requests: string[] = [];
      const launches: unknown[] = [];
      const reads: string[] = [];
      const boundary = { items: [] as Record<string, unknown>[], onLaunch: (spec: unknown) => launches.push(spec),
        onThreadRead: (id: string, includeTurns: unknown) => { expect(includeTurns).toBe(false); reads.push(id); },
        threadReadFailure: undefined as Error | undefined, threadReadResult: undefined as unknown };
      const exec = createThreadListingExec(requests, threads, boundary);
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: home } });
      expect(contribution.hydrateCandidates).toBeTypeOf('function');
      const request = { ...invocation({ exec }), source, candidates };
      await expect(contribution.hydrateCandidates!(request)).resolves.toMatchObject({ ok: true, value: {
        candidates: [{ ...candidates[0], title: 'Native 119' }, { ...candidates[1], title: 'Native 117' }],
      } });
      expect(launches).toHaveLength(1);
      expect(launches[0]).toMatchObject({ kind: 'jsonRpc', framing: 'webSocket', launch: { args: ['app-server', 'proxy'] } });
      expect(reads).toEqual(['thread-119', 'thread-117']);
      expect(requests.filter((method) => method === 'initialize')).toHaveLength(1);
      expect(requests).not.toContain('thread/list');
      threads[119]!.name = 'Renamed native session';
      await expect(contribution.hydrateCandidates!(request)).resolves.toMatchObject({ ok: true, value: {
        candidates: [{ title: 'Renamed native session' }, { title: 'Native 117' }],
      } });
      boundary.threadReadFailure = new Error('private native failure');
      await expect(contribution.hydrateCandidates!(request)).resolves.toEqual({ ok: true, value: { candidates } });
      boundary.threadReadFailure = undefined;
      boundary.threadReadResult = { thread: { id: 'foreign', name: 'Must not substitute' } };
      await expect(contribution.hydrateCandidates!(request)).resolves.toEqual({ ok: true, value: { candidates } });
      boundary.threadReadResult = { thread: { id: candidates[0]!.remoteSessionId, name: '   ' } };
      await expect(contribution.hydrateCandidates!({ ...request, candidates: candidates.slice(0, 1) })).resolves.toEqual({
        ok: true, value: { candidates: candidates.slice(0, 1) },
      });
      contentReadClock.nativeProxyAvailable = false;
      const before = launches.length;
      await expect(contribution.hydrateCandidates!(request)).resolves.toEqual({ ok: true, value: { candidates } });
      expect(launches).toHaveLength(before);
    } finally {
      contentReadClock.nativeProxyAvailable = true;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('stops selected native-name reads when the containing invocation is cancelled', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codex-selected-native-cancel-'));
    try {
      const controller = new AbortController();
      const reads: string[] = [];
      const source = { kind: 'codexHome' as const, home: 'user' as const, homePath: home };
      const exec = createThreadListingExec([], [], { items: [], onThreadRead: (id) => { reads.push(id); controller.abort(); } });
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: home } });
      expect(contribution.hydrateCandidates).toBeTypeOf('function');
      await expect(contribution.hydrateCandidates!({ ...invocation({ exec, signal: controller.signal }), source,
        candidates: [{ remoteSessionId: 'first', updatedAtMs: 1, title: 'Fallback first' },
          { remoteSessionId: 'second', updatedAtMs: 1, title: 'Fallback second' }] })).resolves.toMatchObject({ ok: false, code: 'cancelled' });
      expect(reads).toEqual(['first']);
    } finally { await rm(home, { recursive: true, force: true }); }
  });


  it('reports an absent native proxy without launching it and keeps complete rollouts readable', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codex-proxy-unavailable-'));
    const launches: unknown[] = [];
    try {
      contentReadClock.nativeProxyAvailable = false;
      const sessions = join(home, 'sessions'); await mkdir(sessions);
      for (const [id, paginated] of [['complete', false], ['paginated', true]] as const) {
        await writeFile(join(sessions, `rollout-${id}.jsonl`),
          jsonl({ type: 'session_meta', payload: { id, ...(paginated ? { history_mode: 'paginated' } : {}) } })
          + jsonl({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'readable quartz' }] } }));
      }
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: home } });
      const request = { ...invocation({ exec: createThreadListingExec([], [], { items: [], onLaunch: spec => launches.push(spec) }) }),
        source: { kind: 'codexHome', home: 'user' }, direction: 'older' as const, maxItems: 10 };
      for (let tick = 0; tick < 2; tick++) {
        for (const remoteSessionId of ['paginated', 'native-only']) {
          expect(await contribution.pageTranscript({ ...request, remoteSessionId }))
            .toMatchObject({ ok: false, code: 'agent_unavailable', retryable: true });
        }
      }
      const complete = await contribution.pageTranscript({ ...request, remoteSessionId: 'complete' });
      expect(complete.ok).toBe(true);
      expect(JSON.stringify(complete)).toContain('readable quartz');
      expect(launches).toEqual([]);
    } finally { contentReadClock.nativeProxyAvailable = true; await rm(home, { recursive: true, force: true }); }
  });

  it.each(['page', 'follow'] as const)('preserves an actionable record-limit failure for %s reads', async operation => {
    const home = await mkdtemp(join(tmpdir(), 'codex-record-limit-'));
    try {
      const sessions = join(home, 'sessions'); await mkdir(sessions);
      const id = 'aaaaaaaa-1111-4111-8111-111111111111';
      const file = join(sessions, `rollout-2026-10-20T10-00-00-${id}.jsonl`);
      await writeFile(file, jsonl({ type: 'session_meta', payload: { id } }) + jsonl({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'before' }] } }));
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: home } });
      const request = { ...invocation(), source: { kind: 'codexHome', home: 'user' }, remoteSessionId: id, maxItems: 10 };
      const initial = await contribution.pageTranscript({ ...request, direction: 'older' });
      if (!initial.ok || !initial.value.tailCursor) throw new Error(JSON.stringify(initial));
      await appendFile(file, jsonl({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'after' }], padding: 'x'.repeat(9 * 1024 * 1024) } }));
      const result = operation === 'page' ? await contribution.pageTranscript({ ...request, direction: 'older' })
        : await contribution.readAfterTranscript({ ...request, cursor: initial.value.tailCursor });
      expect(result).toMatchObject({ ok: false, code: 'agent_error', retryable: false, message: expect.stringContaining('JSONL') });
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('pages complete native history through the existing plugin execution boundary and follows appends', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codex-native-history-plugin-'));
    try {
      const entry = (index: number) => ({ turnId: `turn-${index}`, startedAtMs: index * 1000, completedAtMs: index * 1000 + 1,
        item: { id: `item-${index}`, type: index % 2 ? 'userMessage' : 'agentMessage',
          ...(index % 2 ? { content: [{ type: 'text', text: `message-${index}` }] } : { text: `message-${index}` }) } });
      const launches: unknown[] = [];
      const history = { items: [1, 2, 3, 4].map(entry), onLaunch: (spec: unknown) => launches.push(spec) };
      const methods: string[] = [];
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: home } });
      const request = { ...invocation({ exec: createThreadListingExec(methods, [], history) }),
        source: { kind: 'codexHome', home: 'user' }, remoteSessionId: 'native-thread', direction: 'older' as const, maxItems: 2 };
      const items: unknown[] = [];
      let cursor: string | undefined;
      let tail: string | null = null;
      do {
        const page = await contribution.pageTranscript({ ...request, cursor });
        expect(page.ok, JSON.stringify(page)).toBe(true);
        if (!page.ok) throw new Error(page.message);
        items.unshift(...page.value.items);
        tail ??= page.value.tailCursor;
        cursor = page.value.nextCursor ?? undefined;
      } while (cursor);
      expect(items).toHaveLength(4);
      expect(JSON.stringify(items)).toContain('message-1');
      expect(methods).toContain('thread/items/list');
      expect(methods.some(method => ['thread/resume', 'turn/start', 'thread/unarchive'].includes(method))).toBe(false);
      // Native history is a read of an already-running vendor server. Starting
      // a fresh server can backfill/migrate its store and contend with live work.
      expect(launches.map(spec => (spec as { launch: { args: string[] } }).launch.args))
        .toEqual([['app-server', 'proxy'], ['app-server', 'proxy']]);
      history.items.push(entry(5));
      const appended = await contribution.readAfterTranscript({ ...request, cursor: tail! });
      expect(appended.ok, JSON.stringify(appended)).toBe(true);
      if (!appended.ok) throw new Error(appended.message);
      expect(appended.value).toMatchObject({ outcome: 'advanced', items: [expect.objectContaining({ raw: { role: 'user', content: { type: 'text', text: 'message-5' } } })] });
      const beforeUnavailable = launches.length;
      contentReadClock.nativeProxyAvailable = false;
      expect(await contribution.pageTranscript({ ...request, cursor: tail! }))
        .toMatchObject({ ok: false, code: 'agent_unavailable', retryable: true });
      expect(await contribution.readAfterTranscript({ ...request, cursor: tail! }))
        .toMatchObject({ ok: false, code: 'agent_unavailable', retryable: true });
      expect(launches).toHaveLength(beforeUnavailable);
    } finally { contentReadClock.nativeProxyAvailable = true; await rm(home, { recursive: true, force: true }); }
  });

  it('preserves partial native command rows and empty native follow continuations', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codex-native-partial-plugin-'));
    try {
      const entry = (id: string, item: Record<string, unknown>) => ({ turnId: 'turn', item: { id, ...item }, startedAtMs: 1, completedAtMs: 2 });
      const history = { items: [entry('command', { type: 'commandExecution', command: 'pwd', aggregatedOutput: '/repo\n', exitCode: 0 })] };
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: home } });
      const request = { ...invocation({ exec: createThreadListingExec([], [], history) }),
        source: { kind: 'codexHome', home: 'user' }, remoteSessionId: 'native-thread', direction: 'older' as const, maxItems: 1 };
      const latest = await contribution.pageTranscript(request);
      expect(latest.ok, JSON.stringify(latest)).toBe(true);
      if (!latest.ok) throw new Error(latest.message);
      const older = await contribution.pageTranscript({ ...request, cursor: latest.value.nextCursor! });
      expect(older.ok, JSON.stringify(older)).toBe(true);
      if (!older.ok) throw new Error(older.message);
      expect(JSON.stringify(latest.value.items)).toContain('"stdout":"/repo\\n"');
      expect(JSON.stringify(older.value.items)).toContain('"cmd":"pwd"');
      expect(latest.value.items[0]!.id).not.toBe(older.value.items[0]!.id);
      history.items.push(entry('reasoning', { type: 'reasoning', summary: [] }), entry('reply', { type: 'agentMessage', text: 'after-empty-page' }));
      let cursor = latest.value.tailCursor!;
      let found = false;
      for (;;) {
        const page = await contribution.readAfterTranscript({ ...request, cursor });
        expect(page.ok, JSON.stringify(page)).toBe(true);
        if (!page.ok || page.value.outcome !== 'advanced') throw new Error(JSON.stringify(page));
        found ||= JSON.stringify(page.value.items).includes('after-empty-page');
        cursor = page.value.nextCursor;
        if (!page.value.hasMore) break;
      }
      expect(found).toBe(true);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it.each(['PLUGIN_EXEC_CLIENT_EXITED', 'PLUGIN_EXEC_CLIENT_REQUEST_TIMEOUT'])('retains safe %s identity when the native history request fails', async code => {
    const home = await mkdtemp(join(tmpdir(), 'codex-native-read-failure-'));
    try {
      const debug = vi.fn();
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: home } });
      const result = await contribution.pageTranscript({ ...invocation({ exec: createThreadListingExec([], [], {
        items: [], readFailure: Object.assign(new Error('private native error must not enter diagnostics'), { code }),
      }) }), logger: { debug }, source: { kind: 'codexHome', home: 'user' }, remoteSessionId: 'native-thread', direction: 'older', maxItems: 2 });
      expect(result).toMatchObject({ ok: false, code: 'agent_error', message: 'external_sessions_transcript_read_failed' });
      expect(debug).toHaveBeenCalledWith('[codex] Native transcript read failed', {
        exceptionClass: 'Error', code, phase: 'pageTranscript', sourceItemId: 'native-thread', byteOffset: null,
      });
      expect(JSON.stringify(debug.mock.calls)).not.toContain('private native error');
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('keeps connected-account native history out of the ambient user SQLite home', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codex-native-connected-plugin-'));
    try {
      const launches: unknown[] = [];
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: '/user/home', CODEX_SQLITE_HOME: '/user/sqlite' } });
      const page = await contribution.pageTranscript({ ...invocation({ exec: createThreadListingExec([], [], {
        items: [], onLaunch: spec => {
          const env = (spec as { launch: { env: Record<string, string | undefined> } }).launch.env;
          launches.push({ CODEX_HOME: env.CODEX_HOME, CODEX_SQLITE_HOME: env.CODEX_SQLITE_HOME });
        },
      }) }), source: { kind: 'codexHome', home: 'connectedService', connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'profile', homePath: home }, remoteSessionId: 'native-thread', direction: 'older', maxItems: 2 });
      expect(page.ok, JSON.stringify(page)).toBe(true);
      expect(launches).toEqual([{ CODEX_HOME: home, CODEX_SQLITE_HOME: home }]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('rejects mixed native media instead of reporting its text as complete history', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codex-native-media-plugin-'));
    try {
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: home } });
      const page = await contribution.pageTranscript({ ...invocation({ exec: createThreadListingExec([], [], { items: [{
        turnId: 'turn', startedAtMs: 1, completedAtMs: 2, item: { id: 'mixed', type: 'userMessage',
          content: [{ type: 'text', text: 'question with image' }, { type: 'image', url: 'https://example.invalid/image.png' }] },
      }] }) }), source: { kind: 'codexHome', home: 'user' }, remoteSessionId: 'native-thread', direction: 'older', maxItems: 2 });
      expect(page.ok).toBe(false);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('reads native history when a later root-family segment changes to paginated storage', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codex-native-segments-plugin-'));
    try {
      const remoteSessionId = 'aaaaaaaa-1111-4111-8111-111111111111';
      const day = join(home, 'sessions');
      await mkdir(day);
      await writeFile(join(day, `rollout-2026-10-20T10-00-00-${remoteSessionId}.jsonl`),
        jsonl({ type: 'session_meta', payload: { id: remoteSessionId, source: 'cli' } })
        + jsonl({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'local-only' }] } }));
      await writeFile(join(day, `rollout-2026-10-20T11-00-00-${remoteSessionId}_cccccccc-3333-4333-8333-333333333333.jsonl`),
        jsonl({ type: 'session_meta', payload: { id: remoteSessionId, source: 'cli', history_mode: 'paginated',
          history_base: { thread_id: 'ancestor', end_byte_offset: 100, end_ordinal_exclusive: 2 } } }));
      const methods: string[] = [];
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: home } });
      const history = { items: [{
        turnId: 'turn', startedAtMs: 1, completedAtMs: 2, item: { id: 'reply', type: 'agentMessage', text: 'inherited-native-history' },
      }] };
      const request = { ...invocation({ exec: createThreadListingExec(methods, [], history) }),
        source: { kind: 'codexHome', home: 'user' }, remoteSessionId, direction: 'older' as const, maxItems: 2 };
      const page = await contribution.pageTranscript(request);
      expect(page.ok, JSON.stringify(page)).toBe(true);
      expect(JSON.stringify(page)).toContain('inherited-native-history');
      expect(JSON.stringify(page)).not.toContain('local-only');
      expect(methods).toContain('thread/items/list');
      history.items = [];
      expect((await contribution.pageTranscript(request)).ok).toBe(false);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('does not report absent native transcript storage as complete empty history', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codex-native-history-unavailable-'));
    try {
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: home } });
      const result = await contribution.pageTranscript({ ...invocation(), source: { kind: 'codexHome', home: 'user' },
        remoteSessionId: 'native-thread', direction: 'older', maxItems: 2 });
      expect(result.ok).toBe(false);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('pages a large rollout within the complete result byte boundary without losing valid messages', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-codex-byte-pages-'));
    try {
      const day = join(directory, 'sessions', '2026', '10', '21');
      await mkdir(day, { recursive: true });
      const id = '00000000-0000-4000-8000-000000000237';
      const messages = Array.from({ length: 64 }, (_, index) => `message-${index} ${'quartz '.repeat(1400)}`);
      await writeFile(join(day, `rollout-2026-10-21T00-00-00-${id}.jsonl`),
        jsonl({ type: 'session_meta', payload: { id } }) + messages.map(text => jsonl({ type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })).join(''));
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: directory } });
      const request = { ...invocation(), source: { kind: 'codexHome', home: 'user' }, remoteSessionId: id,
        direction: 'older' as const, maxItems: 200 };
      const twoItems = await contribution.pageTranscript({ ...request, maxItems: 2 });
      if (!twoItems.ok) throw new Error(twoItems.message);
      // The whole envelope (including both opaque cursors) owns the bound.
      // A budget just below this page must select fewer items and continue.
      request.maxSerializedBytes = Buffer.byteLength(JSON.stringify(twoItems)) - 1;
      const actual: string[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await contribution.pageTranscript({ ...request, ...(cursor ? { cursor } : {}) });
        expect(page.ok, JSON.stringify(page)).toBe(true);
        if (!page.ok) throw new Error(page.message);
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(request.maxSerializedBytes);
        actual.unshift(...page.value.items.map(item => String(item.raw.content.text)));
        cursor = page.value.nextCursor ?? undefined;
        if (cursor) { expect(seen.has(cursor)).toBe(false); seen.add(cursor); }
      } while (cursor);
      expect(actual).toEqual(messages);
      const appended = messages.map(text => `appended ${text}`);
      await appendFile(join(day, `rollout-2026-10-21T00-00-00-${id}.jsonl`), appended.map(text => jsonl({ type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })).join(''));
      if (!twoItems.value.tailCursor) throw new Error('Expected the captured tail cursor');
      const forwardRequest = { ...request, cursor: twoItems.value.tailCursor, maxSerializedBytes: 64 * 1024 };
      const forwardProbe = await contribution.readAfterTranscript({ ...forwardRequest, maxItems: 2 });
      if (!forwardProbe.ok) throw new Error(forwardProbe.message);
      forwardRequest.maxSerializedBytes = Buffer.byteLength(JSON.stringify(forwardProbe)) - 1;
      const forward: string[] = [];
      for (;;) {
        const page = await contribution.readAfterTranscript(forwardRequest);
        expect(page.ok, JSON.stringify(page)).toBe(true);
        if (!page.ok) throw new Error(page.message);
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(forwardRequest.maxSerializedBytes);
        expect(page.value.outcome).toBe('advanced');
        if (page.value.outcome !== 'advanced') throw new Error('Expected forward progress');
        forward.push(...page.value.items.map(item => String(item.raw.content.text)));
        if (!page.value.hasMore) break;
        expect(page.value.nextCursor).not.toBe(forwardRequest.cursor);
        forwardRequest.cursor = page.value.nextCursor;
      }
      expect(forward).toEqual(appended);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('applies native history-window admission before title work while preserving top-level thread exclusion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-window-contribution-'));
    try {
      const codexHome = join(root, 'codex-home');
      const day = join(codexHome, 'sessions', '2026', '10', '20');
      await mkdir(day, { recursive: true });
      const cutoff = Date.parse('2026-10-19T12:00:00Z');
      for (const [name, id, mtime, extra] of [
        ['23', 'expired', cutoff - 1, {}],
        ['22', 'guardian', cutoff, { thread_source: 'guardian_review', parent_thread_id: 'active', base_instructions: 'x'.repeat(96 * 1024) }],
        ['21', 'active', cutoff, {}],
      ] as const) {
        const path = join(day, `rollout-2026-10-20T${name}-00-00-${id}.jsonl`);
        await writeFile(path, jsonl({ type: 'session_meta', payload: { id, ...extra } }) + jsonl({
          type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Optional display title' }] },
        }));
        await utimes(path, new Date(mtime), new Date(mtime));
      }
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: codexHome } });
      const request = { ...invocation(), source: { kind: 'codexHome', home: 'user' }, maxItems: 10,
        updatedAfterMs: cutoff, includeTitles: false };
      const result = await contribution.listCandidates(request);
      expect(result).toMatchObject({ ok: true, value: { candidates: [{ remoteSessionId: 'active' }], nextCursor: null } });
      if (!result.ok) throw new Error(result.message);
      expect(result.value.candidates[0]?.title).toBeUndefined();
      const revealed = await contribution.listCandidates({ ...request, includeThreads: true });
      expect(revealed).toMatchObject({ ok: true, value: { candidates: [
        { remoteSessionId: 'active' }, { remoteSessionId: 'guardian', thread: { kind: 'reviewer', parentRemoteSessionId: 'active' } },
      ] } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps an updated continuation eligible without narrowing the root-family transcript to the history window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-window-family-'));
    try {
      const codexHome = join(root, 'codex-home');
      const day = join(codexHome, 'sessions', '2026', '10', '20');
      await mkdir(day, { recursive: true });
      const id = 'aaaaaaaa-1111-4111-8111-111111111111';
      const childId = 'bbbbbbbb-2222-4222-8222-222222222222';
      const turnId = 'cccccccc-3333-4333-8333-333333333333';
      const cutoff = Date.parse('2026-10-19T12:00:00Z');
      for (const [name, payload, text, mtime] of [
        [`18T10-00-00-${id}`, { id, source: 'cli' }, 'owned historical root', cutoff - 1],
        [`20T10-00-00-${id}_${turnId}`, { id, source: 'cli' }, 'owned current continuation', cutoff],
        [`20T11-00-00-${childId}`, { id: childId, session_id: id, thread_source: 'subagent', parent_thread_id: id }, 'owned child body', cutoff],
      ] as const) {
        const path = join(day, `rollout-2026-10-${name}.jsonl`);
        await writeFile(path, jsonl({ type: 'session_meta', payload }) + jsonl({ type: 'response_item',
          timestamp: '2026-10-20T12:00:00Z', payload: { type: 'message', role: payload.id === childId ? 'assistant' : 'user',
            content: [{ type: payload.id === childId ? 'output_text' : 'input_text', text }] } }));
        await utimes(path, new Date(mtime), new Date(mtime));
      }
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: codexHome } });
      const source = { kind: 'codexHome', home: 'user' };
      const listed = await contribution.listCandidates({ ...invocation(), source, maxItems: 10,
        updatedAfterMs: cutoff, includeTitles: false });
      expect(listed).toMatchObject({ ok: true, value: { candidates: [{ remoteSessionId: id }], nextCursor: null } });
      const page = await contribution.pageTranscript({ ...invocation(), source, remoteSessionId: id, direction: 'older', maxItems: 20 });
      if (!page.ok) throw new Error(page.message);
      expect(page.value.items.map(item => item.raw.content)).toEqual(expect.arrayContaining([
        expect.objectContaining({ text: 'owned historical root' }),
        expect.objectContaining({ text: 'owned current continuation' }),
        expect.objectContaining({ data: expect.objectContaining({ message: 'owned child body' }) }),
      ]));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('advances slow native decoding under identical budgets with rollback and semantic ordinals intact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-progress-'));
    const clock = Date.now;
    let now = clock();
    try {
      const codexHome = join(root, 'codex-home');
      const day = join(codexHome, 'sessions', '2026', '07', '23');
      await mkdir(day, { recursive: true });
      const id = '11111111-1111-1111-1111-111111111111';
      const laterId = '22222222-2222-2222-2222-222222222222';
      const path = join(day, `rollout-2026-07-23T08-00-00-${id}.jsonl`);
      const message = (role: string, text: string, minute: number) => jsonl({ type: 'response_item', timestamp: `2026-07-23T08:${String(minute).padStart(2, '0')}:00.000Z`, payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
      await writeFile(path, [jsonl({ type: 'session_meta', payload: { id, cwd: '/repo' } }),
        message('user', 'kept prompt', 1), message('assistant', 'kept reply', 2), message('assistant', 'kept reply', 2),
        message('user', 'abandoned prompt', 3), message('assistant', 'body-only phrase abandoned', 4),
        jsonl({ type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } }),
        message('user', 'replacement prompt', 5),
        ...Array.from({ length: 10_000 }, (_, index) => message('assistant', `dense native reply ${index}`, 5)),
        jsonl({ type: 'response_item', timestamp: '2026-07-23T08:05:10.000Z', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'spawn-call', arguments: JSON.stringify({ prompt: 'inspect native correlation', nickname: 'worker', role: 'explorer' }) } }),
        message('assistant', 'interim reply', 5),
        ...Array.from({ length: 4 }, (_, index) => jsonl({ type: 'world_state', payload: { padding: 'x'.repeat(70_000), index } })),
        message('assistant', 'interim reply', 5),
        jsonl({ type: 'response_item', timestamp: '2026-07-23T08:05:20.000Z', payload: { type: 'function_call_output', call_id: 'spawn-call', output: JSON.stringify({ agent_id: 'child-thread' }) } }),
        jsonl({ type: 'event_msg', timestamp: '2026-07-23T08:05:20.000Z', payload: { type: 'collab_agent_spawn_end', new_thread_id: 'child-thread' } }),
        ...Array.from({ length: 4 }, (_, index) => jsonl({ type: 'world_state', payload: { padding: 'x'.repeat(70_000), index } })),
        message('assistant', 'body-only phrase active', 6)].join(''));
      const fixtureBytes = await readFile(path);
      contentReadClock.slowOffset = fixtureBytes.indexOf(Buffer.from('"type":"world_state"')) + 64 * 1024;
      const laterPath = join(day, `rollout-2026-07-23T07-00-00-${laterId}.jsonl`);
      await writeFile(laterPath, jsonl({ type: 'session_meta', payload: { id: laterId, cwd: '/repo' } }) + message('assistant', 'body-only phrase next file', 0));
      // These native carriers are characterized by pinnedRecorderGrammar.test.ts
      // from Codex 0.145.0 / 0.157.1 recorder output. The second stream belongs
      // to the same root family and contributes to its chronological ordinal.
      const childId = '33333333-3333-3333-3333-333333333333';
      await writeFile(join(day, `rollout-2026-07-23T08-00-01-${childId}.jsonl`),
        jsonl({ type: 'session_meta', payload: { id: childId, session_id: id, cwd: '/repo',
          source: { subagent: { thread_spawn: { parent_thread_id: id, depth: 1 } } },
          thread_source: 'subagent', parent_thread_id: id } })
        + message('assistant', 'child stream reply', 3));
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: codexHome } });
      const source = { kind: 'codexHome', home: 'user', homePath: codexHome };
      const ripgrep = { run: async () => ({ exitCode: 0, stdout: `${path}\0${laterPath}\0`, stderr: '' }) };
      Date.now = () => now;
      let cursor: string | undefined;
      let firstCursor: string | undefined;
      let semanticCursor: string | undefined;
      let hitCursor: string | undefined;
      const hits: Array<{ remoteSessionId: string; match?: { snippet: string; sourceItemId: string; messageIndex: number } }> = [];
      const seen = new Set<string>();
      for (let page = 0; page < 80; page += 1) {
        contentReadClock.advance = () => { now += 60; };
        const result = await contribution.listCandidates({ ...invocation(), source, maxItems: 1, searchTarget: 'content', searchTerm: 'body-only phrase', scanDeadlineAtMs: now + 100, cursor, ripgrep });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.message);
        for (const candidate of result.value.candidates) {
          ExternalSessionCandidateV1Schema.parse(candidate);
          if (candidate.match) ExternalSessionCandidateMatchV1Schema.parse(candidate.match);
          hits.push(candidate);
        }
        if (!result.value.nextCursor) { cursor = undefined; break; }
        expect(seen.has(result.value.nextCursor)).toBe(false);
        // The native cursor remains inside the real strict result byte budget
        // even with ten thousand projected rows before the slow suffix.
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(invocation().maxSerializedBytes);
        seen.add(result.value.nextCursor);
        firstCursor ??= result.value.nextCursor;
        const envelope = JSON.parse(Buffer.from(result.value.nextCursor, 'base64url').toString()) as Record<string, unknown>;
        const progress = parseCodexContentSearchProgress(envelope.contentProgress);
        if (progress?.phase === 'matching' && progress.streams[0]?.semantic.pending.length) semanticCursor ??= result.value.nextCursor;
        if (progress?.hit) hitCursor ??= result.value.nextCursor;
        cursor = result.value.nextCursor;
      }
      expect(cursor).toBeUndefined();
      expect(hits).toMatchObject([{ remoteSessionId: id, match: { snippet: 'body-only phrase active', messageIndex: 10_006 } }, { remoteSessionId: laterId, match: { snippet: 'body-only phrase next file', messageIndex: 0 } }]);
      expect(firstCursor).toBeDefined();
      if (!firstCursor) throw new Error('Expected native progress');
      contentReadClock.advance = null;
      expect(semanticCursor).toBeDefined();
      expect(hitCursor).toBeDefined();
      if (!semanticCursor || !hitCursor) throw new Error('Expected native semantic and hit continuations');
      const parsed = JSON.parse(Buffer.from(hitCursor, 'base64url').toString()) as Record<string, unknown>;
      const forged = parseCodexContentSearchProgress(parsed.contentProgress);
      if (!forged?.hit) throw new Error('Expected native hit locator');
      // Cursor hit facts cannot authorize a snippet: the actual native row must match.
      const promptOffset = Buffer.byteLength(jsonl({ type: 'session_meta', payload: { id, cwd: '/repo' } }));
      forged.hit.row = { startOffsetBytes: promptOffset, endOffsetBytes: promptOffset + Buffer.byteLength(message('user', 'kept prompt', 1)) };
      forged.hit.id = forged.hit.id.replace(/:\d{12}:\d{3}$/u, `:${String(promptOffset).padStart(12, '0')}:000`);
      parsed.contentProgress = forged;
      await expect(contribution.listCandidates({ ...invocation(), source, maxItems: 1, searchTarget: 'content', searchTerm: 'body-only phrase',
        cursor: Buffer.from(JSON.stringify(parsed)).toString('base64url'), scanDeadlineAtMs: now + 10_000, ripgrep })).resolves.toMatchObject({ ok: false, code: 'source_invalid' });
      const controller = new AbortController();
      const pendingEnvelope = JSON.parse(Buffer.from(semanticCursor, 'base64url').toString()) as Record<string, unknown>;
      const pendingOffset = parseCodexContentSearchProgress(pendingEnvelope.contentProgress)!.streams[0]!.semantic.pending[0]!.row.startOffsetBytes;
      contentReadClock.onRead = async (position) => { if (position === pendingOffset) controller.abort(); };
      await expect(contribution.listCandidates({ ...invocation({ signal: controller.signal }), source, maxItems: 1, searchTarget: 'content', searchTerm: 'body-only phrase',
        cursor: semanticCursor, scanDeadlineAtMs: now + 10_000, ripgrep })).resolves.toMatchObject({ ok: false, code: 'cancelled' });
      let changedAtFinalRow = false;
      contentReadClock.onRead = async (position, length) => {
        if (position > contentReadClock.slowOffset && length < 1024 && !changedAtFinalRow) {
          changedAtFinalRow = true;
          await appendFile(path, jsonl({ type: 'world_state', payload: {} }));
        }
      };
      await expect(contribution.listCandidates({ ...invocation(), source, maxItems: 1, searchTarget: 'content', searchTerm: 'body-only phrase',
        cursor: firstCursor, scanDeadlineAtMs: now + 10_000, ripgrep })).resolves.toMatchObject({ ok: true, value: {
          candidates: [{ remoteSessionId: id, match: { snippet: 'body-only phrase active', messageIndex: 10_006 } }], contentCoverage: 'partial',
        } });
      expect(changedAtFinalRow).toBe(true);
      contentReadClock.onRead = null;
      await expect(contribution.listCandidates({ ...invocation(), source, maxItems: 1, searchTarget: 'content', searchTerm: 'body-only phrase',
        cursor: semanticCursor, scanDeadlineAtMs: now + 10_000, ripgrep })).resolves.toMatchObject({ ok: true, value: {
          candidates: [{ remoteSessionId: id, match: { snippet: 'body-only phrase active', messageIndex: 10_006 } }], contentCoverage: 'partial',
        } });
    } finally { contentReadClock.advance = null; contentReadClock.onRead = null; contentReadClock.slowOffset = 64 * 1024; Date.now = clock; await rm(root, { recursive: true, force: true }); }
  });
  it('yields content work at its cooperative scan deadline while retaining hard invocation enforcement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-public-content-deadline-'));
    const clock = Date.now;
    let now = clock();
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      const remoteSessionId = '11111111-1111-1111-1111-111111111111';
      const rolloutPath = join(sessionsDir, `rollout-2026-07-23T08-00-00-${remoteSessionId}.jsonl`);
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(rolloutPath, [
        jsonl({ type: 'session_meta', timestamp: '2026-07-23T08:00:00.000Z', payload: { id: remoteSessionId, cwd: '/repo' } }),
        jsonl({ type: 'response_item', timestamp: '2026-07-23T08:01:00.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'body-only phrase' }] } }),
      ].join(''));
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: codexHome } });
      const request = {
        ...invocation(), source: { kind: 'codexHome', home: 'user', homePath: codexHome }, maxItems: 10,
        searchTarget: 'content' as const, searchTerm: 'body-only phrase', scanDeadlineAtMs: now + 100,
        // Only the host subprocess/clock boundaries are substituted; native scanning and decoding remain real.
        ripgrep: { run: async () => { now += 100; return { exitCode: 0, stdout: `${rolloutPath}\0`, stderr: '' }; } },
      };
      Date.now = () => now;
      const first = await contribution.listCandidates(request);
      expect(first).toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'partial', nextCursor: expect.any(String) } });
      if (!first.ok || !first.value.nextCursor) throw new Error('Expected content continuation');
      await expect(contribution.listCandidates({ ...request, deadlineAtMs: now, scanDeadlineAtMs: now + 100 })).resolves.toMatchObject({ ok: false, code: 'timeout' });
      const hardDeadlineAtMs = now + 30_000;
      await expect(contribution.listCandidates({ ...request, deadlineAtMs: hardDeadlineAtMs, scanDeadlineAtMs: now + 100,
        ripgrep: { run: async () => { now = hardDeadlineAtMs; return { exitCode: 0, stdout: `${rolloutPath}\0`, stderr: '' }; } } })).resolves.toMatchObject({ ok: false, code: 'timeout' });
      const resumed = await contribution.listCandidates({ ...request, scanDeadlineAtMs: now + 1000, cursor: first.value.nextCursor,
        deadlineAtMs: now + 30_000,
        ripgrep: { run: async () => ({ exitCode: 0, stdout: `${rolloutPath}\0`, stderr: '' }) } });
      expect(resumed).toMatchObject({ ok: true, value: { candidates: [{ remoteSessionId, match: { snippet: expect.stringContaining('body-only phrase') } }], contentCoverage: 'complete' } });
    } finally { Date.now = clock; await rm(root, { recursive: true, force: true }); }
  });

  it.each(['directory', 'metadata', 'linked root'] as const)('advances preparation under equally slow %s reads before transcript matching', async (slowBoundary) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-content-preparation-'));
    const clock = Date.now;
    let now = clock();
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      const remoteSessionId = '11111111-1111-1111-1111-111111111111';
      const rolloutPath = join(sessionsDir, `rollout-2026-07-23T08-00-00-${remoteSessionId}.jsonl`);
      if (slowBoundary === 'linked root') {
        await mkdir(codexHome, { recursive: true });
        const nativeSessions = join(root, 'native-sessions');
        await mkdir(nativeSessions);
        await symlink(nativeSessions, join(codexHome, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir');
      }
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(rolloutPath, [
        jsonl({ type: 'session_meta', timestamp: '2026-07-23T08:00:00.000Z', payload: { id: remoteSessionId, cwd: '/repo' } }),
        jsonl({ type: 'response_item', timestamp: '2026-07-23T08:01:00.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'preparation body-only phrase' }] } }),
      ].join(''));
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: codexHome } });
      Date.now = () => now;
      if (slowBoundary !== 'metadata') contentReadClock.onDirectoryRead = () => { now += 60; };
      else contentReadClock.onMetadataRead = () => { now += 60; };
      let cursor: string | undefined;
      const hits: string[] = [];
      for (let page = 0; page < 30; page += 1) {
        const result = await contribution.listCandidates({ ...invocation(),
          source: { kind: 'codexHome', home: 'user', homePath: codexHome },
          maxItems: 1, searchTarget: 'content', searchTerm: 'preparation body-only phrase',
          // Rewalking both native owners cannot fit this real outer deadline;
          // a committed directory step fits each cooperative page.
          deadlineAtMs: now + (slowBoundary === 'metadata' ? 30_000 : 300),
          scanDeadlineAtMs: now + 100, ...(cursor ? { cursor } : {}),
          ripgrep: { run: async () => ({ exitCode: 0, stdout: `${rolloutPath}\0`, stderr: '' }) },
        });
        if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
        for (const candidate of result.value.candidates) {
          const parsed = ExternalSessionCandidateV1Schema.parse({ ...candidate, agentId: 'codex', source: { kind: 'codexHome', home: 'user', homePath: codexHome } });
          if (parsed.match) hits.push(parsed.remoteSessionId);
        }
        if (!result.value.nextCursor) { cursor = undefined; break; }
        expect(result.value.nextCursor).not.toBe(cursor);
        cursor = result.value.nextCursor;
      }
      expect(cursor).toBeUndefined();
      expect(hits).toEqual([remoteSessionId]);
    } finally {
      contentReadClock.onDirectoryRead = null;
      contentReadClock.onMetadataRead = null;
      Date.now = clock;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reauthorizes preparation references and rejects changed directory sources before reading transcripts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-preparation-source-'));
    const clock = Date.now;
    let now = clock();
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      const remoteSessionId = '11111111-1111-1111-1111-111111111111';
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(join(sessionsDir, `rollout-2026-07-23T08-00-00-${remoteSessionId}.jsonl`), jsonl({ type: 'session_meta', payload: { id: remoteSessionId } }));
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: codexHome } });
      Date.now = () => now;
      contentReadClock.onDirectoryRead = () => { now += 60; };
      const request = { ...invocation(), source: { kind: 'codexHome' as const, home: 'user' as const, homePath: codexHome },
        maxItems: 1, searchTarget: 'content' as const, searchTerm: 'body-only phrase' };
      const first = await contribution.listCandidates({ ...request, scanDeadlineAtMs: now + 100 });
      if (!first.ok || !first.value.nextCursor) throw new Error('Expected a preparation continuation');
      const raw = decodeCodexExternalSessionIndexCursor(first.value.nextCursor);
      const preparation = parseCodexRolloutPreparationState(raw?.preparation);
      if (!raw || !preparation) throw new Error('Expected a strict native preparation cursor');
      const preparedBytes = Buffer.byteLength(JSON.stringify(first.value), 'utf8');
      await expect(contribution.listCandidates({ ...request, scanDeadlineAtMs: now + 100,
        maxSerializedBytes: preparedBytes - 1 })).resolves.toMatchObject({ ok: false, code: 'agent_error' });
      const unsafe = { ...raw, preparation: { ...preparation, directories: [{ ...preparation.directories[0], ref: { home: 0, path: '../outside' } }] } };
      await expect(contribution.listCandidates({ ...request, scanDeadlineAtMs: now + 100,
        cursor: Buffer.from(JSON.stringify(unsafe)).toString('base64url') })).resolves.toMatchObject({ ok: false, code: 'source_invalid' });
      const aborted = new AbortController();
      aborted.abort();
      await expect(contribution.listCandidates({ ...request, signal: aborted.signal, scanDeadlineAtMs: now + 100,
        cursor: first.value.nextCursor })).resolves.toMatchObject({ ok: false, code: 'cancelled' });
      // A cached directory kind cannot authorize a replacement symlink.
      await rm(join(codexHome, 'sessions', '2026'), { recursive: true });
      const outside = join(root, 'outside');
      await mkdir(outside);
      await symlink(outside, join(codexHome, 'sessions', '2026'), process.platform === 'win32' ? 'junction' : 'dir');
      const directories = await Promise.all(preparation.directories.map(async (entry) => {
        const current = await stat(join(codexHome, entry.ref.path), { bigint: true });
        return { ...entry, generation: `${current.dev}:${current.ino}:${current.birthtimeNs}` };
      }));
      const forged = { ...raw, preparation: { ...preparation, directories } };
      await expect(contribution.listCandidates({ ...request, scanDeadlineAtMs: now + 100,
        cursor: first.value.nextCursor })).resolves.toMatchObject({ ok: false, code: 'source_invalid' });
      await expect(contribution.listCandidates({ ...request, scanDeadlineAtMs: now + 100,
        cursor: Buffer.from(JSON.stringify(forged)).toString('base64url') })).resolves.toMatchObject({ ok: false, code: 'source_invalid' });
    } finally {
      contentReadClock.onDirectoryRead = null;
      Date.now = clock;
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['arrival', 'append', 'replace', 'remove'] as const)('resumes captured preparation across native file %s with physical identity checks', async (change) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-preparation-file-'));
    const clock = Date.now;
    let now = clock();
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      const remoteSessionId = '11111111-1111-1111-1111-111111111111';
      const rolloutPath = join(sessionsDir, `rollout-2026-07-23T08-00-00-${remoteSessionId}.jsonl`);
      const text = [
        jsonl({ type: 'session_meta', payload: { id: remoteSessionId } }),
        jsonl({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'body-only phrase' }] } }),
      ].join('');
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(rolloutPath, text);
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: codexHome } });
      Date.now = () => now;
      contentReadClock.onMetadataRead = () => { now += 60; };
      const request = { ...invocation(), source: { kind: 'codexHome' as const, home: 'user' as const, homePath: codexHome },
        maxItems: 1, searchTarget: 'content' as const, searchTerm: 'body-only phrase' };
      let cursor: string | undefined;
      let saved: ReturnType<typeof decodeCodexExternalSessionIndexCursor> = null;
      let preparation: ReturnType<typeof parseCodexRolloutPreparationState> = null;
      for (let page = 0; page < 20; page += 1) {
        const result = await contribution.listCandidates({ ...request, scanDeadlineAtMs: now + 100, ...(cursor ? { cursor } : {}) });
        if (!result.ok || !result.value.nextCursor) throw new Error('Expected a preparation continuation');
        cursor = result.value.nextCursor;
        saved = decodeCodexExternalSessionIndexCursor(cursor);
        preparation = parseCodexRolloutPreparationState(saved?.preparation);
        if (preparation?.files.length) break;
      }
      if (!saved || !preparation?.files.length) throw new Error('Expected a source-bound file preparation fact');
      contentReadClock.onMetadataRead = null;
      const beforeDirectory = await stat(sessionsDir, { bigint: true });
      const beforeFile = await stat(rolloutPath, { bigint: true });
      if (change === 'arrival') await writeFile(join(sessionsDir, 'rollout-new.jsonl'), jsonl({ type: 'session_meta', payload: { id: 'new-session' } }));
      else if (change === 'append') await appendFile(rolloutPath, jsonl({ type: 'event_msg', payload: { type: 'agent_message', message: 'new native reply' } }));
      else {
        await rename(rolloutPath, join(root, 'previous-rollout.jsonl'));
        if (change === 'replace') await writeFile(rolloutPath, text);
      }
      const afterDirectory = await stat(sessionsDir, { bigint: true });
      expect([afterDirectory.dev, afterDirectory.ino, afterDirectory.birthtimeNs]).toEqual([beforeDirectory.dev, beforeDirectory.ino, beforeDirectory.birthtimeNs]);
      if (change === 'arrival') {
        // The directory's freshness changes, but neither captured physical operand does.
        expect([afterDirectory.mtimeNs, afterDirectory.ctimeNs]).not.toEqual([beforeDirectory.mtimeNs, beforeDirectory.ctimeNs]);
      }
      if (change === 'arrival' || change === 'append') {
        const afterFile = await stat(rolloutPath, { bigint: true });
        expect([afterFile.dev, afterFile.ino, afterFile.birthtimeNs]).toEqual([beforeFile.dev, beforeFile.ino, beforeFile.birthtimeNs]);
        await expect(contribution.listCandidates({ ...request, cursor,
          ripgrep: { run: async () => ({ exitCode: 0, stdout: `${rolloutPath}\0`, stderr: '' }) },
        })).resolves.toMatchObject({ ok: true, value: { candidates: [{ remoteSessionId, match: { snippet: expect.stringContaining('body-only phrase') } }] } });
      } else {
        // Keep directory observations current to reach the native file-stat catch.
        const directories = await Promise.all(preparation.directories.map(async (entry) => {
          const current = await stat(join(codexHome, entry.ref.path), { bigint: true });
          return { ...entry, generation: `${current.dev}:${current.ino}:${current.birthtimeNs}` };
        }));
        await expect(contribution.listCandidates({ ...request,
          cursor: Buffer.from(JSON.stringify({ ...saved, preparation: { ...preparation, directories } })).toString('base64url'),
        })).resolves.toMatchObject({ ok: false, code: 'source_invalid' });
      }
    } finally {
      contentReadClock.onMetadataRead = null;
      Date.now = clock;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses the invocation ExecService to list native app-server threads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-public-native-threads-'));
    try {
      const codexHome = join(root, 'codex-home');
      await mkdir(codexHome, { recursive: true });
      const requests: string[] = [];
      const contribution = createCodexExternalSessionsContribution({
        env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      });

      await expect(contribution.listCandidates({
        source: { kind: 'codexHome', home: 'user' },
        maxItems: 10,
        // Native app-server listing is part of the searched browse; an
        // unsearched browse selects the bounded rollout chunk/preparation mode.
        searchTerm: '33333333',
        searchMode: 'full',
        ...invocation({ exec: createThreadListingExec(requests) }),
      })).resolves.toMatchObject({
        ok: true,
        value: {
          candidates: [{
            remoteSessionId: '33333333-3333-3333-3333-333333333333',
            title: 'Native app-server thread',
          }],
        },
      });

      expect(requests.filter((method) => method === 'thread/list')).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['tail', 'a missing source'],
    [
      'eyJ2IjoyLCJraW5kIjoiY29kZXhGb3J3YXJkQXBwU2VydmVyIiwidXBkYXRlZEF0TXMiOjE3MzYwMDAxMDAwMDAsInByZXZpZXdUZXh0IjoiUmVsZWFzZWQgcHJldmlldyJ9',
      'a disappeared released app-server source',
    ],
  ])('reports read_failed when native history cannot be read for %s (%s)', async (cursor) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-public-unavailable-'));
    try {
      const codexHome = join(root, 'codex-home');
      await mkdir(codexHome, { recursive: true });
      const contribution = createCodexExternalSessionsContribution({
        env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      });

      await expect(contribution.readAfterTranscript({
        source: { kind: 'codexHome', home: 'user' },
        remoteSessionId: '11111111-1111-1111-1111-111111111111',
        cursor,
        maxItems: 20,
        ...invocation(),
      })).resolves.toEqual({
        ok: true,
        value: { outcome: 'read_failed' },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('publishes readable fallback rows through the public contribution for unsupported native records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-public-unsupported-record-'));
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      const remoteSessionId = '11111111-1111-1111-1111-111111111111';
      const rolloutPath = join(
        sessionsDir,
        `rollout-2026-07-23T08-00-00-${remoteSessionId}.jsonl`,
      );
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(rolloutPath, [
        jsonl({
          type: 'session_meta',
          payload: { id: remoteSessionId, cwd: '/repo' },
        }),
        jsonl({ type: 'unsupported_record', payload: { ignored: true } }),
      ].join(''), 'utf8');
      const contribution = createCodexExternalSessionsContribution({
        env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      });
      const source = { kind: 'codexHome', home: 'user', homePath: codexHome } as const;

      const unsupportedPage = await contribution.pageTranscript({
        source,
        remoteSessionId,
        direction: 'older',
        maxItems: 20,
        ...invocation(),
      });
      expect(unsupportedPage.ok).toBe(true);
      if (!unsupportedPage.ok) throw new Error('Expected a readable unsupported-record page');
      expect(unsupportedPage.value.truncated).toBe(false);
      expect(unsupportedPage.value.items).toHaveLength(1);
      expect(AgentExternalSessionTranscriptRawRecordSchema.safeParse(unsupportedPage.value.items[0]?.raw).success).toBe(true);
      expect(unsupportedPage.value.items[0]).toMatchObject({ messageRole: 'agent', raw: { content: { type: 'acp', agentId: 'codex' } } });

      const manyUnsupported = Array.from({ length: 230 }, () => jsonl({ type: 'unsupported_record', payload: { ignored: true } })).join('');
      await appendFile(rolloutPath, manyUnsupported);
      const densePage = await contribution.pageTranscript({ source, remoteSessionId, direction: 'older', maxItems: 210,
        ...invocation({ maxSerializedBytes: 1024 * 1024 }) });
      if (!densePage.ok) throw new Error('Expected a readable dense unsupported-record page');
      expect(densePage.value.items).toHaveLength(210);
      const denseDiagnostic = densePage.value.diagnostics?.find((diagnostic) => diagnostic.code === 'external_sessions_transcript_unsupported_record');
      expect(ExternalSessionRefreshReadDiagnosticV1Schema.safeParse(denseDiagnostic).success).toBe(true);
      expect(denseDiagnostic).toMatchObject({ count: 210, positions: expect.any(Array) });
      expect(denseDiagnostic?.positions).toHaveLength(200);
      const smallPage = await contribution.pageTranscript({ source, remoteSessionId, direction: 'older', maxItems: 1,
        ...invocation({ maxSerializedBytes: 1024 * 1024 }) });
      if (!smallPage.ok) throw new Error('Expected one readable unsupported-record row');
      expect(smallPage.value.diagnostics).toEqual([{ code: 'external_sessions_transcript_unsupported_record', severity: 'benign', count: 1, positions: [expect.any(Number)] }]);

      await writeFile(rolloutPath, [
        jsonl({
          type: 'session_meta',
          payload: { id: remoteSessionId, cwd: '/repo' },
        }),
        jsonl({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'initial item' }],
          },
        }),
      ].join(''), 'utf8');
      const initial = await contribution.pageTranscript({
        source,
        remoteSessionId,
        direction: 'older',
        maxItems: 20,
        ...invocation(),
      });
      if (!initial.ok || !initial.value.tailCursor) {
        throw new Error('Expected a valid Codex transcript cursor');
      }

      await appendFile(rolloutPath, jsonl({
        type: 'response_item',
        payload: { type: 'unrecognized_current_shape' },
      }));
      const unsupportedAfter = await contribution.readAfterTranscript({
        source,
        remoteSessionId,
        cursor: initial.value.tailCursor,
        maxItems: 20,
        ...invocation(),
      });
      expect(unsupportedAfter.ok).toBe(true);
      if (!unsupportedAfter.ok || unsupportedAfter.value.outcome !== 'advanced') throw new Error('Expected an advanced unsupported-record page');
      expect(unsupportedAfter.value.items).toHaveLength(1);
      expect(AgentExternalSessionTranscriptRawRecordSchema.safeParse(unsupportedAfter.value.items[0]?.raw).success).toBe(true);
      expect(unsupportedAfter.value.diagnostics).toContainEqual(expect.objectContaining({ code: 'external_sessions_transcript_unsupported_record', severity: 'benign' }));
      await appendFile(rolloutPath, manyUnsupported);
      const denseAfter = await contribution.readAfterTranscript({ source, remoteSessionId, cursor: unsupportedAfter.value.nextCursor,
        maxItems: 230, ...invocation({ maxSerializedBytes: 1024 * 1024 }) });
      if (!denseAfter.ok || denseAfter.value.outcome !== 'advanced') throw new Error('Expected dense unsupported-record forward progress');
      expect(denseAfter.value.items).toHaveLength(230);
      const afterDiagnostic = denseAfter.value.diagnostics?.find((diagnostic) => diagnostic.code === 'external_sessions_transcript_unsupported_record');
      expect(ExternalSessionRefreshReadDiagnosticV1Schema.safeParse(afterDiagnostic).success).toBe(true);
      expect(afterDiagnostic).toMatchObject({ count: 230 });
      expect(afterDiagnostic?.positions).toHaveLength(200);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports an unreadable rollout as an Agent fault rather than an unavailable Agent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-public-unreadable-rollout-'));
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      const remoteSessionId = '11111111-1111-1111-1111-111111111111';
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(join(sessionsDir, `rollout-2026-07-23T08-00-00-${remoteSessionId}.jsonl`), Buffer.concat([
        Buffer.from(jsonl({ type: 'session_meta', payload: { id: remoteSessionId, cwd: '/repo' } })),
        Buffer.from('{"type":"response_item","payload":{"type":"message","role":"user","content":"'),
        Buffer.from([0xff, 0xfe]),
        Buffer.from('"}}\n'),
      ]));
      const contribution = createCodexExternalSessionsContribution({
        env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      });

      await expect(contribution.pageTranscript({
        source: { kind: 'codexHome', home: 'user', homePath: codexHome },
        remoteSessionId,
        direction: 'older',
        maxItems: 20,
        ...invocation(),
      })).resolves.toMatchObject({ ok: false, code: 'agent_error' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns typed unsupported rather than an authoritative empty page for newer paging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-public-newer-unsupported-'));
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      const remoteSessionId = '44444444-4444-4444-4444-444444444444';
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(
        join(sessionsDir, `rollout-2026-07-23T09-00-00-${remoteSessionId}.jsonl`),
        [
          jsonl({
            type: 'session_meta',
            payload: { id: remoteSessionId, cwd: '/repo' },
          }),
          jsonl({
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'older-only history' }],
            },
          }),
        ].join(''),
        'utf8',
      );
      const contribution = createCodexExternalSessionsContribution({
        env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      });

      await expect(contribution.pageTranscript({
        source: { kind: 'codexHome', home: 'user', homePath: codexHome },
        remoteSessionId,
        direction: 'newer',
        maxItems: 10,
        ...invocation(),
      })).resolves.toEqual({
        ok: false,
        code: 'unsupported',
        message: 'Codex external-session newer paging is not supported.',
        retryable: false,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves the rollout owners candidate, link identity, transcript, and cursor semantics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-public-external-'));
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      await mkdir(sessionsDir, { recursive: true });
      const firstSessionId = '11111111-1111-1111-1111-111111111111';
      const secondSessionId = '22222222-2222-2222-2222-222222222222';
      const firstFile = join(sessionsDir, `rollout-2026-07-23T08-00-00-${firstSessionId}.jsonl`);
      await writeFile(firstFile, [
        jsonl({
          type: 'session_meta',
          timestamp: '2026-07-23T08:00:00.000Z',
          payload: { id: firstSessionId, timestamp: '2026-07-23T08:00:00.000Z', cwd: '/repo/first' },
        }),
        jsonl({
          type: 'response_item',
          timestamp: '2026-07-23T08:01:00.000Z',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'first public message' }],
          },
        }),
        jsonl({
          type: 'response_item',
          timestamp: '2026-07-23T08:02:00.000Z',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'first public response' }],
          },
        }),
      ].join(''), 'utf8');
      await writeFile(
        join(sessionsDir, `rollout-2026-07-23T09-00-00-${secondSessionId}.jsonl`),
        jsonl({
          type: 'session_meta',
          timestamp: '2026-07-23T09:00:00.000Z',
          payload: { id: secondSessionId, timestamp: '2026-07-23T09:00:00.000Z', cwd: '/repo/second' },
        }),
        'utf8',
      );

      const env = { CODEX_HOME: codexHome } as NodeJS.ProcessEnv;
      const activeServerDir = join(root, 'active-server');
      const contribution = createCodexExternalSessionsContribution({ env });
      const source = { kind: 'codexHome', home: 'user' } as const;
      expect(await contribution.resolveSource({ source, ...invocation(), includeAccountingSource: false })).toEqual({
        ok: true,
        value: { source: { kind: 'codexHome', home: 'user', homePath: codexHome }, transcriptMediaReadRoots: [codexHome] },
      });
      const resolvedSource = await contribution.resolveSource({ source, ...invocation() });
      expect(resolvedSource).toEqual({
        ok: true,
        value: {
          source: { kind: 'codexHome', home: 'user', homePath: codexHome },
          transcriptMediaReadRoots: [codexHome],
          accountingSource: {
            rootPath: codexHome,
            rootField: 'homePath',
            resourceKey: expect.stringMatching(/^codex:accounting:[A-Za-z0-9_-]{43}$/u),
            accountingSources: ['codex-native-accounting'],
            discoveredFileCount: 2,
            changeObservation: 'watch_file_changes',
            watchFileChanges: {
              files: [firstFile, join(sessionsDir, `rollout-2026-07-23T09-00-00-${secondSessionId}.jsonl`)],
              topologyDirectories: [
                join(codexHome, 'archived_sessions'),
                join(codexHome, 'sessions'),
                join(codexHome, 'sessions', '2026'),
                join(codexHome, 'sessions', '2026', '07'),
                sessionsDir,
              ],
            },
          },
        },
      });
      if (!resolvedSource.ok) throw new Error('Expected resolved Codex source');

      const listed = await contribution.listCandidates({
        source: resolvedSource.value.source,
        maxItems: 1,
        searchMode: 'fast',
        ...invocation(),
      });
      expect(listed).toMatchObject({
        ok: true,
        value: {
          candidates: [{ remoteSessionId: secondSessionId }],
          nextCursor: expect.any(String),
        },
      });
      if (!listed.ok) throw new Error('Expected Codex candidates');
      expect(listed.value.candidates).toHaveLength(1);
      expect(listed.value.candidates[0]?.linkData).toMatchObject({
        source: { kind: 'codexHome', home: 'user', homePath: codexHome },
      });

      const firstCandidate = await contribution.listCandidates({
        source: resolvedSource.value.source,
        maxItems: 10,
        searchTerm: firstSessionId,
        searchMode: 'fast',
        ...invocation(),
      });
      if (!firstCandidate.ok) throw new Error('Expected first Codex candidate');

      const fullSearch = await contribution.listCandidates({
        source: resolvedSource.value.source,
        maxItems: 10,
        searchTerm: 'first public message',
        searchMode: 'full',
        ...invocation(),
      });
      expect(fullSearch).toMatchObject({
        ok: true,
        value: {
          candidates: [{ remoteSessionId: firstSessionId }],
          nextCursor: null,
        },
      });
      if (!fullSearch.ok) throw new Error('Expected complete Codex rollout search');
      expect(fullSearch.value.searchIncomplete).toBeUndefined();

      const identity = await contribution.resolveLinkIdentity({
        source: resolvedSource.value.source,
        remoteSessionId: firstSessionId,
        linkData: firstCandidate.value.candidates[0]?.linkData,
        ...invocation(),
      });
      expect(identity).toMatchObject({
        ok: true,
        value: {
          source: { kind: 'codexHome', home: 'user', homePath: codexHome },
          remoteSessionId: firstSessionId,
          transcriptMediaReadRoots: [codexHome],
          linkData: {
            source: { kind: 'codexHome', home: 'user', homePath: codexHome },
          },
        },
      });
      if (!identity.ok) throw new Error('Expected Codex identity');

      const page = await contribution.pageTranscript({
        source: identity.value.source,
        remoteSessionId: identity.value.remoteSessionId,
        direction: 'older',
        maxItems: 10,
        ...invocation(),
      });
      expect(page).toMatchObject({
        ok: true,
        value: {
          items: expect.arrayContaining([expect.objectContaining({ id: expect.any(String) })]),
          tailCursor: expect.any(String),
        },
      });
      if (!page.ok) throw new Error('Expected Codex transcript');
      expect(page.value.items.some((item) => item.messageRole === 'user')).toBe(true);
      expect(page.value.items.some((item) => item.messageRole === 'agent')).toBe(true);

      await appendFile(firstFile, jsonl({
        type: 'response_item',
        timestamp: '2026-07-23T08:02:00.000Z',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'follow-up public message' }],
        },
      }), 'utf8');
      const after = await contribution.readAfterTranscript({
        source: identity.value.source,
        remoteSessionId: firstSessionId,
        cursor: page.value.tailCursor!,
        maxItems: 10,
        ...invocation(),
      });
      expect(after).toMatchObject({
        ok: true,
        value: {
          items: [expect.objectContaining({ id: expect.any(String) })],
        },
      });
      if (!after.ok) throw new Error('Expected Codex transcript continuation');
      expect(after.value.items[0]).toMatchObject({
        id: expect.any(String),
        messageRole: 'agent',
        raw: {
          role: 'agent',
          content: {
            type: 'codex',
            data: {
              type: 'message',
              message: 'follow-up public message',
            },
          },
        },
      });
      expect(after.value.items[0]?.id).not.toBe(page.value.items[0]?.id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('advances a bounded nonempty appended suffix with a continuation cursor instead of reporting a gap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-public-read-after-bound-'));
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      const remoteSessionId = '44444444-4444-4444-4444-444444444444';
      const rolloutPath = join(
        sessionsDir,
        `rollout-2026-07-23T08-00-00-${remoteSessionId}.jsonl`,
      );
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(rolloutPath, [
        jsonl({
          type: 'session_meta',
          timestamp: '2026-07-23T08:00:00.000Z',
          payload: { id: remoteSessionId, cwd: '/repo' },
        }),
        jsonl({
          type: 'response_item',
          timestamp: '2026-07-23T08:01:00.000Z',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'initial' }],
          },
        }),
      ].join(''), 'utf8');
      const contribution = createCodexExternalSessionsContribution({
        env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      });
      const source = { kind: 'codexHome', home: 'user', homePath: codexHome } as const;
      const initial = await contribution.pageTranscript({
        source,
        remoteSessionId,
        direction: 'older',
        maxItems: 10,
        ...invocation(),
      });
      if (!initial.ok || !initial.value.tailCursor) {
        throw new Error('Expected a Codex tail cursor');
      }

      await appendFile(rolloutPath, [
        jsonl({
          type: 'response_item',
          timestamp: '2026-07-23T08:02:00.000Z',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'first appended item' }],
          },
        }),
        jsonl({
          type: 'response_item',
          timestamp: '2026-07-23T08:03:00.000Z',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'second appended item' }],
          },
        }),
      ].join(''), 'utf8');

      const firstBounded = await contribution.readAfterTranscript({
        source,
        remoteSessionId,
        cursor: initial.value.tailCursor,
        maxItems: 1,
        ...invocation(),
      });
      if (!firstBounded.ok || firstBounded.value.outcome !== 'advanced') {
        throw new Error('Expected a bounded appended suffix to advance');
      }
      expect(firstBounded.value.items).toHaveLength(1);
      expect(JSON.stringify(firstBounded.value.items[0])).toContain('first appended item');
      expect(firstBounded.value.hasMore).toBe(true);
      expect(firstBounded.value.nextCursor).toEqual(expect.any(String));

      // The bounded page's continuation cursor must make progress without
      // repeating or dropping the appended suffix.
      const secondBounded = await contribution.readAfterTranscript({
        source,
        remoteSessionId,
        cursor: firstBounded.value.nextCursor,
        maxItems: 1,
        ...invocation(),
      });
      if (!secondBounded.ok || secondBounded.value.outcome !== 'advanced') {
        throw new Error('Expected the bounded continuation to advance');
      }
      expect(secondBounded.value.items).toHaveLength(1);
      expect(JSON.stringify(secondBounded.value.items[0])).toContain('second appended item');
      expect(secondBounded.value.hasMore).toBe(false);
      expect(secondBounded.value.nextCursor).toEqual(expect.any(String));

      await expect(contribution.readAfterTranscript({
        source,
        remoteSessionId,
        cursor: secondBounded.value.nextCursor,
        maxItems: 1,
        ...invocation(),
      })).resolves.toEqual({
        ok: true,
        value: { outcome: 'already_current' },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('advances malformed UTF-8 diagnostics through the public read-after result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-public-malformed-'));
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      const remoteSessionId = '33333333-3333-3333-3333-333333333333';
      const rolloutPath = join(
        sessionsDir,
        `rollout-2026-07-23T10-00-00-${remoteSessionId}.jsonl`,
      );
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(rolloutPath, [
        jsonl({
          type: 'session_meta',
          timestamp: '2026-07-23T10:00:00.000Z',
          payload: { id: remoteSessionId, timestamp: '2026-07-23T10:00:00.000Z', cwd: '/repo' },
        }),
        jsonl({
          type: 'response_item',
          timestamp: '2026-07-23T10:00:01.000Z',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'initial' }],
          },
        }),
      ].join(''), 'utf8');
      const contribution = createCodexExternalSessionsContribution({
        env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      });
      const source = { kind: 'codexHome', home: 'user', homePath: codexHome } as const;
      const page = await contribution.pageTranscript({
        source,
        remoteSessionId,
        direction: 'older',
        maxItems: 10,
        ...invocation(),
      });
      if (!page.ok || !page.value.tailCursor) throw new Error('Expected Codex tail cursor');

      const before = (await readFile(rolloutPath)).byteLength;
      const prefix = Buffer.from(
        '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"',
        'utf8',
      );
      await appendFile(
        rolloutPath,
        Buffer.concat([prefix, Buffer.from([0xff]), Buffer.from('"}]}}\n', 'utf8')]),
      );

      await expect(contribution.readAfterTranscript({
        source,
        remoteSessionId,
        cursor: page.value.tailCursor,
        maxItems: 10,
        ...invocation(),
      })).resolves.toMatchObject({
        ok: true,
        value: {
          outcome: 'advanced',
          items: [],
          nextCursor: expect.any(String),
          boundary: expect.any(String),
          diagnostics: [{
            code: 'malformed_source_utf8',
            severity: 'required',
            count: 1,
            positions: [before + prefix.byteLength],
          }],
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed for cancellation, deadlines, invalid item limits, and unfit byte bounds', async () => {
    const controller = new AbortController();
    controller.abort();
    const contribution = createCodexExternalSessionsContribution({
      env: { CODEX_HOME: '/tmp/codex-public-bounds' } as NodeJS.ProcessEnv,
    });
    const source = { kind: 'codexHome', home: 'user' } as const;

    expect(await contribution.resolveSource({
      source,
      ...invocation({ signal: controller.signal }),
    })).toMatchObject({ ok: false, code: 'cancelled' });
    expect(await contribution.resolveSource({
      source,
      ...invocation({ deadlineAtMs: Date.now() - 1 }),
    })).toMatchObject({ ok: false, code: 'timeout' });
    await expect(contribution.listCandidates({
      source,
      maxItems: 0,
      searchMode: 'fast',
      ...invocation(),
    })).resolves.toMatchObject({ ok: false, code: 'invalid_request' });
    // A byte bound that is not a positive size is a MALFORMED inbound request.
    expect(await contribution.resolveSource({
      source,
      ...invocation({ maxSerializedBytes: 0 }),
    })).toMatchObject({ ok: false, code: 'invalid_request' });
    // A well-formed bound the Agent's own OUTPUT cannot fit is not a caller
    // mistake to correct: it is a nonretryable Agent-side failure, and it is the
    // same classification the host's bounded-invocation owner already applies
    // when a leaf overruns the identical budget.
    expect(await contribution.resolveSource({
      source,
      ...invocation({ maxSerializedBytes: 1 }),
    })).toMatchObject({ ok: false, code: 'agent_error', retryable: false });
  });

  it('keeps connected-service home identity qualified through candidates and persisted links', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-public-connected-home-'));
    try {
      const activeServerDir = join(root, 'active-server');
      const codexHome = join(
        activeServerDir,
        'daemon',
        'connected-services',
        'homes',
        'openai-codex',
        'profile-1',
        'codex',
        'codex-home',
      );
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      await mkdir(sessionsDir, { recursive: true });
      const remoteSessionId = '33333333-3333-3333-3333-333333333333';
      await writeFile(
        join(sessionsDir, `rollout-2026-07-23T10-00-00-${remoteSessionId}.jsonl`),
        jsonl({
          type: 'session_meta',
          timestamp: '2026-07-23T10:00:00.000Z',
          payload: { id: remoteSessionId, timestamp: '2026-07-23T10:00:00.000Z', cwd: '/repo/connected' },
        }),
        'utf8',
      );
      const contribution = createCodexExternalSessionsContribution({
        env: {} as NodeJS.ProcessEnv,
      });
      const source = {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'profile-1',
        homePath: codexHome,
      } as const;
      const admittedSource = source;

      const listed = await contribution.listCandidates({
        source,
        maxItems: 10,
        searchMode: 'fast',
        ...invocation(),
      });
      expect(listed).toMatchObject({
        ok: true,
        value: {
          candidates: [{
            remoteSessionId,
            linkData: { source: admittedSource },
          }],
        },
      });
      if (!listed.ok) throw new Error('Expected connected-service Codex candidate');

      const linked = await contribution.resolveLinkedIdentity({
        source,
        remoteSessionId,
        linkData: listed.value.candidates[0]?.linkData ?? {},
        ...invocation(),
      });
      expect(linked).toMatchObject({
        ok: true,
        value: {
          source: admittedSource,
          remoteSessionId,
          linkData: { source: admittedSource },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires the host-admitted connected-service home before granting media read roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-media-read-roots-'));
    try {
      const activeServerDir = join(root, 'active-server');
      const verifiedHome = join(
        activeServerDir,
        'daemon',
        'connected-services',
        'homes',
        'openai-codex',
        'profile-1',
        'codex',
        'codex-home',
      );
      await mkdir(join(verifiedHome, 'sessions'), { recursive: true });
      const contribution = createCodexExternalSessionsContribution({
        env: {} as NodeJS.ProcessEnv,
      });
      const unstampedSource = {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'profile-1',
      } as const;

      await expect(contribution.resolveSource({
        source: unstampedSource,
        ...invocation(),
      })).resolves.toMatchObject({ ok: false, code: 'source_invalid' });

      const resolvedVerified = await contribution.resolveSource({
        source: { ...unstampedSource, homePath: verifiedHome },
        ...invocation(),
      });
      if (!resolvedVerified.ok) throw new Error('Expected a resolved Codex source');
      expect(resolvedVerified.value.transcriptMediaReadRoots).toEqual([await realpath(verifiedHome)]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves link identity with the provider session id byte-exact and rejects blank', async () => {
    // Codex mints this id; the resolved link identity and the descriptor it
    // writes must address the same provider session the caller named.
    const exactRemoteSessionId = '  provider\nses/AB+cd==  ';
    const codexHome = '/tmp/codex-public-link-identity-exact';
    const contribution = createCodexExternalSessionsContribution({
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
    });
    const source = { kind: 'codexHome', home: 'user', homePath: codexHome } as const;

    expect(await contribution.resolveLinkIdentity({
      source,
      remoteSessionId: exactRemoteSessionId,
      linkData: {
        codexBackendMode: 'appServer',
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          agent: {
            backendMode: 'appServer',
            providerSessionId: exactRemoteSessionId,
            appServerTransport: 'daemonProxy',
          },
        },
      },
      ...invocation(),
    })).toMatchObject({
      ok: true,
      value: {
        remoteSessionId: exactRemoteSessionId,
        linkData: {
          runtimeDescriptorV1: {
            agent: {
              providerSessionId: exactRemoteSessionId,
              appServerTransport: 'daemonProxy',
            },
          },
        },
      },
    });

    expect(await contribution.resolveLinkIdentity({
      source,
      remoteSessionId: ' \n\t ',
      linkData: { codexBackendMode: 'appServer' },
      ...invocation(),
    })).toMatchObject({ ok: false, code: 'invalid_request' });
  });

  it('canonicalizes supported backend-mode aliases and rejects unsupported link identity modes', async () => {
    const codexHome = '/tmp/codex-public-link-identity';
    const contribution = createCodexExternalSessionsContribution({
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
    });
    const source = { kind: 'codexHome', home: 'user', homePath: codexHome } as const;

    expect(await contribution.resolveLinkIdentity({
      source,
      remoteSessionId: 'thread-alias',
      linkData: { codexBackendMode: 'mcp_resume' },
      ...invocation(),
    })).toMatchObject({
      ok: true,
      value: {
        remoteSessionId: 'thread-alias',
        linkData: {
          codexBackendMode: 'acp',
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'codex',
            agent: {
              backendMode: 'acp',
              providerSessionId: 'thread-alias',
            },
          },
        },
      },
    });

    expect(await contribution.resolveLinkIdentity({
      source,
      remoteSessionId: 'thread-invalid',
      linkData: { codexBackendMode: 'unsupported-mode' },
      ...invocation(),
    })).toMatchObject({
      ok: false,
      code: 'source_invalid',
      message: 'codex_backend_mode_unsupported',
    });
    expect(await contribution.resolveLinkedIdentity({
      source,
      remoteSessionId: 'thread-invalid',
      linkData: { codexBackendMode: 'unsupported-mode' },
      ...invocation(),
    })).toMatchObject({
      ok: false,
      code: 'source_invalid',
      message: 'codex_backend_mode_unsupported',
    });
  });
});
