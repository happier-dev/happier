import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentMessage } from '@/agent/core/AgentMessage';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { RuntimeEventV1Schema, type RuntimeEventV1 } from '@happier-dev/protocol';
import {
  CONNECTED_SERVICE_RUNTIME_AUTH_FAILURE_REPORT_TIMEOUT_MS,
  resetConnectedServiceRuntimeAuthFailureReportDedupeForTests,
} from '@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon';
import { buildRuntimeAuthRecoveryScheduledResult } from '@/daemon/connectedServices/runtimeAuth/projection/connectedServiceRuntimeAuthRecoveryProjection';
import { createCatalogProviderAcpRuntime } from '../createProviderAcpRuntime';

const notifyDaemonConnectedServiceRuntimeAuthFailure = vi.hoisted(() =>
  vi.fn<(_input: unknown, _options?: unknown) => Promise<unknown>>(async () => ({ ok: true }))
);

vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/daemon/controlClient')>()),
  notifyDaemonConnectedServiceRuntimeAuthFailure,
}));

async function flushAsyncRuntimeHandlers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createCatalogProviderAcpRuntime (runtime auth failures)', () => {
  beforeEach(() => {
    notifyDaemonConnectedServiceRuntimeAuthFailure.mockReset();
    notifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValue({ ok: true });
    // Cases reuse the same sessionId/classification; clear the shared report-path
    // stable-key dedupe window between them.
    resetConnectedServiceRuntimeAuthFailureReportDedupeForTests();
  });

  it('does not notify daemon recovery from ACP status errors without connected-service recovery context', async () => {
    notifyDaemonConnectedServiceRuntimeAuthFailure.mockClear();
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'opencode-session-1' });
    const session = createMutableApiSessionClientFixture({
      overrides: {
        sessionId: 'happy-session-1',
      },
    });
    const runtimeEvents: RuntimeEventV1[] = [];

    const runtime = createCatalogProviderAcpRuntime({
      provider: 'opencode',
      loggerLabel: 'OpenCodeACP',
      directory: '/tmp/project',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      createBackend: async () => backend,
    });
    runtime.subscribeRuntimeEvents((message) => {
      runtimeEvents.push(RuntimeEventV1Schema.parse(message));
    });

    await runtime.sendTurnPrompt('session setup');
    runtime.beginTurn();

    backend.emit({
      type: 'status',
      status: 'error',
      detail: {
        name: 'FreeUsageLimitError',
        serviceId: 'openai',
        headers: { 'retry-after-ms': '2500' },
      },
    } as unknown as AgentMessage);
    await vi.waitFor(() => {
      expect(runtimeEvents.some((event) => event.kind === 'turn-failed')).toBe(true);
    });
    expect(notifyDaemonConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();
  });

  it('does not report native provider runtime-auth classifications to connected-service recovery', async () => {
    notifyDaemonConnectedServiceRuntimeAuthFailure.mockClear();
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'claude-session-1' });
    const session = createMutableApiSessionClientFixture({
      overrides: {
        sessionId: 'happy-native-session-1',
      },
    });
    const runtimeEvents: RuntimeEventV1[] = [];
    const classifyRuntimeAuthFailure = vi.fn(async () => ({
      kind: 'usage_limit',
      serviceId: 'claude-subscription',
      profileId: null,
      groupId: null,
      resetsAtMs: 2_000,
      retryAfterMs: 30_000,
      limitCategory: 'usage_limit',
      quotaScope: 'account',
      providerLimitId: 'five_hour',
      planType: 'pro',
      rateLimits: null,
      source: 'structured_provider_error',
    }));

    const runtime = createCatalogProviderAcpRuntime({
      provider: 'claude',
      loggerLabel: 'ClaudeACP',
      directory: '/tmp/project',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      createBackend: async () => backend,
      hooks: {
        classifyRuntimeAuthFailure,
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
      detail: {
        name: 'NativeClaudeUsageLimit',
      },
    } as unknown as AgentMessage);

    await vi.waitFor(() => {
      expect(classifyRuntimeAuthFailure).toHaveBeenCalledOnce();
      const turnFailed = runtimeEvents.find((event) => event.kind === 'turn-failed');
      expect(turnFailed?.issue.usageLimit).toMatchObject({
        recoverability: 'wait',
        providerLimitId: 'five_hour',
      });
      expect(turnFailed?.issue.usageLimit?.connectedService).toBeUndefined();
    });
    expect(notifyDaemonConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();
  });

  it('does not report daemon recovery when a caller runtime-auth hook throws without connected-service recovery context', async () => {
    notifyDaemonConnectedServiceRuntimeAuthFailure.mockClear();
    notifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValueOnce({
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
    });
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'opencode-session-1' });
    const session = createMutableApiSessionClientFixture({
      overrides: {
        sessionId: 'happy-session-1',
      },
    });
    const runtimeEvents: RuntimeEventV1[] = [];
    const classifyRuntimeAuthFailure = vi.fn(async () => ({
      kind: 'usage_limit',
      serviceId: 'openai',
      profileId: null,
      groupId: null,
      resetsAtMs: 2_500,
      retryAfterMs: 2_500,
      planType: null,
      providerLimitId: null,
      quotaScope: 'account',
      action: null,
      rateLimits: null,
      source: 'structured_provider_error',
    }));
    const callerRuntimeAuthHook = vi.fn(async () => {
      throw new Error('caller hook failed');
    });

    const runtime = createCatalogProviderAcpRuntime({
      provider: 'opencode',
      loggerLabel: 'OpenCodeACP',
      directory: '/tmp/project',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      createBackend: async () => backend,
      hooks: {
        classifyRuntimeAuthFailure,
        onRuntimeAuthFailure: callerRuntimeAuthHook,
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
      detail: {
        name: 'FreeUsageLimitError',
        serviceId: 'openai',
        headers: { 'retry-after-ms': '2500' },
      },
    } as unknown as AgentMessage);

    await vi.waitFor(() => {
      expect(classifyRuntimeAuthFailure).toHaveBeenCalledOnce();
      expect(callerRuntimeAuthHook).toHaveBeenCalledOnce();
    });
    expect(notifyDaemonConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      const turnFailed = runtimeEvents.find((event) => event.kind === 'turn-failed');
      expect(turnFailed?.issue.usageLimit).toMatchObject({
        recoverability: 'wait',
      });
      expect(turnFailed?.issue.usageLimit?.connectedService).toBeUndefined();
    });
  });

  it('does not duplicate daemon-owned exhausted recovery metadata in the provider runtime', async () => {
    notifyDaemonConnectedServiceRuntimeAuthFailure.mockClear();
    notifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValueOnce({
      ok: true,
      result: {
        status: 'switch_attempted',
        result: {
          status: 'no_eligible_member',
        },
      },
    });
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'opencode-session-1' });
    const session = createMutableApiSessionClientFixture({
      overrides: {
        sessionId: 'happy-session-1',
      },
    });
    const classifyRuntimeAuthFailure = vi.fn(async () => ({
      kind: 'usage_limit',
      serviceId: 'openai',
      profileId: 'primary',
      groupId: 'main',
      connectedServiceRecovery: 'available',
      limitCategory: 'usage_limit',
      resetsAtMs: 2_500,
      retryAfterMs: 2_500,
      planType: null,
      rateLimits: null,
      source: 'structured_provider_error',
    }));

    const runtime = createCatalogProviderAcpRuntime({
      provider: 'opencode',
      loggerLabel: 'OpenCodeACP',
      directory: '/tmp/project',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      createBackend: async () => backend,
      hooks: {
        classifyRuntimeAuthFailure,
      },
    });

    await runtime.sendTurnPrompt('session setup');
    runtime.beginTurn();

    backend.emit({
      type: 'status',
      status: 'error',
      detail: {
        name: 'SyntheticRuntimeAuthError',
      },
    } as unknown as AgentMessage);

    await vi.waitFor(() => {
      expect(classifyRuntimeAuthFailure).toHaveBeenCalledOnce();
      expect(notifyDaemonConnectedServiceRuntimeAuthFailure).toHaveBeenCalledOnce();
    });
    expect(session.__getMetadata()).toBeNull();
  });

  it('settles the turn before async daemon recovery and does not re-emit its transcript event', async () => {
    notifyDaemonConnectedServiceRuntimeAuthFailure.mockClear();
    const daemonClassification = {
      kind: 'usage_limit',
      serviceId: 'openai',
      profileId: 'primary',
      groupId: 'main',
      connectedServiceRecovery: 'available',
      limitCategory: 'usage_limit',
      resetsAtMs: null,
      retryAfterMs: null,
      planType: null,
      rateLimits: null,
      source: 'structured_provider_error',
    } as const;
    const scheduled = buildRuntimeAuthRecoveryScheduledResult({
      classification: daemonClassification,
      recovery: {
        status: 'scheduled',
        retryable: true,
        attemptCount: 1,
        maxAttempts: 3,
        nextRetryAtMs: 2_500,
      },
    });
    let resolveDaemonRecovery!: (value: unknown) => void;
    notifyDaemonConnectedServiceRuntimeAuthFailure.mockImplementationOnce(async () =>
      await new Promise((resolve) => {
        resolveDaemonRecovery = resolve;
      })
    );
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'opencode-session-1' });
    const sendSessionEvent = vi.fn();
    const session = createMutableApiSessionClientFixture({
      overrides: {
        sessionId: 'happy-session-1',
        sendSessionEvent,
      },
    });
    const messageBuffer = new MessageBuffer();
    const runtimeEvents: RuntimeEventV1[] = [];
    const classifyRuntimeAuthFailure = vi.fn(async () => daemonClassification);

    const runtime = createCatalogProviderAcpRuntime({
      provider: 'opencode',
      loggerLabel: 'OpenCodeACP',
      directory: '/tmp/project',
      session,
      messageBuffer,
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      createBackend: async () => backend,
      hooks: {
        classifyRuntimeAuthFailure,
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
      detail: {
        name: 'SyntheticRuntimeAuthError',
      },
    } as unknown as AgentMessage);

    await vi.waitFor(() => {
      expect(classifyRuntimeAuthFailure).toHaveBeenCalledOnce();
      expect(runtimeEvents.some((event) => event.kind === 'turn-failed')).toBe(true);
      expect(notifyDaemonConnectedServiceRuntimeAuthFailure).toHaveBeenCalledOnce();
    });
    resolveDaemonRecovery({
      ok: true,
      result: scheduled,
    });
    await vi.waitFor(() => {
      expect(messageBuffer.getMessages().some((message) =>
        message.type === 'status'
        && message.content === 'Connected-service recovery hit a temporary provider failure; retry scheduled.'
      )).toBe(true);
    });
    expect(sendSessionEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'connected-service-runtime-auth-recovery',
    }));
    await flushAsyncRuntimeHandlers();
    expect(runtimeEvents.filter((event) => event.kind === 'turn-failed')).toHaveLength(1);
  });

  it('surfaces a turn failure when connected-service runtime-auth recovery requires user action', async () => {
    notifyDaemonConnectedServiceRuntimeAuthFailure.mockClear();
    notifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValueOnce({
      ok: true,
      result: {
        status: 'recovery_action_required',
        action: {
          kind: 'reconnect_profile',
          profileId: 'primary',
        },
      },
    });
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'opencode-session-1' });
    const session = createMutableApiSessionClientFixture({
      overrides: {
        sessionId: 'happy-session-1',
      },
    });
    const messageBuffer = new MessageBuffer();
    const runtimeEvents: RuntimeEventV1[] = [];
    const classifyRuntimeAuthFailure = vi.fn(async () => ({
      kind: 'auth_expired',
      serviceId: 'openai',
      profileId: 'primary',
      groupId: 'main',
      connectedServiceRecovery: 'available',
      limitCategory: null,
      resetsAtMs: null,
      retryAfterMs: null,
      planType: null,
      rateLimits: null,
      source: 'structured_provider_error',
    }));

    const runtime = createCatalogProviderAcpRuntime({
      provider: 'opencode',
      loggerLabel: 'OpenCodeACP',
      directory: '/tmp/project',
      session,
      messageBuffer,
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      createBackend: async () => backend,
      hooks: {
        classifyRuntimeAuthFailure,
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
      detail: {
        name: 'SyntheticRuntimeAuthError',
      },
    } as unknown as AgentMessage);

    await vi.waitFor(() => {
      expect(classifyRuntimeAuthFailure).toHaveBeenCalledOnce();
      const turnFailed = runtimeEvents.find((event) => event.kind === 'turn-failed');
      expect(turnFailed?.issue.source).toBe('auth_error');
    });
  });

  it('suppresses duplicate identical runtime-auth recovery transcript projections for repeated exhausted retries', async () => {
    notifyDaemonConnectedServiceRuntimeAuthFailure.mockClear();
    notifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValue({
      ok: true,
      result: {
        status: 'switch_attempted',
        result: {
          status: 'no_eligible_member',
        },
      },
    });
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'opencode-session-1' });
    const session = createMutableApiSessionClientFixture({
      overrides: {
        sessionId: 'happy-session-1',
      },
    });
    const messageBuffer = new MessageBuffer();
    const classifyRuntimeAuthFailure = vi.fn(async () => ({
      kind: 'usage_limit',
      serviceId: 'openai',
      profileId: 'primary',
      groupId: 'main',
      connectedServiceRecovery: 'available',
      limitCategory: 'usage_limit',
      resetsAtMs: 2_500,
      retryAfterMs: 2_500,
      planType: null,
      rateLimits: null,
      source: 'structured_provider_error',
    }));

    const runtime = createCatalogProviderAcpRuntime({
      provider: 'opencode',
      loggerLabel: 'OpenCodeACP',
      directory: '/tmp/project',
      session,
      messageBuffer,
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      createBackend: async () => backend,
      hooks: {
        classifyRuntimeAuthFailure,
      },
    });

    await runtime.sendTurnPrompt('session setup');
    runtime.beginTurn();

    const errorEvent = {
      type: 'status',
      status: 'error',
      detail: {
        name: 'SyntheticRuntimeAuthError',
      },
    } as unknown as AgentMessage;

    backend.emit(errorEvent);
    backend.emit(errorEvent);

    await vi.waitFor(() => {
      expect(classifyRuntimeAuthFailure).toHaveBeenCalledTimes(2);
      expect(messageBuffer.getMessages().filter((message) =>
        message.type === 'status'
        && message.content === 'Connected-service account group has no eligible fallback account; waiting for group recovery.'
      )).toHaveLength(1);
    });
  });

  it('suppresses duplicate projections when only Date.now-derived volatile fields differ between triggers', async () => {
    // Incident Jun-11 H-C: retryAfterMs (and the statusMessage derived from it) is recomputed
    // from Date.now() per trigger, so two observations of the SAME failure carry different
    // volatile fields. The deduper must match on stable identity only.
    notifyDaemonConnectedServiceRuntimeAuthFailure.mockClear();
    notifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValue({
      ok: true,
      result: {
        status: 'switch_attempted',
        result: {
          status: 'no_eligible_member',
        },
      },
    });
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'opencode-session-1' });
    const session = createMutableApiSessionClientFixture({
      overrides: {
        sessionId: 'happy-session-1',
      },
    });
    const messageBuffer = new MessageBuffer();
    let classifyCalls = 0;
    const classifyRuntimeAuthFailure = vi.fn(async () => {
      classifyCalls += 1;
      return {
        kind: 'usage_limit',
        serviceId: 'openai',
        profileId: 'primary',
        groupId: 'main',
        connectedServiceRecovery: 'available',
        limitCategory: 'usage_limit',
        resetsAtMs: 2_500,
        // Volatile per-trigger field: shrinks between observations of the same failure.
        retryAfterMs: 2_500 - classifyCalls * 137,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      };
    });

    const runtime = createCatalogProviderAcpRuntime({
      provider: 'opencode',
      loggerLabel: 'OpenCodeACP',
      directory: '/tmp/project',
      session,
      messageBuffer,
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      createBackend: async () => backend,
      hooks: {
        classifyRuntimeAuthFailure,
      },
    });

    await runtime.sendTurnPrompt('session setup');
    runtime.beginTurn();

    const errorEvent = {
      type: 'status',
      status: 'error',
      detail: {
        name: 'SyntheticRuntimeAuthError',
      },
    } as unknown as AgentMessage;

    backend.emit(errorEvent);
    backend.emit(errorEvent);

    await vi.waitFor(() => {
      expect(classifyRuntimeAuthFailure).toHaveBeenCalledTimes(2);
      expect(messageBuffer.getMessages().filter((message) =>
        message.type === 'status'
        && message.content === 'Connected-service account group has no eligible fallback account; waiting for group recovery.'
      )).toHaveLength(1);
    });
  });
});
