import { describe, expect, it, vi } from 'vitest';

import type { AgentBackend, AgentMessage, AgentMessageHandler, SessionId } from '@/agent/core/AgentBackend';
import {
  createExecutionRunHostRuntimeFromAgentBackend,
} from '@/agent/executionRuns/runtime/backend.testkit';
import { createExecutionRunHostRuntimeFromRuntimeTurnOperations } from '@/agent/runtime/bridges/executionRun/hostRuntimeFromTurnOps';
import type { RuntimeTurnMessageHandler, RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';

const resolveBackendEngineAdapterResolutionMock = vi.fn();

vi.mock('@/agent/runtime/registry/engineRegistry', () => ({
  resolveBackendEngineAdapterResolution: (...args: unknown[]) => resolveBackendEngineAdapterResolutionMock(...args),
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
      directSessions: null,
      attach: null,
      sessionHandoff: null,
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
        } as AgentMessage);
        handler({
          type: 'event',
          name: 'runtime.capabilities',
          payload: {
            executionRun: { supported: true },
          },
        } as AgentMessage);
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
        } as AgentMessage);
        handler({
          type: 'model-output',
          fullText: JSON.stringify({
            summary: params.summary,
          }),
        } as AgentMessage);
      });
    },
    async steerInFlightTurn() {},
    async waitForTurnCompletion() {},
    subscribeRuntimeMessages(handler) {
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
        directSessions: null,
        attach: null,
        sessionHandoff: null,
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

  it('routes prompt-capable permission requests through the parent-session envelope', async () => {
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
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.runtime.backend' as never },
      instructions: 'Write the file.',
      permissionMode: 'safe-yolo',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
    });

    await waitForPermissionRequestMessage(sent);

    const permissionRequest = sent.find((entry) => entry.body.type === 'permission-request');
    expect(permissionRequest).toBeDefined();
    expect(permissionRequest).toEqual(expect.objectContaining({
      provider: 'acme.runtime.provider',
      body: expect.objectContaining({
        type: 'permission-request',
        permissionId: 'provider-request-1',
        toolName: 'write',
        description: 'write',
        options: expect.objectContaining({
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
          });
        });
      },
      async steerInFlightTurn(message) {
        calls.push(`steerInFlightTurn:${message}`);
      },
      async waitForTurnCompletion() {
        calls.push('waitForTurnCompletion');
      },
      subscribeRuntimeMessages(handler) {
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

  it('routes parent-session permission responses back through the execution-run runtime', async () => {
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
          } as AgentMessage);
        });
      },
      async steerInFlightTurn() {},
      async waitForTurnCompletion() {},
      subscribeRuntimeMessages(handler) {
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
    const { ExecutionRunHostBridge } = await import('./ExecutionRunHostBridge');
    const bridge = new ExecutionRunHostBridge({
      parentProvider: 'acme.runtime.provider' as never,
      cwd: '/tmp/runtime-turn-bridge',
      sendAcp: (provider, body, opts) => {
        sent.push({ provider, body: body as AgentMessage, opts });
      },
      getNowMs: () => 1_700_000_000_000,
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

    await waitForPermissionRequestMessage(sent);

    await expect(bridge.applyAction(started.runId, {
      actionId: 'permission.respond',
      input: {
        requestId: 'provider-request-1',
        approved: true,
        responseTarget: {
          kind: 'execution_run_host_bridge',
          sessionId: 'parent-session-1',
          runId: started.runId,
          callId: started.callId,
          sidechainId: started.sidechainId,
          backendId: 'runtime-turn.backend',
          runtimeKind: 'native',
          providerRequestId: 'provider-request-1',
        },
      },
    })).resolves.toEqual({ ok: true });

    expect(calls).toContain('respondToPermission:provider-request-1:true');
    expect(sent.some((entry) => entry.body.type === 'permission-response')).toBe(true);
  });
});
