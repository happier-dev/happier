import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentMessage } from '@/agent/core/AgentMessage';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { RuntimeEventV1Schema, SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY, type RuntimeEventV1 } from '@happier-dev/protocol';
import {
  CONNECTED_SERVICE_RUNTIME_AUTH_FAILURE_REPORT_TIMEOUT_MS,
  resetConnectedServiceRuntimeAuthFailureReportDedupeForTests,
} from '@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon';
import { createCatalogProviderAcpRuntime } from '../createProviderAcpRuntime';

const notifyDaemonConnectedServiceRuntimeAuthFailure = vi.hoisted(() =>
  vi.fn<(_input: unknown, _options?: unknown) => Promise<unknown>>(async () => ({ ok: true }))
);

vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/daemon/controlClient')>()),
  notifyDaemonConnectedServiceRuntimeAuthFailure,
}));

describe('createCatalogProviderAcpRuntime (runtime auth failures)', () => {
  beforeEach(() => {
    // Cases reuse the same sessionId/classification; clear the shared report-path
    // stable-key dedupe window between them.
    resetConnectedServiceRuntimeAuthFailureReportDedupeForTests();
  });

  it('uses provider connected-service adapters to notify the daemon from ACP status errors', async () => {
    notifyDaemonConnectedServiceRuntimeAuthFailure.mockClear();
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'opencode-session-1' });
    const session = createMutableApiSessionClientFixture({
      overrides: {
        sessionId: 'happy-session-1',
      },
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
    });

    await runtime.startOrLoad({});
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
      expect(notifyDaemonConnectedServiceRuntimeAuthFailure).toHaveBeenCalledWith({
        sessionId: 'happy-session-1',
        switchesThisTurn: 0,
        classification: expect.objectContaining({
          kind: 'usage_limit',
          serviceId: 'openai',
          retryAfterMs: 2500,
          source: 'structured_provider_error',
        }),
      }, {
        timeoutMs: CONNECTED_SERVICE_RUNTIME_AUTH_FAILURE_REPORT_TIMEOUT_MS,
      });
    });
  });

  it('notifies daemon recovery when a caller runtime-auth hook throws', async () => {
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
        onRuntimeAuthFailure: callerRuntimeAuthHook,
      },
    });
    runtime.subscribeRuntimeEvents((message) => {
      runtimeEvents.push(RuntimeEventV1Schema.parse(message));
    });

    await runtime.startOrLoad({});
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
      expect(callerRuntimeAuthHook).toHaveBeenCalledOnce();
      expect(notifyDaemonConnectedServiceRuntimeAuthFailure).toHaveBeenCalledWith({
        sessionId: 'happy-session-1',
        switchesThisTurn: 0,
        classification: expect.objectContaining({
          kind: 'usage_limit',
          serviceId: 'openai',
        }),
      }, {
        timeoutMs: CONNECTED_SERVICE_RUNTIME_AUTH_FAILURE_REPORT_TIMEOUT_MS,
      });
    });
    await vi.waitFor(() => {
      const turnFailed = runtimeEvents.find((event) => event.kind === 'turn-failed');
      expect(turnFailed?.issue.usageLimit).toMatchObject({
        recoveryDecision: 'manual_intervention',
        connectedService: {
          serviceId: 'openai',
        },
      });
    });
  });

  it('projects exhausted usage-limit recovery metadata from daemon group-fallback results', async () => {
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

    await runtime.startOrLoad({});
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
      expect(session.__getMetadata()).toMatchObject({
        [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: {
          status: 'exhausted',
          lastProbeError: 'no_eligible_member',
          selectedAuth: {
            kind: 'group',
            serviceId: 'openai',
            groupId: 'main',
            profileId: 'primary',
          },
        },
      });
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

    await runtime.startOrLoad({});
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

    await runtime.startOrLoad({});
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
