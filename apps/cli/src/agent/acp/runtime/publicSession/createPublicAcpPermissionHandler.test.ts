import { describe, expect, it, vi } from 'vitest';

import type {
  HostCurrentSessionInteractionsService as PluginCurrentSessionInteractionsService,
  HostSessionApprovalRequest as PluginSessionApprovalRequest,
  HostSessionApprovalResult as PluginSessionApprovalResult,
  HostSessionConfirmationRequest as PluginSessionConfirmationRequest,
  HostSessionConfirmationResult as PluginSessionConfirmationResult,
  HostSessionInteractionRequest as PluginSessionInteractionRequest,
  HostSessionInteractionResult as PluginSessionInteractionResult,
  HostSessionQuestionsRequest as PluginSessionQuestionsRequest,
  HostSessionQuestionsResult as PluginSessionQuestionsResult,
} from '@/agent/runtime/state/currentSessionUiTypes';
import type { ApiSessionClient } from '@/api/session/sessionClient';

import { createPublicAcpPermissionHandler } from './createPublicAcpPermissionHandler';

type ApprovalRequester = (
  request: PluginSessionApprovalRequest,
  options?: { signal?: AbortSignal },
) => Promise<PluginSessionApprovalResult>;

class TestInteractions implements PluginCurrentSessionInteractionsService {
  constructor(private readonly requestApproval: ApprovalRequester) {}

  request(request: PluginSessionApprovalRequest, options?: { signal?: AbortSignal }): Promise<PluginSessionApprovalResult>;
  request(request: PluginSessionQuestionsRequest, options?: { signal?: AbortSignal }): Promise<PluginSessionQuestionsResult>;
  request(request: PluginSessionConfirmationRequest, options?: { signal?: AbortSignal }): Promise<PluginSessionConfirmationResult>;
  async request(
    request: PluginSessionInteractionRequest,
    options?: { signal?: AbortSignal },
  ): Promise<PluginSessionInteractionResult> {
    if (request.kind !== 'approval') throw new Error(`Unexpected ${request.kind} interaction`);
    return await this.requestApproval(request, options);
  }
}

function interactions(request: ApprovalRequester): PluginCurrentSessionInteractionsService {
  return new TestInteractions(request);
}

class FakePermissionSession {
  sessionId = 'public-acp-permission-test';
  rpcHandlerManager = {
    registerHandler() {},
  };
  agentState: {
    requests: Record<string, unknown>;
    completedRequests: Record<string, unknown>;
  } = { requests: {}, completedRequests: {} };

  getAgentStateSnapshot() {
    return this.agentState;
  }

  updateAgentState(updater: (current: typeof this.agentState) => typeof this.agentState) {
    this.agentState = updater(this.agentState);
    return this.agentState;
  }

  getMetadataSnapshot() {
    return null;
  }
}

describe('createPublicAcpPermissionHandler', () => {
  it.each(['read-only', 'plan'] as const)(
    'preserves the host ACP filesystem effect through the composed native interaction path in %s mode',
    async (permissionMode) => {
      const [{ ProviderEnforcedPermissionHandler }, { createNativeAgentCurrentSessionUiServices }] = await Promise.all([
        import('@/agent/permissions/providerEnforced/handler'),
        import('@/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions'),
      ]);
      const hostPermissionHandler = new ProviderEnforcedPermissionHandler(
        new FakePermissionSession() as unknown as ApiSessionClient,
        { logPrefix: '[PublicAcpPermissionTest]' },
      );
      hostPermissionHandler.setPermissionMode(permissionMode);
      const currentSession = createNativeAgentCurrentSessionUiServices({
        permissionHandler: hostPermissionHandler,
        pluginId: 'happier.agent.test',
        contributionId: 'test',
        runtimeId: 'test',
        sessionId: 'public-acp-permission-test',
        generationId: 'generation-1',
        interactionDeadlineMs: 1_000,
        isCurrent: () => true,
        signal: new AbortController().signal,
      });
      const handler = createPublicAcpPermissionHandler({
        interactions: currentSession.interactions,
        signal: new AbortController().signal,
        resolveRequestId: (toolCallId) => `turn-1:${toolCallId}`,
      });

      for (const toolName of ['writeTextFile', 'write_file', 'rename', 'delete', 'mkdir']) {
        await expect(handler.handleToolCall(
          `host-fs-write:${toolName}`,
          toolName,
          { path: '/workspace/forbidden.txt', bytes: 9 },
          { origin: 'host_acp_fs_write' },
        )).resolves.toEqual({ decision: 'denied' });
      }
    },
  );

  it('maps an approved session-scoped SVC10 result to ACP session approval', async () => {
    const request = vi.fn(async () => ({
      requestId: 'interaction-1',
      kind: 'approval' as const,
      status: 'approved' as const,
      persistence: 'session' as const,
    }));
    const signal = new AbortController().signal;
    const handler = createPublicAcpPermissionHandler({
      interactions: interactions(request),
      signal,
      resolveRequestId: (toolCallId) => `turn-1:${toolCallId}`,
    });

    await expect(handler.handleToolCall('call-1', 'Bash', { command: 'pwd' })).resolves.toEqual({
      decision: 'approved_for_session',
    });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'approval',
      allowSessionPersistence: true,
    }), { signal: expect.any(AbortSignal) });
  });

  it('forwards the active turn causal authority unchanged to the canonical interaction owner', async () => {
    const request = vi.fn(async () => ({
      requestId: 'interaction-causal',
      kind: 'approval' as const,
      status: 'approved' as const,
      persistence: 'once' as const,
    }));
    const causalPermissionAuthority = Object.freeze({
      kind: 'admittedSessionInputV1' as const,
      admittedPermissionCeiling: 'read-only' as const,
    });
    const handler = createPublicAcpPermissionHandler({
      interactions: interactions(request),
      signal: new AbortController().signal,
      resolveRequestId: (toolCallId) => `turn-1:${toolCallId}`,
      resolveTurnId: () => 'turn-1',
      resolveCausalPermissionAuthority: () => causalPermissionAuthority,
    } as Parameters<typeof createPublicAcpPermissionHandler>[0] & Readonly<{
      resolveCausalPermissionAuthority(toolCallId: string): typeof causalPermissionAuthority | null;
    }>);

    await expect(handler.handleToolCall('call-causal', 'Bash', { command: 'pwd' })).resolves.toEqual({
      decision: 'approved',
    });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ kind: 'approval' }), {
      signal: expect.any(AbortSignal),
      permissionContext: { turnId: 'turn-1', causalPermissionAuthority },
    });
  });

  it('fails closed before presentation when the current active turn has no causal authority', async () => {
    const request = vi.fn(async () => ({
      requestId: 'interaction-missing-causal',
      kind: 'approval' as const,
      status: 'approved' as const,
      persistence: 'once' as const,
    }));
    const handler = createPublicAcpPermissionHandler({
      interactions: interactions(request),
      signal: new AbortController().signal,
      resolveRequestId: (toolCallId) => `turn-1:${toolCallId}`,
      resolveCausalPermissionAuthority: () => null,
    });

    await expect(handler.handleToolCall('call-missing-causal', 'Bash', { command: 'pwd' })).resolves.toEqual({
      decision: 'abort',
      rationale: 'ACP permission request causal authority is unavailable',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('fails closed before presentation when the active turn lacks its host identity', async () => {
    const request = vi.fn(async () => ({
      requestId: 'interaction-missing-turn',
      kind: 'approval' as const,
      status: 'approved' as const,
      persistence: 'once' as const,
    }));
    const handler = createPublicAcpPermissionHandler({
      interactions: interactions(request),
      signal: new AbortController().signal,
      resolveRequestId: (toolCallId) => `turn-1:${toolCallId}`,
      resolveTurnId: () => null,
      resolveCausalPermissionAuthority: () => ({
        kind: 'admittedSessionInputV1',
        admittedPermissionCeiling: 'read-only',
      }),
    });

    await expect(handler.handleToolCall('call-missing-turn', 'Bash', { command: 'pwd' })).resolves.toEqual({
      decision: 'abort',
      rationale: 'ACP permission request turn custody is unavailable',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('fails closed before presentation for invalid JSON and maps unavailable presentation to abort', async () => {
    const request = vi.fn(async () => ({
      requestId: 'interaction-unavailable',
      kind: 'approval' as const,
      status: 'unavailable' as const,
    }));
    const handler = createPublicAcpPermissionHandler({
      interactions: interactions(request),
      signal: new AbortController().signal,
      resolveRequestId: (toolCallId) => `turn-1:${toolCallId}`,
    });

    await expect(handler.handleToolCall('call-invalid', 'Bash', { value: undefined })).resolves.toEqual({
      decision: 'abort',
      rationale: 'ACP tool input is not valid bounded JSON',
    });
    expect(request).not.toHaveBeenCalled();

    await expect(handler.handleToolCall('call-unavailable', 'Bash', { command: 'pwd' })).resolves.toEqual({
      decision: 'abort',
    });
  });

  it('aborts the exact in-flight SVC10 request when the ACP turn terminates', async () => {
    let observedSignal: AbortSignal | undefined;
    let interactionSettled = false;
    const request = vi.fn<ApprovalRequester>((_request, options) => {
      observedSignal = options?.signal;
      return new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          setTimeout(() => {
            interactionSettled = true;
            reject(options.signal?.reason);
          }, 5);
        }, { once: true });
      });
    });
    const handler = createPublicAcpPermissionHandler({
      interactions: interactions(request),
      signal: new AbortController().signal,
      resolveRequestId: (toolCallId) => `turn-1:${toolCallId}`,
    });

    const pending = handler.handleToolCall('call-pending', 'Bash', { command: 'pwd' });
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    await handler.abortPendingRequestsAndFlush?.('turn ended');

    expect(observedSignal?.aborted).toBe(true);
    expect(interactionSettled).toBe(true);
    await expect(pending).resolves.toEqual(expect.objectContaining({ decision: 'abort' }));
  });
});
