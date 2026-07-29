import { describe, expect, it, vi } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { AgentMessage } from '@/agent/core/AgentMessage';
import { RuntimeEventV1Schema, type RuntimeEventV1 } from '@happier-dev/protocol';

import { createAcpRuntime } from '../createAcpRuntime';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';

type CapturedMessage = Readonly<{ type?: unknown; message?: unknown }>;

describe('createAcpRuntime (status error surfacing)', () => {
  it('surfaces status:error detail as a runtime issue without assistant prose', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });

    const sent: CapturedMessage[] = [];
    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.sendTurnPrompt('session setup');
    runtime.beginTurn();

    backend.emit({ type: 'status', status: 'error', detail: 'Model not found.' } satisfies AgentMessage);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(sent.some((msg) => msg.type === 'message' && typeof msg.message === 'string' && msg.message.includes('Model not found'))).toBe(false);
    expect(sent.some((msg) => msg.type === 'turn_failed')).toBe(true);
  });

  it('projects provider runtime-auth classifications from status errors into the primary runtime issue', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });

    const runtimeEvents: RuntimeEventV1[] = [];
    const onRuntimeAuthFailure = vi.fn();
    const session = createBasicSessionClientWithOverrides();

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      hooks: {
        classifyRuntimeAuthFailure: () => ({
          kind: 'usage_limit',
          serviceId: 'openai',
          profileId: null,
          groupId: null,
          resetsAtMs: 123_000,
          retryAfterMs: 5_000,
          planType: null,
          providerLimitId: 'free_tier_limit',
          quotaScope: 'account',
          action: null,
          rateLimits: null,
          source: 'structured_provider_error',
        }),
        onRuntimeAuthFailure,
      },
    });
    runtime.subscribeRuntimeEvents((message) => {
      runtimeEvents.push(RuntimeEventV1Schema.parse(message));
    });

    await runtime.sendTurnPrompt('session setup');
    runtime.beginTurn();

    backend.emit({
      type: 'status',
      status: 'error',
      detail: { name: 'FreeUsageLimitError' },
    } as unknown as AgentMessage);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    const turnFailed = runtimeEvents.find((event) => event.kind === 'turn-failed');
    const lastRuntimeIssue = turnFailed?.issue;
    expect(lastRuntimeIssue?.source).toBe('usage_limit');
    expect(lastRuntimeIssue?.usageLimit).toMatchObject({
      resetAtMs: 123_000,
      retryAfterMs: 5_000,
      providerLimitId: 'free_tier_limit',
      recoverability: 'wait',
    });
    expect(lastRuntimeIssue?.usageLimit?.connectedService).toBeUndefined();
    expect(onRuntimeAuthFailure).toHaveBeenCalledWith(expect.objectContaining({
      activeSessionId: 'sess_main',
      classification: expect.objectContaining({
        kind: 'usage_limit',
        serviceId: 'openai',
      }),
    }));
  });

  it('keeps asynchronous runtime-auth recovery results out of the canonical turn failure', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });

    const runtimeEvents: RuntimeEventV1[] = [];
    const session = createBasicSessionClientWithOverrides();

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      hooks: {
        classifyRuntimeAuthFailure: () => ({
          kind: 'usage_limit',
          serviceId: 'openai',
          profileId: 'primary',
          groupId: 'main',
          resetsAtMs: null,
          retryAfterMs: 5_000,
          planType: null,
          providerLimitId: 'free_tier_limit',
          quotaScope: 'account',
          action: null,
          rateLimits: null,
          source: 'structured_provider_error',
        }),
        onRuntimeAuthFailure: async () => ({
          ok: true,
          result: {
            status: 'switch_attempted',
            result: {
              status: 'apply_failed',
              activeProfileId: 'backup',
              generation: 4,
              applyResult: {
                ok: false,
                errorCode: 'partial_applied_pending_reconciliation',
                diagnostics: {
                  failurePhase: 'reconciliation',
                },
              },
            },
          },
        }),
      },
    });
    runtime.subscribeRuntimeEvents((message) => {
      runtimeEvents.push(RuntimeEventV1Schema.parse(message));
    });

    await runtime.sendTurnPrompt('session setup');
    runtime.beginTurn();

    backend.emit({
      type: 'status',
      status: 'error',
      detail: { name: 'FreeUsageLimitError' },
    } as unknown as AgentMessage);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    const turnFailed = runtimeEvents.find((event) => event.kind === 'turn-failed');
    expect(turnFailed?.issue.usageLimit).toMatchObject({
      recoverability: 'switch_account',
      connectedService: {
        serviceId: 'openai',
        profileId: 'primary',
        groupId: 'main',
      },
    });
    expect(turnFailed?.issue.usageLimit).not.toHaveProperty('recoveryDecision');
  });

  it('flushes pending permission requests when status:error aborts the turn', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const flushReasons: string[] = [];

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session: createBasicSessionClientWithOverrides(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: {
        handleToolCall: async () => ({ decision: 'approved' }),
        abortPendingRequestsAndFlush: async (reason: string) => {
          flushReasons.push(reason);
        },
      },
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.sendTurnPrompt('session setup');
    runtime.beginTurn();

    backend.emit({ type: 'status', status: 'error', detail: 'Model not found.' } satisfies AgentMessage);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(flushReasons).toEqual(['ACP runtime status:error']);
  });

  it('does not surface abort-like status:error detail as a transcript message', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });

    const sent: CapturedMessage[] = [];
    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.sendTurnPrompt('session setup');
    runtime.beginTurn();

    backend.emit({
      type: 'status',
      status: 'error',
      detail: 'Error: OpenCode session aborted\n    at Object.cancel (/tmp/runtime.ts:10:1)',
    } satisfies AgentMessage);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(sent.some((msg) => msg.type === 'message' && typeof msg.message === 'string' && msg.message.includes('OpenCode session aborted'))).toBe(false);
    expect(sent.some((msg) => msg.type === 'message' && typeof msg.message === 'string' && msg.message.includes('at Object.cancel'))).toBe(false);
    expect(sent.some((msg) => msg.type === 'turn_cancelled')).toBe(true);
    expect(sent.some((msg) => msg.type === 'turn_failed')).toBe(false);
  });
});
