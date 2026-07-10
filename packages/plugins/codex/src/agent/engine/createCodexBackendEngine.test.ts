import { describe, expect, it, vi } from 'vitest';

import type {
  CreateSessionRuntimeParamsV1,
  ExecClientHandleV1,
  ExecClientSpecV1,
  ExecRunOptionsV1,
  ExecRuntimeServiceV1,
  JsonRpcClientV1,
  PluginContextV1,
  RuntimeEventV1,
  RuntimeSendOptionsV1,
  SessionRuntimeV1,
  TerminalRuntimeHostOrchestrationV1,
} from '@happier-dev/plugin-sdk';

import { buildCodexAgentRuntimeDescriptor } from '../../protocol/runtimeDescriptorV1.js';
import { createCodexBackendEngine } from './createCodexBackendEngine.js';

type HostRunSessionParams = CreateSessionRuntimeParamsV1 & Readonly<{
  credentials: Readonly<{
    token: string;
    encryption: Readonly<{
      type: 'legacy';
      secret: Uint8Array;
    }>;
  }>;
  startedBy: 'daemon';
  resume: string;
  modelId: string;
  environmentVariables: Readonly<Record<string, string>>;
}>;

function createCapturingExec(fixtureOptions: Readonly<{
  autoCompleteTurns?: boolean;
  failWithModelCapacityOnFirstPrompt?: string;
  emitActivityBeforeCapacityFailure?: boolean;
  resumeResponseDelayMs?: number;
  threadReadResponseDelayMs?: number;
  oversizedResumeResponse?: boolean;
  requireResumeBeforeThreadRead?: boolean;
  enforceRequestTimeouts?: boolean;
}> = {}): Readonly<{
  exec: ExecRuntimeServiceV1;
  specs: ExecClientSpecV1[];
  requests: Array<Readonly<{ method: string; params: unknown; timeoutMs?: number }>>;
  notifications: Array<Readonly<{ method: string; params: unknown }>>;
  emitNotification: (method: string, params: unknown) => Promise<void>;
  completeTurn: () => Promise<void>;
}> {
  const specs: ExecClientSpecV1[] = [];
  const requests: Array<Readonly<{ method: string; params: unknown; timeoutMs?: number }>> = [];
  const notifications: Array<Readonly<{ method: string; params: unknown }>> = [];
  const notificationHandlers = new Map<string, (params: unknown) => Promise<void> | void>();
  const resumedThreadIds = new Set<string>();
  const promptTurnStartCounts = new Map<string, number>();
  let turnSeq = 0;
  let pendingTurn: Readonly<{ threadId: string; turnId: string }> | null = null;

  const completeTurn = async (): Promise<void> => {
    const turn = pendingTurn;
    if (!turn) return;
    pendingTurn = null;
    await notificationHandlers.get('turn/completed')?.({
      threadId: turn.threadId,
      turn: { id: turn.turnId },
    });
  };

  const emitNotification = async (method: string, params: unknown): Promise<void> => {
    await notificationHandlers.get(method)?.(params);
  };

  const client: JsonRpcClientV1 = {
    async request(method, params, options) {
      requests.push({ method, params, timeoutMs: options?.timeoutMs });
      if (method === 'initialize') return { serverInfo: { name: 'fake-codex-app-server' } };
      if (method === 'thread/start') return { threadId: 'thread-started' };
      if (method === 'thread/resume') {
        const record = params && typeof params === 'object' ? params as { threadId?: unknown } : {};
        const resumedThreadId = typeof record.threadId === 'string' ? record.threadId : 'thread-resumed';
        resumedThreadIds.add(resumedThreadId);
        if (fixtureOptions.resumeResponseDelayMs && fixtureOptions.resumeResponseDelayMs > 0) {
          if (
            fixtureOptions.enforceRequestTimeouts === true
            && typeof options?.timeoutMs === 'number'
            && options.timeoutMs < fixtureOptions.resumeResponseDelayMs
          ) {
            await delay(options.timeoutMs);
            throw new Error(`Codex app-server request thread/resume timed out after ${options.timeoutMs}ms`);
          }
          await delay(fixtureOptions.resumeResponseDelayMs);
        }
        if (fixtureOptions.oversizedResumeResponse === true) {
          const error = new Error('JSON-RPC frame exceeded the configured size limit (1024 bytes)') as Error & { code?: string };
          error.code = 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR';
          throw error;
        }
        return { threadId: resumedThreadId };
      }
      if (method === 'thread/read') {
        const record = params && typeof params === 'object' ? params as { threadId?: unknown; includeTurns?: unknown } : {};
        const requestedThreadId = typeof record.threadId === 'string' ? record.threadId : '';
        if (fixtureOptions.requireResumeBeforeThreadRead === true && !resumedThreadIds.has(requestedThreadId)) {
          throw new Error(`thread not found: ${requestedThreadId}`);
        }
        if (fixtureOptions.threadReadResponseDelayMs && fixtureOptions.threadReadResponseDelayMs > 0) {
          if (
            fixtureOptions.enforceRequestTimeouts === true
            && typeof options?.timeoutMs === 'number'
            && options.timeoutMs < fixtureOptions.threadReadResponseDelayMs
          ) {
            await delay(options.timeoutMs);
            throw new Error(`Codex app-server request thread/read timed out after ${options.timeoutMs}ms`);
          }
          await delay(fixtureOptions.threadReadResponseDelayMs);
        }
        return {
          thread: {
            id: requestedThreadId,
            turns: record.includeTurns === true ? [{ id: 'turn-history' }] : [],
          },
        };
      }
      if (method === 'turn/start') {
        turnSeq += 1;
        const turnId = `turn-${turnSeq}`;
        const record = params && typeof params === 'object' ? params as { input?: Array<{ text?: unknown }>; threadId?: unknown } : {};
        const threadId = typeof record.threadId === 'string' ? record.threadId : 'thread-started';
        const promptText = Array.isArray(record.input) && typeof record.input[0]?.text === 'string'
          ? record.input[0].text
          : '';
        const promptTurnStartCount = (promptTurnStartCounts.get(promptText) ?? 0) + 1;
        promptTurnStartCounts.set(promptText, promptTurnStartCount);
        pendingTurn = { threadId, turnId };
        await notificationHandlers.get('turn/started')?.({ threadId, turn: { id: turnId } });
        if (
          fixtureOptions.failWithModelCapacityOnFirstPrompt
          && promptText === fixtureOptions.failWithModelCapacityOnFirstPrompt
          && promptTurnStartCount === 1
        ) {
          const capacityError = {
            message: 'Selected model is at capacity. Please try a different model.',
            codexErrorInfo: 'other',
            additionalDetails: null,
          };
          if (fixtureOptions.emitActivityBeforeCapacityFailure === true) {
            await notificationHandlers.get('item/agentMessage/delta')?.({
              threadId,
              turnId,
              itemId: 'assistant-message-1',
              delta: 'I started the work.',
            });
          }
          pendingTurn = null;
          await notificationHandlers.get('turn/completed')?.({
            threadId,
            turn: { id: turnId, status: 'failed', error: capacityError },
          });
          return { turnId };
        }
        if (fixtureOptions.autoCompleteTurns !== false) await completeTurn();
        return { turnId };
      }
      if (method === 'turn/steer') return {};
      if (method === 'turn/interrupt') {
        const record = params && typeof params === 'object' ? params as { threadId?: unknown; turnId?: unknown } : {};
        await notificationHandlers.get('turn/interrupted')?.({
          threadId: typeof record.threadId === 'string' ? record.threadId : 'thread-started',
          turn: { id: typeof record.turnId === 'string' ? record.turnId : 'turn-interrupted' },
        });
        return {};
      }
      return {};
    },
    async notify(method, params) {
      notifications.push({ method, params });
    },
    registerRequestHandler() {
      return () => undefined;
    },
    registerNotificationHandler(method, handler) {
      notificationHandlers.set(method, handler);
      return () => {
        if (notificationHandlers.get(method) === handler) {
          notificationHandlers.delete(method);
        }
      };
    },
  };

  const handle: ExecClientHandleV1<JsonRpcClientV1> = {
    client,
    process: {
      pid: 123,
      exit: Promise.resolve({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      writeStdin: async () => undefined,
      kill: () => undefined,
      dispose: async () => undefined,
    },
    status: 'running',
    onExit: () => () => undefined,
    dispose: async () => undefined,
  };

  return {
    specs,
    requests,
    notifications,
    emitNotification,
    completeTurn,
    exec: {
      systemTools: {
        resolve: async () => {
          throw new Error('system tool resolution is not used by Codex app-server engine tests');
        },
      },
      run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      spawn: async () => handle.process,
      spawnClient: async (spec: ExecClientSpecV1, _options?: ExecRunOptionsV1) => {
        specs.push(spec);
        return handle;
      },
    },
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function createAppServerRuntime(
  engine: ReturnType<typeof createCodexBackendEngine>,
  sessionParams: CreateSessionRuntimeParamsV1,
): Promise<SessionRuntimeV1> {
  const runtime = await engine.runtimeCore?.createSessionRuntime(sessionParams);
  if (!runtime) {
    throw new Error('Expected Codex engine to create a public session runtime.');
  }
  return runtime;
}

async function sendRuntimeText(
  runtime: SessionRuntimeV1,
  text: string,
  options?: RuntimeSendOptionsV1,
): Promise<void> {
  await expect(runtime.send({ v: 1, text }, options)).resolves.toEqual(
    expect.objectContaining({ status: 'accepted' }),
  );
}

async function waitForRequestCount(
  exec: ReturnType<typeof createCapturingExec>,
  method: string,
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (exec.requests.filter((request) => request.method === method).length >= count) return;
    await delay(5);
  }
  throw new Error(`Timed out waiting for ${count} ${method} requests`);
}

async function waitForRuntimeEvent(
  events: readonly RuntimeEventV1[],
  predicate: (event: RuntimeEventV1) => boolean,
): Promise<RuntimeEventV1> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const event = events.find(predicate);
    if (event) return event;
    await delay(5);
  }
  throw new Error('Timed out waiting for runtime event');
}

function createPluginContextFixture(
  exec = createCapturingExec(),
  envOverrides: Readonly<Record<string, string>> = {},
): PluginContextV1 {
  // Unit fixture implements only the PluginContext fields exercised by the Codex app-server engine.
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    config: { values: {} },
    agentRuntime: {
      exec: exec.exec,
      acp: {
        defineAcpBackend: vi.fn(() => ({
          runtimeCore: {
            createSessionRuntime: vi.fn(async () => ({ kind: 'acp-runtime' })),
            createExecutionRunBackend: vi.fn(),
          },
        })),
      },
    },
    env: {
      get: vi.fn(() => null),
      require: vi.fn(() => {
        throw new Error('env.require is not used by Codex app-server engine tests');
      }),
      list: vi.fn(() => ({
        HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '250',
        HAPPIER_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS: '500',
        ...envOverrides,
      })),
    },
  } as unknown as PluginContextV1;
}

describe('createCodexBackendEngine', () => {
  it('exposes the plugin-owned Codex handoff surface', () => {
    const ctx = createPluginContextFixture();
    const engine = createCodexBackendEngine(ctx);

    expect(engine.handoffSurface).toMatchObject({
      exportBundle: expect.any(Function),
      importBundle: expect.any(Function),
    });
  });

  it('launches the Codex terminal runtime through a host-granted agent CLI executable', async () => {
    const ctx = createPluginContextFixture(createCapturingExec(), {
      CODEX_HOME: '/tmp/codex-home',
      OPENAI_API_KEY: 'ambient-native-key',
    });
    const engine = createCodexBackendEngine(ctx);
    const resolveAgentCliExecutable = vi.fn(async () => ({
      executable: {
        path: '/managed/runtime/node',
        hostGrant: { kind: 'agent-cli' as const, grantId: 'agent-cli:codex' },
      },
      args: ['/managed/codex/bin/codex.js'],
      source: 'managed',
      resolvedPath: '/managed/codex/bin/codex.js',
    }));
    const waitForTermination = vi.fn(async () => ({ type: 'exited' as const, code: 0 }));
    const stop = vi.fn(async () => undefined);
    const launch = vi.fn(async () => ({
      pid: 123,
      waitForTermination,
      stop,
      readBufferedStderr: () => '',
    }));
    const publishControlState = vi.fn(async () => undefined);
    const host: TerminalRuntimeHostOrchestrationV1 = {
      input: { subscribe: () => ({ unsubscribe: () => undefined }) },
      switching: { register: () => ({ unsubscribe: () => undefined }) },
      process: {
        resolveAgentCliExecutable,
        launch,
      },
      transcripts: {
        openDirectMirror: vi.fn(async () => ({ stop: vi.fn(async () => undefined) })),
      },
      projection: {
        openDirectTranscriptMirror: vi.fn(async () => ({ stop: vi.fn(async () => undefined) })),
        publishControlState,
        publishProviderSessionId: vi.fn(async () => true),
        publishSubagentStarted: vi.fn(async () => undefined),
        publishSubagentCompleted: vi.fn(async () => undefined),
      },
    };

    expect(engine.terminalRuntimeSurface?.launch).toEqual(expect.any(Function));
    const result = await engine.terminalRuntimeSurface?.launch?.({
      sessionId: 'session-1',
      directory: '/repo',
      metadata: {
        permissionMode: 'default',
      },
      isolation: {
        env: { OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1' },
        unsetEnvKeys: ['openai_api_key'],
      },
      host,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ type: 'process_exited', exitCode: 0 });
    expect(resolveAgentCliExecutable).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'codex',
      cwd: '/repo',
    }));
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      executable: {
        path: '/managed/runtime/node',
        hostGrant: { kind: 'agent-cli', grantId: 'agent-cli:codex' },
      },
      args: expect.arrayContaining(['/managed/codex/bin/codex.js', '--cd', '/repo']),
      cwd: '/repo',
      stdio: 'inherit',
      unsetEnvKeys: ['openai_api_key'],
    }));
    const launchedEnv = launch.mock.calls[0]?.[0]?.env;
    expect(launchedEnv?.OPENAI_API_KEY).toBeUndefined();
    expect(launchedEnv?.OPENAI_BASE_URL).toBe('http://127.0.0.1:11434/v1');
    expect(publishControlState).toHaveBeenCalledWith(expect.objectContaining({
      target: 'local',
    }));
  });

  it('exposes the plugin-owned Codex fork surface with typed ACP fallback support', async () => {
    const ctx = createPluginContextFixture();
    const engine = createCodexBackendEngine(ctx);
    const loadSession = vi.fn(async () => ({
      ok: true,
      value: {
        providerSessionId: 'parent-acp-thread',
      },
    }));
    const forkSession = vi.fn(async () => ({
      ok: true,
      value: {
        providerSessionId: 'forked-acp-thread',
      },
    }));

    const result = await engine.forkSurface?.fork?.({
      parentSessionId: 'parent-session',
      directory: '/repo',
      forkPoint: { kind: 'latest' },
      parentMetadata: {
        agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
          backendMode: 'acp',
          providerSessionId: 'parent-acp-thread',
        }),
      },
      acp: {
        loadSession,
        forkSession,
      },
    });

    expect(result).toEqual(expect.objectContaining({
      providerSessionId: 'forked-acp-thread',
      launch: expect.objectContaining({
        sessionStateUpdates: expect.arrayContaining([
          {
            fieldId: 'identity.providerSessionId',
            value: 'forked-acp-thread',
          },
        ]),
      }),
    }));
    expect(loadSession).toHaveBeenCalledWith({
      backendId: 'codex',
      directory: '/repo',
      providerSessionId: 'parent-acp-thread',
    });
    expect(forkSession).toHaveBeenCalledWith({
      backendId: 'codex',
      directory: '/repo',
      sourceProviderSessionId: 'parent-acp-thread',
    });
  });

  it('creates a plugin-owned Codex app-server runtime that starts a thread through spawnClient', async () => {
    const exec = createCapturingExec();
    const ctx = createPluginContextFixture(exec);
    const engine = createCodexBackendEngine(ctx);

    const sessionRuntime = await createAppServerRuntime(engine, { cwd: '/tmp/codex-project' });

    expect(sessionRuntime).toEqual(expect.objectContaining({
      identity: expect.objectContaining({ read: expect.any(Function) }),
      events: expect.objectContaining({ subscribe: expect.any(Function) }),
      send: expect.any(Function),
      dispose: expect.any(Function),
      permissions: { capability: 'inline' },
    }));

    expect(exec.specs).toHaveLength(1);
    expect(exec.specs[0]).toMatchObject({
      launch: {
        kind: 'agent-cli',
        agentId: 'codex',
        cwd: '/tmp/codex-project',
      },
      protocol: { kind: 'json-rpc-2.0' },
      transport: {
        kind: 'stdio',
        framing: { kind: 'strict-lf-json' },
      },
    });
    expect(exec.requests.map((request) => request.method)).toEqual([
      'initialize',
      'account/rateLimits/read',
      'thread/start',
    ]);
    expect(sessionRuntime.identity.read()).toEqual({
      providerSessionId: 'thread-started',
    });
  });

  it('forwards host run options into the Codex app-server runtime plan opts', async () => {
    const ctx = createPluginContextFixture();
    const engine = createCodexBackendEngine(ctx);
    const credentials = {
      token: 'host-token',
      encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
    } satisfies HostRunSessionParams['credentials'];
    const sessionParams = {
      backendId: 'codex-daemon',
      cwd: '/tmp/codex-project',
      credentials,
      startedBy: 'daemon',
      resume: 'resume-session-1',
      modelId: 'gpt-5-codex',
      environmentVariables: { HAPPIER_TEST_FLAG: '1' },
    } satisfies HostRunSessionParams;

    const runtime = await createAppServerRuntime(engine, sessionParams);

    expect(runtime.identity.read()).toEqual({ providerSessionId: 'resume-session-1' });
  });

  it('sends app-server turns through the public session runtime instead of no-op placeholders', async () => {
    const exec = createCapturingExec();
    const ctx = createPluginContextFixture(exec);
    const engine = createCodexBackendEngine(ctx);
    const sessionRuntime = await createAppServerRuntime(engine, { cwd: '/tmp/codex-project' });

    await sendRuntimeText(sessionRuntime, 'hello codex');

    expect(exec.requests).toContainEqual(expect.objectContaining({
      method: 'turn/start',
      params: expect.objectContaining({
        threadId: 'thread-started',
        input: [{ type: 'text', text: 'hello codex' }],
      }),
    }));
  });

  it('publishes app-server assistant deltas as committed transcript runtime events at turn completion', async () => {
    const exec = createCapturingExec({ autoCompleteTurns: false });
    const ctx = createPluginContextFixture(exec);
    const engine = createCodexBackendEngine(ctx);
    const sessionRuntime = await createAppServerRuntime(engine, { cwd: '/tmp/codex-project' });
    const runtimeEvents: RuntimeEventV1[] = [];
    sessionRuntime.events.subscribe((event) => {
      runtimeEvents.push(event);
    });

    await sendRuntimeText(sessionRuntime, 'hello codex');
    await exec.emitNotification('item/agentMessage/delta', {
      threadId: 'thread-started',
      turnId: 'turn-1',
      itemId: 'assistant-message-1',
      delta: 'Hello',
    });
    await exec.emitNotification('item/agentMessage/delta', {
      threadId: 'thread-started',
      turnId: 'turn-1',
      itemId: 'assistant-message-1',
      delta: ' from Codex',
    });
    await exec.completeTurn();

    await waitForRuntimeEvent(runtimeEvents, (event) => (
      event.kind === 'transcript-agent-message-committed'
      && event.agentId === 'codex'
    ));
    const turnStart = runtimeEvents.find((event) => event.kind === 'turn-start');
    const agentMessage = runtimeEvents.find((event) => (
      event.kind === 'transcript-agent-message-committed'
      && event.agentId === 'codex'
    ));
    expect(turnStart?.turnId).toMatch(/^codex-turn-/);
    expect(agentMessage).toEqual(expect.objectContaining({
      kind: 'transcript-agent-message-committed',
      agentId: 'codex',
      localId: `codex:${turnStart?.turnId}:assistant:assistant-message-1`,
      body: { type: 'message', message: 'Hello from Codex' },
    }));
  });

  it('retries the plugin app-server prompt once after a temporary model-capacity failure without turn activity', async () => {
    const exec = createCapturingExec({
      failWithModelCapacityOnFirstPrompt: 'model-capacity-once',
    });
    const ctx = createPluginContextFixture(exec);
    const engine = createCodexBackendEngine(ctx);
    const sessionRuntime = await createAppServerRuntime(engine, { cwd: '/tmp/codex-project' });
    const runtimeEvents: RuntimeEventV1[] = [];
    sessionRuntime.events.subscribe((event) => {
      runtimeEvents.push(event);
    });

    await sendRuntimeText(sessionRuntime, 'model-capacity-once');
    await waitForRequestCount(exec, 'turn/start', 2);

    const turnStarts = exec.requests.filter((request) => request.method === 'turn/start') as Array<{
      params?: { input?: Array<{ text?: string }> };
    }>;
    expect(turnStarts.map((request) => request.params?.input?.[0]?.text)).toEqual([
      'model-capacity-once',
      'model-capacity-once',
    ]);
    expect(runtimeEvents).not.toContainEqual(expect.objectContaining({
      kind: 'backend-error',
      error: expect.objectContaining({
        message: expect.stringContaining('capacity'),
      }),
    }));
  });

  it('continues instead of replaying the plugin app-server prompt after temporary model-capacity failure with turn activity', async () => {
    const exec = createCapturingExec({
      failWithModelCapacityOnFirstPrompt: 'model-capacity-after-activity',
      emitActivityBeforeCapacityFailure: true,
    });
    const ctx = createPluginContextFixture(exec);
    const engine = createCodexBackendEngine(ctx);
    const sessionRuntime = await createAppServerRuntime(engine, { cwd: '/tmp/codex-project' });

    await sendRuntimeText(sessionRuntime, 'model-capacity-after-activity');
    await waitForRequestCount(exec, 'turn/start', 2);

    const turnStarts = exec.requests.filter((request) => request.method === 'turn/start') as Array<{
      params?: { input?: Array<{ text?: string }> };
    }>;
    const prompts = turnStarts.map((request) => request.params?.input?.[0]?.text ?? '');
    expect(prompts.filter((prompt) => prompt === 'model-capacity-after-activity')).toHaveLength(1);
    expect(prompts.some((prompt) => prompt.includes('continue') && prompt.includes('repeat completed work'))).toBe(true);
  });

  it('uses the configured continuation prompt for temporary model-capacity recovery after activity', async () => {
    const exec = createCapturingExec({
      failWithModelCapacityOnFirstPrompt: 'model-capacity-configured-continuation',
      emitActivityBeforeCapacityFailure: true,
    });
    const ctx = createPluginContextFixture(exec, {
      HAPPIER_CODEX_CONTEXT_WINDOW_CONTINUATION_PROMPT: 'Configured continuation prompt from host policy.',
    });
    const engine = createCodexBackendEngine(ctx);
    const sessionRuntime = await createAppServerRuntime(engine, { cwd: '/tmp/codex-project' });

    await sendRuntimeText(sessionRuntime, 'model-capacity-configured-continuation');
    await waitForRequestCount(exec, 'turn/start', 2);

    const turnStarts = exec.requests.filter((request) => request.method === 'turn/start') as Array<{
      params?: { input?: Array<{ text?: string }> };
    }>;
    expect(turnStarts.map((request) => request.params?.input?.[0]?.text)).toContain(
      'Configured continuation prompt from host policy.',
    );
  });

  it('publishes requested resume identity before delayed app-server history hydration completes', async () => {
    const exec = createCapturingExec({ resumeResponseDelayMs: 500 });
    const ctx = createPluginContextFixture(exec);
    const engine = createCodexBackendEngine(ctx);

    let settled = false;
    const start = createAppServerRuntime(engine, {
      cwd: '/tmp/codex-project',
      initialRuntimeState: { providerSessionId: 'resume-slow' },
    })
      .finally(() => {
        settled = true;
      });
    await delay(50);

    expect(settled).toBe(false);
    await expect(start).resolves.toEqual(expect.objectContaining({
      identity: expect.objectContaining({ read: expect.any(Function) }),
    }));
    const sessionRuntime = await start;
    expect(sessionRuntime.identity.read()).toEqual({ providerSessionId: 'resume-slow' });
  });

  it('defaults resumed app-server sessions to lean thread metadata recovery', async () => {
    const exec = createCapturingExec({
      oversizedResumeResponse: true,
      requireResumeBeforeThreadRead: true,
    });
    const ctx = createPluginContextFixture(exec);
    const engine = createCodexBackendEngine(ctx);

    const sessionRuntime = await createAppServerRuntime(engine, {
      cwd: '/tmp/codex-project',
      initialRuntimeState: { providerSessionId: 'resume-123' },
    });

    const resumeIndex = exec.requests.findIndex((request) => request.method === 'thread/resume');
    const readIndex = exec.requests.findIndex((request) => request.method === 'thread/read');
    expect(resumeIndex).toBeGreaterThanOrEqual(0);
    expect(readIndex).toBeGreaterThan(resumeIndex);
    expect(exec.requests[readIndex]).toMatchObject({
      method: 'thread/read',
      params: {
        threadId: 'resume-123',
        includeTurns: false,
      },
    });
    expect(sessionRuntime.identity.read()).toEqual({ providerSessionId: 'resume-123' });
  });

  it('waits beyond the normal startup timeout for recoverable oversized no-history resumes', async () => {
    const exec = createCapturingExec({
      resumeResponseDelayMs: 700,
      oversizedResumeResponse: true,
      requireResumeBeforeThreadRead: true,
      enforceRequestTimeouts: true,
    });
    const ctx = createPluginContextFixture(exec, {
      HAPPIER_CODEX_APP_SERVER_RESUME_RECOVERY_TIMEOUT_MS: '1200',
    });
    const engine = createCodexBackendEngine(ctx);

    await expect(createAppServerRuntime(engine, {
      cwd: '/tmp/codex-project',
      initialRuntimeState: { providerSessionId: 'resume-slow' },
    })).resolves.toEqual(expect.objectContaining({
      identity: expect.objectContaining({ read: expect.any(Function) }),
    }));

    const resumeIndex = exec.requests.findIndex((request) => request.method === 'thread/resume');
    const readIndex = exec.requests.findIndex((request) => request.method === 'thread/read');
    expect(resumeIndex).toBeGreaterThanOrEqual(0);
    expect(readIndex).toBeGreaterThan(resumeIndex);
    expect(exec.requests[resumeIndex]).toMatchObject({
      method: 'thread/resume',
      timeoutMs: 1200,
    });
    expect(exec.requests[readIndex]).toMatchObject({
      method: 'thread/read',
      params: {
        threadId: 'resume-slow',
        includeTurns: false,
      },
    });
  });

  it('uses the resume recovery timeout for lean thread metadata reads after oversized resumes', async () => {
    const exec = createCapturingExec({
      threadReadResponseDelayMs: 700,
      oversizedResumeResponse: true,
      requireResumeBeforeThreadRead: true,
      enforceRequestTimeouts: true,
    });
    const ctx = createPluginContextFixture(exec, {
      HAPPIER_CODEX_APP_SERVER_RESUME_RECOVERY_TIMEOUT_MS: '1200',
    });
    const engine = createCodexBackendEngine(ctx);

    await expect(createAppServerRuntime(engine, {
      cwd: '/tmp/codex-project',
      initialRuntimeState: { providerSessionId: 'resume-slow-read' },
    })).resolves.toEqual(expect.objectContaining({
      identity: expect.objectContaining({ read: expect.any(Function) }),
    }));

    const resumeIndex = exec.requests.findIndex((request) => request.method === 'thread/resume');
    const readIndex = exec.requests.findIndex((request) => request.method === 'thread/read');
    expect(resumeIndex).toBeGreaterThanOrEqual(0);
    expect(readIndex).toBeGreaterThan(resumeIndex);
    expect(exec.requests[readIndex]).toMatchObject({
      method: 'thread/read',
      timeoutMs: 1200,
      params: {
        threadId: 'resume-slow-read',
        includeTurns: false,
      },
    });
  });

  it('keeps full app-server history import as an explicit opt-in', async () => {
    const exec = createCapturingExec({
      oversizedResumeResponse: true,
      requireResumeBeforeThreadRead: true,
    });
    const ctx = createPluginContextFixture(exec);
    const engine = createCodexBackendEngine(ctx);

    await expect(createAppServerRuntime(engine, {
      cwd: '/tmp/codex-project',
      initialRuntimeState: {
        providerSessionId: 'resume-123',
        importHistory: true,
      },
    })).rejects.toThrow(/JSON-RPC frame exceeded/);

    expect(exec.requests.map((request) => request.method)).toEqual([
      'initialize',
      'account/rateLimits/read',
      'thread/resume',
    ]);
  });

  it('provisions and sends execution-run prompts through the app-server request flow', async () => {
    const exec = createCapturingExec();
    const ctx = createPluginContextFixture(exec);
    const engine = createCodexBackendEngine(ctx);

    const executionRunBackend = engine.runtimeCore?.createExecutionRunBackend({
      cwd: '/tmp/codex-project',
      backendId: 'codex',
      permissionMode: 'read_only',
    });
    expect(executionRunBackend).toEqual(expect.objectContaining({
      readResumeSupport: expect.any(Function),
      provisionSession: expect.any(Function),
      sendPrompt: expect.any(Function),
      cancel: expect.any(Function),
      waitForTurnCompletion: expect.any(Function),
      probeTurnLiveness: expect.any(Function),
      dispose: expect.any(Function),
    }));
    await expect(executionRunBackend?.provisionSession({
      initialPrompt: 'first prompt',
    })).resolves.toEqual(expect.objectContaining({
      sessionId: 'thread-started',
    }));
    await executionRunBackend?.sendPrompt('thread-started', 'second prompt');

    expect(exec.requests.map((request) => request.method)).toEqual([
      'initialize',
      'account/rateLimits/read',
      'thread/start',
      'turn/start',
      'turn/start',
    ]);
    expect(exec.requests).toContainEqual(expect.objectContaining({
      method: 'turn/start',
      params: expect.objectContaining({
        threadId: 'thread-started',
        input: [{ type: 'text', text: 'second prompt' }],
      }),
    }));
  });

  it('provisions resumed execution-run sessions through lean app-server metadata recovery', async () => {
    const exec = createCapturingExec({
      oversizedResumeResponse: true,
      requireResumeBeforeThreadRead: true,
    });
    const ctx = createPluginContextFixture(exec);
    const engine = createCodexBackendEngine(ctx);

    const executionRunBackend = engine.runtimeCore?.createExecutionRunBackend({
      cwd: '/tmp/codex-project',
      backendId: 'codex',
      runId: 'run-resume',
    });

    await expect(executionRunBackend?.provisionSession({
      resumeSessionId: 'resume-123',
    })).resolves.toEqual({ sessionId: 'resume-123' });

    const resumeIndex = exec.requests.findIndex((request) => request.method === 'thread/resume');
    const readIndex = exec.requests.findIndex((request) => request.method === 'thread/read');
    expect(resumeIndex).toBeGreaterThanOrEqual(0);
    expect(readIndex).toBeGreaterThan(resumeIndex);
    expect(exec.requests[readIndex]).toMatchObject({
      method: 'thread/read',
      params: {
        threadId: 'resume-123',
        includeTurns: false,
      },
    });
  });

  it('resolves execution-run sendPrompt after app-server turn acceptance and before turn completion', async () => {
    const exec = createCapturingExec({ autoCompleteTurns: false });
    const ctx = createPluginContextFixture(exec);
    const engine = createCodexBackendEngine(ctx);

    const executionRunBackend = engine.runtimeCore?.createExecutionRunBackend({
      cwd: '/tmp/codex-project',
      backendId: 'codex',
      runId: 'run-ack',
    });
    await executionRunBackend?.provisionSession();

    const result = await Promise.race([
      executionRunBackend?.sendPrompt('thread-started', 'long running prompt')
        .then(() => 'submitted' as const),
      delay(25).then(() => 'blocked' as const),
    ]);

    expect(result).toBe('submitted');
    await expect(executionRunBackend?.probeTurnLiveness?.('thread-started')).resolves.toMatchObject({
      active: true,
      diagnostics: expect.objectContaining({
        promptInFlight: false,
        turnInFlight: true,
      }),
    });
    const completion = executionRunBackend?.waitForTurnCompletion?.(250);
    await exec.completeTurn();
    await expect(completion).resolves.toBeUndefined();
  });
});
