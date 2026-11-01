import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type {
  ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';
import type {
  PluginProtocolClientHandle,
  PluginProtocolClientSpec,
} from '@happier-dev/plugin-sdk/exec/protocol-clients';
import type {
  AgentSessionConfigurationSnapshot,
  AgentSessionRuntime,
  AgentSessionRuntimeEvent,
  AgentSessionSendRequest,
  AgentSessionModelsSource,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentSessionRuntimeEventSchema } from '@happier-dev/plugin-sdk/agents/runtime';
import { InteractionTransientAuthorRequestV1Schema } from '@happier-dev/plugin-sdk/interactions';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PI_REQUEST_AUTH_CAPABILITY_PATH_ENV,
  PI_REQUEST_AUTH_PRODUCER_VERSION_ENV,
  resolvePiRequestAuthExtensionPath,
} from '../../auth/services/requestAuth/index.js';
import { buildPiCompletedContextCompactionPayload, type PiRuntimeEvent } from './events.js';
import { createPiExecutionRunConversation, createPiRuntimeOperations } from './operations.js';

type Capture = {
  initialRecords?: readonly unknown[];
  specs: Extract<PluginProtocolClientSpec, { kind: 'jsonStream' }>[];
  written: unknown[];
  availableCommands?: readonly Readonly<{
    name: string;
    description?: string;
    source?: 'extension' | 'prompt' | 'skill';
  }>[];
  commandCatalogRequestCount?: number;
  commandCatalogGate?: Promise<void>;
  commandCatalogErrors?: string[];
  sessionStatsRequestCount?: number;
  sessionStats?: unknown;
  versionProbeCount?: number;
  versionOutput?: string;
  systemToolResolveCount?: number;
  resolvedExecutable?: ManagedExecutableRef;
  versionProbeExecutable?: ManagedExecutableRef;
  listener?: (record: unknown) => void | Promise<void>;
  resolveExit?: (result: Awaited<ReturnType<PluginProtocolClientHandle<'jsonStream'>['wait']>>) => void;
  warnings?: unknown[][];
  logs?: unknown[][];
  questionRequests?: unknown[];
  questionResult?: unknown;
  questionHandler?: (request: unknown, options?: Readonly<{ signal?: AbortSignal }>) => Promise<unknown>;
  approvalRequests?: unknown[];
  systemToolGate?: Promise<void>;
  systemToolSignal?: AbortSignal;
  spawnGate?: Promise<void>;
  spawnSignal?: AbortSignal;
  handleDisposeCount?: number;
};

function createRuntimeContext(capture: Capture) {
  const client = {
    subscribe(listener) {
      capture.listener = listener;
      for (const record of capture.initialRecords ?? []) void listener(record);
      return { dispose: () => {
        if (capture.listener === listener) capture.listener = undefined;
      } };
    },
    async write(record: JsonValue) {
      if (isRecord(record) && record.type === 'get_commands' && typeof record.id === 'string') {
        capture.commandCatalogRequestCount = (capture.commandCatalogRequestCount ?? 0) + 1;
        await capture.commandCatalogGate;
        const error = capture.commandCatalogErrors?.shift();
        await capture.listener?.({
          type: 'response',
          id: record.id,
          command: 'get_commands',
          success: error === undefined,
          ...(error === undefined
            ? { data: { commands: capture.availableCommands ?? [] } }
            : { error }),
        });
        return;
      }
      if (isRecord(record) && record.type === 'get_session_stats' && typeof record.id === 'string') {
        capture.sessionStatsRequestCount = (capture.sessionStatsRequestCount ?? 0) + 1;
        await capture.listener?.({
          type: 'response',
          id: record.id,
          command: 'get_session_stats',
          success: true,
          data: capture.sessionStats ?? { contextUsage: null },
        });
        return;
      }
      capture.written.push(record);
    },
    dispose: async () => undefined,
  };
  const exit = new Promise<Awaited<ReturnType<PluginProtocolClientHandle<'jsonStream'>['wait']>>>((resolve) => {
    capture.resolveExit = resolve;
  });
  const handle: PluginProtocolClientHandle<'jsonStream'> = {
    client,
    process: {
      pid: 123,
      write: async () => undefined,
      closeStdin: async () => undefined,
      wait: () => exit,
      onOutput: () => ({ dispose: () => undefined }),
      dispose: async () => undefined,
    },
      wait: () => exit,
      dispose: async () => {
        capture.handleDisposeCount = (capture.handleDisposeCount ?? 0) + 1;
      },
  };
  return {
    // The fake process boundary accepts these prepared extension arguments without loading files.
    happierToolsExtension: { extensionPath: '/tmp/pi-tools-bridge.js', configPath: '/tmp/pi-tools-config.json' },
    logger: {
      debug: (...args: unknown[]) => { capture.logs?.push(args); },
      info: (...args: unknown[]) => { capture.logs?.push(args); },
      warn: (...args: unknown[]) => { capture.warnings?.push(args); capture.logs?.push(args); },
      error: (...args: unknown[]) => { capture.logs?.push(args); },
    },
    services: {
      interactions: {
        requestApproval: async (request: unknown) => {
          capture.approvalRequests?.push(request);
          return { requestId: 'host-approval', kind: 'approval' as const, status: 'approved' as const, persistence: 'once' as const };
        },
        askQuestions: async (request: unknown, options?: Readonly<{ signal?: AbortSignal }>) => {
          capture.questionRequests?.push(request);
          if (capture.questionHandler) return await capture.questionHandler(request, options);
          return capture.questionResult ?? {
            requestId: 'pi-question-unavailable',
            kind: 'questions',
            status: 'unavailable',
          };
        },
      },
      exec: {
        systemTools: {
          resolve: async (request: Readonly<{ signal?: AbortSignal }>) => {
            capture.systemToolResolveCount = (capture.systemToolResolveCount ?? 0) + 1;
            capture.systemToolSignal = request.signal;
            await capture.systemToolGate;
            const executable = Object.freeze({
              kind: 'systemTool' as const,
              id: 'pi-cli',
            });
            capture.resolvedExecutable = executable;
            return {
              executable,
              executablePath: '/tmp/happier-pi-cli',
            };
          },
        },
        run: async (request) => {
          capture.versionProbeCount = (capture.versionProbeCount ?? 0) + 1;
          capture.versionProbeExecutable = request.executable;
          return {
            termination: {
              observed: { kind: 'exit' as const, exitCode: 0 },
              requestedBy: { kind: 'none' as const },
            },
            stdout: new TextEncoder().encode(capture.versionOutput ?? '0.81.1'),
            stderr: new Uint8Array(),
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        },
        clients: {
          spawn: async (
            spec: Extract<PluginProtocolClientSpec, { kind: 'jsonStream' }>,
            options?: Readonly<{ signal?: AbortSignal }>,
          ) => {
            capture.spawnSignal = options?.signal;
            await capture.spawnGate;
            capture.specs.push(spec);
            return handle;
          },
        },
      },
    },
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function emit(capture: Capture, record: unknown): Promise<void> {
  await capture.listener?.(record);
}

function extensionUserInput(text: string) {
  return { type: 'extension_ui_request', id: 'input-notification', method: 'notify',
    message: JSON.stringify({ type: 'happy-pi-user-input', text }) };
}

async function emitExit(
  capture: Capture,
  result: Readonly<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string }>,
): Promise<void> {
  capture.resolveExit?.({
    termination: {
      observed: result.signal ? { kind: 'signal', signal: result.signal } : { kind: 'exit', exitCode: result.exitCode ?? 0 },
      requestedBy: { kind: 'none' },
    },
    stdout: new Uint8Array(),
    stderr: new TextEncoder().encode(result.stderr),
    stdoutTruncated: false,
    stderrTruncated: false,
  });
  await Promise.resolve();
}

async function ackLastCommand(capture: Capture, data?: unknown): Promise<void> {
  const command = capture.written.at(-1);
  if (!isRecord(command) || typeof command.id !== 'string' || typeof command.type !== 'string') {
    throw new Error('Expected Pi command to be written before acknowledging it');
  }
  await emit(capture, {
    type: 'response',
    id: command.id,
    command: command.type,
    success: true,
    ...(data === undefined ? {} : { data }),
  });
}

async function ackCommandAt(capture: Capture, index: number, data?: unknown): Promise<void> {
  const command = capture.written[index];
  if (!isRecord(command) || typeof command.id !== 'string' || typeof command.type !== 'string') {
    throw new Error(`Expected Pi command ${index} to be written before acknowledging it`);
  }
  await emit(capture, {
    type: 'response',
    id: command.id,
    command: command.type,
    success: true,
    ...(data === undefined ? {} : { data }),
  });
}

async function failLastCommand(capture: Capture, error = 'Pi RPC command failed'): Promise<void> {
  const command = capture.written.at(-1);
  if (!isRecord(command) || typeof command.id !== 'string' || typeof command.type !== 'string') {
    throw new Error('Expected Pi command to be written before rejecting it');
  }
  await emit(capture, {
    type: 'response',
    id: command.id,
    command: command.type,
    success: false,
    error,
  });
}

async function waitForWrittenCount(capture: Capture, count: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (capture.written.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${count} Pi RPC writes`);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function createRuntime(capture: Capture) {
  const params = {
    ...createRuntimeContext(capture),
    cwd: '/tmp/pi-workspace',
    env: {},
    sessionId: 'happier-session-1',
    initialSessionId: 'pi-provider-session-1',
  };
  return await createPiRuntimeOperations(params);
}

async function createRuntimeWithEnv(capture: Capture, env: Readonly<Record<string, string>>) {
  return await createPiRuntimeOperations({
    ...createRuntimeContext(capture),
    cwd: '/tmp/pi-workspace',
    env,
    sessionId: 'happier-session-1',
    initialSessionId: 'pi-provider-session-1',
  });
}

function parseEvents(events: AgentSessionRuntimeEvent[]): AgentSessionRuntimeEvent[] {
  return events.map((event) => AgentSessionRuntimeEventSchema.parse(event));
}

function sendPrompt(
  runtime: AgentSessionRuntime,
  text: string,
  options: Readonly<{
    inputIds?: AgentSessionSendRequest['inputIds'];
    delivery?: AgentSessionSendRequest['delivery'];
  }> = {},
) {
  return runtime.send({
    inputIds: options.inputIds ?? ['pi-input-1'],
    input: { text },
    delivery: options.delivery ?? { kind: 'newTurn', turnId: 'pi-turn-1' },
  });
}

function configuration(options: Readonly<Record<string, string>>): AgentSessionConfigurationSnapshot {
  return {
    mode: { value: null, updatedAtMs: 1 },
    model: { value: null, updatedAtMs: 1 },
    permissionIntent: { value: null, updatedAtMs: 1 },
    options: Object.fromEntries(Object.entries(options).map(([id, value]) => [id, { value, updatedAtMs: 1 }])),
  };
}

describe('createPiRuntimeOperations', () => {
  it.each(['dispose', 'exit'] as const)('settles idle compaction once on %s', async (boundary) => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch(event => events.push(event));
    const compact = runtime.compact!({ compactionId: 'interrupted-idle', trigger: 'idle' });
    await waitForWrittenCount(capture, 1);
    await emit(capture, { type: 'compaction_start', reason: 'manual' });
    await ackLastCommand(capture);
    await expect(compact).resolves.toMatchObject({ status: 'admitted' });
    if (boundary === 'exit') {
      await emitExit(capture, { exitCode: 17, signal: null, stdout: '', stderr: '' });
    }
    await runtime.dispose();
    await runtime.dispose();
    expect(events.filter(event => event.kind === 'context-compaction')).toMatchObject([
      { compactionId: 'interrupted-idle', trigger: 'idle', phase: 'started' },
      { compactionId: 'interrupted-idle', trigger: 'idle', phase: boundary === 'exit' ? 'failed' : 'cancelled' },
    ]);
    expect(events.some(event => event.kind === 'turn-start' || event.kind === 'turn-complete')).toBe(false);
  });

  it('host idle compaction settles native manual completion and accepts the next prompt', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    expect(runtime.runtimeCapabilities?.sessionCapabilities?.compaction).toMatchObject({
      events: true, manual: true, idle: { mode: 'host', defaultEnabled: false },
    });
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch(event => events.push(event));
    const compact = runtime.compact!({ compactionId: 'idle-compact', trigger: 'idle' });
    await waitForWrittenCount(capture, 1);
    expect(capture.written.map(command => isRecord(command) ? command.type : undefined)).toEqual(['compact']);
    await emit(capture, { type: 'compaction_start', reason: 'manual' });
    await ackLastCommand(capture);
    await expect(compact).resolves.toMatchObject({ status: 'admitted' });
    await emit(capture, { type: 'compaction_end', reason: 'manual', aborted: false,
      result: { summary: 'compacted', firstKeptEntryId: 'kept-entry', tokensBefore: 150000, tokensAfter: 10000 } });
    expect(parseEvents(events).filter(event => event.kind === 'context-compaction')).toMatchObject([
      { phase: 'started', trigger: 'idle', compactionId: 'idle-compact' },
      { phase: 'completed', trigger: 'idle', compactionId: 'idle-compact' },
    ]);
    expect(events.some(event => event.kind === 'turn-start' || event.kind === 'turn-complete')).toBe(false);
    const again = runtime.compact!({ compactionId: 'manual-after-idle', trigger: 'manual' });
    await waitForWrittenCount(capture, 2);
    expect(capture.written.map(command => isRecord(command) ? command.type : undefined)).toEqual(['compact', 'compact']);
    await emit(capture, { type: 'compaction_start', reason: 'manual' });
    await ackLastCommand(capture);
    await expect(again).resolves.toMatchObject({ status: 'admitted' });
    await emit(capture, { type: 'compaction_end', reason: 'manual', aborted: true });
    const prompt = sendPrompt(runtime, 'next prompt');
    await waitForWrittenCount(capture, 3);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toMatchObject({ status: 'admitted' });
    await emit(capture, { type: 'agent_end', willRetry: false });
    await runtime.dispose();
  });


  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(['session', 'executionRun'])('retains extension startup output until the first %s consumer watches', async (kind) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100);
    const capture: Capture = { specs: [], written: [] };
    const params = { ...createRuntimeContext(capture), cwd: '/tmp/pi-workspace', env: {}, eagerStart: true };
    const opening = kind === 'session'
      ? createPiRuntimeOperations({ ...params, sessionId: 'startup-host-session' })
      : createPiExecutionRunConversation(params);
    await waitForWrittenCount(capture, 1);
    expect(capture.written[0]).toMatchObject({ type: 'get_state' });
    const observedAtMs = Date.now();
    await emit(capture, extensionUserInput('extension startup input'));
    await emit(capture, { type: 'agent_start' });
    await emit(capture, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'startup answer' } });
    await emit(capture, { type: 'agent_end' });
    await ackLastCommand(capture, { sessionId: 'startup-native-session' });
    const runtime = await opening;
    try {
      clock.mockReturnValue(observedAtMs + 1_000);
      const events: PiRuntimeEvent[] = [];
      runtime.watch((event) => events.push(event));
      const conversation = events.filter((event) => ['transcript-message-committed', 'turn-start', 'message-delta', 'turn-complete'].includes(event.kind));
      expect(conversation).toEqual([
        expect.objectContaining({ kind: 'transcript-message-committed', role: 'user', text: 'extension startup input', emittedAtMs: observedAtMs }),
        expect.objectContaining({ kind: 'turn-start', startedBy: 'provider' }),
        expect.objectContaining({ kind: 'message-delta', text: 'startup answer' }),
        expect.objectContaining({ kind: 'turn-complete' }),
      ]);
      await vi.waitFor(() => expect(events.filter((event) => event.kind === 'available-commands')).toHaveLength(1));
      expect(events.filter((event) => event.kind === 'provider-session-id')).toHaveLength(1);
      expect(events.filter((event) => event.kind === 'available-commands')).toHaveLength(1);
      const laterEvents: PiRuntimeEvent[] = [];
      runtime.watch((event) => laterEvents.push(event));
      expect(laterEvents.map((event) => event.kind)).toEqual(['provider-session-id', 'available-commands']);
    } finally {
      await runtime.dispose();
    }
  });

  it('orders a reentrant consumer event after the retained startup events', async () => {
    const capture: Capture = { specs: [], written: [] };
    const opening = createPiRuntimeOperations({ ...createRuntimeContext(capture), cwd: '/tmp/pi-workspace', env: {},
      sessionId: 'startup-host-session', eagerStart: true });
    await waitForWrittenCount(capture, 1);
    await emit(capture, extensionUserInput('first startup input'));
    await emit(capture, { type: 'agent_start' });
    await emit(capture, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'startup answer' } });
    await emit(capture, { type: 'agent_end' });
    await ackLastCommand(capture, { sessionId: 'startup-native-session' });
    const runtime = await opening;
    try {
      const events: AgentSessionRuntimeEvent[] = [];
      runtime.watch((event) => {
        events.push(event);
        if (event.kind === 'transcript-message-committed' && event.text === 'first startup input') {
          void emit(capture, extensionUserInput('reentrant input'));
        }
      });
      expect(events.filter((event) => event.kind === 'transcript-message-committed' || event.kind === 'message-delta')).toEqual([
        expect.objectContaining({ kind: 'transcript-message-committed', text: 'first startup input' }),
        expect.objectContaining({ kind: 'message-delta', text: 'startup answer' }),
        expect.objectContaining({ kind: 'transcript-message-committed', text: 'reentrant input' }),
      ]);
    } finally {
      await runtime.dispose();
    }
  });

  it('stops startup replay when its first consumer disposes the runtime', async () => {
    const capture: Capture = { specs: [], written: [] };
    const opening = createPiRuntimeOperations({ ...createRuntimeContext(capture), cwd: '/tmp/pi-workspace', env: {},
      sessionId: 'startup-host-session', eagerStart: true });
    await waitForWrittenCount(capture, 1);
    await emit(capture, extensionUserInput('startup input'));
    await emit(capture, { type: 'agent_start' });
    await ackLastCommand(capture, { sessionId: 'startup-native-session' });
    const runtime = await opening;
    const events: AgentSessionRuntimeEvent[] = [];
    let disposal: Promise<void> | undefined;
    runtime.watch((event) => {
      events.push(event);
      disposal = Promise.resolve(runtime.dispose());
    });
    await disposal;
    expect(events).toEqual([expect.objectContaining({ kind: 'transcript-message-committed', text: 'startup input' })]);
    expect(capture.handleDisposeCount).toBe(1);
  });

  it.each(['session', 'executionRun'])('prepares the input bridge for a native %s without host tools or MCP', async (kind) => {
    const root = mkdtempSync(join(tmpdir(), 'happier-pi-runtime-input-'));
    try {
      const capture: Capture = { specs: [], written: [] };
      const { happierToolsExtension: _preparedFixture, ...context } = createRuntimeContext(capture);
      const params = { ...context, cwd: root, env: { PI_CODING_AGENT_DIR: join(root, 'agent') },
        initialSessionId: 'native-input-session' };
      const runtime = kind === 'session'
        ? await createPiRuntimeOperations({ ...params, sessionId: 'host-input-session' })
        : await createPiExecutionRunConversation(params);
      try {
        const args = capture.specs[0]!.launch.args;
        const flagIndex = args.indexOf('--happier-tools-config');
        expect(flagIndex).toBeGreaterThan(0);
        const configPath = args[flagIndex + 1]!;
        const extensionPath = args[flagIndex - 1]!;
        expect(readFileSync(extensionPath, 'utf8')).toContain('happy-pi-user-input');
        expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({ directory: root, tools: [], mcpServers: {} });
        expect(existsSync(join(root, 'agent'))).toBe(false);
        await runtime.dispose();
        expect(existsSync(configPath)).toBe(false);
        expect(existsSync(extensionPath)).toBe(false);
      } finally {
        await runtime.dispose();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to spawn when the mandatory input bridge cannot be materialized', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-pi-runtime-input-failure-'));
    try {
      const capture: Capture = { specs: [], written: [] };
      const { happierToolsExtension: _preparedFixture, ...context } = createRuntimeContext(capture);
      const agentDir = join(root, 'agent');
      writeFileSync(agentDir, 'not a directory');
      vi.stubEnv('TMPDIR', agentDir);
      vi.stubEnv('TMP', agentDir);
      vi.stubEnv('TEMP', agentDir);
      await expect(createPiRuntimeOperations({ ...context, cwd: root, env: { PI_CODING_AGENT_DIR: agentDir },
        sessionId: 'host-input-session' })).rejects.toThrow();
      expect(capture.specs).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('includes process resolution in the five-minute eager session-open deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let releaseSystemTool!: () => void;
    const capture: Capture = {
      specs: [],
      written: [],
      systemToolGate: new Promise<void>((resolve) => {
        releaseSystemTool = resolve;
      }),
    };
    let outcome: 'pending' | 'resolved' | 'rejected' = 'pending';
    const opening = createPiRuntimeOperations({
      ...createRuntimeContext(capture),
      cwd: '/tmp/pi-workspace',
      env: {},
      sessionId: 'happier-session-1',
      initialSessionId: null,
      eagerStart: true,
    }).then(
      (runtime) => {
        outcome = 'resolved';
        return runtime;
      },
      (error: unknown) => {
        outcome = 'rejected';
        return error;
      },
    );

    await vi.advanceTimersByTimeAsync(61_000);
    releaseSystemTool();
    await vi.advanceTimersByTimeAsync(0);
    expect(capture.written.at(-1)).toMatchObject({ type: 'get_state' });

    await vi.advanceTimersByTimeAsync(239_000);
    expect(outcome).toBe('rejected');
    expect(capture.systemToolSignal?.aborted).toBe(true);
    await expect(opening).resolves.toMatchObject({
      message: expect.stringMatching(/timed out.*provider session state/i),
    });
    expect(capture.handleDisposeCount).toBeGreaterThanOrEqual(1);
  });

  it.each([
    { kind: 'create' as const },
    {
      kind: 'resume' as const,
      resumeSessionSelector: '/tmp/pi-session.jsonl',
      resumeProviderSessionId: 'pi-provider-session-1',
    },
  ])('rejects a late $kind process spawn and disposes its handle', async (resume) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let releaseSpawn!: () => void;
    const capture: Capture = {
      specs: [],
      written: [],
      spawnGate: new Promise<void>((resolve) => {
        releaseSpawn = resolve;
      }),
    };
    let outcome: 'pending' | 'resolved' | 'rejected' = 'pending';
    const opening = createPiRuntimeOperations({
      ...createRuntimeContext(capture),
      cwd: '/tmp/pi-workspace',
      env: {},
      sessionId: 'happier-session-1',
      initialSessionId: null,
      eagerStart: true,
      ...resume,
    }).then(
      (runtime) => {
        outcome = 'resolved';
        return runtime;
      },
      (error: unknown) => {
        outcome = 'rejected';
        return error;
      },
    );

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(outcome).toBe('rejected');
    expect(capture.spawnSignal?.aborted).toBe(true);
    await expect(opening).resolves.toMatchObject({
      message: expect.stringMatching(/timed out.*process startup/i),
    });

    releaseSpawn();
    await vi.advanceTimersByTimeAsync(0);
    expect(capture.handleDisposeCount).toBe(1);
    expect(capture.written).toEqual([]);
  });

  it('keeps eager session-open RPCs alive beyond the former 60-second cutoff', async () => {
    vi.useFakeTimers();
    const capture: Capture = { specs: [], written: [] };
    let settled: 'pending' | 'resolved' | 'rejected' = 'pending';
    const opening = createPiRuntimeOperations({
      ...createRuntimeContext(capture),
      cwd: '/tmp/pi-workspace',
      env: {},
      sessionId: 'happier-session-1',
      initialSessionId: null,
      eagerStart: true,
    }).then(
      (runtime) => {
        settled = 'resolved';
        return runtime;
      },
      () => {
        settled = 'rejected';
        return null;
      },
    );

    await vi.advanceTimersByTimeAsync(60_001);

    expect(capture.written.some((entry) => isRecord(entry) && entry.type === 'get_state')).toBe(true);
    expect(settled).toBe('pending');

    await ackLastCommand(capture, { sessionId: 'pi-provider-session-1' });
    const runtime = await opening;
    expect(runtime).not.toBeNull();
    await runtime?.dispose();
  });

  it('shares one five-minute deadline across sequential eager session-open RPCs', async () => {
    vi.useFakeTimers();
    const capture: Capture = { specs: [], written: [] };
    let settled: 'pending' | 'resolved' | 'rejected' = 'pending';
    const opening = createPiRuntimeOperations({
      ...createRuntimeContext(capture),
      cwd: '/tmp/pi-workspace',
      env: {},
      sessionId: 'happier-session-1',
      initialSessionId: null,
      eagerStart: true,
    }).then(
      (runtime) => {
        settled = 'resolved';
        return runtime;
      },
      () => {
        settled = 'rejected';
        return null;
      },
    );

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    await ackLastCommand(capture, { sessionId: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(capture.written.at(-1)).toEqual(expect.objectContaining({ type: 'new_session' }));

    await vi.advanceTimersByTimeAsync(60_001);

    expect(settled).toBe('rejected');
    expect(await opening).toBeNull();
  });

  it('keeps the absolute resume selector separate from the matching native session id', async () => {
    const capture: Capture = { specs: [], written: [] };
    const params = {
      ...createRuntimeContext(capture),
      cwd: '/tmp/pi-workspace',
      env: {},
      sessionId: 'happier-session-1',
      initialSessionId: 'pi-provider-session-1',
      resumeSessionSelector: '/home/lee/.pi/agent/sessions/workspace-a/pi-provider-session-1.jsonl',
      resumeProviderSessionId: 'pi-provider-session-1',
    };
    const runtime = await createPiRuntimeOperations(params);

    const prompt = sendPrompt(runtime, 'continue the native session');
    await waitForWrittenCount(capture, 1);
    expect(capture.written[0]).toMatchObject({
      type: 'prompt',
      message: 'continue the native session',
    });
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });
    await runtime.dispose();
  });

  it('publishes extension-injected user prompts as user transcript rows with a provider-started turn', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    // A Pi extension (e.g. AFT background bash) injects a prompt while the session is idle,
    // then the provider starts a run on its own.
    const injectedText = '  <system-reminder>\n[BACKGROUND BASH COMPLETED]\n- task bash-1 (exit 0)\n</system-reminder>\n';
    await emit(capture, extensionUserInput(injectedText));
    await emit(capture, { type: 'agent_start' });
    await emit(capture, {
      type: 'message_end',
      message: { role: 'user', content: [{ type: 'text', text: injectedText }] },
    });
    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'ack' },
    });
    await emit(capture, { type: 'agent_end' });

    const parsedEvents = parseEvents(events);
    const committed = parsedEvents.filter(
      (event) => event.kind === 'transcript-message-committed' && event.role === 'user',
    );
    expect(committed).toEqual([
      expect.objectContaining({
        kind: 'transcript-message-committed',
        role: 'user',
        text: injectedText,
        messageId: expect.stringMatching(/^provider-user-prompt:/),
      }),
    ]);
    // A second observation of identical text commits a distinct row: the id is
    // per-occurrence, so legitimate repeats do not collapse into one transcript row.
    await emit(capture, extensionUserInput(injectedText));
    const committedAfterRepeat = events.filter(
      (event): event is Extract<AgentSessionRuntimeEvent, { kind: 'transcript-message-committed' }> =>
        event.kind === 'transcript-message-committed' && event.role === 'user',
    );
    expect(committedAfterRepeat).toHaveLength(2);
    expect(committedAfterRepeat[1]!.messageId).not.toBe(committedAfterRepeat[0]!.messageId);
    const turnStart = parsedEvents.find((event) => event.kind === 'turn-start');
    expect(turnStart).toMatchObject({ kind: 'turn-start', startedBy: 'provider' });
    const turnComplete = parsedEvents.find((event) => event.kind === 'turn-complete');
    expect(turnComplete).toMatchObject({ turnId: turnStart?.turnId });
    expect(parsedEvents.some((event) => event.kind === 'turn-failed')).toBe(false);

    await runtime.dispose();
  });

  it('suppresses the echo of host-submitted prompts and keeps only injected user prompts', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    const submission = sendPrompt(runtime, 'happier sent prompt');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(submission).resolves.toEqual({ status: 'admitted' });

    // Pi starts the run before echoing its initial user message.
    await emit(capture, { type: 'agent_start' });
    await emit(capture, {
      type: 'message_end',
      message: { role: 'user', content: [{ type: 'text', text: 'happier sent prompt' }] },
    });
    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'ok' },
    });

    const committed = parseEvents(events).filter((event) => event.kind === 'transcript-message-committed');
    expect(committed).toEqual([]);

    await runtime.dispose();
  });

  it('suppresses the echo of in-flight steer messages', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    const submission = sendPrompt(runtime, 'happier sent prompt');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(submission).resolves.toEqual({ status: 'admitted' });
    await emit(capture, { type: 'agent_start' });

    const steer = runtime.send({
      inputIds: ['pi-input-2'],
      input: { text: 'focus on error handling' },
      delivery: { kind: 'steer', turnId: 'pi-turn-1' },
    });
    await waitForWrittenCount(capture, 2);
    await ackLastCommand(capture);
    await expect(steer).resolves.toEqual({ status: 'admitted' });

    // The steer text echoes as a user message mid-turn.
    await emit(capture, {
      type: 'message_end',
      message: { role: 'user', content: [{ type: 'text', text: 'focus on error handling' }] },
    });
    // Origin, rather than text equality, distinguishes an extension submission.
    await emit(capture, extensionUserInput('focus on error handling'));

    const committed = parseEvents(events).filter(
      (event) => event.kind === 'transcript-message-committed' && event.role === 'user',
    );
    expect(committed.map((event) => (event as { text?: string }).text)).toEqual([
      'focus on error handling',
    ]);

    await runtime.dispose();
  });

  it.each([
    ['/review concurrency', 'EXPANDED TEMPLATE BODY: review src/index.ts.'],
    ['transform this input', 'Transformed by an input extension.'],
  ])('ignores the provider user echo after agent_start for %s', async (prompt, expanded) => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    const submission = sendPrompt(runtime, prompt);
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(submission).resolves.toEqual({ status: 'admitted' });

    await emit(capture, { type: 'agent_start' });
    await emit(capture, {
      type: 'message_end',
      message: {
        role: 'user',
        content: [{ type: 'text', text: expanded }],
      },
    });
    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'ok' },
    });
    await emit(capture, { type: 'agent_end' });

    expect(parseEvents(events).filter(
      (event) => event.kind === 'transcript-message-committed' && event.role === 'user',
    )).toEqual([]);

    await runtime.dispose();
  });

  it('surfaces a later injection whose text matches a prompt rejected before effect', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    const rejectedText = 'continue the interrupted work';
    const submission = sendPrompt(runtime, rejectedText);
    await waitForWrittenCount(capture, 1);
    await failLastCommand(capture);
    await expect(submission).resolves.toMatchObject({ status: 'rejected', diagnostic: expect.anything() });

    // An extension later injects a prompt with the identical text; it must surface.
    await emit(capture, extensionUserInput(rejectedText));

    const committed = parseEvents(events).filter(
      (event) => event.kind === 'transcript-message-committed' && event.role === 'user',
    );
    expect(committed.map((event) => (event as { text?: string }).text)).toEqual([rejectedText]);

    await runtime.dispose();
  });

  it('reports extension submissions even after an accepted command has no user echo', async () => {
    const capture: Capture = { specs: [], written: [], warnings: [], logs: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));
    const text = 'private input handled by a user extension';
    const submission = sendPrompt(runtime, text);
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(submission).resolves.toEqual({ status: 'admitted' });
    await emit(capture, extensionUserInput(text));
    await emit(capture, extensionUserInput(text));
    const committed = events.filter((event) => event.kind === 'transcript-message-committed');
    expect(committed).toEqual([
      expect.objectContaining({ role: 'user', text }),
      expect.objectContaining({ role: 'user', text }),
    ]);
    expect(capture.warnings).toEqual([]);
    expect(JSON.stringify(capture.logs)).not.toContain(text);
    await runtime.dispose();
  });

  it('ignores unrelated or malformed extension notifications', async () => {
    const capture: Capture = { specs: [], written: [], warnings: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));
    for (const message of ['regular extension notice', '{', JSON.stringify({ type: 'other', text: 'unrelated' }),
      JSON.stringify({ type: 'happy-pi-user-input', text: '' }), JSON.stringify({ type: 'happy-pi-user-input', text: 1 })]) {
      await emit(capture, { type: 'extension_ui_request', id: 'notify', method: 'notify', message });
    }
    expect(events.filter((event) => event.kind === 'transcript-message-committed')).toEqual([]);
    expect(capture.warnings).toEqual([]);
    await runtime.dispose();
  });

  it('retains queued extension submission observations across cancellation and identical retries', async () => {
    const capture: Capture = { specs: [], written: [], logs: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));
    const submission = sendPrompt(runtime, 'run until cancelled');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(submission).resolves.toEqual({ status: 'admitted' });
    await emit(capture, { type: 'agent_start' });
    const text = 'private queued follow-up';
    // The input hook reports a queued submission before a model turn or user echo exists.
    await emit(capture, extensionUserInput(text));
    const cancel = runtime.cancel!({ turnId: 'pi-turn-1', reason: 'user' });
    await waitForWrittenCount(capture, 2);
    await emit(capture, { type: 'agent_end', willRetry: false });
    await ackLastCommand(capture);
    await expect(cancel).resolves.toEqual({ status: 'requested', turnId: 'pi-turn-1' });
    await emit(capture, extensionUserInput(text));
    const committed = events.filter((event) => event.kind === 'transcript-message-committed');
    expect(committed).toEqual([
      expect.objectContaining({ role: 'user', text }),
      expect.objectContaining({ role: 'user', text }),
    ]);
    expect(committed[0]).not.toHaveProperty('turnId');
    expect(committed[1]).not.toHaveProperty('turnId');
    expect(JSON.stringify(capture.logs)).not.toContain(text);
    await runtime.dispose();
  });

  it('answers a blocking Pi extension dialog through the canonical interaction surface', async () => {
    const capture: Capture = {
      specs: [],
      written: [],
      questionRequests: [],
      questionResult: {
        requestId: 'host-question-1',
        kind: 'questions',
        status: 'answered',
        answers: {
          'pi-dialog-1': {
            kind: 'singleChoice',
            answer: { kind: 'choice', choiceId: 'choice-1' },
          },
        },
      },
    };
    const runtime = await createRuntime(capture);

    await emit(capture, {
      type: 'extension_ui_request',
      id: 'pi-dialog-1',
      method: 'select',
      title: 'Choose scope',
      options: ['Repository', 'Workspace'],
    });

    await vi.waitFor(() => expect(capture.questionRequests).toHaveLength(1));
    expect(capture.questionRequests?.[0]).toEqual({
      kind: 'questions',
      title: 'Pi question',
      questions: [{
        id: 'pi-dialog-1',
        prompt: 'Choose scope',
        type: 'singleChoice',
        required: true,
        choices: [
          { id: 'choice-0', label: 'Repository' },
          { id: 'choice-1', label: 'Workspace' },
        ],
      }],
    });
    await vi.waitFor(() => expect(capture.written).toContainEqual({
      type: 'extension_ui_response',
      id: 'pi-dialog-1',
      value: 'Workspace',
    }));

    await runtime.dispose();
  });

  it('binds MCP confirmations to native call identity and fails closed after that call ends', async () => {
    const capture: Capture = { specs: [], written: [], approvalRequests: [], questionRequests: [] };
    const runtime = await createRuntime(capture);
    const prompt = sendPrompt(runtime, 'Use MCP');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await prompt;
    await emit(capture, { type: 'tool_execution_start', toolCallId: 'native-a', toolName: 'mcp__a__echo', args: { text: 'actual-a' } });
    await emit(capture, { type: 'tool_execution_start', toolCallId: 'native-b', toolName: 'mcp__b__echo', args: { text: 'actual-b' } });
    await emit(capture, { type: 'extension_ui_request', id: 'dialog-b', method: 'confirm',
      title: 'happier:mcp-approval:native-b', message: '{"text":"untrusted-dialog-text"}' });
    await vi.waitFor(() => expect(capture.approvalRequests).toHaveLength(1));
    expect(capture.approvalRequests?.[0]).toMatchObject({ kind: 'approval',
      subject: { kind: 'tool', name: 'mcp__b__echo', input: { text: 'actual-b' } } });
    expect(capture.questionRequests).toEqual([]);
    await vi.waitFor(() => expect(capture.written).toContainEqual({ type: 'extension_ui_response', id: 'dialog-b', confirmed: true }));
    await emit(capture, { type: 'tool_execution_end', toolCallId: 'native-b', toolName: 'mcp__b__echo', result: {} });
    await emit(capture, { type: 'extension_ui_request', id: 'retired', method: 'confirm', title: 'happier:mcp-approval:native-b', message: '' });
    await vi.waitFor(() => expect(capture.written).toContainEqual({ type: 'extension_ui_response', id: 'retired', confirmed: false }));
    expect(capture.approvalRequests).toHaveLength(1);
    expect(capture.questionRequests).toEqual([]);
    await emit(capture, { type: 'tool_execution_start', toolCallId: 'native-a', toolName: 'bash', args: { command: 'duplicate' } });
    await emit(capture, { type: 'extension_ui_request', id: 'duplicate', method: 'confirm', title: 'happier:mcp-approval:native-a', message: '' });
    await vi.waitFor(() => expect(capture.written).toContainEqual({ type: 'extension_ui_response', id: 'duplicate', confirmed: false }));
    expect(capture.approvalRequests).toHaveLength(1);
    // Over the old Interaction subject limit, but within the existing strict
    // runtime event's 512-code-unit tool-name contract.
    const longName = `mcp__a__${'工具'.repeat(96)}`;
    await emit(capture, { type: 'tool_execution_start', toolCallId: 'long-native', toolName: longName, args: { text: 'long' } });
    await emit(capture, { type: 'extension_ui_request', id: 'long-dialog', method: 'confirm', title: 'happier:mcp-approval:long-native', message: '' });
    await vi.waitFor(() => expect(capture.approvalRequests).toHaveLength(2));
    const admitted = InteractionTransientAuthorRequestV1Schema.parse(capture.approvalRequests?.[1]);
    expect(admitted).toMatchObject({ kind: 'approval', subject: { name: longName, input: { text: 'long' } } });
    await runtime.dispose();
  });

  it('preserves editor prefill as editable initial content', async () => {
    const capture: Capture = {
      specs: [],
      written: [],
      questionRequests: [],
      questionResult: {
        requestId: 'host-question-editor',
        kind: 'questions',
        status: 'answered',
        answers: {
          'pi-dialog-editor': { kind: 'text', value: 'Updated notes' },
        },
      },
    };
    const runtime = await createRuntime(capture);

    await emit(capture, {
      type: 'extension_ui_request',
      id: 'pi-dialog-editor',
      method: 'editor',
      title: 'Edit release notes',
      prefill: 'Existing notes',
    });

    await vi.waitFor(() => expect(capture.questionRequests).toContainEqual({
      kind: 'questions',
      title: 'Pi question',
      questions: [{
        id: 'pi-dialog-editor',
        prompt: 'Edit release notes',
        type: 'text',
        required: true,
        initialValue: 'Existing notes',
      }],
    }));
    await vi.waitFor(() => expect(capture.written).toContainEqual({
      type: 'extension_ui_response',
      id: 'pi-dialog-editor',
      value: 'Updated notes',
    }));

    await runtime.dispose();
  });

  it('cancels a blocking Pi extension dialog before aborting its turn', async () => {
    const capture: Capture = {
      specs: [],
      written: [],
      questionRequests: [],
      questionHandler: async (_request, options) => await new Promise((resolve) => {
        options?.signal?.addEventListener('abort', () => resolve({
          requestId: 'host-question-cancelled',
          kind: 'questions',
          status: 'userCancelled',
        }), { once: true });
      }),
    };
    const runtime = await createRuntime(capture);
    const prompt = sendPrompt(runtime, 'ask me');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });
    await emit(capture, { type: 'agent_start' });
    await emit(capture, {
      type: 'extension_ui_request',
      id: 'pi-dialog-cancelled',
      method: 'input',
      title: 'Enter a value',
    });
    await vi.waitFor(() => expect(capture.questionRequests).toHaveLength(1));

    const cancel = runtime.cancel!({ turnId: 'pi-turn-1', reason: 'user' });
    await vi.waitFor(() => expect(capture.written).toContainEqual({
      type: 'extension_ui_response',
      id: 'pi-dialog-cancelled',
      cancelled: true,
    }));
    await waitForWrittenCount(capture, 3);
    expect(capture.written.at(-1)).toEqual(expect.objectContaining({ type: 'abort' }));
    await ackLastCommand(capture);
    await expect(cancel).resolves.toEqual({ status: 'requested', turnId: 'pi-turn-1' });

    await runtime.dispose();
  });

  it('publishes the process command catalog once for native command dispatch', async () => {
    const capture: Capture = {
      specs: [],
      written: [],
      availableCommands: [
        { name: 'goal', description: 'Set the session goal' },
        { name: '/SKILL:Review' },
      ],
    };
    const runtime = await createPiRuntimeOperations({
      ...createRuntimeContext(capture),
      cwd: '/tmp/pi-workspace',
      env: {},
      sessionId: 'happier-session-1',
      initialSessionId: 'pi-provider-session-1',
      eagerStart: true,
    });
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(AgentSessionRuntimeEventSchema.parse(event)));

    await vi.waitFor(() => {
      expect(capture.commandCatalogRequestCount).toBe(1);
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'available-commands',
        commands: [
          { name: 'goal', description: 'Set the session goal' },
          { name: 'skill:review' },
        ],
      }));
    });

    const prompt = sendPrompt(runtime, 'continue after command discovery');
    await waitForWrittenCount(capture, 1);
    await ackCommandAt(capture, 0);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });
    expect(capture.commandCatalogRequestCount).toBe(1);

    await runtime.dispose();
  });

  it('reuses in-flight command discovery before applying extension-command no-turn settlement', async () => {
    let releaseCommandCatalog!: () => void;
    const capture: Capture = {
      specs: [],
      written: [],
      availableCommands: [{ name: 'goal', source: 'extension' }],
      commandCatalogGate: new Promise<void>((resolve) => {
        releaseCommandCatalog = resolve;
      }),
    };
    const runtime = await createPiRuntimeOperations({
      ...createRuntimeContext(capture),
      cwd: '/tmp/pi-workspace',
      env: {},
      sessionId: 'happier-session-1',
      initialSessionId: 'pi-provider-session-1',
      eagerStart: true,
    });
    expect(capture.commandCatalogRequestCount).toBe(1);

    const submission = sendPrompt(runtime, '/goal fix authentication');
    await waitForWrittenCount(capture, 1);
    expect(capture.written[0]).toMatchObject({
      type: 'prompt',
      message: '/goal fix authentication',
    });
    await ackCommandAt(capture, 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(capture.written).toHaveLength(1);

    releaseCommandCatalog();
    await waitForWrittenCount(capture, 2);
    expect(capture.commandCatalogRequestCount).toBe(1);
    expect(capture.written[1]).toMatchObject({ type: 'get_state' });
    await ackCommandAt(capture, 1, {
      sessionId: 'pi-provider-session-1',
      isStreaming: false,
      isCompacting: false,
    });
    await expect(submission).resolves.toEqual({ status: 'admitted' });

    await runtime.dispose();
  });

  it('retries a settled failed command refresh on later session use', async () => {
    const capture: Capture = {
      specs: [],
      written: [],
      warnings: [],
      availableCommands: [{ name: 'goal', source: 'extension' }],
      commandCatalogErrors: ['Provider command catalog temporarily unavailable'],
    };
    const runtime = await createPiRuntimeOperations({
      ...createRuntimeContext(capture),
      cwd: '/tmp/pi-workspace',
      env: {},
      sessionId: 'happier-session-1',
      initialSessionId: 'pi-provider-session-1',
      eagerStart: true,
    });
    await vi.waitFor(() => expect(capture.warnings).toHaveLength(1));
    expect(capture.commandCatalogRequestCount).toBe(1);

    const submission = sendPrompt(runtime, '/goal fix authentication');
    await waitForWrittenCount(capture, 1);
    await ackCommandAt(capture, 0);
    await waitForWrittenCount(capture, 2);
    expect(capture.commandCatalogRequestCount).toBe(2);
    expect(capture.written[1]).toMatchObject({ type: 'get_state' });
    await ackCommandAt(capture, 1, {
      sessionId: 'pi-provider-session-1',
      isStreaming: false,
      isCompacting: false,
    });
    await expect(submission).resolves.toEqual({ status: 'admitted' });

    await runtime.dispose();
  });

  it('does not let optional command discovery delay eager session opening or ordinary prompts', async () => {
    let releaseCommandCatalog!: () => void;
    const capture: Capture = {
      specs: [],
      written: [],
      commandCatalogGate: new Promise<void>((resolve) => {
        releaseCommandCatalog = resolve;
      }),
    };
    const opening = createPiRuntimeOperations({
      ...createRuntimeContext(capture),
      cwd: '/tmp/pi-workspace',
      env: {},
      sessionId: 'happier-session-1',
      initialSessionId: 'pi-provider-session-1',
      eagerStart: true,
    });

    await vi.waitFor(() => expect(capture.commandCatalogRequestCount).toBe(1));
    const openingObservation = await Promise.race([
      opening.then((runtime) => ({ kind: 'opened' as const, runtime })),
      new Promise<{ kind: 'waiting' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'waiting' }), 20);
      }),
    ]);

    releaseCommandCatalog();
    const runtime = openingObservation.kind === 'opened'
      ? openingObservation.runtime
      : await opening;
    expect(openingObservation.kind).toBe('opened');

    const prompt = sendPrompt(runtime, 'continue with the implementation');
    await waitForWrittenCount(capture, 1);
    expect(capture.written[0]).toMatchObject({
      type: 'prompt',
      message: 'continue with the implementation',
    });
    await ackCommandAt(capture, 0);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });

    await runtime.dispose();
  });

  it('settles an acknowledged provider command that does not start an agent turn', async () => {
    const capture: Capture = {
      specs: [],
      written: [],
      availableCommands: [{ name: 'goal', source: 'extension' }],
    };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(AgentSessionRuntimeEventSchema.parse(event)));

    const submission = sendPrompt(runtime, '/goal fix authentication');
    await waitForWrittenCount(capture, 1);
    expect(capture.written[0]).toEqual(expect.objectContaining({
      type: 'prompt',
      message: '/goal fix authentication',
    }));
    await ackCommandAt(capture, 0);
    await waitForWrittenCount(capture, 2);
    expect(capture.written[1]).toEqual(expect.objectContaining({ type: 'get_state' }));
    await ackCommandAt(capture, 1, {
      sessionId: 'pi-provider-session-1',
      isStreaming: false,
      isCompacting: false,
    });

    await expect(submission).resolves.toEqual({ status: 'admitted' });
    expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining([
      'input-accepted',
      'turn-start',
      'turn-complete',
    ]));
    expect(events.some((event) => event.kind === 'turn-failed')).toBe(false);

    await runtime.dispose();
  });

  it('keeps a provider command active when Pi cannot confirm an idle state', async () => {
    const capture: Capture = {
      specs: [],
      written: [],
      availableCommands: [{ name: 'goal', source: 'extension' }],
    };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(AgentSessionRuntimeEventSchema.parse(event)));

    const submission = sendPrompt(runtime, '/goal fix authentication');
    await waitForWrittenCount(capture, 1);
    await ackCommandAt(capture, 0);
    await waitForWrittenCount(capture, 2);
    await ackCommandAt(capture, 1, {
      sessionId: 'pi-provider-session-1',
    });

    await expect(submission).resolves.toEqual({ status: 'admitted' });
    expect(events.some((event) => event.kind === 'turn-complete')).toBe(false);

    await emit(capture, { type: 'agent_start' });
    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'goal updated' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'goal updated' }] },
    });
    await emit(capture, { type: 'agent_end', willRetry: false });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'turn-complete' }),
    ]));
    await runtime.dispose();
  });

  it.each([
    ['a prompt command', '/goal fix authentication', { name: 'goal', source: 'prompt' as const }],
    ['a differently-cased extension command', '/goal fix authentication', { name: 'Goal', source: 'extension' as const }],
    ['a tab-delimited extension command', '/goal\tfix authentication', { name: 'goal', source: 'extension' as const }],
  ])('does not apply no-turn settlement to %s', async (_label, text, command) => {
    const capture: Capture = {
      specs: [],
      written: [],
      availableCommands: [command],
    };
    const runtime = await createRuntime(capture);

    const submission = sendPrompt(runtime, text);
    await waitForWrittenCount(capture, 1);
    await ackCommandAt(capture, 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (capture.written.length > 1) {
      await ackCommandAt(capture, 1, {
        sessionId: 'pi-provider-session-1',
        isStreaming: false,
        isCompacting: false,
      });
    }
    await expect(submission).resolves.toEqual({ status: 'admitted' });

    expect(capture.written).toHaveLength(1);
    await runtime.dispose();
  });

  it('exposes the native AgentSessionRuntime contract directly at the Pi RPC owner', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    const subscription = runtime.watch((event) => events.push(AgentSessionRuntimeEventSchema.parse(event)));
    expect(capture.systemToolResolveCount).toBe(1);
    expect(capture.versionProbeCount).toBeUndefined();
    expect(capture.specs[0]?.launch.executable).toBe(capture.resolvedExecutable);
    expect(capture.specs[0]?.launch.cwd).toEqual({ root: 'workspace', relativePath: '' });

    const prompt = runtime.send({
      inputIds: ['pi-input-native-1'],
      input: { text: 'hello' },
      delivery: { kind: 'newTurn', turnId: 'pi-turn-native-1' },
    });
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);

    await expect(prompt).resolves.toEqual({ status: 'admitted' });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'input-accepted',
        inputIds: ['pi-input-native-1'],
        delivery: { kind: 'newTurn', turnId: 'pi-turn-native-1' },
      }),
    ]));
    subscription.dispose();
  });

  it('derives launch provider and startup model from the selected connected service', async () => {
    const capture: Capture = { specs: [], written: [] };

    await createRuntimeWithEnv(capture, {
      HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([
        { kind: 'profile', serviceId: 'openai-codex', profileId: 'primary' },
      ]),
      PI_CODING_AGENT_DIR: '/tmp/happier-pi-agent-dir',
      [PI_REQUEST_AUTH_CAPABILITY_PATH_ENV]: '/tmp/request-auth-capability.json',
    });

    expect(capture.specs[0]?.launch.args).toEqual(expect.arrayContaining([
      '--provider',
      'openai-codex',
      '--model',
      'gpt-5.5',
      '--models',
      'openai-codex/*',
    ]));
  });

  it.each([
    ['0.81.0', '0.81.0'],
    ['0.81.1', '0.81.1'],
    ['0.82.1', '0.82.1'],
    ['v0.82.1', '0.82.1'],
    ['pi 0.82.1+fork.7', '0.82.1+fork.7'],
  ])(
    'loads exactly one request-auth extension on supported Pi %s',
    async (versionOutput, producerVersion) => {
      const capture: Capture = { specs: [], written: [], versionOutput };
      const agentDir = '/tmp/happier-pi-agent-dir';

      await createRuntimeWithEnv(capture, {
        PI_CODING_AGENT_DIR: agentDir,
        [PI_REQUEST_AUTH_CAPABILITY_PATH_ENV]: '/tmp/request-auth-capability.json',
      });

      const args = capture.specs[0]?.launch.args ?? [];
      const extensionIndexes = args
        .map((arg, index) => arg === '--extension' && args[index + 1] === resolvePiRequestAuthExtensionPath(agentDir) ? index : -1)
        .filter((index) => index >= 0);
      expect(extensionIndexes).toHaveLength(1);
      const extensionIndex = extensionIndexes[0]!;
      expect(extensionIndex).toBeGreaterThanOrEqual(0);
      expect(args[extensionIndex + 1]).toBe(resolvePiRequestAuthExtensionPath(agentDir));
      expect(capture.specs[0]?.launch.env?.[PI_REQUEST_AUTH_PRODUCER_VERSION_ENV]).toBe(producerVersion);
      expect(capture.systemToolResolveCount).toBe(1);
      expect(capture.versionProbeCount).toBe(1);
      expect(capture.versionProbeExecutable).toBe(capture.resolvedExecutable);
      expect(capture.specs[0]?.launch.executable).toBe(capture.resolvedExecutable);
    },
  );

  it.each([
    ['0.74.2', 'version_too_old'],
    ['0.80.10', 'version_too_old'],
    ['00.082.001', 'version_unreadable'],
    ['0.82.1_rc.1', 'version_unreadable'],
    ['pi unknown', 'version_unreadable'],
  ])('rejects unsupported Pi %s before starting a connected request-auth runtime', async (versionOutput, reason) => {
    const capture: Capture = {
      specs: [],
      written: [],
      versionOutput,
    };

    await expect(createRuntimeWithEnv(capture, {
      PI_CODING_AGENT_DIR: '/tmp/happier-pi-agent-dir',
      [PI_REQUEST_AUTH_CAPABILITY_PATH_ENV]: '/tmp/request-auth-capability.json',
    })).rejects.toMatchObject({
      name: 'PiRequestAuthCompatibilityError',
      code: 'pi_request_auth_version_unsupported',
      compatibility: expect.objectContaining({
        supported: false,
        reason,
        minimumVersion: '0.81.0',
      }),
    });

    expect(capture.systemToolResolveCount).toBe(1);
    expect(capture.versionProbeCount).toBe(1);
    expect(capture.specs).toHaveLength(0);
  });

  it('fails closed before spawn when a projected child capability has no agent dir', async () => {
    const capture: Capture = { specs: [], written: [] };

    await expect(createRuntimeWithEnv(capture, {
      [PI_REQUEST_AUTH_CAPABILITY_PATH_ENV]: '/tmp/request-auth-capability.json',
    })).rejects.toThrow(
      'Pi request-auth runtime requires the agent dir and child endpoint capability',
    );

    expect(capture.versionProbeCount).toBeUndefined();
    expect(capture.specs).toHaveLength(0);
  });

  it('starts a direct-token connected-service session that has no request-auth capability', async () => {
    // Pi takes an Anthropic API key or Claude setup-token DIRECTLY: the
    // materializer writes `auth.anthropic = { type: 'api_key' }` and
    // deliberately projects no child request-auth capability for it. Reading
    // the connected-service SELECTION as the request-auth signal refused that
    // supported credential/Agent combination before spawn.
    const capture: Capture = { specs: [], written: [] };

    await createRuntimeWithEnv(capture, {
      HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([
        { kind: 'profile', serviceId: 'anthropic', profileId: 'primary' },
      ]),
      PI_CODING_AGENT_DIR: '/tmp/happier-pi-agent-dir',
    });

    expect(capture.specs).toHaveLength(1);
    expect(capture.specs[0]?.launch.args).toEqual(expect.arrayContaining([
      '--provider',
      'anthropic',
      '--model',
      'claude-opus-5',
      '--models',
      'anthropic/*',
    ]));
    // No capability means no request-auth extension and no version floor.
    expect(capture.specs[0]?.launch.args).not.toContain(resolvePiRequestAuthExtensionPath('/tmp/happier-pi-agent-dir'));
    expect(capture.versionProbeCount).toBeUndefined();
    expect(capture.specs[0]?.launch.env?.[PI_REQUEST_AUTH_PRODUCER_VERSION_ENV]).toBeUndefined();
  });

  it('does not impose the request-auth version floor on native Pi sessions', async () => {
    const capture: Capture = {
      specs: [],
      written: [],
      versionOutput: '0.74.2',
    };

    await createRuntime(capture);

    expect(capture.systemToolResolveCount).toBe(1);
    expect(capture.versionProbeCount).toBeUndefined();
    expect(capture.specs[0]?.launch.executable).toBe(capture.resolvedExecutable);
    expect(capture.specs).toHaveLength(1);
  });

  it('projects only the admitted Pi foreground output with the exact host turn', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => {
      events.push(event);
    });

    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'session replay before admission' },
    });
    await emit(capture, {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'session replay before admission' }] },
    });
    const prompt = sendPrompt(runtime, 'hello');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });
    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'hel' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'hel' }] },
    });
    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'lo' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    });
    await emit(capture, {
      type: 'tool_execution_start',
      toolCallId: 'tool-call-1',
      toolName: 'grep',
      args: { pattern: 'PiRuntime' },
    });
    await emit(capture, {
      type: 'tool_execution_end',
      toolCallId: 'tool-call-1',
      toolName: 'grep',
      result: { matches: 2 },
      isError: false,
    });
    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'final answer' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] },
    });
    await emit(capture, {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] },
    });
    await emit(capture, { type: 'turn_end', turnId: 'provider-turn-1' });
    await emit(capture, { type: 'agent_end', willRetry: false });
    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'late output after completion' },
    });
    await emit(capture, {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'late output after completion' }] },
    });

    expect(events.some((event) => (
      event.kind === 'turn-complete' || event.kind === 'turn-failed' || event.kind === 'turn-cancelled'
    ))).toBe(true);

    const parsedEvents = parseEvents(events);
    const turnStart = parsedEvents.find((event) => event.kind === 'turn-start');
    expect(turnStart).toMatchObject({
      kind: 'turn-start',
      sessionId: 'happier-session-1',
      turnId: 'pi-turn-1',
      startedBy: 'host',
    });
    expect(parsedEvents.filter((event) => event.kind === 'message-delta')).toEqual([
      expect.objectContaining({ turnId: 'pi-turn-1', channel: 'assistant', text: 'hel' }),
      expect.objectContaining({ turnId: 'pi-turn-1', channel: 'assistant', text: 'lo' }),
      expect.objectContaining({ turnId: 'pi-turn-1', channel: 'assistant', text: 'final answer' }),
    ]);
    expect(parsedEvents.filter((event) => event.kind === 'transcript-message-committed')).toEqual([
      expect.objectContaining({ turnId: 'pi-turn-1', role: 'assistant', text: 'final answer' }),
    ]);
    expect(parsedEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'tool-call',
        sessionId: 'happier-session-1',
        turnId: turnStart?.turnId,
        toolCallId: 'tool-call-1',
        toolName: 'grep',
        input: { pattern: 'PiRuntime' },
      }),
      expect.objectContaining({
        kind: 'tool-result',
        sessionId: 'happier-session-1',
        turnId: turnStart?.turnId,
        toolCallId: 'tool-call-1',
        output: { matches: 2 },
        isError: false,
      }),
      expect.objectContaining({
        kind: 'turn-complete',
        sessionId: 'happier-session-1',
        turnId: turnStart?.turnId,
        agentTurnId: 'provider-turn-1',
      }),
    ]));
  });

  it.each([false, true])('publishes settled Pi usage with a conservative clock (tool: %s)', async (hasTool) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100);
    const capture: Capture = {
      specs: [],
      written: [],
      sessionStats: {
        contextUsage: { tokens: 12_345, contextWindow: 200_000, percent: 6.1725 },
      },
    };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    const prompt = sendPrompt(runtime, 'hello');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });
    await emit(capture, { type: 'message_start', message: { role: 'assistant', content: [] } });
    if (hasTool) {
      clock.mockReturnValue(200);
      await emit(capture, { type: 'tool_execution_end', toolCallId: 'clock-tool', toolName: 'Read', result: {} });
      clock.mockReturnValue(300);
      await emit(capture, { type: 'message_start', message: { role: 'assistant', content: [] } });
    }
    clock.mockReturnValue(1000);
    await emit(capture, { type: 'agent_end', willRetry: false });
    await vi.waitFor(() => expect(events.some((event) => event.kind === 'usage-observed')).toBe(true));

    expect(parseEvents(events)).toContainEqual(expect.objectContaining({
      kind: 'usage-observed',
      sessionId: 'happier-session-1',
      promptCache: { lastUseAtMs: hasTool ? 200 : 100 },
      context: expect.objectContaining({
        usedTokens: 12_345,
        windowTokens: 200_000,
      }),
    }));

    expect(capture.sessionStatsRequestCount).toBe(1);

    await runtime.dispose();
  });

  it('gives each fetched usage snapshot a distinct identity after reopening the same Session', async () => {
    const ids: string[] = [];
    for (let reopen = 0; reopen < 2; reopen += 1) {
      const capture: Capture = { specs: [], written: [], sessionStats: { contextUsage: { tokens: 100, contextWindow: 200_000 } } };
      const runtime = await createRuntime(capture);
      runtime.watch((event) => { if (event.kind === 'usage-observed') ids.push(event.observationId); });
      const prompt = sendPrompt(runtime, 'hello');
      await waitForWrittenCount(capture, 1);
      await ackLastCommand(capture);
      await prompt;
      await emit(capture, { type: 'agent_end', willRetry: false });
      await vi.waitFor(() => expect(ids).toHaveLength(reopen + 1));
      await runtime.dispose();
    }
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('publishes typed provider acceptance from the exact Pi prompt RPC response before turn evidence', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    const prompt = sendPrompt(runtime, 'hello', {
      inputIds: ['pi-input-42'],
      delivery: { kind: 'newTurn', turnId: 'pi-turn-42' },
    });
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });

    expect(events.filter((event) => event.kind === 'input-accepted')).toEqual([expect.objectContaining({
      kind: 'input-accepted',
      inputIds: ['pi-input-42'],
      delivery: { kind: 'newTurn', turnId: 'pi-turn-42' },
    })]);

    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    });
    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'again' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'again' }] },
    });

    expect(events.filter((event) => event.kind === 'input-accepted')).toHaveLength(1);
  });

  it('preserves exact prompt acceptance when pre-admission record buffering fails', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    const prompt = sendPrompt(runtime, 'accepted before observation failure', {
      inputIds: ['pi-input-buffer-failure'],
      delivery: { kind: 'newTurn', turnId: 'pi-turn-buffer-failure' },
    });
    await waitForWrittenCount(capture, 1);
    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'must not replay' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'must not replay' }] },
    });
    const invalidRecord: Record<string, unknown> = { type: 'agent_start' };
    invalidRecord.self = invalidRecord;
    await emit(capture, invalidRecord);
    await ackLastCommand(capture);

    await expect(prompt).resolves.toMatchObject({ status: 'rejected' });
    expect(events.filter((event) => event.kind === 'input-accepted')).toEqual([
      expect.objectContaining({
        inputIds: ['pi-input-buffer-failure'],
        delivery: { kind: 'newTurn', turnId: 'pi-turn-buffer-failure' },
      }),
    ]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'input-delivery-failed',
        inputIds: ['pi-input-buffer-failure'],
      }),
    ]));
    expect(events.some((event) => event.kind === 'input-rejected')).toBe(false);
    expect(events.some((event) => event.kind === 'message-delta')).toBe(false);
    await runtime.dispose();
  });

  it('keeps ambiguous prompt response loss custody unknown when pre-admission record buffering fails', async () => {
    vi.useFakeTimers();
    try {
      const capture: Capture = { specs: [], written: [] };
      const runtime = await createRuntime(capture);
      const events: AgentSessionRuntimeEvent[] = [];
      runtime.watch((event) => events.push(event));

      const prompt = sendPrompt(runtime, 'response lost after observation failure', {
        inputIds: ['pi-input-buffered-response-loss'],
        delivery: { kind: 'newTurn', turnId: 'pi-turn-buffered-response-loss' },
      });
      await Promise.resolve();
      await Promise.resolve();
      await emit(capture, {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'must not replay' },
        message: { role: 'assistant', content: [{ type: 'text', text: 'must not replay' }] },
      });
      const invalidRecord: Record<string, unknown> = { type: 'agent_start' };
      invalidRecord.self = invalidRecord;
      await emit(capture, invalidRecord);
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(prompt).resolves.toMatchObject({
        status: 'rejected',
        diagnostic: expect.objectContaining({ code: 'pi_input_outcome_unknown' }),
      });
      expect(capture.written).toHaveLength(1);
      expect(events.filter((event) => event.kind === 'input-accepted')).toEqual([]);
      expect(events.filter((event) => event.kind === 'input-rejected')).toEqual([]);
      expect(events.filter((event) => (
        event.kind === 'input-custody-unknown' || event.kind === 'input-delivery-failed'
      ))).toEqual([
        expect.objectContaining({
          kind: 'input-custody-unknown',
          inputIds: ['pi-input-buffered-response-loss'],
        }),
      ]);
      expect(events.some((event) => event.kind === 'message-delta')).toBe(false);
      await runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['yolo', 'read-only'],
    ['read-only', 'yolo'],
  ])('rejects launch-only permission changes from %s to %s without partially applying configuration', async (initial, requested) => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createPiRuntimeOperations({
      ...createRuntimeContext(capture),
      cwd: '/tmp/pi-workspace',
      env: {},
      sessionId: 'happier-session-1',
      permissionMode: initial,
    });

    await expect(runtime.updateConfiguration!({
      ...configuration({}),
      permissionIntent: { value: requested, updatedAtMs: 2 },
    })).resolves.toMatchObject({ status: 'unsupported' });
    expect(capture.written).toEqual([]);

    await expect(runtime.updateConfiguration!({
      ...configuration({ reasoning_effort: 'high' }),
      model: { value: 'openai/gpt-4o-mini', updatedAtMs: 2 },
      permissionIntent: { value: requested, updatedAtMs: 2 },
    })).resolves.toMatchObject({ status: 'unsupported' });
    expect(capture.written).toEqual([]);
    await runtime.dispose();
  });

  it.each([
    ['default', 'auto'],
    ['safe-yolo', 'workspace_write'],
    ['plan', 'read-only'],
  ] as const)('preserves model and thinking updates for the unchanged effective launch permission from %s to %s', async (initial, requested) => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createPiRuntimeOperations({
      ...createRuntimeContext(capture),
      cwd: '/tmp/pi-workspace',
      env: {},
      sessionId: 'happier-session-1',
      permissionMode: initial,
    });
    const update = runtime.updateConfiguration!({
      ...configuration({ reasoning_effort: 'high' }),
      permissionIntent: { value: requested, updatedAtMs: 2 },
      model: { value: 'openai/gpt-4o-mini', updatedAtMs: 2 },
    });
    await waitForWrittenCount(capture, 1);
    expect(capture.written[0]).toMatchObject({ type: 'set_model', provider: 'openai', modelId: 'gpt-4o-mini' });
    await ackLastCommand(capture);
    await waitForWrittenCount(capture, 2);
    expect(capture.written[1]).toMatchObject({ type: 'set_thinking_level', level: 'high' });
    await ackLastCommand(capture);
    await expect(update).resolves.toEqual({ status: 'applied', changed: ['model', 'options'] });
    await runtime.dispose();
  });

  it('applies canonical reasoning_effort runtime config updates to Pi thinking level', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);

    const update = runtime.updateConfiguration!(configuration({ reasoning_effort: 'high' }));
    await waitForWrittenCount(capture, 1);

    expect(capture.written.at(-1)).toEqual(expect.objectContaining({
      type: 'set_thinking_level',
      level: 'high',
    }));

    await ackLastCommand(capture);
    await expect(update).resolves.toEqual({ status: 'applied', changed: ['options'] });
  });

  it('cleans up the generated model extension when the host rejects its models binding', async () => {
    const capture: Capture = { specs: [], written: [] };
    await expect(createPiRuntimeOperations({
      ...createRuntimeContext(capture),
      models: { bind() { throw new Error('host binding unavailable'); } },
      cwd: '/tmp/pi-workspace', env: {}, sessionId: 'happier-session-1',
    })).rejects.toThrow('host binding unavailable');
    const args = capture.specs[0]!.launch.args!;
    const extensionFlag = args.indexOf('--extension');
    expect(extensionFlag).toBeGreaterThanOrEqual(0);
    expect(existsSync(args[extensionFlag + 1]!)).toBe(false);
  });

  it('retains early discovery completion and reprojects current model options without renewing catalog age', async () => {
    const capture: Capture = { specs: [], written: [], initialRecords: [{
      type: 'happier-pi-model-catalog',
      models: [{ provider: 'openai', id: 'gpt-6', name: 'GPT 6', reasoning: true }],
    }] };
    let source: AgentSessionModelsSource | null = null;
    const disposeBinding = vi.fn();
    const runtime = await createPiRuntimeOperations({
      ...createRuntimeContext(capture),
      models: { bind(nextSource) { source = nextSource; return { dispose: disposeBinding }; } },
      cwd: '/tmp/pi-workspace', env: {}, sessionId: 'happier-session-1', initialSessionId: 'pi-provider-session-1',
    });
    const extensionFlag = capture.specs[0]!.launch.args!.indexOf('--extension');
    const extensionPath = capture.specs[0]!.launch.args![extensionFlag + 1]!;
    expect(extensionFlag).toBeGreaterThanOrEqual(0);
    expect(readFileSync(extensionPath, 'utf8')).toContain('process.stdout.write');
    const observedAt = source?.read().observedAt;
    expect(observedAt).toEqual(expect.any(Number));
    const update = runtime.updateConfiguration!(configuration({ reasoning_effort: 'high' }));
    await waitForWrittenCount(capture, 1);
    await ackCommandAt(capture, 0);
    await update;
    await waitForWrittenCount(capture, 2);
    await ackCommandAt(capture, 1, {
      model: { provider: 'openai', id: 'gpt-6' }, thinkingLevel: 'high',
    });
    await vi.waitFor(() => expect(source?.read()).toMatchObject({
      currentModelId: 'openai/gpt-6',
      models: [{ id: 'openai/gpt-6', modelOptions: [{ currentValue: 'high' }] }],
      observedAt: expect.any(Number),
    }));
    expect(source?.read().observedAt).toBe(observedAt);
    const updateAgain = runtime.updateConfiguration!(configuration({ reasoning_effort: 'low' }));
    await waitForWrittenCount(capture, 3);
    await ackCommandAt(capture, 2);
    await updateAgain;
    await waitForWrittenCount(capture, 4);
    await ackCommandAt(capture, 3, {
      model: { provider: 'openai', id: 'gpt-6' }, thinkingLevel: 'low',
    });
    await vi.waitFor(() => expect(source?.read()).toMatchObject({
      models: [{ id: 'openai/gpt-6', modelOptions: [{ currentValue: 'low' }] }], observedAt,
    }));
    expect(capture.written.some((record) => isRecord(record) && record.type === 'get_available_models')).toBe(false);
    await emit(capture, { type: 'happier-pi-model-catalog', error: 'refresh-unsupported', models: [
      { provider: 'openai', id: 'stale-local-model' },
    ] });
    expect(source?.read()).toMatchObject({ models: [{ id: 'openai/gpt-6' }], observedAt });
    await runtime.dispose();
    expect(disposeBinding).toHaveBeenCalledTimes(1);
    expect(existsSync(extensionPath)).toBe(false);
  });

  it('does not infer typed provider acceptance from Pi turn evidence before the exact RPC response', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    const prompt = sendPrompt(runtime, 'hello', {
      inputIds: ['pi-input-43'],
      delivery: { kind: 'newTurn', turnId: 'pi-turn-43' },
    });
    await waitForWrittenCount(capture, 1);
    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'early' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'early' }] },
    });
    expect(events.some((event) => event.kind === 'input-accepted')).toBe(false);

    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });

    expect(events.filter((event) => event.kind === 'input-accepted')).toEqual([expect.objectContaining({
      kind: 'input-accepted',
      inputIds: ['pi-input-43'],
      delivery: { kind: 'newTurn', turnId: 'pi-turn-43' },
    })]);
  });

  it('keeps prompt admission pending while Pi compacts, then accepts the delayed exact response', async () => {
    vi.useFakeTimers();
    try {
      const capture: Capture = { specs: [], written: [] };
      const runtime = await createRuntime(capture);
      const events: AgentSessionRuntimeEvent[] = [];
      runtime.watch((event) => events.push(event));

      let settled = false;
      const prompt = sendPrompt(runtime, 'continue after compaction', {
        inputIds: ['pi-input-delayed-by-compaction'],
        delivery: { kind: 'newTurn', turnId: 'pi-turn-delayed-by-compaction' },
      }).finally(() => {
        settled = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      await emit(capture, { type: 'compaction_start', reason: 'threshold' });
      await vi.advanceTimersByTimeAsync(30_000);

      expect(settled).toBe(false);
      expect(events.some((event) => event.kind === 'input-custody-unknown')).toBe(false);

      await emit(capture, {
        type: 'compaction_end',
        reason: 'threshold',
        success: true,
      });
      await ackLastCommand(capture);

      await expect(prompt).resolves.toEqual({ status: 'admitted' });
      expect(events.filter((event) => event.kind === 'input-accepted')).toEqual([
        expect.objectContaining({
          inputIds: ['pi-input-delayed-by-compaction'],
          delivery: { kind: 'newTurn', turnId: 'pi-turn-delayed-by-compaction' },
        }),
      ]);
      await runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores the prompt response-loss deadline after Pi compaction finishes', async () => {
    vi.useFakeTimers();
    try {
      const capture: Capture = { specs: [], written: [] };
      const runtime = await createRuntime(capture);
      const events: AgentSessionRuntimeEvent[] = [];
      runtime.watch((event) => events.push(event));

      let result: Awaited<ReturnType<typeof sendPrompt>> | undefined;
      void sendPrompt(runtime, 'lost response after compaction', {
        inputIds: ['pi-input-lost-after-compaction'],
        delivery: { kind: 'newTurn', turnId: 'pi-turn-lost-after-compaction' },
      }).then((value) => {
        result = value;
      });
      await Promise.resolve();
      await Promise.resolve();
      await emit(capture, { type: 'compaction_start', reason: 'threshold' });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(result).toBeUndefined();

      await emit(capture, {
        type: 'compaction_end',
        reason: 'threshold',
        success: true,
      });
      await vi.advanceTimersByTimeAsync(30_000);

      expect(result).toMatchObject({
        status: 'rejected',
        diagnostic: expect.objectContaining({ code: 'pi_input_outcome_unknown' }),
      });
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'input-custody-unknown',
          inputIds: ['pi-input-lost-after-compaction'],
        }),
      ]));
      await runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps ambiguous prompt response loss custody unknown when generic Pi stream activity was buffered', async () => {
    vi.useFakeTimers();
    try {
      const capture: Capture = { specs: [], written: [] };
      const runtime = await createRuntime(capture);
      const events: AgentSessionRuntimeEvent[] = [];
      runtime.watch((event) => events.push(event));

      const prompt = sendPrompt(runtime, 'follow up after resume', {
        inputIds: ['pi-input-44'],
        delivery: { kind: 'newTurn', turnId: 'pi-turn-44' },
      });
      await Promise.resolve();
      await Promise.resolve();
      await emit(capture, { type: 'agent_start' });
      await emit(capture, { type: 'turn_start' });
      await emit(capture, {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'unrelated output' },
        message: { role: 'assistant', content: [{ type: 'text', text: 'unrelated output' }] },
      });
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(prompt).resolves.toMatchObject({
        status: 'rejected',
        diagnostic: expect.objectContaining({ code: 'pi_input_outcome_unknown' }),
      });
      expect(events.filter((event) => event.kind === 'input-accepted')).toEqual([]);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'message-delta', text: 'unrelated output' }),
        expect.objectContaining({ kind: 'input-custody-unknown', inputIds: ['pi-input-44'] }),
      ]));
      await runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a concurrent steer race supply acceptance evidence for a pending prompt', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);

    const prompt = sendPrompt(runtime, 'new turn', {
      inputIds: ['pi-input-new-turn'],
      delivery: { kind: 'newTurn', turnId: 'pi-turn-new-turn' },
    });
    await waitForWrittenCount(capture, 1);
    const steer = sendPrompt(runtime, 'steer concurrently', {
      inputIds: ['pi-input-steer'],
      delivery: { kind: 'steer', turnId: 'pi-turn-new-turn' },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const writesBeforeAck = capture.written.length;

    if (writesBeforeAck > 1) {
      await ackCommandAt(capture, 1);
    }
    const steerResult = await steer;
    await ackCommandAt(capture, 0);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });

    expect(writesBeforeAck).toBe(1);
    expect(steerResult).toMatchObject({
      status: 'rejected',
      diagnostic: expect.objectContaining({ code: 'pi_input_rejected' }),
    });
  });

  it('classifies an exact negative prompt ACK as rejected before effect', async () => {
    const echoedPromptSentinel = 'PI_PROMPT_SENTINEL_PRE_ACCEPT_7C1E';
    const capture: Capture = { specs: [], written: [], warnings: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    const prompt = sendPrompt(runtime, 'unacknowledged prompt', {
      inputIds: ['pi-input-no-evidence'],
      delivery: { kind: 'newTurn', turnId: 'pi-turn-no-evidence' },
    });
    await waitForWrittenCount(capture, 1);
    await failLastCommand(
      capture,
      `429 {"error":{"code":"rate_limit_error","message":"Provider echoed ${echoedPromptSentinel}"}}`,
    );

    await expect(prompt).resolves.toMatchObject({
      status: 'rejected',
      diagnostic: expect.objectContaining({
        code: 'rate_limit_error',
        message: expect.stringContaining(echoedPromptSentinel),
      }),
    });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'input-rejected', inputIds: ['pi-input-no-evidence'] }),
    ]));
    expect(events.some((event) => event.kind === 'input-custody-unknown')).toBe(false);
    expect(capture.warnings).toEqual([
      [
        '[PiRuntime] Provider prompt rejected',
        {
          classification: 'pi_provider_failure',
          providerCode: 'rate_limit_error',
          retryable: true,
        },
      ],
    ]);
    expect(JSON.stringify(capture.warnings)).not.toContain(echoedPromptSentinel);
    await runtime.dispose();
  });

  it('preserves retryability for an explicit pre-acceptance transient Provider rejection', async () => {
    const capture: Capture = { specs: [], written: [], warnings: [] };
    const runtime = await createRuntime(capture);

    const prompt = sendPrompt(runtime, 'retryable provider request', {
      inputIds: ['pi-input-retryable-nack'],
      delivery: { kind: 'newTurn', turnId: 'pi-turn-retryable-nack' },
    });
    await waitForWrittenCount(capture, 1);
    await failLastCommand(
      capture,
      '429 {"error":{"code":"rate_limit_error","message":"Too many requests"}}',
    );

    await expect(prompt).resolves.toMatchObject({
      status: 'rejected',
      diagnostic: expect.objectContaining({ code: 'rate_limit_error' }),
      retryable: true,
    });
    await runtime.dispose();
  });

  it('keeps an exact negative prompt ACK rejected when pre-admission record buffering fails', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    const prompt = sendPrompt(runtime, 'rejected after observation failure', {
      inputIds: ['pi-input-negative-ack-buffer-failure'],
      delivery: { kind: 'newTurn', turnId: 'pi-turn-negative-ack-buffer-failure' },
    });
    await waitForWrittenCount(capture, 1);
    const invalidRecord: Record<string, unknown> = { type: 'agent_start' };
    invalidRecord.self = invalidRecord;
    await emit(capture, invalidRecord);
    await failLastCommand(capture, 'Prompt was rejected before acceptance');

    await expect(prompt).resolves.toMatchObject({
      status: 'rejected',
      diagnostic: expect.objectContaining({
        code: 'pi_provider_session_error',
        message: 'Pi provider rejected the prompt before acceptance: Prompt was rejected before acceptance',
      }),
    });
    expect(events.filter((event) => event.kind === 'input-rejected')).toEqual([
      expect.objectContaining({ inputIds: ['pi-input-negative-ack-buffer-failure'] }),
    ]);
    expect(events.some((event) => (
      event.kind === 'input-accepted'
      || event.kind === 'input-custody-unknown'
      || event.kind === 'input-delivery-failed'
    ))).toBe(false);
    await runtime.dispose();
  });

  it('keeps an exact negative prompt ACK rejected when unrelated Pi stream activity follows', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    const prompt = sendPrompt(runtime, 'rejected prompt', {
      inputIds: ['pi-input-negative-ack'],
      delivery: { kind: 'newTurn', turnId: 'pi-turn-negative-ack' },
    });
    await waitForWrittenCount(capture, 1);
    await failLastCommand(capture, 'Prompt was rejected before acceptance');
    await emit(capture, { type: 'agent_start' });
    await emit(capture, { type: 'turn_start' });
    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'stale output' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'stale output' }] },
    });

    await expect(prompt).resolves.toMatchObject({
      status: 'rejected',
      diagnostic: expect.objectContaining({
        code: 'pi_provider_session_error',
        message: 'Pi provider rejected the prompt before acceptance: Prompt was rejected before acceptance',
      }),
    });
    expect(events.filter((event) => event.kind === 'input-accepted')).toEqual([]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'message-delta', text: 'stale output' }),
      expect.objectContaining({ kind: 'input-rejected', inputIds: ['pi-input-negative-ack'] }),
    ]));
    await runtime.dispose();
  });

  it.each([
    ['new-turn', { kind: 'newTurn', turnId: 'pi-turn-response-loss' }],
    ['steer', { kind: 'steer', turnId: 'pi-turn-response-loss' }],
  ] as const)('classifies %s prompt response loss after invocation as custody unknown', async (_label, delivery) => {
    vi.useFakeTimers();
    try {
      const capture: Capture = { specs: [], written: [] };
      const runtime = await createRuntime(capture);
      const events: AgentSessionRuntimeEvent[] = [];
      runtime.watch((event) => events.push(event));

      const prompt = sendPrompt(runtime, 'response lost after write', {
        inputIds: ['pi-input-response-loss'],
        delivery,
      });
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(prompt).resolves.toMatchObject({ status: 'rejected', retryable: false });
      expect(capture.written).toHaveLength(1);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'input-custody-unknown',
          inputIds: ['pi-input-response-loss'],
        }),
      ]));
      expect(events.some((event) => event.kind === 'input-rejected')).toBe(false);
      await runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('projects raw Pi compaction records through the protocol event contract', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => {
      events.push(event);
    });
    events.length = 0;

    const prompt = sendPrompt(runtime, 'hello');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });
    await emit(capture, { type: 'compaction_start', reason: 'threshold' });
    await emit(capture, { type: 'compaction_start', reason: 'threshold' });
    await emit(capture, { type: 'compaction_start', reason: 'manual' });
    await emit(capture, {
      type: 'compaction_end',
      reason: 'overflow',
      result: {
        summary: 'foreign terminal',
        firstKeptEntryId: 'entry-foreign',
        tokensBefore: 101,
        estimatedTokensAfter: 41,
      },
      aborted: false,
      willRetry: true,
    });
    await emit(capture, {
      type: 'compaction_end',
      reason: 'threshold',
      result: {
        summary: 'compacted',
        firstKeptEntryId: 'entry-1',
        tokensBefore: 100,
        estimatedTokensAfter: 40,
      },
      aborted: false,
      willRetry: true,
    });
    await emit(capture, {
      type: 'compaction_end',
      reason: 'threshold',
      result: {
        summary: 'compacted',
        firstKeptEntryId: 'entry-1',
        tokensBefore: 100,
        estimatedTokensAfter: 40,
      },
      aborted: false,
      willRetry: true,
    });

    const compactionEvents = parseEvents(events).filter((event) => event.kind === 'context-compaction');
    expect(compactionEvents).toEqual([
      expect.objectContaining({
        kind: 'context-compaction',
        phase: 'started',
        sessionId: 'happier-session-1',
        trigger: 'threshold',
        compactionId: expect.stringMatching(/^pi:/),
      }),
      expect.objectContaining({
        kind: 'context-compaction',
        phase: 'completed',
        sessionId: 'happier-session-1',
        trigger: 'threshold',
        tokenCountBefore: 100,
        tokenCountAfter: 40,
      }),
    ]);
    expect(compactionEvents[0]?.compactionId).toBe(compactionEvents[1]?.compactionId);
    expect(compactionEvents.every((event) => !('retryAttempt' in event))).toBe(true);
    expect(compactionEvents.every((event) => !('provider' in event))).toBe(true);
  });

  it('maps exact Pi compaction cancellation and sanitized failure fields', () => {
    expect(buildPiCompletedContextCompactionPayload({
      type: 'compaction_end',
      reason: 'manual',
      result: undefined,
      aborted: true,
      willRetry: false,
    })).toMatchObject({
      phase: 'cancelled',
      trigger: 'manual',
    });

    const failed = buildPiCompletedContextCompactionPayload({
      type: 'compaction_end',
      reason: 'overflow',
      result: undefined,
      aborted: false,
      willRetry: false,
      errorMessage: 'Compaction failed: {"error":{"message":"Context limit reached"},"request_id":"secret-request"}',
    });
    expect(failed).toMatchObject({
      phase: 'failed',
      trigger: 'overflow',
      diagnostic: {
        code: 'pi_compaction_failed',
        message: 'Context limit reached',
      },
    });
    expect(JSON.stringify(failed)).not.toContain('secret-request');

    expect(buildPiCompletedContextCompactionPayload({
      type: 'compaction_end',
      reason: 'threshold',
      result: undefined,
      aborted: false,
      willRetry: false,
    })).toMatchObject({
      phase: 'failed',
      diagnostic: { code: 'pi_compaction_failed' },
    });
  });

  it('withholds a retrying Provider diagnostic and publishes only eventual success', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    const prompt = sendPrompt(runtime, 'hello');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });
    const hasTerminalTurn = () => events.some((event) => (
      event.kind === 'turn-complete' || event.kind === 'turn-failed' || event.kind === 'turn-cancelled'
    ));
    expect(hasTerminalTurn()).toBe(false);

    await emit(capture, {
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        content: [],
        stopReason: 'error',
        errorMessage: '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      },
    });
    await emit(capture, { type: 'turn_end', turnId: 'inner-turn-1' });
    await emit(capture, { type: 'agent_end', willRetry: true });
    await emit(capture, { type: 'turn_start', turnId: 'inner-turn-2' });
    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'eventual success' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'eventual success' }] },
    });
    await emit(capture, { type: 'agent_end', willRetry: false });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'message-delta',
        channel: 'assistant',
        text: 'eventual success',
      }),
      expect.objectContaining({
        kind: 'turn-complete',
      }),
    ]));
    expect(events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
      }),
    ]));
    expect(hasTerminalTurn()).toBe(true);
    await runtime.dispose();
  });

  it.each([
    {
      name: 'rate-limit failure',
      provider: 'zai',
      errorMessage: '429: {"code":"1302","message":"Rate limit reached for requests"}',
    },
    {
      name: 'Connected Service broker refresh failure',
      provider: 'openai-codex',
      errorMessage: 'OAuth refresh failed for openai-codex: happier_broker_bridge_status_500',
    },
  ])('keeps a transient $name turn open when Pi resumes after an agent_end without retry intent', async ({
    provider,
    errorMessage,
  }) => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    const prompt = sendPrompt(runtime, 'hello');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });

    await emit(capture, {
      type: 'message_end',
      terminalStatus: 'failed',
      provider,
      message: {
        role: 'assistant',
        provider,
        content: [],
        stopReason: 'error',
        errorMessage,
      },
    });
    await emit(capture, { type: 'agent_end' });
    expect(events.some((event) => (
      event.kind === 'turn-complete' || event.kind === 'turn-failed' || event.kind === 'turn-cancelled'
    ))).toBe(false);

    await emit(capture, { type: 'turn_start', turnId: 'inner-turn-2' });
    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'continued after rate limit' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'continued after rate limit' }] },
    });
    await emit(capture, { type: 'agent_end', willRetry: false });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'message-delta',
        channel: 'assistant',
        text: 'continued after rate limit',
      }),
      expect.objectContaining({
        kind: 'turn-complete',
      }),
    ]));
    expect(events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
      }),
    ]));
    await runtime.dispose();
  });

  it('publishes only the latest Provider diagnostic when a Pi retry also fails', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    const prompt = sendPrompt(runtime, 'hello');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });

    await emit(capture, {
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        content: [],
        stopReason: 'error',
        errorMessage:
          '529 {"type":"error","error":{"type":"overloaded_error","message":"First attempt overloaded"}}',
      },
    });
    await emit(capture, { type: 'agent_end', willRetry: true });
    await emit(capture, { type: 'turn_start', turnId: 'inner-turn-2' });
    await emit(capture, {
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        content: [],
        stopReason: 'error',
        errorMessage: 'Provider request failed without a safe automatic continuation.',
        happierRequestAuthProviderDiagnostic:
          '401 {"type":"error","error":{"type":"authentication_error","message":"Final credential was rejected"}}',
      },
    });
    await emit(capture, { type: 'agent_end', willRetry: false });

    const failed = events.find((event) => event.kind === 'turn-failed');
    expect(failed).toEqual(expect.objectContaining({
      kind: 'turn-failed',
      diagnostic: expect.objectContaining({
        code: 'pi_provider_session_error',
        message: 'Final credential was rejected',
      }),
    }));
    expect(JSON.stringify(failed)).not.toContain('First attempt overloaded');
    await runtime.dispose();
  });

  it('publishes and logs only the normalized safe fields from a structured Provider failure', async () => {
    const echoedPromptSentinel = 'PI_PROMPT_SENTINEL_ACCEPTED_TURN_9B4D';
    const capture: Capture = { specs: [], written: [], warnings: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    const prompt = sendPrompt(runtime, 'hello');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });

    await emit(capture, {
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'openai-codex',
        model: 'gpt-5.6-luna',
        content: [],
        stopReason: 'error',
        errorMessage:
          `401: {"error":{"code":"provider_auth_failed","message":"Provider echoed ${echoedPromptSentinel}; credential sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa was rejected"},"request_body":"secret prompt payload"}`,
      },
    });
    await emit(capture, { type: 'agent_end', willRetry: false });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        diagnostic: {
          code: 'provider_auth_failed',
          severity: 'error',
          message: expect.stringContaining(echoedPromptSentinel),
        },
      }),
    ]));
    expect(capture.warnings).toEqual([
      [
        '[PiRuntime] Provider turn failed',
        {
          classification: 'pi_provider_failure',
          providerCode: 'provider_auth_failed',
          retryable: false,
          failureRecord: {
            record: { type: 'message_end' },
            messageShape: {
              role: 'assistant',
              provider: 'openai-codex',
              model: 'gpt-5.6-luna',
              stopReason: 'error',
            },
          },
        },
      ],
    ]);
    expect(JSON.stringify(capture.warnings)).not.toContain(echoedPromptSentinel);
    expect(JSON.stringify(capture.warnings)).not.toContain('sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(JSON.stringify(capture.warnings)).not.toContain('secret prompt payload');
    await runtime.dispose();
  });

  it('publishes the structured diagnostic from a Pi turn_failed record without an assistant message', async () => {
    const capture: Capture = { specs: [], written: [], warnings: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    const prompt = sendPrompt(runtime, 'hello');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });

    await emit(capture, { type: 'turn_start', turnId: 'provider-turn-1' });
    await emit(capture, {
      type: 'turn_failed',
      turnId: 'provider-turn-1',
      code: 'rate_limit_exceeded',
      status: 429,
      detail: 'Service temporarily unavailable. Please retry.',
    });
    await emit(capture, { type: 'agent_end', willRetry: false });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        diagnostic: {
          code: 'rate_limit_exceeded',
          severity: 'error',
          message: 'Service temporarily unavailable. Please retry.',
        },
      }),
    ]));
    expect(capture.warnings).toEqual([
      [
        '[PiRuntime] Provider turn failed',
        {
          classification: 'pi_provider_failure',
          providerCode: 'rate_limit_exceeded',
          retryable: true,
          failureRecord: {
            record: {
              type: 'turn_failed',
              code: 'rate_limit_exceeded',
              status: 429,
              turnId: 'provider-turn-1',
            },
          },
        },
      ],
    ]);
    await runtime.dispose();
  });

  it('preserves partial output and still fails the turn on a later Provider terminal', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    const prompt = sendPrompt(runtime, 'hello');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });

    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'partial answer' },
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial answer' }],
      },
    });
    await emit(capture, {
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        content: [{ type: 'text', text: 'partial answer' }],
        stopReason: 'error',
        errorMessage: 'Provider request failed without a safe automatic continuation.',
        happierRequestAuthProviderDiagnostic:
          '529 {"type":"error","error":{"type":"overloaded_error","message":"Provider failed after partial output"}}',
      },
    });
    await emit(capture, { type: 'agent_end', willRetry: false });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'message-delta',
        channel: 'assistant',
        text: 'partial answer',
      }),
      expect.objectContaining({
        kind: 'turn-failed',
        diagnostic: expect.objectContaining({
          code: 'pi_provider_session_error',
          message: 'Provider failed after partial output',
        }),
      }),
    ]));
    expect(events.some((event) => event.kind === 'turn-complete')).toBe(false);
    await runtime.dispose();
  });

  it('terminalizes cancellation during Pi retry backoff with the withheld Provider diagnostic', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    const prompt = sendPrompt(runtime, 'hello');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });

    await emit(capture, {
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        content: [],
        stopReason: 'error',
        errorMessage:
          '529 {"type":"error","error":{"type":"overloaded_error","message":"Provider overloaded before retry backoff"}}',
        happierRequestAuthProviderDiagnostic:
          '529 {"type":"error","error":{"type":"overloaded_error","message":"Provider overloaded before retry backoff"}}',
      },
    });
    await emit(capture, { type: 'agent_end', willRetry: true });

    const cancel = runtime.cancel!({ turnId: 'pi-turn-1', reason: 'user' });
    await waitForWrittenCount(capture, 2);
    await emit(capture, {
      type: 'auto_retry_end',
      success: false,
      finalError: 'Retry cancelled',
    });
    await ackLastCommand(capture);
    await expect(cancel).resolves.toEqual({ status: 'requested', turnId: 'pi-turn-1' });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-cancelled',
        cause: 'user',
        diagnostic: expect.objectContaining({
          code: 'pi_provider_session_error',
          message: 'Provider overloaded before retry backoff',
        }),
      }),
    ]));
    expect(events.some((event) => event.kind === 'turn-complete')).toBe(false);
    await runtime.dispose();
  });

  it('treats abort as cancelled when cleanup disposes the Pi RPC client first', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const prompt = sendPrompt(runtime, 'cancel while the runtime is disposing');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });

    const cancel = runtime.cancel!({ turnId: 'pi-turn-1', reason: 'user' });
    await waitForWrittenCount(capture, 2);
    expect(capture.written.at(-1)).toEqual(expect.objectContaining({ type: 'abort' }));

    await runtime.dispose();

    await expect(cancel).resolves.toEqual({ status: 'requested', turnId: 'pi-turn-1' });
  });

  it('reports notRunning without aborting Pi when the requested turn is not the tracked turn', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(AgentSessionRuntimeEventSchema.parse(event)));

    const prompt = sendPrompt(runtime, 'currently active turn');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });
    await emit(capture, { type: 'turn_start', turnId: 'provider-turn-1' });

    const writesBeforeCancel = capture.written.length;
    await expect(runtime.cancel!({ turnId: 'pi-turn-stale', reason: 'user' })).resolves.toEqual({
      status: 'notRunning',
    });

    expect(capture.written.length).toBe(writesBeforeCancel);
    expect(capture.written).not.toContainEqual(expect.objectContaining({ type: 'abort' }));
    expect(events.some((event) => event.kind === 'turn-cancelled')).toBe(false);

    await runtime.dispose();
  });

  it('reports notRunning without aborting Pi when no turn was ever admitted', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);

    await expect(runtime.cancel!({ turnId: 'pi-turn-1', reason: 'user' })).resolves.toEqual({
      status: 'notRunning',
    });

    expect(capture.written).toEqual([]);

    await runtime.dispose();
  });

  it('aborts an exactly matched in-flight Pi admission and settles its late prompt acknowledgement as cancelled', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(AgentSessionRuntimeEventSchema.parse(event)));

    const prompt = sendPrompt(runtime, 'cancel while the prompt is still in flight');
    await waitForWrittenCount(capture, 1);

    const cancel = runtime.cancel!({ turnId: 'pi-turn-1', reason: 'user' });
    await waitForWrittenCount(capture, 2);
    expect(capture.written.at(-1)).toEqual(expect.objectContaining({ type: 'abort' }));
    await ackLastCommand(capture);
    await expect(cancel).resolves.toEqual({ status: 'requested', turnId: 'pi-turn-1' });
    expect(events.some((event) => (
      event.kind === 'turn-complete' || event.kind === 'turn-failed' || event.kind === 'turn-cancelled'
    ))).toBe(false);

    await ackCommandAt(capture, 0);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });
    expect(events.map((event) => event.kind).filter((kind) => ![
      'available-commands',
      'provider-session-id',
    ].includes(kind))).toEqual([
      'input-accepted',
      'turn-start',
      'turn-cancelled',
    ]);
    expect(events.at(-1)).toEqual(expect.objectContaining({
      kind: 'turn-cancelled',
      sessionId: 'happier-session-1',
      turnId: 'pi-turn-1',
      cause: 'user',
    }));

    const successor = sendPrompt(runtime, 'successor after the cancelled admission', {
      inputIds: ['pi-input-2'],
      delivery: { kind: 'newTurn', turnId: 'pi-turn-2' },
    });
    await waitForWrittenCount(capture, 3);
    await ackLastCommand(capture);
    await expect(successor).resolves.toEqual({ status: 'admitted' });
    await emit(capture, { type: 'agent_start' });
    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'successor response' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'successor response' }] },
    });
    await emit(capture, { type: 'agent_end', willRetry: false });

    expect(events.map((event) => event.kind).filter((kind) => ![
      'available-commands',
      'provider-session-id',
    ].includes(kind))).toEqual([
      'input-accepted',
      'turn-start',
      'turn-cancelled',
      'input-accepted',
      'turn-start',
      'message-delta',
      'turn-complete',
    ]);
    expect(events.filter((event) => (
      event.kind === 'turn-complete' || event.kind === 'turn-failed' || event.kind === 'turn-cancelled'
    ))).toEqual([
      expect.objectContaining({ kind: 'turn-cancelled', turnId: 'pi-turn-1', cause: 'user' }),
      expect.objectContaining({ kind: 'turn-complete', turnId: 'pi-turn-2' }),
    ]);

    await runtime.dispose();
  });

  it('settles a cancelled in-flight admission identically when the prompt ack precedes the abort ack', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(AgentSessionRuntimeEventSchema.parse(event)));

    const prompt = sendPrompt(runtime, 'cancel racing the prompt acknowledgement');
    await waitForWrittenCount(capture, 1);

    const cancel = runtime.cancel!({ turnId: 'pi-turn-1', reason: 'user' });
    await waitForWrittenCount(capture, 2);
    expect(capture.written.at(1)).toEqual(expect.objectContaining({ type: 'abort' }));

    await ackCommandAt(capture, 0);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });
    await ackLastCommand(capture);
    await expect(cancel).resolves.toEqual({ status: 'requested', turnId: 'pi-turn-1' });

    expect(events.map((event) => event.kind).filter((kind) => ![
      'available-commands',
      'provider-session-id',
    ].includes(kind))).toEqual([
      'input-accepted',
      'turn-start',
      'turn-cancelled',
    ]);
    expect(events.at(-1)).toEqual(expect.objectContaining({
      kind: 'turn-cancelled',
      sessionId: 'happier-session-1',
      turnId: 'pi-turn-1',
      cause: 'user',
    }));

    await runtime.dispose();
  });

  it('terminalizes an acknowledged abort as cancelled once and admits a successor turn', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(AgentSessionRuntimeEventSchema.parse(event)));

    const firstPrompt = sendPrompt(runtime, 'first turn');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(firstPrompt).resolves.toEqual({ status: 'admitted' });
    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'partial first response' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'partial first response' }] },
    });

    const cancel = runtime.cancel!({ turnId: 'pi-turn-1', reason: 'user' });
    await waitForWrittenCount(capture, 2);
    expect(capture.written.at(-1)).toEqual(expect.objectContaining({ type: 'abort' }));
    await emit(capture, { type: 'agent_end', willRetry: false });
    expect(events.some((event) => (
      event.kind === 'turn-complete' || event.kind === 'turn-failed' || event.kind === 'turn-cancelled'
    ))).toBe(false);
    await ackLastCommand(capture);
    await expect(cancel).resolves.toEqual({ status: 'requested', turnId: 'pi-turn-1' });

    const terminalEvents = () => events.filter((event) => (
      event.kind === 'turn-complete' || event.kind === 'turn-failed' || event.kind === 'turn-cancelled'
    ));
    expect(terminalEvents()).toEqual([
      expect.objectContaining({
        kind: 'turn-cancelled',
        sessionId: 'happier-session-1',
        turnId: 'pi-turn-1',
        cause: 'user',
      }),
    ]);

    await emit(capture, { type: 'agent_end', willRetry: false });
    expect(terminalEvents()).toHaveLength(1);

    const successor = sendPrompt(runtime, 'successor turn', {
      inputIds: ['pi-input-2'],
      delivery: { kind: 'newTurn', turnId: 'pi-turn-2' },
    });
    await waitForWrittenCount(capture, 3);
    await ackLastCommand(capture);
    await expect(successor).resolves.toEqual({ status: 'admitted' });
    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'successor response' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'successor response' }] },
    });
    await emit(capture, { type: 'agent_end', willRetry: false });

    expect(terminalEvents()).toEqual([
      expect.objectContaining({
        kind: 'turn-cancelled',
        turnId: 'pi-turn-1',
        cause: 'user',
      }),
      expect.objectContaining({
        kind: 'turn-complete',
        turnId: 'pi-turn-2',
      }),
    ]);
    await runtime.dispose();
  });

  it('releases a deferred final Pi boundary when abort is not acknowledged', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(AgentSessionRuntimeEventSchema.parse(event)));

    const prompt = sendPrompt(runtime, 'turn that keeps running');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });
    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'completed despite abort failure' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'completed despite abort failure' }] },
    });

    const cancel = runtime.cancel!({ turnId: 'pi-turn-1', reason: 'user' });
    await waitForWrittenCount(capture, 2);
    await emit(capture, { type: 'agent_end', willRetry: false });
    await failLastCommand(capture, 'abort refused');

    await expect(cancel).resolves.toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'pi_cancel_failed', message: 'abort refused' },
    });
    expect(events.filter((event) => (
      event.kind === 'turn-complete' || event.kind === 'turn-failed' || event.kind === 'turn-cancelled'
    ))).toEqual([
      expect.objectContaining({
        kind: 'turn-complete',
        turnId: 'pi-turn-1',
      }),
    ]);
    await runtime.dispose();
  });

  it('publishes a typed failed turn when Pi ends without assistant text', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => {
      events.push(event);
    });

    const prompt = sendPrompt(runtime, 'hello');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });

    await emit(capture, { type: 'turn_end', turnId: 'provider-turn-empty' });
    expect(events.some((event) => event.kind === 'turn-failed')).toBe(false);
    await emit(capture, { type: 'agent_end', willRetry: false });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        sessionId: 'happier-session-1',
        agentTurnId: 'provider-turn-empty',
        diagnostic: expect.objectContaining({
          code: 'pi_empty_provider_response',
          message: expect.stringContaining('without returning an assistant message'),
        }),
      }),
    ]));
    expect(events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-complete',
        agentTurnId: 'provider-turn-empty',
      }),
    ]));
  });

  it('preserves Pi assistant error messages instead of reporting a generic empty response', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => {
      events.push(event);
    });

    const prompt = sendPrompt(runtime, 'hello');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });

    const providerError = JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going.',
      },
      request_id: 'req_sensitive',
    });

    await emit(capture, {
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        content: [],
        stopReason: 'error',
        errorMessage: `400 ${providerError}`,
      },
    });
    await emit(capture, {
      type: 'turn_end',
      turnId: 'provider-turn-error',
      message: {
        role: 'assistant',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        content: [],
        stopReason: 'error',
        errorMessage: `400 ${providerError}`,
      },
    });
    expect(events.some((event) => event.kind === 'turn-failed')).toBe(false);
    await emit(capture, { type: 'agent_end', willRetry: false });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        sessionId: 'happier-session-1',
        agentTurnId: 'provider-turn-error',
        diagnostic: expect.objectContaining({
          code: 'pi_provider_session_error',
          message: expect.stringContaining('Third-party apps now draw from your extra usage'),
        }),
      }),
    ]));
    const failedTurn = events.find((event) => event.kind === 'turn-failed');
    expect(JSON.stringify(failedTurn)).not.toContain('req_sensitive');
    expect(JSON.stringify(failedTurn)).not.toContain('without returning an assistant message');
  });

  it('publishes the exact Provider diagnostic retained beside a retry-suppression message', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => {
      events.push(event);
    });

    const prompt = sendPrompt(runtime, 'hello');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });

    const exactProviderDiagnostic =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"rate limit maybe; contact support"}}';
    await emit(capture, {
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        content: [],
        stopReason: 'error',
        errorMessage: 'Provider request failed without a safe automatic continuation.',
        happierRequestAuthProviderDiagnostic: exactProviderDiagnostic,
      },
    });
    await emit(capture, { type: 'turn_end', turnId: 'provider-turn-error' });
    await emit(capture, { type: 'agent_end', willRetry: false });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        diagnostic: expect.objectContaining({
          code: 'pi_provider_session_error',
          message: 'rate limit maybe; contact support',
        }),
      }),
    ]));
  });

  it('maps one sticky unexpected Pi process exit without double-terminalizing disposal', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    const prompt = sendPrompt(runtime, 'exit during turn');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(prompt).resolves.toEqual({ status: 'admitted' });
    await emit(capture, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'partial' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
    });

    const exit = {
      exitCode: 17,
      signal: null,
      stdout: '',
      stderr: 'nested Pi child failure; apiKey=top-secret-value',
    };
    await emitExit(capture, exit);
    await emitExit(capture, exit);

    expect(events.filter((event) => event.kind === 'turn-failed')).toHaveLength(1);
    expect(events.filter((event) => event.kind === 'runtime-ended')).toHaveLength(1);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        diagnostic: expect.objectContaining({
          message: expect.stringMatching(/exit code 17.*nested Pi child failure/u),
        }),
      }),
    ]));
    expect(JSON.stringify(events)).not.toContain('top-secret-value');

    await runtime.dispose();
    await emitExit(capture, exit);
    expect(events.filter((event) => (
      event.kind === 'turn-complete' || event.kind === 'turn-failed' || event.kind === 'turn-cancelled'
    ))).toHaveLength(1);
    expect(events.filter((event) => event.kind === 'runtime-ended')).toHaveLength(1);
  });

  it('validates vendor runtime events before publishing them', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => {
      events.push(event);
    });
    events.length = 0;

    await emit(capture, {
      type: 'runtime_event',
      event: {
        kind: 'runtime-activity-snapshot',
        sessionId: 'happier-session-1',
        emittedAtMs: 1,
        state: 'idle',
        activeCount: 0,
      },
    });
    await emit(capture, {
      type: 'runtime_event',
      event: {
        kind: 'message-delta',
        sessionId: 123,
        emittedAtMs: -1,
        delta: 'malformed',
      },
    });
    await emit(capture, {
      type: 'runtime_event',
      event: {
        kind: 'runtime-activity-snapshot',
        sessionId: 'happier-session-1',
        emittedAtMs: 2,
        state: 'active',
        activeCount: 1,
      },
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(expect.objectContaining({
      kind: 'runtime-activity-snapshot',
      sessionId: 'happier-session-1',
      emittedAtMs: 1,
      state: 'idle',
      activeCount: 0,
    }));
    const malformedResult = AgentSessionRuntimeEventSchema.safeParse(events[1]);
    expect(malformedResult.success).toBe(true);
    if (!malformedResult.success) return;
    expect(malformedResult.data).toMatchObject({
      kind: 'runtime-ended',
      sessionId: 'happier-session-1',
      cause: 'protocolError',
      diagnostic: {
        code: 'malformed_runtime_event',
      },
    });
    if (malformedResult.data.kind !== 'runtime-ended') return;
    const details = malformedResult.data.diagnostic?.details;
    expect(isRecord(details)).toBe(true);
    if (!isRecord(details) || !Array.isArray(details.issues)) return;
    expect(details.issues.length).toBeGreaterThan(0);
    expect(details.issues.every((issue) => (
      isRecord(issue) && Object.keys(issue).length === 1 && typeof issue.message === 'string'
    ))).toBe(true);
    expect(JSON.stringify(malformedResult.data)).toContain('message-delta');
  });

  it('rejects child transcript user text runtime events without stable local ids', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => {
      events.push(event);
    });
    events.length = 0;

    await emit(capture, {
      type: 'runtime_event',
      event: {
        kind: 'transcript-user-text',
        sessionId: 'happier-session-1',
        emittedAtMs: 1,
        text: 'child terminal-origin prompt',
      },
    });

    expect(events).toHaveLength(1);
    const malformedResult = AgentSessionRuntimeEventSchema.safeParse(events[0]);
    expect(malformedResult.success).toBe(true);
    if (!malformedResult.success) return;
    expect(malformedResult.data).toMatchObject({
      kind: 'runtime-ended',
      sessionId: 'happier-session-1',
      diagnostic: {
        code: 'malformed_runtime_event',
      },
    });
    expect(JSON.stringify(malformedResult.data)).toContain('transcript-user-text');
  });

  it('validates projected Pi runtime events before publishing them', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));
    const send = sendPrompt(runtime, 'hello');
    await waitForWrittenCount(capture, 1);
    await ackLastCommand(capture);
    await expect(send).resolves.toEqual({ status: 'admitted' });
    events.length = 0;

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValueOnce(-1).mockReturnValue(1);
    try {
      await emit(capture, {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'invalid-time' },
        message: { role: 'assistant', content: [{ type: 'text', text: 'invalid-time' }] },
      });
    } finally {
      nowSpy.mockRestore();
    }

    expect(events).toHaveLength(1);
    const malformedResult = AgentSessionRuntimeEventSchema.safeParse(events[0]);
    expect(malformedResult.success).toBe(true);
    if (!malformedResult.success) return;
    expect(malformedResult.data).toMatchObject({
      kind: 'runtime-ended',
      sessionId: 'happier-session-1',
      emittedAtMs: 1,
      diagnostic: {
        code: 'malformed_runtime_event',
      },
    });
    expect(JSON.stringify(malformedResult.data)).toContain('message-delta');
  });

  it('publishes a diagnostic for non-object vendor runtime event payloads', async () => {
    const capture: Capture = { specs: [], written: [] };
    const runtime = await createRuntime(capture);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => {
      events.push(event);
    });
    events.length = 0;

    await emit(capture, {
      type: 'runtime_event',
      event: 'not-a-runtime-event',
    });

    expect(events).toHaveLength(1);
    const malformedResult = AgentSessionRuntimeEventSchema.safeParse(events[0]);
    expect(malformedResult.success).toBe(true);
    if (!malformedResult.success) return;
    expect(malformedResult.data).toMatchObject({
      kind: 'runtime-ended',
      sessionId: 'happier-session-1',
      diagnostic: {
        code: 'malformed_runtime_event',
      },
    });
  });
});
