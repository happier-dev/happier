import { readFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative } from 'node:path';

import { expect, vi } from 'vitest';

import type {
  TerminalHostHandle,
  TerminalInputInjectionResult,
} from '@happier-dev/plugin-sdk/experimental/runtime/session';
import type {
  ExecClientHandleV1,
  JsonStreamClientV1,
  PluginEventListenerV1,
  PluginContextV1,
  RuntimeCancelResultV1,
  RuntimeConfigUpdateOutcomeV1,
  RuntimeDisposeReasonV1,
  RuntimeEventV1,
  RuntimePermissionResponseOutcomeV1,
  RuntimeSendResultV1,
  SessionRuntimeConfigUpdateV1,
  SessionRuntimeV1,
  TerminalHostRuntimeServiceV1,
  TranscriptFileFollowHandleV1,
  TranscriptFileFollowInputV1,
  TranscriptsRuntimeServiceV1,
} from '@happier-dev/plugin-sdk';

const DEFAULT_TEST_FILE_FOLLOW_POLL_INTERVAL_MS = 25;

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
  service: TerminalHostRuntimeServiceV1;
}> {
  const handle = createTerminalHostHandle();
  const service: TerminalHostRuntimeServiceV1 = {
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
      currentInput: 'What would you like to work on?',
      observedAt: 101,
    })),
    controlPort: vi.fn(async () => null),
    dispose: vi.fn(async () => undefined),
  };
  return { handle, service };
}

export function createEventsFixture(): Readonly<{
  service: Pick<PluginContextV1['events'], 'subscribe'>;
  emit(id: string, payload: unknown): Promise<void>;
}> {
  const listenersById = new Map<string, Set<PluginEventListenerV1>>();
  return {
    service: {
      subscribe: vi.fn((selector, listener) => {
        if (typeof selector !== 'string') {
          throw new Error('Claude runtime test fixture only supports direct event ids');
        }
        const listeners = listenersById.get(selector) ?? new Set<PluginEventListenerV1>();
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
  service: PluginContextV1['agentRuntime']['exec'];
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
  const client: JsonStreamClientV1 = {
    closed,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async writeRecord(record) {
      written.push(record);
    },
  };
  const handle: ExecClientHandleV1<JsonStreamClientV1> = {
    client,
    process: {
      pid: 123,
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
    } as unknown as PluginContextV1['agentRuntime']['exec'],
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
  input: TranscriptFileFollowInputV1,
  sourcePath: string,
  pollIntervalMs: number,
): TranscriptFileFollowHandleV1 {
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

function createTranscriptsFixture(options: TestTranscriptsFixtureOptions = {}): TranscriptsRuntimeServiceV1 {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_TEST_FILE_FOLLOW_POLL_INTERVAL_MS;
  return {
    append: vi.fn(async () => undefined),
    defineSource: vi.fn(async (definition: Readonly<{ id: string }>) => ({
      id: definition.id,
      dispose: vi.fn(async () => undefined),
    })),
    fileFollow: {
      follow: vi.fn(async (input: TranscriptFileFollowInputV1) => {
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
    session: createPluginStorageScopeFixture(),
    local: createPluginStorageScopeFixture(),
    synced: createPluginStorageScopeFixture(),
  };
}

export function createPluginContextFixture(
  terminalHost: TerminalHostRuntimeServiceV1,
  events: Pick<PluginContextV1['events'], 'subscribe'>,
  extras?: Readonly<{
    accountUsage?: unknown;
    configValues?: Readonly<Record<string, unknown>>;
    enabledFeatures?: readonly string[];
    exec?: PluginContextV1['agentRuntime']['exec'];
    settingsValues?: Readonly<Record<string, unknown>>;
    sessionHooks?: unknown;
    sessionPermissions?: unknown;
    sessionWriteAgentState?: unknown;
    sessionWriteStateField?: unknown;
    sessionWriteMetadata?: unknown;
    sessionWriteSystemRecord?: unknown;
    sessionReadSystemRecord?: unknown;
    sessionSend?: unknown;
    sessionAuth?: unknown;
    sessionHasProviderAcceptedUserMessageDelivery?: unknown;
    transcripts?: unknown;
    transcriptFileFollowAllowedPaths?: readonly string[];
    transcriptFileFollowAllowedPathRoots?: readonly string[];
  }>,
): PluginContextV1 {
  const configValues = extras?.configValues ?? {};
  const settingsValues = extras?.settingsValues ?? {};
  const enabledFeatures = new Set(extras?.enabledFeatures ?? ['agents.claude.unifiedTerminal']);
  const sessionHooks = extras?.sessionHooks ?? createSessionHooksFixture().service;
  const sessionPermissions = extras?.sessionPermissions ?? {
    requestDecision: vi.fn(async () => ({ decision: 'approved' })),
    getMode: () => 'default',
  };
  const transcripts = extras?.transcripts ?? createTranscriptsFixture({
    allowedPaths: extras?.transcriptFileFollowAllowedPaths,
    allowedPathRoots: extras?.transcriptFileFollowAllowedPathRoots,
  });
  const currentSession = {
    permissions: sessionPermissions,
    ...(extras?.sessionHasProviderAcceptedUserMessageDelivery
      ? { hasProviderAcceptedUserMessageDelivery: extras.sessionHasProviderAcceptedUserMessageDelivery }
      : {}),
    ...(extras?.sessionWriteAgentState ? { writeAgentState: extras.sessionWriteAgentState } : {}),
    writeStateField: extras?.sessionWriteStateField ?? vi.fn(async () => undefined),
    ...(extras?.sessionWriteMetadata ? { writeMetadata: extras.sessionWriteMetadata } : {}),
    ...(extras?.sessionWriteSystemRecord ? { writeSystemRecord: extras.sessionWriteSystemRecord } : {}),
    ...(extras?.sessionReadSystemRecord ? { readSystemRecord: extras.sessionReadSystemRecord } : {}),
    ...(extras?.sessionSend ? { send: extras.sessionSend } : {}),
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
      get: vi.fn(async (key: string) => settingsValues[key]),
    },
    storage: createPluginStorageFixture(),
    events,
    agentRuntime: {
      exec: extras?.exec ?? createSdkExecFixture().service,
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
  } as unknown as PluginContextV1;
}

type ClaudeTestRuntimeOperations = Readonly<{
  beginTurnLifecycle(): void;
  startOrLoadSession(opts?: Readonly<Record<string, unknown>>): Promise<string | null | Readonly<Record<string, unknown>>>;
  sendTurnPrompt(prompt: string, meta?: Readonly<{
    localId?: string | null;
    localIds?: readonly string[];
    providerClaimedPendingLocalIds?: readonly string[];
    userMessageSeq?: number | null;
    userMessageSeqs?: readonly number[];
  }>): Promise<void>;
  steerInFlightTurn(message: string, meta?: Readonly<{
    localId?: string | null;
    localIds?: readonly string[];
    providerClaimedPendingLocalIds?: readonly string[];
    userMessageSeq?: number | null;
    userMessageSeqs?: readonly number[];
  }>): Promise<void>;
  waitForTurnCompletion(opts?: Readonly<{ timeoutMs?: number | null }>): Promise<void>;
  subscribeRuntimeEvents(handler: (event: RuntimeEventV1) => void): () => void;
  respondToPermission(requestId: string, approved: boolean): Promise<RuntimePermissionResponseOutcomeV1>;
  cancelTurn(): Promise<void>;
  readSessionIdentity(): Readonly<{ sessionId: string | null }>;
  updateSessionRuntimeConfig(
    update: SessionRuntimeConfigUpdateV1 & Readonly<Record<string, unknown>>,
  ): Promise<RuntimeConfigUpdateOutcomeV1 | void>;
  resetOrDisposeRuntime(reason?: RuntimeDisposeReasonV1 | Readonly<{ reason?: RuntimeDisposeReasonV1 }>): Promise<void>;
}>;

type ClaudeTestRuntimeNativeExtras = Partial<ClaudeTestRuntimeOperations>;

type ClaudeTestRuntimeEnvelope = Readonly<{
  operations: ClaudeTestRuntimeOperations;
  nativeRuntime: SessionRuntimeV1 & ClaudeTestRuntimeNativeExtras;
}>;

function readRuntimeNativeExtras(runtime: SessionRuntimeV1): ClaudeTestRuntimeNativeExtras {
  return runtime as SessionRuntimeV1 & ClaudeTestRuntimeNativeExtras;
}

function createRuntimeInput(prompt: string): Readonly<{ v: 1; text: string }> {
  return { v: 1, text: prompt };
}

function assertAccepted(result: RuntimeSendResultV1): void {
  if (result.status === 'accepted') return;
  throw new Error(result.diagnostic ?? `runtime send was not accepted: ${result.status}`);
}

function expectSessionRuntime(value: unknown): SessionRuntimeV1 {
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
  return value as SessionRuntimeV1;
}

export function expectRuntimeEnvelope(value: unknown): ClaudeTestRuntimeEnvelope {
  const runtime = expectSessionRuntime(value);
  const extras = readRuntimeNativeExtras(runtime);
  const operations: ClaudeTestRuntimeOperations = {
    beginTurnLifecycle: () => {
      extras.beginTurnLifecycle?.();
    },
    startOrLoadSession: async (opts) => {
      if (extras.startOrLoadSession) return await extras.startOrLoadSession(opts);
      return { sessionId: runtime.identity.read().providerSessionId };
    },
    sendTurnPrompt: async (prompt, meta) => {
      if (extras.sendTurnPrompt) {
        await extras.sendTurnPrompt(prompt, meta);
        return;
      }
      const result = await runtime.send(createRuntimeInput(prompt));
      assertAccepted(result);
    },
    steerInFlightTurn: async (message, meta) => {
      if (extras.steerInFlightTurn) {
        await extras.steerInFlightTurn(message, meta);
        return;
      }
      const result = await runtime.send(createRuntimeInput(message), {
        deliverAs: 'steer',
        ...(typeof meta?.userMessageSeq === 'number' && Number.isFinite(meta.userMessageSeq)
          ? { userMessageSeq: meta.userMessageSeq }
          : {}),
      });
      assertAccepted(result);
    },
    waitForTurnCompletion: async (opts) => {
      await extras.waitForTurnCompletion?.(opts);
    },
    subscribeRuntimeEvents: (handler) => runtime.events.subscribe(handler),
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
      const result: RuntimeCancelResultV1 | undefined = await runtime.cancel?.({ reason: 'user' });
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
