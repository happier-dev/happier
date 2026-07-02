import { describe, expect, it, vi } from 'vitest';

import type { AgentBackend, AgentMessage, AgentMessageHandler, SessionId } from '@/agent/core/AgentBackend';
import type { RuntimeEventV1 } from '@happier-dev/protocol';
import {
  createExecutionRunHostRuntimeFromAgentBackend,
} from '@/agent/runtime/bridges/executionRun/testkit';
import { createExecutionRunHostRuntimeFromRuntimeTurnOperations } from '@/agent/runtime/bridges/executionRun/hostRuntimeFromTurnOps';
import type { RuntimeTurnMessageHandler, RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';

const resolveBackendEngineAdapterResolutionMock = vi.fn();
const { dispatchBridgeLifecycleHookEvent } = vi.hoisted(() => ({
  dispatchBridgeLifecycleHookEvent: vi.fn().mockResolvedValue({
    matchedHandlerCount: 0,
    outcomes: [],
  }),
}));

vi.mock('@/agent/runtime/registry/engineRegistry', () => ({
  resolveBackendEngineAdapterResolution: (...args: unknown[]) => resolveBackendEngineAdapterResolutionMock(...args),
}));

vi.mock('@/plugins/runtime/hooks/execution/dispatchBridgeLifecycleHookEvent', () => ({
  dispatchBridgeLifecycleHookEvent,
}));

vi.mock('@/agent/prompts/library/resolveCliMemoryRecallGuidanceEnabled', () => ({
  resolveCliMemoryRecallGuidanceEnabled: vi.fn(async () => false),
}));

vi.mock('@/agent/prompts/library/resolveCliVoicePromptStackBlocks', () => ({
  resolveCliVoicePromptStackBlocks: vi.fn(async () => []),
}));

vi.mock('@/pets/discovery/resolveCodexPetRoots', () => ({
  resolveCodexPetRoots: vi.fn(async () => []),
  resolveCodexPetRootsWithDiagnostics: vi.fn(async () => ({
    roots: [],
    diagnostics: [],
  })),
}));

type AssertNever<T extends never> = T;
export type ExecutionRunHostBridgeOptionsDoNotExposeLegacyFactory = AssertNever<
  Extract<
    keyof ConstructorParameters<typeof import('./ExecutionRunHostBridge').ExecutionRunHostBridge>[0],
    `${'create'}${'Backend'}`
  >
>;

vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', () => ({
  createResolvedContributionRegistry: vi.fn(() => ({})),
  getResolvedContributionRegistry: vi.fn(() => ({})),
  resolveMergedContributionRegistry: vi.fn(async () => ({})),
}));

vi.mock('../../../plugins/projection/registry/createResolvedContributionRegistry', () => ({
  createResolvedContributionRegistry: vi.fn(() => ({})),
  getResolvedContributionRegistry: vi.fn(() => ({})),
  resolveMergedContributionRegistry: vi.fn(async () => ({})),
}));

function createStaticBackend(responseText: string): AgentBackend {
  let handler: AgentMessageHandler | null = null;
  const sessionId: SessionId = 'runtime-core-session-1' as SessionId;
  return {
    async startSession(): Promise<{ sessionId: SessionId }> {
      return { sessionId };
    },
    async sendPrompt(_sessionId: SessionId, _prompt: string): Promise<void> {
      handler?.({ type: 'model-output', fullText: responseText } as AgentMessage);
    },
    async cancel(_sessionId: SessionId): Promise<void> {},
    async respondToPermission(_requestId: string, _approved: boolean): Promise<void> {},
    onMessage(next: AgentMessageHandler): void {
      handler = next;
    },
    async dispose(): Promise<void> {},
    async waitForResponseComplete(): Promise<void> {},
  };
}

function mockRuntimeCore(runtime: ReturnType<typeof createExecutionRunHostRuntimeFromRuntimeTurnOperations> | ReturnType<typeof createExecutionRunHostRuntimeFromAgentBackend>): void {
  const createExecutionRunBackend = vi.fn(() => runtime);
  resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
    backendId: 'acme.runtime.backend',
    providerId: 'acme.runtime.provider',
    provenance: 'first_party',
    backend: {
      id: 'acme.runtime.backend',
      providerId: 'acme.runtime.provider',
      runtimeKind: 'native',
      capabilities: {},
    },
    provider: { id: 'acme.runtime.provider' },
    engineAdapter: {
      runtimeCore: {
        createExecutionRunBackend,
      },
    },
    executionSurfaces: {
      terminalRuntime: null,
      externalSession: null,
      attach: null,
      handoff: null,
      fork: null,
      checkpoint: null,
    },
    diagnostics: [],
  });
}

async function waitForPermissionRequestMessage(
  sent: ReadonlyArray<{
    body: AgentMessage;
  }>,
  timeoutMs = 500,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (sent.some((entry) => entry.body.type === 'permission-request')) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

type TestResponseTarget = Readonly<{ kind: string } & Record<string, unknown>>;
type TestPublishedRequest = Readonly<{
  requestId: string;
  toolName: string;
  toolInput: unknown;
  createdAt: number;
  source?: string;
  responseTarget?: TestResponseTarget | null;
  sidechainId?: string | null;
}>;
type TestResponseTargetDispatch = Readonly<{
  requestId: string;
  responseTarget: TestResponseTarget;
  completedRequest: Readonly<Record<string, unknown>>;
}>;

function createTestPermissionRequestStore(): Readonly<{
  published: TestPublishedRequest[];
  handlers: Map<string, (dispatch: TestResponseTargetDispatch) => void | PromiseLike<void>>;
  store: Readonly<{
    publishRequest: ReturnType<typeof vi.fn>;
    registerResponseTargetHandler: ReturnType<typeof vi.fn>;
  }>;
}> {
  const published: TestPublishedRequest[] = [];
  const handlers = new Map<string, (dispatch: TestResponseTargetDispatch) => void | PromiseLike<void>>();
  return {
    published,
    handlers,
    store: {
      publishRequest: vi.fn((params: TestPublishedRequest) => {
        published.push(params);
      }),
      registerResponseTargetHandler: vi.fn((
        kind: string,
        handler: (dispatch: TestResponseTargetDispatch) => void | PromiseLike<void>,
      ) => {
        handlers.set(kind, handler);
        return vi.fn();
      }),
    },
  };
}

async function waitForPublishedRequest(
  published: ReadonlyArray<TestPublishedRequest>,
  timeoutMs = 500,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (published.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createPermissionRequestRuntimeTurnOperations(params: Readonly<{
  backendId: string;
  runtimeKind: string;
  permissionRequestId: string;
  toolName: string;
  summary: string;
}>): RuntimeTurnOperations {
  const handlers = new Set<RuntimeTurnMessageHandler>();
  return {
    beginTurnLifecycle() {},
    async startOrLoadSession() {
      handlers.forEach((handler) => {
        handler({
          type: 'event',
          name: 'runtime.descriptor',
          payload: {
            v: 1,
            providerId: 'acme.runtime.provider',
            provider: {
              backendMode: params.runtimeKind,
              providerExtra: {
                owner: 'happier',
                schemaId: 'happier.executionRunRuntimeIdentity',
                v: 1,
                runtimeHandle: {
                  backendId: params.backendId,
                  providerId: 'acme.runtime.provider',
                  source: 'built_in',
                },
              },
            },
          },
        } as unknown as RuntimeEventV1);
        handler({
          type: 'event',
          name: 'runtime.capabilities',
          payload: {
            executionRun: { supported: true },
          },
        } as unknown as RuntimeEventV1);
      });
    },
    async sendTurnPrompt() {
      handlers.forEach((handler) => {
        handler({
          type: 'permission-request',
          id: params.permissionRequestId,
          reason: params.toolName,
          payload: {
            toolName: params.toolName,
            input: { path: '/tmp/execution-run-permission.txt' },
          },
        } as unknown as RuntimeEventV1);
        handler({
          type: 'model-output',
          fullText: JSON.stringify({
            summary: params.summary,
          }),
        } as unknown as RuntimeEventV1);
      });
    },
    async steerInFlightTurn() {},
    async waitForTurnCompletion() {},
    subscribeRuntimeEvents(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    async respondToPermission() {},
    async cancelTurn() {},
    readSessionIdentity() {
      return { sessionId: 'runtime-turn-session-1' };
    },
    async updateSessionRuntimeConfig() {},
    async resetOrDisposeRuntime() {},
  };
}

describe('ExecutionRunHostBridge runtimeCore consumption', () => {
  it('creates execution-run backends through runtimeCore when no compatibility factory is injected', async () => {
    const createExecutionRunBackend = vi.fn(() =>
      createExecutionRunHostRuntimeFromAgentBackend(createStaticBackend(
        JSON.stringify({
          findings: [],
          summary: 'ok',
        }),
      )),
    );
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      backendId: 'acme.runtime.backend',
      providerId: 'acme.runtime.provider',
      provenance: 'first_party',
      backend: {
        id: 'acme.runtime.backend',
        providerId: 'acme.runtime.provider',
        runtimeKind: 'native',
        capabilities: {},
      },
      provider: { id: 'acme.runtime.provider' },
      engineAdapter: {
        runtimeCore: {
          createExecutionRunBackend,
        },
      },
      executionSurfaces: {
        terminalRuntime: null,
        externalSession: null,
        attach: null,
        handoff: null,
        fork: null,
        checkpoint: null,
      },
      diagnostics: [],
    });

    const { ExecutionRunHostBridge } = await import('./ExecutionRunHostBridge');
    const bridge = new ExecutionRunHostBridge({
      parentProvider: 'acme.runtime.provider' as never,
      cwd: '/tmp/runtime-core-bridge',
      sendAcp: () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await bridge.start({
      sessionId: 'parent-session-1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.runtime.backend' as never },
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    expect(resolveBackendEngineAdapterResolutionMock).toHaveBeenCalledWith('acme.runtime.backend', expect.any(Object));
    expect(createExecutionRunBackend).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/tmp/runtime-core-bridge',
      backendId: 'acme.runtime.backend',
      backendTarget: {
        kind: 'backend',
        backendId: 'acme.runtime.backend',
        sourceKind: 'built_in',
      },
      permissionMode: 'read_only',
      start: expect.objectContaining({
        intent: 'review',
        retentionPolicy: 'ephemeral',
        backendTarget: { kind: 'builtInAgent', agentId: 'acme.runtime.backend' },
      }),
    }));
  });

  it('publishes prompt-capable permission requests through AgentStateRequestStore', async () => {
    const sent: Array<{
      provider: string;
      body: AgentMessage;
      opts?: { meta?: Record<string, unknown> };
    }> = [];
    const operations = createPermissionRequestRuntimeTurnOperations({
      backendId: 'acme.runtime.backend',
      runtimeKind: 'native',
      permissionRequestId: 'provider-request-1',
      toolName: 'write',
      summary: 'prompt-capable',
    });

    mockRuntimeCore(createExecutionRunHostRuntimeFromRuntimeTurnOperations(operations));
    const permissionRequests = createTestPermissionRequestStore();
    const { ExecutionRunHostBridge } = await import('./ExecutionRunHostBridge');
    const bridge = new ExecutionRunHostBridge({
      parentProvider: 'acme.runtime.provider' as never,
      cwd: '/tmp/runtime-core-bridge',
      sendAcp: (provider, body, opts) => {
        sent.push({ provider, body: body as AgentMessage, opts });
      },
      getNowMs: () => 1_700_000_000_000,
      getPermissionRequestStore: () => permissionRequests.store,
    });

    const started = await bridge.start({
      sessionId: 'parent-session-1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.runtime.backend' as never },
      instructions: 'Write the file.',
      permissionMode: 'safe-yolo',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
    });

    await waitForPublishedRequest(permissionRequests.published);

    expect(sent.filter((entry) => entry.body.type === 'permission-request')).toHaveLength(0);
    expect(permissionRequests.store.registerResponseTargetHandler).toHaveBeenCalledWith(
      'execution_run_host_bridge',
      expect.any(Function),
    );
    expect(permissionRequests.store.publishRequest).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'provider-request-1',
      toolName: 'write',
      source: 'execution_run',
      sidechainId: started.sidechainId,
      responseTarget: expect.objectContaining({
        kind: 'execution_run_host_bridge',
        sessionId: 'parent-session-1',
        runId: started.runId,
        callId: started.callId,
        sidechainId: started.sidechainId,
        backendId: 'acme.runtime.backend',
        runtimeKind: 'native',
        providerRequestId: 'provider-request-1',
      }),
      toolInput: expect.objectContaining({
          input: {
            path: '/tmp/execution-run-permission.txt',
          },
          executionRun: expect.objectContaining({
            sessionId: 'parent-session-1',
            runId: started.runId,
            callId: started.callId,
            sidechainId: started.sidechainId,
            backendId: 'acme.runtime.backend',
            runtimeKind: 'native',
            permissionMode: 'safe-yolo',
            providerRequestId: 'provider-request-1',
            responseTarget: expect.objectContaining({
              kind: 'execution_run_host_bridge',
              sessionId: 'parent-session-1',
              runId: started.runId,
              callId: started.callId,
              sidechainId: started.sidechainId,
              backendId: 'acme.runtime.backend',
              runtimeKind: 'native',
              providerRequestId: 'provider-request-1',
            }),
          }),
      }),
    }));
  });

  it('does not surface deterministic permission requests to the parent session', async () => {
    const sent: Array<{
      provider: string;
      body: AgentMessage;
      opts?: { meta?: Record<string, unknown> };
    }> = [];
    const operations = createPermissionRequestRuntimeTurnOperations({
      backendId: 'acme.runtime.backend',
      runtimeKind: 'native',
      permissionRequestId: 'provider-request-2',
      toolName: 'write',
      summary: 'deterministic',
    });

    mockRuntimeCore(createExecutionRunHostRuntimeFromRuntimeTurnOperations(operations));
    const { ExecutionRunHostBridge } = await import('./ExecutionRunHostBridge');
    const bridge = new ExecutionRunHostBridge({
      parentProvider: 'acme.runtime.provider' as never,
      cwd: '/tmp/runtime-core-bridge',
      sendAcp: (provider, body, opts) => {
        sent.push({ provider, body: body as AgentMessage, opts });
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await bridge.start({
      sessionId: 'parent-session-1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.runtime.backend' as never },
      instructions: 'Review the repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sent.filter((entry) => entry.body.type === 'permission-request')).toHaveLength(0);
  });

  it('denies deterministic permission requests through the runtime instead of dropping them', async () => {
    const sent: Array<{
      provider: string;
      body: AgentMessage;
      opts?: { meta?: Record<string, unknown> };
    }> = [];
    const calls: string[] = [];
    const handlers = new Set<(message: AgentMessage) => void>();

    const runtime = {
      async readResumeSupport() {
        return false;
      },
      async provisionSession() {
        return { sessionId: 'runtime-session-1' };
      },
      async sendPrompt() {
        handlers.forEach((handler) => {
          handler({
            type: 'permission-request',
            id: 'provider-request-deterministic',
            reason: 'write',
            payload: {
              toolName: 'write',
              input: { path: '/tmp/deterministic-deny.txt' },
            },
          } as AgentMessage);
        });
      },
      async cancel() {},
      subscribeMessages(handler: (message: AgentMessage) => void) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      async respondToPermission(requestId: string, approved: boolean) {
        calls.push(`respondToPermission:${requestId}:${approved}`);
      },
      async dispose() {},
    };

    mockRuntimeCore(runtime);
    const { ExecutionRunHostBridge } = await import('./ExecutionRunHostBridge');
    const bridge = new ExecutionRunHostBridge({
      parentProvider: 'acme.runtime.provider' as never,
      cwd: '/tmp/runtime-turn-bridge',
      sendAcp: (provider, body, opts) => {
        sent.push({ provider, body: body as AgentMessage, opts });
      },
      getNowMs: () => 1_700_000_000_000,
    });

    await expect(bridge.start({
      sessionId: 'parent-session-1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'runtime-turn.backend' as never },
      instructions: 'Stay deterministic.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    })).resolves.toEqual(expect.objectContaining({
      runId: expect.any(String),
      callId: expect.any(String),
      sidechainId: expect.any(String),
    }));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toContain('respondToPermission:provider-request-deterministic:false');
    expect(sent.filter((entry) => entry.body.type === 'permission-request')).toHaveLength(0);
  });

  it('accepts shared runtime-turn operations at the execution-run creation boundary', async () => {
    const calls: string[] = [];
    const handlers = new Set<RuntimeTurnMessageHandler>();
    const operations: RuntimeTurnOperations = {
      beginTurnLifecycle() {
        calls.push('beginTurnLifecycle');
      },
      async startOrLoadSession() {
        calls.push('startOrLoadSession');
      },
      async sendTurnPrompt(prompt) {
        calls.push(`sendTurnPrompt:${prompt}`);
        handlers.forEach((handler) => {
          handler({
            type: 'model-output',
            fullText: JSON.stringify({
              findings: [],
              summary: 'ok',
            }),
          } as unknown as RuntimeEventV1);
        });
      },
      async steerInFlightTurn(message) {
        calls.push(`steerInFlightTurn:${message}`);
      },
      async waitForTurnCompletion() {
        calls.push('waitForTurnCompletion');
      },
      subscribeRuntimeEvents(handler) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      async respondToPermission(requestId, approved) {
        calls.push(`respondToPermission:${requestId}:${approved}`);
      },
      async cancelTurn() {
        calls.push('cancelTurn');
      },
      readSessionIdentity() {
        return { sessionId: 'runtime-turn-session-1' };
      },
      async updateSessionRuntimeConfig() {
        calls.push('updateSessionRuntimeConfig');
      },
      async resetOrDisposeRuntime() {
        calls.push('resetOrDisposeRuntime');
      },
    };

    mockRuntimeCore(createExecutionRunHostRuntimeFromRuntimeTurnOperations(operations));
    const { ExecutionRunHostBridge } = await import('./ExecutionRunHostBridge');
    const bridge = new ExecutionRunHostBridge({
      parentProvider: 'acme.runtime.provider' as never,
      cwd: '/tmp/runtime-turn-bridge',
      sendAcp: () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await bridge.start({
      sessionId: 'parent-session-1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'runtime-turn.backend' as never },
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await bridge.waitForTerminal(started.runId);

    expect(calls[0]).toBe('startOrLoadSession');
    expect(calls[1]).toBe('beginTurnLifecycle');
    expect(calls[2]).toContain('sendTurnPrompt:Review this repo.');
    expect(calls.slice(3)).toEqual([
      'waitForTurnCompletion',
      'resetOrDisposeRuntime',
    ]);
  });

  it('routes AgentStateRequestStore response-target dispatches back through the execution-run runtime', async () => {
    const calls: string[] = [];
    const handlers = new Set<RuntimeTurnMessageHandler>();
    const operations: RuntimeTurnOperations = {
      beginTurnLifecycle() {},
      async startOrLoadSession() {},
      async sendTurnPrompt() {
        handlers.forEach((handler) => {
          handler({
            type: 'permission-request',
            id: 'provider-request-1',
            reason: 'write',
            payload: {
              toolName: 'write',
              input: { path: '/tmp/needs-parent-approval.txt' },
            },
          } as unknown as RuntimeEventV1);
        });
      },
      async steerInFlightTurn() {},
      async waitForTurnCompletion() {},
      subscribeRuntimeEvents(handler) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      async respondToPermission(requestId, approved) {
        calls.push(`respondToPermission:${requestId}:${approved}`);
      },
      async cancelTurn() {},
      readSessionIdentity() {
        return { sessionId: 'runtime-turn-session-1' };
      },
      async updateSessionRuntimeConfig() {},
      async resetOrDisposeRuntime() {},
    };

    const sent: Array<{
      provider: string;
      body: AgentMessage;
      opts?: { meta?: Record<string, unknown> };
    }> = [];

    mockRuntimeCore(createExecutionRunHostRuntimeFromRuntimeTurnOperations(operations));
    const permissionRequests = createTestPermissionRequestStore();
    const { ExecutionRunHostBridge } = await import('./ExecutionRunHostBridge');
    const bridge = new ExecutionRunHostBridge({
      parentProvider: 'acme.runtime.provider' as never,
      cwd: '/tmp/runtime-turn-bridge',
      sendAcp: (provider, body, opts) => {
        sent.push({ provider, body: body as AgentMessage, opts });
      },
      getNowMs: () => 1_700_000_000_000,
      getPermissionRequestStore: () => permissionRequests.store,
    });

    const started = await bridge.start({
      sessionId: 'parent-session-1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'runtime-turn.backend' as never },
      instructions: 'Need parent approval.',
      permissionMode: 'safe-yolo',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
    });

    await waitForPublishedRequest(permissionRequests.published);

    const published = permissionRequests.published[0];
    expect(published?.responseTarget).toEqual(expect.objectContaining({
      kind: 'execution_run_host_bridge',
      runId: started.runId,
      providerRequestId: 'provider-request-1',
    }));
    const handler = permissionRequests.handlers.get('execution_run_host_bridge');
    expect(handler).toBeTypeOf('function');
    await handler!({
      requestId: 'provider-request-1',
      responseTarget: published.responseTarget!,
      completedRequest: {
        status: 'approved',
        decision: 'approved',
        responseTarget: published.responseTarget!,
      },
    });

    expect(calls).toContain('respondToPermission:provider-request-1:true');
    expect(sent.some((entry) => entry.body.type === 'permission-response')).toBe(true);
  });
});
