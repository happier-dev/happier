import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { AgentExecutionRunConversationRuntimeV1, AgentExecutionRunRuntimeContextV1, AgentSessionConfigurationSnapshot, AgentSessionOpenRequest, AgentSessionRuntime, AgentSessionRuntimeContext, AgentSessionRuntimeFactory } from '@happier-dev/plugin-sdk/agents/runtime';

import { buildCodexAppServerArgs, createCodexNativeAppServerClient } from './client.js';
import { createCodexAppServerRuntime, startCodexAppServerRuntime, type CodexAppServerRuntimeHost } from './runtime.js';
import { openCodexNativeAppServerExecutionRunConversation, openCodexNativeAppServerSession } from './native.js';
import type { CodexProviderBindingEngineConfigV1 } from '../../providerBinding/runtimeConfig.js';
import { resolveCodexTerminalPermissionPolicy } from '../terminal/permissionPolicy.js';
import { connectManagedJsonRpcTestClient, createManagedJsonRpcTestClient } from '../../../../../../../apps/cli/src/testkit/process/managedJsonRpc';
import { CODEX_RAW_PROXY_FIXTURE_SCRIPT } from './client.test-support';

// The network fixture models pinned Codex 0.159.2's empty paginated rollout:
// name/set supplies metadata; a full read persists it; native resume then works.
export async function withCodexNativeAttachFixture(run: (fixture: {
  runtime: ReturnType<typeof createCodexAppServerRuntime>;
  requests: Array<{ method: string; params: Record<string, unknown> }>;
  exec: ExecService;
  launchEnvironment: NonNullable<AgentSessionOpenRequest['launchEnvironment']>;
  directory: string;
  endpoints: readonly string[];
  nativeLaunches: readonly (readonly string[])[];
  nativeProcessExits: readonly string[];
  resume(): Promise<unknown>;
  failRead(): void;
  failResume(message: string): void;
  emitNotification(method: string, params: Record<string, unknown>): void;
  failNextRevert(outcome: 'methodNotFound' | 'applied' | 'notApplied'): void;
  openConfiguredSession(providerSessionId?: string, mcpServers?: AgentSessionOpenRequest['mcpServers']): Promise<AgentSessionRuntime>;
  openConfiguredRun(): Promise<AgentExecutionRunConversationRuntimeV1>;
}) => Promise<void>, options: {
  longTemporaryDirectory?: boolean;
  toolRestriction?: Pick<AgentSessionConfigurationSnapshot, 'allowedTools' | 'unlistedTools'>;
  mcpServers?: AgentSessionOpenRequest['mcpServers'];
  mcpToolPolicy?: AgentSessionOpenRequest['mcpToolPolicy'];
  permissionMode?: AgentSessionConfigurationSnapshot['permissionIntent']['value'];
  interactions?: CodexAppServerRuntimeHost['ui'];
  models?: AgentSessionRuntimeContext['session']['services']['models'];
  modelListResponse?: unknown;
  accountRead?: () => unknown | Promise<unknown>;
  rateLimitsRead?: () => unknown | Promise<unknown>;
  connectedAccountService?: Readonly<{ pluginId: string; localId: string }>;
  sessionConnectedAccounts?: AgentSessionOpenRequest['connectedAccounts'];
  pluginListResponse?: unknown;
  skillListResponse?: unknown;
  skillListResponseForRoots?: (extraRoots: readonly string[], params: Readonly<Record<string, unknown>>) => unknown;
  sessionFactory?: Pick<AgentSessionRuntimeFactory, 'open'>;
  skillListFailure?: Readonly<{ code: number; message: string }>;
  initializeFailure?: Readonly<{ code: number; message: string }>;
  goalFailure?: Readonly<{ code: number; message: string }>;
  goalThreadsVisibleOnlyWhenLoaded?: boolean;
  onTurnStart?: (input: Readonly<{ socket: WebSocket; params: Record<string, unknown>; turnId: string }>) => void | Promise<void>;
  beforeTurnStartResponse?: () => Promise<void>;
  beforeThreadResumeResponse?: (input: Readonly<{ socket: WebSocket; params: Record<string, unknown> }>) => void | Promise<void>;
  turnIdForStart?: (occurrence: number) => string;
  nativeToolMode?: 'code_mode_only' | 'direct';
  nativeMcpServers?: Readonly<Record<string, Readonly<{ enabled: boolean }>>>;
  runtimeAuthHost?: Pick<CodexAppServerRuntimeHost, 'nativeHome' | 'refreshRuntimeAuth'>;
  initialProviderBinding?: CodexProviderBindingEngineConfigV1;
  providerBinding?: AgentSessionOpenRequest['providerBinding'];
  configuration?: AgentSessionConfigurationSnapshot;
  connectedAccounts?: AgentSessionRuntimeContext['services']['connectedAccounts'];
  processEnv?: Readonly<Record<string, string | undefined>>;
  skills?: AgentSessionOpenRequest['skills'];
  startupInstructions?: Extract<AgentSessionOpenRequest, { kind: 'create' }>['startupInstructions'] | null;
  appServerTransport?: 'daemonProxy';
  rejectExtraRootsSet?: boolean;
  nativeSpawnFailure?: Error;
  nativeProcessResult?: PluginProcessResult;
  logger?: CodexAppServerRuntimeHost['logger'];
  beforeExtraRootsSetResponse?: (input: Readonly<{ occurrence: number; params: Record<string, unknown> }>) => Promise<void>;
  directory?: string;
  observer?: Readonly<{
    recordAppServerRequest(method: string, params: unknown): void;
    recordLaunch(input: Readonly<{ argv: readonly string[]; env?: Readonly<Record<string, string | undefined>> }>): void;
  }>;
} = {}) {
  // Unix IPC fixtures need short paths; TMPDIR is a genuine OS/environment boundary.
  const root = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'ca-'));
  const configuredLaunchEnvironment = {
    values: { CODEX_HOME: root, ...Object.fromEntries(Object.entries(options.processEnv ?? {})
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')) },
    unset: ['CODEX_SQLITE_HOME',
      ...(options.processEnv?.HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON ? [] : ['HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON'])],
  } satisfies NonNullable<AgentSessionOpenRequest['launchEnvironment']>;
  const priorTmpdir = process.env.TMPDIR;
  const nativeTmpdir = options.longTemporaryDirectory ? join(root, 't'.repeat(100)) : root;
  await mkdir(nativeTmpdir, { recursive: true });
  process.env.TMPDIR = nativeTmpdir;
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\happier-codex-native-attach-${process.pid}-${Date.now()}`
    : join(root, 's');
  const server = createServer();
  const ws = new WebSocketServer({ server });
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const endpoints: string[] = [];
  const nativeLaunches: (readonly string[])[] = [];
  const nativeProcessExits: string[] = [];
  let named = false;
  let materialized = false;
  let goal: Record<string, unknown> | null = null;
  let rejectRead = false;
  let resumeFailure: string | null = null;
  let extraRootsSetOccurrence = 0;
  let turnStartOccurrence = 0;
  let revertFailure: 'methodNotFound' | 'applied' | 'notApplied' | null = null;
  const nativeServers = new Set([ws]);
  const turns: Array<{ id: string; status: string }> = [];
  const emitNotification = (method: string, params: Record<string, unknown>) => {
    if (method === 'thread/goal/cleared') goal = null;
    if (method === 'thread/goal/updated' && params.goal && typeof params.goal === 'object') {
      goal = params.goal as Record<string, unknown>;
    }
    if (method === 'turn/completed' && params.turn && typeof params.turn === 'object') {
      const observed = params.turn as { id?: unknown; status?: unknown };
      const turn = turns.find((entry) => entry.id === observed.id);
      if (turn && typeof observed.status === 'string') turn.status = observed.status;
    }
    for (const webSockets of nativeServers) {
      for (const socket of webSockets.clients) socket.send(JSON.stringify({ method, params }));
    }
  };
  // Each server substitutes one native process. An unrelated control process
  // may not find the fixture's live thread through its own rollout lookup scope.
  const loadedGoalServers = new WeakSet<WebSocketServer>();
  const bindServer = (webSockets: WebSocketServer) => webSockets.on('connection', (socket) => {
    // Independent Codex 0.162.1 control processes do not inherit the runtime's extra roots.
    let extraRoots: readonly string[] = [];
    socket.on('message', async (payload) => {
      const message = JSON.parse(payload.toString()) as {
        id?: number; method: string; params?: Record<string, unknown>;
      };
      if (message.id === undefined || typeof message.method !== 'string') return;
      const params = message.params ?? {};
      requests.push({ method: message.method, params });
      options.observer?.recordAppServerRequest(message.method, params);
      if (message.method === 'skills/extraRoots/set') {
        await options.beforeExtraRootsSetResponse?.({ occurrence: ++extraRootsSetOccurrence, params });
      }
      let result: unknown = {};
      let error: unknown;
      if (message.method === 'turn/start') turnStartOccurrence += 1;
      const turnId = message.method === 'turn/start'
        ? options.turnIdForStart?.(turnStartOccurrence) ?? `provider-turn-${turnStartOccurrence}` : 'fixture-turn';
      if (message.method === 'initialize') {
        result = { userAgent: 'happier_cli/0.162.1 (fixture)' };
        error = options.initializeFailure;
      } else if (message.method === 'config/read') {
        result = { config: { mcp_servers: options.nativeMcpServers ?? (options.mcpServers ? { happier__wilson: { enabled: true } } : {}), features: { code_mode: { excluded_tool_namespaces: ['functions'] } } } };
      } else if (message.method === 'account/read') {
        try { result = await options.accountRead?.() ?? {}; }
        catch { error = { code: -32000, message: 'Account read unavailable' }; }
      } else if (message.method === 'account/rateLimits/read') {
        try { result = await options.rateLimitsRead?.() ?? {}; }
        catch { error = { code: -32000, message: 'Quota read unavailable' }; }
      } else if (message.method === 'thread/start') {
        loadedGoalServers.add(webSockets);
        result = { model: 'fixture-model', thread: { id: 'fresh-thread', turns: [] }, sandbox: { type: 'readOnly' }, reasoningEffort: 'low' };
      } else if (message.method.startsWith('thread/goal/')) {
        // An independent native control process can find only a persisted rollout.
        if (options.goalFailure) error = options.goalFailure;
        else if (!materialized || params.threadId !== 'fresh-thread'
          || (options.goalThreadsVisibleOnlyWhenLoaded && !loadedGoalServers.has(webSockets))) {
          error = { code: -32600, message: `thread not found: ${String(params.threadId)}` };
        } else if (message.method === 'thread/goal/set') {
          goal = { ...goal, ...params, status: params.status ?? goal?.status ?? 'active',
            createdAt: 1_776_272_400, updatedAt: 1_776_272_460 };
          result = { goal };
        } else if (message.method === 'thread/goal/clear') {
          goal = null;
          result = { cleared: true };
        } else result = { goal };
      } else if (message.method === 'turn/start') {
        const turn = { id: turnId, status: 'inProgress' };
        turns.push(turn);
        materialized = true;
        result = { turn: { ...turn, items: [] } };
      } else if (message.method === 'thread/name/set') {
        named = true;
      } else if (message.method === 'thread/read') {
        if (rejectRead) error = { code: -32000, message: 'rollout persistence failed' };
        else {
          materialized ||= named && params.includeTurns === true;
          result = { thread: { id: params.threadId, turns } };
        }
      } else if (message.method === 'thread/resume') {
        if (resumeFailure) error = { code: -32000, message: resumeFailure };
        else if (params.threadId === 'fresh-thread' && !materialized) error = { code: -32000, message: 'no rollout found' };
        else {
          loadedGoalServers.add(webSockets);
          result = { thread: { id: params.threadId, turns }, sandbox: { type: 'readOnly' }, reasoningEffort: 'low' };
        }
      } else if (message.method === 'turn/interrupt') {
        const turn = turns.find((entry) => entry.id === params.turnId);
        if (!turn) throw new Error('Cannot interrupt an unknown fixture turn');
        turn.status = 'interrupted';
      } else if (message.method === 'thread/revert') {
        if (revertFailure === 'methodNotFound') error = { code: -32601, message: 'Method not found' };
        else if (revertFailure) error = { code: -32000, message: 'Rollback reply lost' };
        if (!revertFailure || revertFailure === 'applied') {
          const index = turns.findIndex((turn) => turn.id === params.beforeTurnId);
          if (index >= 0) turns.splice(index);
        }
        revertFailure = null;
      } else if (message.method === 'thread/rollback') {
        turns.splice(-Number(params.numTurns));
      } else if (message.method === 'thread/turns/list') {
        result = { data: turns, nextCursor: null };
      } else if (message.method === 'experimentalFeature/list') {
        result = { data: [{ name: 'realtime_conversation', enabled: true }], nextCursor: null };
      } else if (message.method === 'model/list') {
        result = options.modelListResponse ?? { data: [{ id: 'fixture-model', model: 'fixture-model', displayName: 'Fixture Model', isDefault: true }], nextCursor: null };
      } else if (message.method === 'plugin/list') {
        result = options.pluginListResponse ?? { marketplaces: [] };
      } else if (message.method === 'skills/list') {
        result = options.skillListResponseForRoots?.(extraRoots, params) ?? options.skillListResponse ?? { data: [] };
        error = options.skillListFailure;
      } else if (message.method === 'skills/extraRoots/set') {
        if (options.rejectExtraRootsSet) error = { code: -32601, message: 'Method not found' };
        else extraRoots = Array.isArray(params.extraRoots) ? params.extraRoots.filter((root): root is string => typeof root === 'string') : [];
      }
      if (message.method === 'thread/resume') await options.beforeThreadResumeResponse?.({ socket, params });
      if (message.method === 'turn/start') await options.beforeTurnStartResponse?.();
      socket.send(JSON.stringify({ id: message.id, ...(error ? { error } : { result }) }));
      if (message.method === 'turn/start') await options.onTurnStart?.({ socket, params, turnId });
      if (message.method === 'turn/interrupt') {
        emitNotification('turn/completed', { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted' } });
      }
      if (message.method === 'thread/realtime/start') {
        socket.send(JSON.stringify({ method: 'thread/realtime/started', params: { threadId: 'fresh-thread', realtimeSessionId: null, version: 'v3' } }));
        socket.send(JSON.stringify({ method: 'thread/realtime/sdp', params: { threadId: 'fresh-thread', sdp: 'answer' } }));
      }
    });
  });
  bindServer(ws);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  const connectClient = (request?: { maxFrameBytes?: number; requestTimeoutMs?: number }) => createManagedJsonRpcTestClient({
    cwd: root, command: process.execPath, args: ['-e', CODEX_RAW_PROXY_FIXTURE_SCRIPT, socketPath],
    maxFrameBytes: request?.maxFrameBytes, requestTimeoutMs: request?.requestTimeoutMs,
  });
  // Substitute the native executable with a byte relay; host framing and RPC remain real.
  const exec = {
    clients: { spawn: connectClient, connectJsonRpc: (request: { endpoint: { socketPath: string }; maxFrameBytes?: number; requestTimeoutMs?: number }, options?: { signal?: AbortSignal }) => connectManagedJsonRpcTestClient({ cwd: root, socketPath: request.endpoint.socketPath, maxFrameBytes: request.maxFrameBytes, requestTimeoutMs: request.requestTimeoutMs, signal: options?.signal }) },
    systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'codex-cli' }, executablePath: '/fixture/codex' }) },
    run: async () => ({ stdout: new TextEncoder().encode(JSON.stringify({ models: [{ slug: 'fixture-model', tool_mode: options.nativeToolMode === 'direct' ? undefined : 'code_mode_only' }, { slug: 'direct-model' }] })), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false, termination: { requestedBy: { kind: 'none' }, observed: { kind: 'exit', exitCode: 0 } } }),
  } as unknown as ExecService;
  const createClient = async (request?: { toolRestrictionRequired?: boolean; toolRestrictionAllowedMcpServerKeys?: readonly string[]; configOverrides?: readonly string[]; disableUserMcpServers?: boolean; processEnv?: Readonly<Record<string, string | undefined>> }) => {
    // Observe the real config/argv owner at the process boundary; this fixture substitutes Unix transport for the process.
    options.observer?.recordLaunch({ argv: buildCodexAppServerArgs({ ...request, env: request?.processEnv ?? {} }), env: request?.processEnv });
    return await createCodexNativeAppServerClient({
      exec, processEnv: {}, toolRestrictionRequired: request?.toolRestrictionRequired, toolRestrictionAllowedMcpServerKeys: request?.toolRestrictionAllowedMcpServerKeys, transport: { kind: 'unixWebSocket', socketPath, realtimeConversationAdvertised: true },
    });
  };
  const runtime = createCodexAppServerRuntime({
    directory: options.directory ?? root, happierSessionId: 'actual-happier-session',
    toolRestriction: options.toolRestriction,
    mcpServers: options.mcpServers,
    mcpToolPolicy: options.mcpToolPolicy,
    initialPermissionMode: options.permissionMode ?? undefined,
    initialProviderBinding: options.initialProviderBinding,
    processEnv: options.processEnv,
    connectedAccountService: options.connectedAccountService,
    skills: options.skills,
    appServerTransport: options.appServerTransport,
    resolveCurrentPolicy: () => options.permissionMode
      ? resolveCodexTerminalPermissionPolicy(options.permissionMode)
      : ({ approvalPolicy: 'never', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } }),
    host: { baseProcessEnv: {}, logger: { debug() {}, warn() {} }, createClient, ui: options.interactions, ...options.runtimeAuthHost },
  });
  const opened: { session: AgentSessionRuntime | null; run: AgentExecutionRunConversationRuntimeV1 | null } = {
    session: null, run: null,
  };
  await runtime.updateConfig?.({ configOption: { id: 'reasoning_effort', value: 'low' } });
  const nativeExec = {
    ...exec,
    // Substitute the process boundary with the same real JSON-RPC socket transport.
    clients: { ...exec.clients, spawn: async (request: { maxFrameBytes: number; requestTimeoutMs: number;
      launch: { args?: readonly string[]; env?: Readonly<Record<string, string>> } }) => {
      options.observer?.recordLaunch({ argv: request.launch.args ?? [], env: request.launch.env });
      return await connectClient(request);
    } },
    run: async (request: { args: readonly string[] }) => ({
      stdout: new TextEncoder().encode(request.args.includes('--version') ? 'codex-cli 0.159.2' : request.args.includes('models') ? JSON.stringify({ models: [{ slug: 'fixture-model', tool_mode: options.nativeToolMode === 'direct' ? undefined : 'code_mode_only' }, { slug: 'direct-model' }] }) : ''),
      stderr: new Uint8Array(),
      stdoutTruncated: false, stderrTruncated: false,
      termination: { requestedBy: { kind: 'none' }, observed: { kind: 'exit', exitCode: 0 } },
    }),
    spawn: async (request: { args: readonly string[]; env?: Readonly<Record<string, string>> }) => {
      if (options.nativeSpawnFailure) throw options.nativeSpawnFailure;
      options.observer?.recordLaunch({ argv: request.args, env: request.env });
      if (options.nativeProcessResult) return {
        write: async () => undefined, closeStdin: async () => undefined,
        onOutput: () => ({ dispose() {} }), dispose: async () => undefined,
        wait: async () => options.nativeProcessResult!,
      };
      nativeLaunches.push([...request.args]);
      const endpoint = request.args[request.args.indexOf('--listen') + 1];
      if (!endpoint?.startsWith('unix://')) throw new Error('Expected shared native socket launch');
      endpoints.push(endpoint);
      const nativeSocketPath = endpoint.slice('unix://'.length);
      // Codex rejects overlong AF_UNIX paths. Node may silently truncate them;
      // model the native process's platform rejection instead of hanging in stat.
      if (Buffer.byteLength(nativeSocketPath) > (process.platform === 'darwin' ? 103 : 107)) {
        throw Object.assign(new Error('Native socket path is too long'), { code: 'ENAMETOOLONG' });
      }
      await mkdir(dirname(nativeSocketPath), { recursive: true, mode: 0o700 });
      const nativeServer = createServer();
      const nativeWebSockets = new WebSocketServer({ server: nativeServer });
      nativeServers.add(nativeWebSockets);
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
          nativeProcessExits.push(endpoint);
          nativeServers.delete(nativeWebSockets);
        },
      };
    },
  } as unknown as ExecService;
  try {
    await run({ runtime, requests, exec: nativeExec, launchEnvironment: configuredLaunchEnvironment, directory: root, endpoints, nativeLaunches, nativeProcessExits, emitNotification,
      failNextRevert: (outcome) => { revertFailure = outcome; },
      failRead: () => { rejectRead = true; }, failResume: (message) => { resumeFailure = message; }, async openConfiguredSession(providerSessionId, mcpServers = options.mcpServers) {
      // Exec and host SDK services are genuine external boundaries; native/runtime/client logic stays real.
      const context = {
        signal: new AbortController().signal,
        services: { exec: nativeExec, logger: options.logger ?? { debug() {}, warn() {} }, sessions: {},
          ...(options.connectedAccounts ? { connectedAccounts: options.connectedAccounts } : {}) },
        session: { id: 'actual-happier-session', services: { models: options.models,
          ...(options.runtimeAuthHost?.nativeHome ? { nativeHome: options.runtimeAuthHost.nativeHome } : {}),
        } },
        workState: { publisher: () => ({ publish: async () => ({ status: 'applied', revision: 'fixture-goal' }) }) },
        ui: { title: { set: async () => undefined } },
      } as unknown as AgentSessionRuntimeContext;
      const openSession = options.sessionFactory?.open ?? openCodexNativeAppServerSession;
      opened.session = await openSession({
        ...(providerSessionId ? { kind: 'resume' as const, providerSessionId } : { kind: 'create' as const }),
        sessionId: 'actual-happier-session', cwd: root,
        ...(options.sessionConnectedAccounts ? { connectedAccounts: options.sessionConnectedAccounts } : {}),
        launchEnvironment: configuredLaunchEnvironment,
        configuration: {
          mode: { value: null, updatedAtMs: 0 }, model: { value: 'fixture-model', updatedAtMs: 1 },
          permissionIntent: { value: options.permissionMode ?? 'read-only', updatedAtMs: 1 },
          options: { reasoning_effort: { value: 'low', updatedAtMs: 1 } },
          ...options.toolRestriction,
          ...options.configuration,
        },
        ...(mcpServers ? { mcpServers } : {}),
        ...(options.providerBinding ? { providerBinding: options.providerBinding } : {}),
        ...(options.mcpToolPolicy ? { mcpToolPolicy: options.mcpToolPolicy } : {}),
        ...(options.skills ? { skills: options.skills } : {}),
        ...(options.startupInstructions === null ? {} : {
          startupInstructions: options.startupInstructions ?? { v: 1, id: 'fixture.startup', revision: 1, instructions: 'Actual startup instructions.' },
        }),
      }, context);
      return opened.session;
    }, async openConfiguredRun() {
      const context = {
        signal: new AbortController().signal,
        services: { exec: nativeExec, logger: options.logger ?? { debug() {}, warn() {} } },
        executionRun: { id: 'skills-run-1', services: {
          ...(options.runtimeAuthHost?.nativeHome ? { nativeHome: options.runtimeAuthHost.nativeHome } : {}),
          ...(options.runtimeAuthHost?.refreshRuntimeAuth
            ? { auth: { services: { refreshRuntimeAuth: options.runtimeAuthHost.refreshRuntimeAuth } } } : {}),
        } },
      } as unknown as AgentExecutionRunRuntimeContextV1;
      opened.run = await openCodexNativeAppServerExecutionRunConversation({
        kind: 'create', runId: 'skills-run-1', cwd: root,
        profile: { pluginId: 'happier.agent.codex', localId: 'codex' },
        input: { text: 'Use the review skill.' },
        launchEnvironment: configuredLaunchEnvironment,
        configuration: {
          mode: { value: null, updatedAtMs: 0 }, model: { value: 'fixture-model', updatedAtMs: 1 },
          permissionIntent: { value: options.permissionMode ?? 'read-only', updatedAtMs: 1 }, options: {},
          ...options.toolRestriction,
          ...options.configuration,
        },
        ...(options.providerBinding ? { providerBinding: options.providerBinding } : {}),
        ...(options.skills ? { skills: options.skills } : {}),
        ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
        ...(options.mcpToolPolicy ? { mcpToolPolicy: options.mcpToolPolicy } : {}),
      }, context);
      return opened.run;
    }, async resume() {
      const peer = await createClient();
      try { return await peer.request('thread/resume', { threadId: 'fresh-thread' }); }
      finally { await peer.dispose(); }
    } });
  } finally {
    await opened.run?.dispose();
    await opened.session?.dispose();
    await runtime.dispose();
    for (const socket of ws.clients) socket.terminate();
    await new Promise<void>((resolve) => ws.close(() => resolve()));
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
    if (priorTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = priorTmpdir;
  }
}
