import { readFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative } from 'node:path';

import { expect, vi } from 'vitest';
import type {
  AgentSessionHostServices,
  AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';

import type {
  TerminalHostHandle,
  TerminalInputInjectionResult,
} from '@happier-dev/agents';
import type {
  ClaudeSdkExecClientHandle,
  ClaudeSdkJsonStreamClient,
  ClaudeSdkQueryContext,
} from '../sdk/query.js';
import type { ClaudeAgentSdkContext } from './remote/sdk/session.js';
import type { ClaudeUnifiedTerminalContext } from './terminal/unified/turnOperations.js';
import type { ClaudeTestSessionRuntime } from './sessionRuntime.testkit.js';
import type {
  ClaudeProviderConfigurationOutcome,
  ClaudeProviderConfigurationUpdate,
  ClaudeProviderDisposeReason,
  ClaudeProviderPermissionResponseOutcome,
  ClaudeRuntimePromptSubmissionOutcome,
} from './providerOperations.js';
import type { ClaudeProviderEvent } from './providerEvents.js';

const DEFAULT_TEST_FILE_FOLLOW_POLL_INTERVAL_MS = 25;
type AgentTerminalHostService = NonNullable<AgentSessionHostServices['terminalHost']>;
type ClaudeTestPluginContext = ClaudeAgentSdkContext & ClaudeUnifiedTerminalContext;
type ClaudeTestEventListener = (event: Readonly<{
  id: string;
  payload: unknown;
  envelope: Readonly<{
    emittedAt: string;
    source: Readonly<{ kind: 'host'; namespace: 'session' }>;
  }>;
}>) => void | Promise<void>;
type ClaudeTestEventsService = Readonly<{
  subscribe(selector: string, listener: ClaudeTestEventListener): Readonly<{ unsubscribe(): void }>;
}>;
type ClaudeTestTranscriptFileFollowInput = Readonly<{
  path: string;
  startAt: 'beginning' | 'end';
  strategy?: 'poll';
  onLine(line: Readonly<{ line: string; sourcePath: string; sequence: number }>): void | Promise<void>;
  onError?(error: unknown): void | Promise<void>;
}>;
type ClaudeTestTranscriptFileFollowHandle = Readonly<{
  id: string;
  drainNow(): Promise<void>;
  close(options?: Readonly<{ finalDrain?: boolean }>): Promise<void>;
}>;
type ClaudeTestTranscriptsService = Readonly<{
  append(...args: readonly unknown[]): Promise<void>;
  defineSource(definition: Readonly<{ id: string }>): Promise<Readonly<{ id: string; dispose(): Promise<void> }>>;
  fileFollow: Readonly<{
    follow(input: ClaudeTestTranscriptFileFollowInput): Promise<ClaudeTestTranscriptFileFollowHandle>;
  }>;
  publishSessionEvent(event: unknown): Promise<Readonly<{ status: 'custodied' }>>;
  markSourceFactConsumed(request: unknown): Promise<Readonly<{ status: 'custodied' }>>;
}>;

export function createTerminalHostHandle(): TerminalHostHandle {
  return {
    kind: 'zellij',
    sessionName: 'happier-claude-happy-session-1',
    paneId: 'pane-1',
    attachMetadata: {
      attachStrategy: 'terminal_host',
      topology: 'exclusive',
      locality: 'same_machine',
      maxClients: null,
      requiresLocalAttachmentInfo: true,
      liveProbe: 'required',
    },
  };
}

export function createTerminalHostFixture(): Readonly<{
  handle: TerminalHostHandle;
  service: AgentTerminalHostService;
}> {
  const handle = createTerminalHostHandle();
  const service: AgentTerminalHostService = {
    resolve: vi.fn(async () => ({
      status: 'resolved',
      hostKind: 'zellij',
      reason: 'zellij_forced',
    } as const)),
    createOrAttachHost: vi.fn(async () => handle),
    injectUserPrompt: vi.fn(async (_handle, input): Promise<TerminalInputInjectionResult> => ({
      status: 'injected',
      injectedAt: 123,
      bytesWritten: input.text.length,
      hostKind: handle.kind,
      hostSessionName: handle.sessionName,
      paneId: handle.paneId,
    })),
    interruptTurn: vi.fn(async () => undefined),
    evaluateLiveness: vi.fn(async () => ({
      paneAlive: true,
      observedAt: 100,
    })),
    captureInputState: vi.fn(async () => ({
      stable: true,
      currentInput: [
        'What would you like to work on?',
        '╭───────────────────────────────────────────────╮',
        '│ >                                             │',
        '╰───────────────────────────────────────────────╯',
      ].join('\n'),
      observedAt: 101,
    })),
    controlPort: vi.fn(async () => null),
    dispose: vi.fn(async () => undefined),
  };
  return { handle, service };
}

export function createEventsFixture(): Readonly<{
  service: ClaudeTestEventsService;
  emit(id: string, payload: unknown): Promise<void>;
}> {
  const listenersById = new Map<string, Set<ClaudeTestEventListener>>();
  return {
    service: {
      subscribe: vi.fn((selector, listener) => {
        if (typeof selector !== 'string') {
          throw new Error('Claude runtime test fixture only supports direct event ids');
        }
        const listeners = listenersById.get(selector) ?? new Set<ClaudeTestEventListener>();
        listeners.add(listener);
        listenersById.set(selector, listeners);
        return {
          unsubscribe: () => {
            listeners.delete(listener);
          },
        };
      }),
    },
    async emit(id, payload) {
      const listeners = listenersById.get(id);
      if (!listeners) return;
      for (const listener of Array.from(listeners)) {
        await listener({
          id,
          payload,
          envelope: {
            emittedAt: new Date(0).toISOString(),
            source: { kind: 'host', namespace: 'session' },
          },
        });
      }
    },
  };
}

export function createSessionHooksFixture(): Readonly<{
  serverStop: ReturnType<typeof vi.fn>;
  serverDispose: ReturnType<typeof vi.fn>;
  service: {
      startServer: ReturnType<typeof vi.fn>;
      resolveForwarderAssets: ReturnType<typeof vi.fn>;
      createPluginDir: ReturnType<typeof vi.fn>;
      disposePluginDir: ReturnType<typeof vi.fn>;
      publishProviderTranscript: ReturnType<typeof vi.fn>;
  };
}> {
  const serverStop = vi.fn();
  const serverDispose = vi.fn(async () => {
    serverStop();
  });
  return {
    serverStop,
    serverDispose,
    service: {
      startServer: vi.fn(async () => ({
        port: 43123,
        sessionHookSecretFile: '/tmp/happier-claude-hook-session.secret',
        permissionHookSecretFile: '/tmp/happier-claude-hook-permission.secret',
        stop: serverStop,
        dispose: serverDispose,
      })),
      resolveForwarderAssets: vi.fn(async () => ({
        nodeExecutable: '/bin/node',
        sessionForwarderScript: '/app/session_hook_forwarder.cjs',
        permissionForwarderScript: '/app/permission_hook_forwarder.cjs',
      })),
      createPluginDir: vi.fn(async () => '/tmp/happier-claude-hook-plugin'),
      disposePluginDir: vi.fn(async () => undefined),
      publishProviderTranscript: vi.fn(async () => undefined),
    },
  };
}

export function createSdkExecFixture(): Readonly<{
  spawnClient: ReturnType<typeof vi.fn>;
  written: unknown[];
  service: ClaudeSdkQueryContext;
  emit(record: unknown): Promise<void>;
  exitWith(result: Readonly<{
    exitCode: number | null;
    signal: string | null;
    stdout?: string;
    stderr?: string;
  }>): Promise<void>;
  resolveExit(): Promise<void>;
}> {
  const listeners = new Set<(record: unknown) => void | Promise<void>>();
  const written: unknown[] = [];
  let resolveExitPromise: ((result: Readonly<{
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
  }>) => void) | null = null;
  const exit = new Promise<Readonly<{
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
  }>>((resolve) => {
    resolveExitPromise = resolve;
  });
  const closed = exit.then(() => undefined);
  const client: ClaudeSdkJsonStreamClient = {
    closed,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async writeRecord(record) {
      written.push(record);
      return { kind: 'written' };
    },
  };
  const handle: ClaudeSdkExecClientHandle = {
    client,
    process: {
      exit,
      async writeStdin() {},
      kill() {},
      async dispose() {},
    },
    status: 'running',
    onExit() {
      return () => undefined;
    },
    async dispose() {
      resolveExitPromise?.({
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
      });
    },
  };
  const spawnClient = vi.fn(async () => handle);

  return {
    spawnClient,
    written,
    service: {
      // Boundary fixture: Vitest mock has one implementation while the SDK exposes overloads.
      spawnClient,
    } as unknown as ClaudeSdkQueryContext,
    async emit(record) {
      await Promise.all([...listeners].map((listener) => listener(record)));
    },
    async exitWith(result) {
      resolveExitPromise?.({
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      });
      await exit;
    },
    async resolveExit() {
      resolveExitPromise?.({
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
      });
      await exit;
    },
  };
}

type TestTranscriptsFixtureOptions = Readonly<{
  allowedPaths?: readonly string[];
  allowedPathRoots?: readonly string[];
  pollIntervalMs?: number;
}>;

function isPathInsideRoot(filePath: string, rootPath: string): boolean {
  const rel = relative(rootPath, filePath);
  return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel));
}

async function resolveGrantedTranscriptPath(
  filePath: string,
  options: TestTranscriptsFixtureOptions,
): Promise<string> {
  if (!isAbsolute(filePath)) {
    throw new Error('test transcript file follow requires an absolute transcript path');
  }
  const realFilePath = await realpath(filePath);
  const allowedPathEntries = await Promise.all((options.allowedPaths ?? []).map(async (path) => realpath(path)));
  if (allowedPathEntries.includes(realFilePath)) {
    return realFilePath;
  }
  const rootInputs = options.allowedPathRoots ?? [tmpdir()];
  const allowedRootEntries = await Promise.all(rootInputs.map(async (path) => realpath(path)));
  if (allowedRootEntries.some((rootPath) => isPathInsideRoot(realFilePath, rootPath))) {
    return realFilePath;
  }
  throw new Error('test transcript file follow path is not granted');
}

async function readFileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
}

function createTestTranscriptFileFollowHandle(
  input: ClaudeTestTranscriptFileFollowInput,
  sourcePath: string,
  pollIntervalMs: number,
): ClaudeTestTranscriptFileFollowHandle {
  let closed = false;
  let closePromise: Promise<void> | null = null;
  let offsetPromise = input.startAt === 'end' ? readFileSize(sourcePath) : Promise.resolve(0);
  let pending = '';
  let sequence = 0;
  let drainInFlight: Promise<void> | null = null;

  const notifyError = async (error: unknown): Promise<void> => {
    if (!input.onError) throw error;
    await input.onError(error);
  };

  const emitLine = async (line: string): Promise<void> => {
    sequence += 1;
    await input.onLine(Object.freeze({
      line,
      sourcePath,
      sequence,
    }));
  };

  const drainOnce = async (): Promise<void> => {
    if (closed) return;
    try {
      const buffer = await readFile(sourcePath);
      let offset = await offsetPromise;
      if (offset > buffer.byteLength) {
        offset = 0;
        pending = '';
      }
      if (offset === buffer.byteLength) return;
      const chunk = buffer.subarray(offset).toString('utf8');
      offsetPromise = Promise.resolve(buffer.byteLength);
      const combined = pending + chunk;
      const lines = combined.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (line.length > 0) await emitLine(line);
      }
    } catch (error) {
      await notifyError(error);
    }
  };

  const drain = async (): Promise<void> => {
    if (drainInFlight) return await drainInFlight;
    drainInFlight = drainOnce().finally(() => {
      drainInFlight = null;
    });
    return await drainInFlight;
  };

  const timer = setInterval(() => {
    void drain();
  }, pollIntervalMs);
  timer.unref?.();
  void drain();

  return Object.freeze({
    id: `test-transcript-file-follow:${sourcePath}`,
    async drainNow() {
      await drain();
    },
    async close(options) {
      if (closed) return await (closePromise ?? Promise.resolve());
      closed = true;
      clearInterval(timer);
      closePromise = (async () => {
        if (options?.finalDrain === true) {
          closed = false;
          try {
            await drainInFlight;
            await drain();
          } finally {
            closed = true;
          }
        }
      })();
      return await closePromise;
    },
  });
}

function createTranscriptsFixture(options: TestTranscriptsFixtureOptions = {}): ClaudeTestTranscriptsService {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_TEST_FILE_FOLLOW_POLL_INTERVAL_MS;
  return {
    append: vi.fn(async () => undefined),
    defineSource: vi.fn(async (definition: Readonly<{ id: string }>) => ({
      id: definition.id,
      dispose: vi.fn(async () => undefined),
    })),
    fileFollow: {
      follow: vi.fn(async (input: ClaudeTestTranscriptFileFollowInput) => {
        if (input.startAt !== 'beginning' && input.startAt !== 'end') {
          throw new Error('test transcript file follow startAt must be beginning or end');
        }
        if (input.strategy !== undefined && input.strategy !== 'poll') {
          throw new Error('test transcript file follow only supports poll strategy');
        }
        const sourcePath = await resolveGrantedTranscriptPath(input.path, options);
        return createTestTranscriptFileFollowHandle(input, sourcePath, pollIntervalMs);
      }),
    },
    publishSessionEvent: vi.fn(async () => ({ status: 'custodied' as const })),
    markSourceFactConsumed: vi.fn(async () => ({ status: 'custodied' as const })),
  };
}

function createPluginStorageScopeFixture() {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn(async (key: string) => (store.has(key) ? store.get(key) : null)),
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, JSON.parse(JSON.stringify(value)));
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    listKeys: vi.fn(async () => [...store.keys()]),
  };
}

function createPluginStorageFixture() {
  return {
    ephemeral: createPluginStorageScopeFixture(),
    daemonSession: createPluginStorageScopeFixture(),
    daemon: createPluginStorageScopeFixture(),
    account: createPluginStorageScopeFixture(),
  };
}

export function createPluginContextFixture(
  terminalHost: AgentTerminalHostService,
  events: ClaudeTestEventsService,
  extras?: Readonly<{
    accountUsage?: unknown;
    configValues?: Readonly<Record<string, unknown>>;
    enabledFeatures?: readonly string[];
    exec?: ClaudeSdkQueryContext;
    settingsValues?: Readonly<Record<string, unknown>>;
    sessionHooks?: unknown;
    sessionPermissions?: unknown;
    sessionWriteAgentState?: unknown;
    sessionWriteStateField?: unknown;
    sessionPublishWorkflowHeadline?: unknown;
    sessionWriteSystemRecord?: unknown;
    sessionReadSystemRecord?: unknown;
    publishSessionEvent?: unknown;
    markSourceFactConsumed?: unknown;
    sessionAuth?: unknown;
    transcripts?: unknown;
    toolExecution?: unknown;
    transcriptFileFollowAllowedPaths?: readonly string[];
    transcriptFileFollowAllowedPathRoots?: readonly string[];
  }>,
): ClaudeTestPluginContext {
  const configValues = extras?.configValues ?? {};
  const settingsValues = extras?.settingsValues ?? {};
  const enabledFeatures = new Set(extras?.enabledFeatures ?? ['agents.claude.unifiedTerminal']);
  const sessionHooks = extras?.sessionHooks ?? createSessionHooksFixture().service;
  const sessionPermissions = extras?.sessionPermissions ?? {
    requestDecision: vi.fn(async () => ({ decision: 'approved' })),
    getMode: () => 'default',
  };
  const rawTranscripts = extras?.transcripts ?? createTranscriptsFixture({
    allowedPaths: extras?.transcriptFileFollowAllowedPaths,
    allowedPathRoots: extras?.transcriptFileFollowAllowedPathRoots,
  });
  const transcriptRecord = rawTranscripts as Readonly<Record<string, unknown>>;
  const publishSessionEvent = extras?.publishSessionEvent
    ?? transcriptRecord.publishSessionEvent;
  const markSourceFactConsumed = extras?.markSourceFactConsumed
    ?? transcriptRecord.markSourceFactConsumed;
  const transcripts = Object.freeze({
    ...transcriptRecord,
    publishSessionEvent,
    markSourceFactConsumed,
  });
  const currentSession = {
    permissions: sessionPermissions,
    ...(extras?.sessionWriteAgentState ? { writeAgentState: extras.sessionWriteAgentState } : {}),
    writeStateField: extras?.sessionWriteStateField ?? vi.fn(async () => undefined),
    workflowActivity: {
      publishHeadlines: extras?.sessionPublishWorkflowHeadline ?? vi.fn(async () => undefined),
    },
    writeSystemRecord: extras?.sessionWriteSystemRecord ?? vi.fn(async () => undefined),
    readSystemRecord: extras?.sessionReadSystemRecord ?? vi.fn(async () => null),
    ...(extras?.sessionAuth ? { auth: extras.sessionAuth } : {}),
  };
  // Boundary fixture: these tests exercise the Claude plugin contract and only need SDK services consumed by this runtime.
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    config: { values: configValues },
    features: {
      isEnabled: vi.fn((featureId: string) => enabledFeatures.has(featureId)),
    },
    settings: {
      forScope: vi.fn((scope: Readonly<{ kind: string }>) => {
        if (scope.kind !== 'account') throw new Error(`unexpected settings scope: ${scope.kind}`);
        return { get: vi.fn(async (key: string) => settingsValues[key]) };
      }),
    },
    storage: createPluginStorageFixture(),
    events,
    agentRuntime: {
      exec: extras?.exec ?? createSdkExecFixture().service,
      ...(extras?.toolExecution ? { toolExecution: extras.toolExecution } : {}),
      terminalHost,
      sessionHooks,
      transcripts,
      accountUsage: extras?.accountUsage ?? {
        resolveSourceContext: vi.fn(async () => null),
        recordSnapshot: vi.fn(async () => ({ status: 'recorded', recordId: 'claude-test-usage' })),
        adoptProvisionalRecord: vi.fn(async () => ({ status: 'adopted', recordId: 'claude-test-usage' })),
      },
    },
    session: currentSession,
    sessions: {
      current: currentSession,
    },
  } as unknown as ClaudeTestPluginContext;
}

type ClaudeTestRuntimeOperations = Readonly<{
  beginTurnLifecycle(): void;
  startProviderSession(opts?: Readonly<Record<string, unknown>>): Promise<string | null | Readonly<Record<string, unknown>>>;
  sendTurnPrompt(prompt: string, meta?: Readonly<{
    localId?: string | null;
    localIds?: readonly string[];
    userMessageSeq?: number | null;
    userMessageSeqs?: readonly number[];
  }>): Promise<ClaudeRuntimePromptSubmissionOutcome>;
  steerInFlightTurn(message: string, meta?: Readonly<{
    localId?: string | null;
    localIds?: readonly string[];
    userMessageSeq?: number | null;
    userMessageSeqs?: readonly number[];
  }>): Promise<ClaudeRuntimePromptSubmissionOutcome>;
  waitForTurnCompletion(opts?: Readonly<{ timeoutMs?: number | null }>): Promise<void>;
  subscribeRuntimeEvents(handler: (event: ClaudeProviderEvent) => void): () => void;
  subscribeCanonicalAgentSessionEvents(handler: (event: AgentSessionRuntimeEvent) => void): () => void;
  respondToPermission(
    requestId: string,
    approved: boolean,
  ): Promise<ClaudeProviderPermissionResponseOutcome>;
  cancelTurn(): Promise<void>;
  readSessionIdentity(): Readonly<{ sessionId: string | null }>;
  updateSessionRuntimeConfig(
    update: ClaudeProviderConfigurationUpdate,
  ): Promise<ClaudeProviderConfigurationOutcome | void>;
  resetOrDisposeRuntime(
    reason?: ClaudeProviderDisposeReason | Readonly<{ reason?: ClaudeProviderDisposeReason }>,
  ): Promise<void>;
}>;

type ClaudeTestRuntimeNativeExtras = Partial<ClaudeTestRuntimeOperations>;

type ClaudeTestRuntimeEnvelope = Readonly<{
  operations: ClaudeTestRuntimeOperations;
  nativeRuntime: ClaudeTestSessionRuntime & ClaudeTestRuntimeNativeExtras;
}>;

function readRuntimeNativeExtras(runtime: ClaudeTestSessionRuntime): ClaudeTestRuntimeNativeExtras {
  return runtime as ClaudeTestSessionRuntime & ClaudeTestRuntimeNativeExtras;
}

function createRuntimeInput(prompt: string): Readonly<{ v: 1; text: string }> {
  return { v: 1, text: prompt };
}

function assertAccepted(
  result: Awaited<ReturnType<ClaudeTestSessionRuntime['send']>>,
): void {
  if (result.status === 'accepted') return;
  throw new Error(result.diagnostic ?? `runtime send was not accepted: ${result.status}`);
}

function expectSessionRuntime(value: unknown): ClaudeTestSessionRuntime {
  expect(value).toMatchObject({
    identity: {
      read: expect.any(Function),
    },
    events: {
      subscribe: expect.any(Function),
    },
    send: expect.any(Function),
    dispose: expect.any(Function),
  });
  return value as ClaudeTestSessionRuntime;
}

export function expectRuntimeEnvelope(value: unknown): ClaudeTestRuntimeEnvelope {
  const runtime = expectSessionRuntime(value);
  const extras = readRuntimeNativeExtras(runtime);
  const operations: ClaudeTestRuntimeOperations = {
    beginTurnLifecycle: () => {
      extras.beginTurnLifecycle?.();
    },
    startProviderSession: async (opts) => {
      if (extras.startProviderSession) return await extras.startProviderSession(opts);
      return { sessionId: runtime.identity.read().providerSessionId };
    },
    sendTurnPrompt: async (prompt, meta) => {
      if (extras.sendTurnPrompt) {
        return await extras.sendTurnPrompt(prompt, meta);
      }
      const result = await runtime.send(createRuntimeInput(prompt));
      assertAccepted(result);
      return { kind: 'accepted' };
    },
    steerInFlightTurn: async (message, meta) => {
      if (extras.steerInFlightTurn) {
        return await extras.steerInFlightTurn(message, meta);
      }
      const result = await runtime.send(createRuntimeInput(message), {
        deliverAs: 'steer',
        ...(typeof meta?.userMessageSeq === 'number' && Number.isFinite(meta.userMessageSeq)
          ? { userMessageSeq: meta.userMessageSeq }
          : {}),
      });
      assertAccepted(result);
      return { kind: 'accepted' };
    },
    waitForTurnCompletion: async (opts) => {
      await extras.waitForTurnCompletion?.(opts);
    },
    subscribeRuntimeEvents: (handler) => runtime.events.subscribe(handler),
    subscribeCanonicalAgentSessionEvents: (handler) => {
      const subscribe = (runtime as ClaudeTestSessionRuntime & Readonly<{
        subscribeCanonicalAgentSessionEvents?: (listener: (event: AgentSessionRuntimeEvent) => void) => () => void;
      }>).subscribeCanonicalAgentSessionEvents;
      if (typeof subscribe !== 'function') {
        throw new Error('Claude public session runtime omitted canonical agent session events');
      }
      return subscribe(handler);
    },
    respondToPermission: async (requestId, approved) => {
      if (extras.respondToPermission) return await extras.respondToPermission(requestId, approved);
      const permissions = runtime.permissions;
      if (permissions?.capability !== 'responds') return { delivered: false, reason: 'unknown_request' };
      return await permissions.respond({ requestId, approved });
    },
    cancelTurn: async () => {
      if (extras.cancelTurn) {
        await extras.cancelTurn();
        return;
      }
      const result:
        | Awaited<ReturnType<ClaudeTestSessionRuntime['cancel']>>
        | undefined = await runtime.cancel?.({ reason: 'user' });
      if (result?.status === 'unsupported' || result?.status === 'unavailable') {
        throw new Error(result.diagnostic ?? `runtime cancel failed: ${result.status}`);
      }
    },
    readSessionIdentity: () => ({
      sessionId: runtime.identity.read().providerSessionId,
    }),
    updateSessionRuntimeConfig: async (update) => {
      if (extras.updateSessionRuntimeConfig) return await extras.updateSessionRuntimeConfig(update);
      return await runtime.updateConfig?.(update);
    },
    resetOrDisposeRuntime: async (reason) => {
      if (extras.resetOrDisposeRuntime) {
        await extras.resetOrDisposeRuntime(reason);
        return;
      }
      const disposeReason = typeof reason === 'string' ? reason : reason?.reason;
      await runtime.dispose(disposeReason);
    },
  };
  return {
    operations,
    nativeRuntime: runtime,
  };
}
