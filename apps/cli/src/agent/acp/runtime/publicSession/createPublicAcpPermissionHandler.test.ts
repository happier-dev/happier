import { describe, expect, it, vi } from 'vitest';

import type {
  HostCurrentSessionInteractionsService as PluginCurrentSessionInteractionsService,
  HostSessionApprovalRequest as PluginSessionApprovalRequest,
  HostSessionApprovalResult as PluginSessionApprovalResult,
  HostSessionInteractionRequest as PluginSessionInteractionRequest,
  HostSessionInteractionResult as PluginSessionInteractionResult,
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
        occurrenceId: 'occurrence-1',
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

  it('presents ACP form elicitation through nativeAgentSessionInteractions and returns accepted answers', async () => {
    const { createNativeAgentCurrentSessionUiServices } = await import(
      '@/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions'
    );
    const multiLinePlanMessage = `${"# Plan Summary\n\n"}${"- Step 1: Inspect ACP form elicitation.\n".repeat(20)}`;
    const handleToolCall = vi.fn(async (_toolCallId: string, toolName: string, input: unknown) => {
      expect(toolName).toBe('AskUserQuestion');
      expect(input).toMatchObject({
        questions: [
          {
            id: 'value',
            question: multiLinePlanMessage.trim(),
            options: [
              { id: 'approve', label: 'Approve plan', description: 'Exit plan mode and execute' },
              { id: 'refine', label: 'Refine plan', description: 'Stay in plan mode' },
            ],
          },
        ],
      });
      return {
        decision: 'approved' as const,
        answers: {
          value: ['approve'],
        },
      };
    });
    const currentSession = createNativeAgentCurrentSessionUiServices({
      permissionHandler: { handleToolCall },
      pluginId: 'happier.agent.omp',
      contributionId: 'omp',
      runtimeId: 'omp',
      sessionId: 'public-acp-permission-test',
      occurrenceId: 'occurrence-1',
      interactionDeadlineMs: 1_000,
      isCurrent: () => true,
      signal: new AbortController().signal,
    });
    const handler = createPublicAcpPermissionHandler({
      interactions: currentSession.interactions,
      signal: new AbortController().signal,
      resolveRequestId: (toolCallId) => `turn-1:${toolCallId}`,
      resolveTurnId: () => 'turn-1',
      resolveCausalPermissionAuthority: () => ({
        kind: 'admittedSessionInputV1',
        admittedPermissionCeiling: 'plan',
      }),
    });

    await expect(
      handler.handleElicitation!({
        mode: 'form',
        sessionId: 'session-1',
        toolCallId: 'elicit-plan-1',
        message: multiLinePlanMessage,
        requestedSchema: {
          type: 'object',
          properties: {
            value: {
              type: 'string',
              oneOf: [
                { const: 'approve', title: 'Approve plan', description: 'Exit plan mode and execute' },
                { const: 'refine', title: 'Refine plan', description: 'Stay in plan mode' },
              ],
            },
          },
          required: ['value'],
        },
      }),
    ).resolves.toEqual({
      action: 'accept',
      content: {
        value: 'approve',
      },
    });
    expect(handleToolCall).toHaveBeenCalledTimes(1);
  });

  it('routes empty-property ACP form elicitation through confirmation and maps decline/cancel', async () => {
    const { createNativeAgentCurrentSessionUiServices } = await import(
      '@/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions'
    );
    const handleToolCall = vi.fn(async (_toolCallId: string, toolName: string, input: unknown) => {
      expect(toolName).toBe('AgentConfirmation');
      const confirmation = input as { message?: string };
      if (confirmation.message === 'Confirm accept?') {
        return {
          decision: 'approved' as const,
        };
      }
      return {
        decision: 'rejected' as const,
      };
    });
    const currentSession = createNativeAgentCurrentSessionUiServices({
      permissionHandler: { handleToolCall },
      pluginId: 'happier.agent.omp',
      contributionId: 'omp',
      runtimeId: 'omp',
      sessionId: 'public-acp-permission-test',
      occurrenceId: 'occurrence-1',
      interactionDeadlineMs: 1_000,
      isCurrent: () => true,
      signal: new AbortController().signal,
    });
    const handler = createPublicAcpPermissionHandler({
      interactions: currentSession.interactions,
      signal: new AbortController().signal,
      resolveRequestId: (toolCallId) => `turn-1:${toolCallId}`,
    });

    await expect(
      handler.handleElicitation!({
        mode: 'form',
        sessionId: 'session-1',
        toolCallId: 'confirm-1',
        message: 'Confirm accept?',
        requestedSchema: {
          type: 'object',
          properties: {},
        },
      }),
    ).resolves.toEqual({
      action: 'accept',
      content: {},
    });

    await expect(
      handler.handleElicitation!({
        mode: 'form',
        sessionId: 'session-1',
        toolCallId: 'confirm-2',
        message: 'Confirm decline?',
        requestedSchema: {
          type: 'object',
          properties: {},
        },
      }),
    ).resolves.toEqual({
      action: 'decline',
    });

    await expect(
      handler.handleElicitation!({
        mode: 'url',
        sessionId: 'session-1',
        elicitationId: 'url-1',
        message: 'Open URL',
        url: 'https://example.com',
      } as never),
    ).resolves.toEqual({
      action: 'cancel',
    });
    expect(handleToolCall).toHaveBeenCalledTimes(2);
  });

  it('truncates plan messages exceeding 4,096 code points without failing canonical schema validation', async () => {
    const { createNativeAgentCurrentSessionUiServices } = await import(
      '@/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions'
    );
    const hugePlanMessage = 'Plan step details. '.repeat(350); // ~6,650 characters (> 4,096 limit)
    let capturedQuestionPrompt: string | undefined;
    const handleToolCall = vi.fn(async (_toolCallId: string, toolName: string, input: unknown) => {
      expect(toolName).toBe('AskUserQuestion');
      const questionsInput = input as { questions: Array<{ id: string; question: string }> };
      capturedQuestionPrompt = questionsInput.questions[0]?.question;
      return {
        decision: 'approved' as const,
        answers: {
          decision: ['approve'],
        },
      };
    });
    const currentSession = createNativeAgentCurrentSessionUiServices({
      permissionHandler: { handleToolCall },
      pluginId: 'happier.agent.omp',
      contributionId: 'omp',
      runtimeId: 'omp',
      sessionId: 'public-acp-permission-test',
      occurrenceId: 'occurrence-1',
      interactionDeadlineMs: 1_000,
      isCurrent: () => true,
      signal: new AbortController().signal,
    });
    const handler = createPublicAcpPermissionHandler({
      interactions: currentSession.interactions,
      signal: new AbortController().signal,
      resolveRequestId: (toolCallId) => `turn-1:${toolCallId}`,
    });

    const response = await handler.handleElicitation!({
      mode: 'form',
      sessionId: 'session-1',
      toolCallId: 'huge-plan-1',
      message: hugePlanMessage,
      requestedSchema: {
        type: 'object',
        properties: {
          decision: {
            type: 'string',
            oneOf: [
              { const: 'approve', title: 'Approve plan' },
              { const: 'refine', title: 'Refine plan' },
            ],
          },
        },
        required: ['decision'],
      },
    });

    expect(response).toEqual({
      action: 'accept',
      content: {
        decision: 'approve',
      },
    });
    expect(capturedQuestionPrompt).toBeDefined();
    expect(Array.from(capturedQuestionPrompt!).length).toBeLessThanOrEqual(4_096);
    expect(capturedQuestionPrompt!).toContain('... [truncated]');
  });
});
