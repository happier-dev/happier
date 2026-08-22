import { describe, expect, it, vi } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { AgentMessage } from '@/agent/core/AgentMessage';
import {
  AgentSessionRuntimeEventV1Schema,
  type AgentSessionRuntimeEventV1,
} from '@happier-dev/protocol';

import { createAcpRuntime } from '../createAcpRuntime';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';

describe('createAcpRuntime (status error surfacing)', () => {
  function collectRuntimeEvents(runtime: Readonly<{
    subscribeRuntimeEvents: (handler: (message: unknown) => void) => () => void;
  }>): AgentSessionRuntimeEventV1[] {
    const events: AgentSessionRuntimeEventV1[] = [];
    runtime.subscribeRuntimeEvents((message) => {
      events.push(AgentSessionRuntimeEventV1Schema.parse(message));
    });
    return events;
  }

  it('surfaces status:error detail as a runtime issue without assistant prose', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });

    const session = createBasicSessionClientWithOverrides();

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
    const runtimeEvents = collectRuntimeEvents(runtime);

    await runtime.sendTurnPrompt('session setup');
    runtime.beginTurn();

    backend.emit({ type: 'status', status: 'error', detail: 'Model not found.' } satisfies AgentMessage);
    await vi.waitFor(() => {
      expect(runtimeEvents.some((event) => event.kind === 'turn-failed')).toBe(true);
    });

    expect(runtimeEvents.some((event) => (
      event.kind === 'transcript-message-committed'
      && event.role === 'assistant'
      && event.text.includes('Model not found')
    ))).toBe(false);
  });

  it('projects provider runtime-auth classifications into a bounded canonical diagnostic', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });

    const runtimeEvents: AgentSessionRuntimeEventV1[] = [];
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
      runtimeEvents.push(AgentSessionRuntimeEventV1Schema.parse(message));
    });

    await runtime.sendTurnPrompt('session setup');
    runtime.beginTurn();

    backend.emit({
      type: 'status',
      status: 'error',
      detail: { name: 'FreeUsageLimitError' },
    } as unknown as AgentMessage);
    await vi.waitFor(() => {
      expect(runtimeEvents.some((event) => event.kind === 'turn-failed')).toBe(true);
    });

    const turnFailed = runtimeEvents.find((event) => event.kind === 'turn-failed');
    expect(turnFailed?.diagnostic).toMatchObject({
      code: 'usage_limit',
      severity: 'error',
      details: { source: 'usage_limit' },
    });
    expect(JSON.stringify(turnFailed)).not.toContain('free_tier_limit');
    expect(onRuntimeAuthFailure).toHaveBeenCalledWith(expect.objectContaining({
      activeSessionId: 'sess_main',
      classification: expect.objectContaining({
        kind: 'usage_limit',
        serviceId: 'openai',
      }),
    }));
  });

  it('keeps asynchronous runtime-auth recovery results out of the canonical turn diagnostic', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });

    const runtimeEvents: AgentSessionRuntimeEventV1[] = [];
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
      runtimeEvents.push(AgentSessionRuntimeEventV1Schema.parse(message));
    });

    await runtime.sendTurnPrompt('session setup');
    runtime.beginTurn();

    backend.emit({
      type: 'status',
      status: 'error',
      detail: { name: 'FreeUsageLimitError' },
    } as unknown as AgentMessage);
    await vi.waitFor(() => {
      expect(runtimeEvents.some((event) => event.kind === 'turn-failed')).toBe(true);
    });

    const turnFailed = runtimeEvents.find((event) => event.kind === 'turn-failed');
    expect(turnFailed?.diagnostic).toMatchObject({
      code: 'usage_limit',
      severity: 'error',
      details: { source: 'usage_limit' },
    });
    expect(JSON.stringify(turnFailed)).not.toContain('connectedService');
    expect(JSON.stringify(turnFailed)).not.toContain('recoveryDecision');
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
    });
    const runtimeEvents = collectRuntimeEvents(runtime);

    await runtime.sendTurnPrompt('session setup');
    runtime.beginTurn();

    backend.emit({
      type: 'status',
      status: 'error',
      detail: 'Error: OpenCode session aborted\n    at Object.cancel (/tmp/runtime.ts:10:1)',
    } satisfies AgentMessage);
    await vi.waitFor(() => {
      expect(runtimeEvents.some((event) => event.kind === 'turn-cancelled')).toBe(true);
    });

    expect(runtimeEvents.some((event) => (
      event.kind === 'transcript-message-committed'
      && event.role === 'assistant'
      && (event.text.includes('OpenCode session aborted') || event.text.includes('at Object.cancel'))
    ))).toBe(false);
    expect(runtimeEvents.some((event) => event.kind === 'turn-failed')).toBe(false);
  });
});
