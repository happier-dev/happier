import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import type { AgentSessionRuntime, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';

import { createCodexNativeAppServerClient } from './client.js';
import { createCodexAppServerRuntime, startCodexAppServerRuntime } from './runtime.js';
import { openCodexNativeAppServerSession } from './native.js';

// The network fixture models pinned Codex 0.159.2's empty paginated rollout:
// name/set supplies metadata; a full read persists it; native resume then works.
export async function withCodexNativeAttachFixture(run: (fixture: {
  runtime: ReturnType<typeof createCodexAppServerRuntime>;
  requests: Array<{ method: string; params: Record<string, unknown> }>;
  exec: ExecService;
  endpoints: readonly string[];
  resume(): Promise<unknown>;
  failRead(): void;
  failResume(message: string): void;
  openConfiguredSession(providerSessionId?: string): Promise<AgentSessionRuntime>;
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'happier-codex-native-attach-'));
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\happier-codex-native-attach-${process.pid}-${Date.now()}`
    : join(root, 'app-server.sock');
  const server = createServer();
  const ws = new WebSocketServer({ server });
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const endpoints: string[] = [];
  let named = false;
  let materialized = false;
  let rejectRead = false;
  let resumeFailure: string | null = null;
  const bindServer = (webSockets: WebSocketServer) => webSockets.on('connection', (socket) => socket.on('message', (payload) => {
    const message = JSON.parse(payload.toString()) as {
      id?: number; method: string; params?: Record<string, unknown>;
    };
    if (message.id === undefined) return;
    const params = message.params ?? {};
    requests.push({ method: message.method, params });
    let result: unknown = {};
    let error: unknown;
    if (message.method === 'thread/start') {
      result = { thread: { id: 'fresh-thread', turns: [] }, sandbox: { type: 'readOnly' }, reasoningEffort: 'low' };
    } else if (message.method === 'thread/name/set') {
      named = true;
    } else if (message.method === 'thread/read') {
      if (rejectRead) error = { code: -32000, message: 'rollout persistence failed' };
      else {
        materialized = named && params.includeTurns === true;
        result = { thread: { id: params.threadId, turns: [] } };
      }
    } else if (message.method === 'thread/resume') {
      if (resumeFailure) error = { code: -32000, message: resumeFailure };
      else if (params.threadId === 'fresh-thread' && !materialized) error = { code: -32000, message: 'no rollout found' };
      else result = { thread: { id: params.threadId, turns: [] }, sandbox: { type: 'readOnly' }, reasoningEffort: 'low' };
    } else if (message.method === 'experimentalFeature/list') {
      result = { data: [{ name: 'realtime_conversation', enabled: true }], nextCursor: null };
    }
    socket.send(JSON.stringify({ id: message.id, ...(error ? { error } : { result }) }));
    if (message.method === 'thread/realtime/start') {
      socket.send(JSON.stringify({ method: 'thread/realtime/started', params: { threadId: 'fresh-thread', realtimeSessionId: null, version: 'v3' } }));
      socket.send(JSON.stringify({ method: 'thread/realtime/sdp', params: { threadId: 'fresh-thread', sdp: 'answer' } }));
    }
  }));
  bindServer(ws);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  // Only tool resolution crosses the Exec boundary; the real client uses Unix transport.
  const exec = {
    systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'codex-cli' }, executablePath: '/fixture/codex' }) },
  } as unknown as ExecService;
  const createClient = async () => await createCodexNativeAppServerClient({
    exec, processEnv: {}, transport: { kind: 'unixWebSocket', socketPath, realtimeConversationAdvertised: true },
  });
  const runtime = createCodexAppServerRuntime({
    directory: root, happierSessionId: 'actual-happier-session',
    resolveCurrentPolicy: () => ({ approvalPolicy: 'never', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } }),
    host: { baseProcessEnv: {}, logger: { debug: vi.fn(), warn: vi.fn() }, createClient },
  });
  const opened: { session: AgentSessionRuntime | null } = { session: null };
  await runtime.updateConfig?.({ configOption: { id: 'reasoning_effort', value: 'low' } });
  const nativeExec = {
    ...exec,
    run: async (request: { args: readonly string[] }) => ({
      stdout: new TextEncoder().encode(request.args.includes('--version') ? 'codex-cli 0.159.2' : ''),
      stderr: new Uint8Array(),
      termination: { observed: { kind: 'exit', exitCode: 0 } },
    }),
    spawn: async (request: { args: readonly string[] }) => {
      const endpoint = request.args[request.args.indexOf('--listen') + 1];
      if (!endpoint?.startsWith('unix://')) throw new Error('Expected shared native socket launch');
      endpoints.push(endpoint);
      const nativeSocketPath = endpoint.slice('unix://'.length);
      await mkdir(dirname(nativeSocketPath), { recursive: true, mode: 0o700 });
      const nativeServer = createServer();
      const nativeWebSockets = new WebSocketServer({ server: nativeServer });
      bindServer(nativeWebSockets);
      await new Promise<void>((resolve, reject) => {
        nativeServer.once('error', reject);
        nativeServer.listen(nativeSocketPath, resolve);
      });
      let settleExit!: (value: unknown) => void;
      const exited = new Promise((resolve) => { settleExit = resolve; });
      return {
        wait: () => exited,
        dispose: async () => {
          for (const socket of nativeWebSockets.clients) socket.terminate();
          await new Promise<void>((resolve) => nativeWebSockets.close(() => resolve()));
          await new Promise<void>((resolve, reject) => nativeServer.close((error) => error ? reject(error) : resolve()));
          settleExit({ termination: { observed: { kind: 'exit', exitCode: 0 } } });
        },
      };
    },
  } as unknown as ExecService;
  try {
    await run({ runtime, requests, exec: nativeExec, endpoints, failRead: () => { rejectRead = true; }, failResume: (message) => { resumeFailure = message; }, async openConfiguredSession(providerSessionId) {
      // Exec and host SDK services are genuine external boundaries; native/runtime/client logic stays real.
      const context = {
        signal: new AbortController().signal,
        services: { exec: nativeExec, logger: { debug: vi.fn(), warn: vi.fn() }, sessions: {} },
        session: { id: 'actual-happier-session', services: {} },
        ui: { title: { set: async () => undefined } },
      } as unknown as AgentSessionRuntimeContext;
      opened.session = await openCodexNativeAppServerSession({
        ...(providerSessionId ? { kind: 'resume' as const, providerSessionId } : { kind: 'create' as const }),
        sessionId: 'actual-happier-session', cwd: root,
        launchEnvironment: { values: { CODEX_HOME: root }, unset: [] },
        configuration: {
          mode: { value: null, updatedAtMs: 0 }, model: { value: 'fixture-model', updatedAtMs: 1 },
          permissionIntent: { value: 'read-only', updatedAtMs: 1 },
          options: { reasoning_effort: { value: 'low', updatedAtMs: 1 } },
        },
        startupInstructions: { v: 1, id: 'fixture.startup', revision: 1, instructions: 'Actual startup instructions.' },
      }, context);
      return opened.session;
    }, async resume() {
      const peer = await createClient();
      try { return await peer.request('thread/resume', { threadId: 'fresh-thread' }); }
      finally { await peer.dispose(); }
    } });
  } finally {
    await opened.session?.dispose();
    await runtime.dispose();
    await new Promise<void>((resolve) => ws.close(() => resolve()));
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
}
