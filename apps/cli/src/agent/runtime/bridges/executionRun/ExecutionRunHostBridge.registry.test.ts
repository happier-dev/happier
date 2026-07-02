import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentBackend, AgentMessage, AgentMessageHandler, SessionId } from '@/agent/core/AgentBackend';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import { createExecutionRunHostRuntimeFromAgentBackend } from '@/agent/runtime/bridges/executionRun/testkit';

type TestRuntimeFactoryInput = Readonly<{
  cwd: string;
  runId?: string;
  backendId: string;
  backendTarget?: unknown;
  modelId?: string;
  permissionMode: string;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  start?: unknown;
  happyHomeDir?: string | null;
}>;

type TestRuntimeFactory = (opts: TestRuntimeFactoryInput) => ExecutionRunHostRuntime;

const TEST_PRIMARY_BACKEND_ID = `${'primary'}.${'backend'}` as never;

const {
  createExecutionRunRuntimeMock,
  dispatchBridgeLifecycleHookEvent,
  runtimeFactoryRef,
} = vi.hoisted(() => {
  const runtimeFactoryRef: { current: TestRuntimeFactory | null } = { current: null };
  return {
    createExecutionRunRuntimeMock: vi.fn((opts: TestRuntimeFactoryInput): ExecutionRunHostRuntime => {
      const factory = runtimeFactoryRef.current;
      if (!factory) {
        throw new Error('Test execution-run runtime factory was not configured');
      }
      return factory(opts);
    }),
    dispatchBridgeLifecycleHookEvent: vi.fn().mockResolvedValue(undefined),
    runtimeFactoryRef,
  };
});

vi.mock('./createExecutionRunBridgeRuntime', () => ({
  createExecutionRunBridgeRuntime: createExecutionRunRuntimeMock,
}));

vi.mock('@/plugins/runtime/hooks/execution/dispatchBridgeLifecycleHookEvent', () => ({
  dispatchBridgeLifecycleHookEvent,
}));

function asExecutionRunHostRuntime(backend: AgentBackend) {
  return createExecutionRunHostRuntimeFromAgentBackend(backend);
}

function createExecutionRunManager(
  managerCtor: typeof import('@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge').ExecutionRunHostBridge,
  opts: ConstructorParameters<typeof managerCtor>[0] & Readonly<{ createRuntime: TestRuntimeFactory }>,
): InstanceType<typeof managerCtor> {
  const { createRuntime, ...bridgeOptions } = opts;
  runtimeFactoryRef.current = createRuntime;
  return new managerCtor(bridgeOptions) as InstanceType<typeof managerCtor>;
}

function createStaticBackend(responseText: string): AgentBackend {
  let handler: AgentMessageHandler | null = null;
  const sessionId: SessionId = 'child_session_1' as SessionId;
  return {
    async startSession(): Promise<{ sessionId: SessionId }> {
      return { sessionId };
    },
    async sendPrompt(_sessionId: SessionId, _prompt: string): Promise<void> {
      handler?.({ type: 'model-output', fullText: responseText } as AgentMessage);
    },
    async cancel(_sessionId: SessionId): Promise<void> {},
    onMessage(next: AgentMessageHandler): void {
      handler = next;
    },
    async dispose(): Promise<void> {},
    async waitForResponseComplete(): Promise<void> {},
  };
}

function createResumableStaticBackend(responseText: string): AgentBackend {
  let handler: AgentMessageHandler | null = null;
  const sessionId: SessionId = 'child_session_1' as SessionId;
  const resumedSessionId: SessionId = 'child_session_resumed' as SessionId;
  return {
    async startSession(): Promise<{ sessionId: SessionId }> {
      return { sessionId };
    },
    async loadSessionWithReplayCapture(_sessionId: SessionId): Promise<{ sessionId: SessionId; replay: unknown[] }> {
      return { sessionId: resumedSessionId, replay: [] };
    },
    async sendPrompt(_sessionId: SessionId, _prompt: string): Promise<void> {
      handler?.({ type: 'model-output', fullText: responseText } as AgentMessage);
    },
    async cancel(_sessionId: SessionId): Promise<void> {},
    onMessage(next: AgentMessageHandler): void {
      handler = next;
    },
    async dispose(): Promise<void> {},
    async waitForResponseComplete(): Promise<void> {},
  };
}

describe('ExecutionRunManager execution-run registry integration', () => {
  const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;
  const originalHappyServerUrl = process.env.HAPPIER_SERVER_URL;
  const originalHappyWebappUrl = process.env.HAPPIER_WEBAPP_URL;
  let happyHomeDir: string;

  beforeEach(() => {
    happyHomeDir = join(tmpdir(), `happier-cli-exec-run-mgr-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    runtimeFactoryRef.current = null;
    createExecutionRunRuntimeMock.mockClear();
    dispatchBridgeLifecycleHookEvent.mockReset();
    dispatchBridgeLifecycleHookEvent.mockResolvedValue(undefined);
    vi.resetModules();
  });

  afterEach(() => {
    if (existsSync(happyHomeDir)) {
      rmSync(happyHomeDir, { recursive: true, force: true });
    }
    if (originalHappyHomeDir === undefined) {
      delete process.env.HAPPIER_HOME_DIR;
    } else {
      process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;
    }
    if (originalHappyServerUrl === undefined) {
      delete process.env.HAPPIER_SERVER_URL;
    } else {
      process.env.HAPPIER_SERVER_URL = originalHappyServerUrl;
    }
    if (originalHappyWebappUrl === undefined) {
      delete process.env.HAPPIER_WEBAPP_URL;
    } else {
      process.env.HAPPIER_WEBAPP_URL = originalHappyWebappUrl;
    }
  });

  it('writes a running marker on start and a terminal marker on completion', async () => {
    const { ExecutionRunHostBridge: ExecutionRunManager } = await import('@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge');
    const { listExecutionRunMarkers } = await import('@/daemon/executionRunRegistry');

    const manager = createExecutionRunManager(ExecutionRunManager, {
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () =>
        asExecutionRunHostRuntime(createStaticBackend(
          JSON.stringify({
            findings: [],
            summary: 'ok',
          }),
        )),
      sendAcp: () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    const running = await listExecutionRunMarkers();
    expect(running.some((m) => m.runId === started.runId)).toBe(true);

    await manager.waitForTerminal(started.runId);

    expect(dispatchBridgeLifecycleHookEvent).toHaveBeenCalledWith(expect.objectContaining({
      happyHomeDir,
      event: expect.objectContaining({
        eventId: 'execution_run.start',
        happySessionId: 'parent_session_1',
        payload: expect.objectContaining({
          runId: started.runId,
          intent: 'review',
          runClass: 'bounded',
        }),
      }),
    }));
    expect(dispatchBridgeLifecycleHookEvent).toHaveBeenCalledWith(expect.objectContaining({
      happyHomeDir,
      event: expect.objectContaining({
        eventId: 'execution_run.terminal',
        happySessionId: 'parent_session_1',
        payload: expect.objectContaining({
          runId: started.runId,
          status: 'succeeded',
        }),
      }),
    }));

    // Marker writes are best-effort and may lag the terminal promise. Poll briefly until the
    // terminal marker is visible to avoid brittle timing assumptions.
    let marker: any = null;
    for (let i = 0; i < 25; i += 1) {
      const markers = await listExecutionRunMarkers();
      marker = markers.find((m) => m.runId === started.runId) ?? null;
      if (marker?.status === 'succeeded') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(marker).not.toBeNull();
    expect(marker?.status).toBe('succeeded');
    expect(marker?.intent).toBe('review');
    expect(marker?.backendTarget).toEqual({ kind: 'backend', backendId: TEST_PRIMARY_BACKEND_ID, sourceKind: 'built_in' });
    expect(marker?.permissionMode).toBe('read_only');
    expect(typeof marker?.startedAtMs).toBe('number');
    expect(typeof marker?.updatedAtMs).toBe('number');
  });

  it('updates lastActivityAtMs for long-lived sends (best-effort)', async () => {
    const { ExecutionRunHostBridge: ExecutionRunManager } = await import('@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge');
    const { listExecutionRunMarkers } = await import('@/daemon/executionRunRegistry');

    let nowMs = 1_700_000_000_000;
    const manager = createExecutionRunManager(ExecutionRunManager, {
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => asExecutionRunHostRuntime(createStaticBackend('ok')),
      sendAcp: () => {},
      getNowMs: () => nowMs,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      instructions: '',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });

    nowMs = 1_700_000_000_500;
    const sent = await manager.send(started.runId, { message: 'hello' });
    expect(sent.ok).toBe(true);
    expect(dispatchBridgeLifecycleHookEvent).toHaveBeenCalledWith(expect.objectContaining({
      happyHomeDir,
      event: expect.objectContaining({
        eventId: 'execution_run.send',
        happySessionId: 'parent_session_1',
        payload: expect.objectContaining({
          runId: started.runId,
          messageLength: 5,
          resume: false,
        }),
      }),
    }));

    const markers = await listExecutionRunMarkers();
    const marker = markers.find((m) => m.runId === started.runId) ?? null;
    expect(marker).not.toBeNull();
    expect(marker?.status).toBe('running');
    expect(marker?.permissionMode).toBe('read_only');
    expect(marker?.lastActivityAtMs).toBe(nowMs);
    expect(marker?.updatedAtMs).toBe(nowMs);

    const stopped = await manager.stop(started.runId);
    expect(stopped.ok).toBe(true);
    await manager.waitForTerminal(started.runId);
  });

  it('preserves runId when direct send resumes a resumable long-lived run', async () => {
    const { ExecutionRunHostBridge: ExecutionRunManager } = await import('@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge');

    const runtimeInputs: TestRuntimeFactoryInput[] = [];
    const manager = createExecutionRunManager(ExecutionRunManager, {
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: (opts) => {
        runtimeInputs.push(opts);
        return asExecutionRunHostRuntime(createResumableStaticBackend('ok'));
      },
      sendAcp: () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      instructions: '',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });

    const stopped = await manager.stop(started.runId);
    expect(stopped.ok).toBe(true);
    await manager.waitForTerminal(started.runId);
    runtimeInputs.length = 0;

    const sent = await manager.send(started.runId, { message: 'resume this run', resume: true });

    expect(sent.ok).toBe(true);
    expect(runtimeInputs.at(-1)?.runId).toBe(started.runId);
  });

  it('passes the concrete configured ACP backend id through execution-run state instead of customAcp', async () => {
    const { ExecutionRunHostBridge: ExecutionRunManager } = await import('@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge');

    const observedBackendIds: string[] = [];
    const manager = createExecutionRunManager(ExecutionRunManager, {
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: (opts: { backendId: string }) => {
        observedBackendIds.push(opts.backendId);
        return asExecutionRunHostRuntime(createStaticBackend('ok'));
      },
      sendAcp: () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    expect(observedBackendIds).toEqual(['review-bot']);
    expect(manager.get(started.runId)?.backendId).toBe('review-bot');
    expect(manager.get(started.runId)?.backendTarget).toEqual({
      kind: 'configuredAcpBackend',
      backendId: 'review-bot',
    });
  });

  it('cleans up ephemeral isolation when startup probing fails before controller registration', async () => {
    process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
    process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';

    const { reloadConfiguration, configuration } = await import('@/configuration');
    reloadConfiguration();

    const { createCatalogProviderExecutionRunBackend } = await import('./runtime/catalog');
    const { ExecutionRunHostBridge: ExecutionRunManager } = await import('@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge');

    let isolationRoot = '';
    const nativeRuntime: ExecutionRunHostRuntime = Object.freeze({
      async readResumeSupport() {
        throw new Error('startup probe failed');
      },
      async provisionSession() {
        return { sessionId: 'unreachable-session' };
      },
      async sendPrompt() {},
      async cancel() {},
      subscribeMessages() {
        return () => undefined;
      },
      async dispose() {},
    });

    const manager = createExecutionRunManager(ExecutionRunManager, {
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: (opts: { runId?: string; permissionMode: string }) => {
        isolationRoot = join(configuration.activeServerDir, 'isolation', 'pi', 'execution_run', String(opts.runId));
        return createCatalogProviderExecutionRunBackend({
          providerId: 'pi',
          createRuntime: () => nativeRuntime,
        }, {
          cwd: process.cwd(),
          backendId: 'pi',
          runId: opts.runId,
          permissionMode: opts.permissionMode,
          start: {
            intent: 'delegate',
            retentionPolicy: 'ephemeral',
          },
        });
      },
      sendAcp: () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    await expect(manager.start({
      sessionId: 'parent_session_1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'pi' },
      instructions: '',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'request_response',
    })).rejects.toThrow('startup probe failed');

    expect(isolationRoot).not.toBe('');
    expect(existsSync(isolationRoot)).toBe(false);
  });
});
