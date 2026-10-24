import { afterEach, describe, expect, it, vi } from 'vitest';

import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { resetConnectedServiceRuntimeAuthFailureReportDedupeForTests } from '@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon';

import { PiRpcBackend } from './PiRpcBackend';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import type { SessionTurnMutationV1 } from '@/api/session/mutations/sessionMutationTypes';
import { createTestAcpRuntime } from '@/testkit/backends/acpRuntime';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

const mockNotifyDaemonConnectedServiceRuntimeAuthFailure = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('@/daemon/controlClient', () => ({
  notifyDaemonConnectedServiceRuntimeAuthFailure: mockNotifyDaemonConnectedServiceRuntimeAuthFailure,
}));

type PrivateStderrBackend = {
  currentModelProvider: string | null;
  pendingTurn: unknown;
  handleStderrLine(line: string): void;
  reportPiRuntimeAuthFailureToDaemon(classification: unknown): Promise<void>;
};

function createScheduledRuntimeAuthRecoveryReport(input: Readonly<{ includeTranscriptEvent?: boolean }> = {}) {
  const diagnostic = {
    code: 'recovery_retry_scheduled',
    failurePhase: 'runtime_auth_recovery',
    source: 'runtime_auth_recovery',
    serviceId: 'openai-codex',
    profileId: 'codex1',
    retryable: true,
    suggestedActions: [],
    diagnostics: { runtimeFailureKind: 'usage_limit' },
  };
  const transcriptEvent = {
    type: 'connected-service-runtime-auth-recovery',
    status: 'retry_scheduled',
    serviceId: 'openai-codex',
    profileId: 'codex1',
    nextRetryAtMs: 1_700_000_100_000,
    terminal: false,
    diagnostic,
  };
  return {
    ok: true,
    result: {
      status: 'recovery_retry_scheduled',
      recovery: {
        status: 'scheduled',
        retryable: true,
        nextRetryAtMs: 1_700_000_100_000,
      },
      uxDiagnostic: diagnostic,
      ...(input.includeTranscriptEvent === false ? {} : { transcriptEvent }),
    },
  };
}

function createPendingTurnForTest(): unknown {
  return { stderrRuntimeAuthReportedKeys: new Set<string>() };
}

function createBackendWithSelection(): PiRpcBackend {
  return new PiRpcBackend({
    cwd: '/tmp',
    command: 'pi',
    args: [],
    env: {
      [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
        { kind: 'profile', serviceId: 'openai-codex', profileId: 'codex1' },
      ]),
    },
    happierSessionId: 'sess_pi_1',
  });
}

describe('PiRpcBackend stderr runtime-auth detection', () => {
  afterEach(() => {
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockReset();
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValue({});
    // The shared daemon-report path dedupes on stable identity; tests reuse session ids and
    // classifications across cases, so the window must not leak between tests.
    resetConnectedServiceRuntimeAuthFailureReportDedupeForTests();
  });

  it('reports a usage limit that surfaces only on stderr during an active turn', () => {
    const backend = createBackendWithSelection();
    const priv = backend as unknown as PrivateStderrBackend;
    priv.currentModelProvider = 'openai';
    priv.pendingTurn = createPendingTurnForTest();
    const reportSpy = vi.spyOn(priv, 'reportPiRuntimeAuthFailureToDaemon').mockResolvedValue(undefined);
    const messages: unknown[] = [];
    backend.onMessage((message) => messages.push(message));

    priv.handleStderrLine('ERROR: usage limit reached for this account (resource_exhausted)');

    expect(reportSpy).toHaveBeenCalledTimes(1);
    expect(reportSpy.mock.calls[0]?.[0]).toMatchObject({ kind: 'usage_limit', serviceId: 'openai-codex' });
    expect(messages.some((message) => {
      const typed = message as { type?: string; status?: string };
      return typed.type === 'status' && typed.status === 'error';
    })).toBe(false);
  });

  it('does not terminalize an active turn from auth-looking stderr diagnostics', () => {
    const backend = createBackendWithSelection();
    const priv = backend as unknown as PrivateStderrBackend;
    priv.currentModelProvider = 'openai';
    priv.pendingTurn = createPendingTurnForTest();
    const messages: unknown[] = [];
    backend.onMessage((message) => messages.push(message));

    priv.handleStderrLine('authentication state refreshed for pi');

    expect(messages.some((message) => {
      const typed = message as { type?: string; status?: string };
      return typed.type === 'status' && typed.status === 'error';
    })).toBe(false);
    expect(messages.some((message) => {
      const typed = message as { type?: string };
      return typed.type === 'terminal-output';
    })).toBe(true);
  });

  it('does not report ordinary stderr noise', () => {
    const backend = createBackendWithSelection();
    const priv = backend as unknown as PrivateStderrBackend;
    priv.currentModelProvider = 'openai';
    priv.pendingTurn = createPendingTurnForTest();
    const reportSpy = vi.spyOn(priv, 'reportPiRuntimeAuthFailureToDaemon').mockResolvedValue(undefined);

    priv.handleStderrLine('[pi] info: streaming response chunk 12');
    priv.handleStderrLine('debug: connected to provider endpoint');

    expect(reportSpy).not.toHaveBeenCalled();
  });

  it('does not report a stderr usage limit when no turn is in flight', () => {
    const backend = createBackendWithSelection();
    const priv = backend as unknown as PrivateStderrBackend;
    priv.currentModelProvider = 'openai';
    priv.pendingTurn = null;
    const reportSpy = vi.spyOn(priv, 'reportPiRuntimeAuthFailureToDaemon').mockResolvedValue(undefined);

    priv.handleStderrLine('ERROR: usage limit reached for this account');

    expect(reportSpy).not.toHaveBeenCalled();
  });

  it('debounces a multi-line usage-limit episode into a single report', () => {
    const backend = createBackendWithSelection();
    const priv = backend as unknown as PrivateStderrBackend;
    priv.currentModelProvider = 'openai';
    priv.pendingTurn = createPendingTurnForTest();
    const reportSpy = vi.spyOn(priv, 'reportPiRuntimeAuthFailureToDaemon').mockResolvedValue(undefined);

    priv.handleStderrLine('ERROR: usage limit reached for this account');
    priv.handleStderrLine('ERROR: usage limit reached (retry later)');

    expect(reportSpy).toHaveBeenCalledTimes(1);
  });

  it('detects machine-readable usage-limit stderr markers', () => {
    const backend = createBackendWithSelection();
    const priv = backend as unknown as PrivateStderrBackend;
    priv.currentModelProvider = 'openai';
    priv.pendingTurn = createPendingTurnForTest();
    const reportSpy = vi.spyOn(priv, 'reportPiRuntimeAuthFailureToDaemon').mockResolvedValue(undefined);

    priv.handleStderrLine('{"type":"usage_limit_reached"}');

    expect(reportSpy).toHaveBeenCalledTimes(1);
    expect(reportSpy.mock.calls[0]?.[0]).toMatchObject({ kind: 'usage_limit', serviceId: 'openai-codex' });
  });

  it('detects structured 429 stderr without rate-limit wording', () => {
    const backend = createBackendWithSelection();
    const priv = backend as unknown as PrivateStderrBackend;
    priv.currentModelProvider = 'openai';
    priv.pendingTurn = createPendingTurnForTest();
    const reportSpy = vi.spyOn(priv, 'reportPiRuntimeAuthFailureToDaemon').mockResolvedValue(undefined);

    priv.handleStderrLine('{"status":429}');

    expect(reportSpy).toHaveBeenCalledTimes(1);
    expect(reportSpy.mock.calls[0]?.[0]).toMatchObject({ kind: 'rate_limit', serviceId: 'openai-codex' });
  });

  it('detects nested structured 429 stderr without rate-limit wording', () => {
    const backend = createBackendWithSelection();
    const priv = backend as unknown as PrivateStderrBackend;
    priv.currentModelProvider = 'openai';
    priv.pendingTurn = createPendingTurnForTest();
    const reportSpy = vi.spyOn(priv, 'reportPiRuntimeAuthFailureToDaemon').mockResolvedValue(undefined);

    priv.handleStderrLine('{"error":{"status":429}}');

    expect(reportSpy).toHaveBeenCalledTimes(1);
    expect(reportSpy.mock.calls[0]?.[0]).toMatchObject({ kind: 'rate_limit', serviceId: 'openai-codex' });
  });

  it('detects nested structured 429 stderr inside JSON-RPC wrappers', () => {
    const backend = createBackendWithSelection();
    const priv = backend as unknown as PrivateStderrBackend;
    priv.currentModelProvider = 'openai';
    priv.pendingTurn = createPendingTurnForTest();
    const reportSpy = vi.spyOn(priv, 'reportPiRuntimeAuthFailureToDaemon').mockResolvedValue(undefined);

    priv.handleStderrLine('{"error":{"code":-32603,"message":"Internal error","data":{"status":429}}}');

    expect(reportSpy).toHaveBeenCalledTimes(1);
    expect(reportSpy.mock.calls[0]?.[0]).toMatchObject({ kind: 'rate_limit', serviceId: 'openai-codex' });
  });

  it('detects plain HTTP 429 stderr as a rate limit', () => {
    const backend = createBackendWithSelection();
    const priv = backend as unknown as PrivateStderrBackend;
    priv.currentModelProvider = 'openai';
    priv.pendingTurn = createPendingTurnForTest();
    const reportSpy = vi.spyOn(priv, 'reportPiRuntimeAuthFailureToDaemon').mockResolvedValue(undefined);

    priv.handleStderrLine('HTTP 429');

    expect(reportSpy).toHaveBeenCalledTimes(1);
    expect(reportSpy.mock.calls[0]?.[0]).toMatchObject({ kind: 'rate_limit', serviceId: 'openai-codex' });
  });

  it('detects structured usage-limit marker names without spaces or underscores', () => {
    const backend = createBackendWithSelection();
    const priv = backend as unknown as PrivateStderrBackend;
    priv.currentModelProvider = 'openai';
    priv.pendingTurn = createPendingTurnForTest();
    const reportSpy = vi.spyOn(priv, 'reportPiRuntimeAuthFailureToDaemon').mockResolvedValue(undefined);

    priv.handleStderrLine('{"type":"FreeUsageLimitError"}');

    expect(reportSpy).toHaveBeenCalledTimes(1);
    expect(reportSpy.mock.calls[0]?.[0]).toMatchObject({ kind: 'usage_limit', serviceId: 'openai-codex' });
  });

  it('detects nested JSON-RPC usage-limit markers', () => {
    const backend = createBackendWithSelection();
    const priv = backend as unknown as PrivateStderrBackend;
    priv.currentModelProvider = 'openai';
    priv.pendingTurn = createPendingTurnForTest();
    const reportSpy = vi.spyOn(priv, 'reportPiRuntimeAuthFailureToDaemon').mockResolvedValue(undefined);

    priv.handleStderrLine('{"code":-32603,"message":"Internal error","data":{"codex_error_info":"usage_limit_exceeded"}}');

    expect(reportSpy).toHaveBeenCalledTimes(1);
    expect(reportSpy.mock.calls[0]?.[0]).toMatchObject({ kind: 'usage_limit', serviceId: 'openai-codex' });
  });

  it('does not re-emit daemon typed runtime-auth recovery projection after reporting stderr runtime auth failure', async () => {
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValueOnce(createScheduledRuntimeAuthRecoveryReport());
    const backend = createBackendWithSelection();
    const priv = backend as unknown as PrivateStderrBackend;
    const messages: unknown[] = [];
    backend.onMessage((message) => messages.push(message));

    await priv.reportPiRuntimeAuthFailureToDaemon({
      kind: 'usage_limit',
      serviceId: 'openai-codex',
      profileId: 'codex1',
      groupId: null,
      resetsAtMs: null,
      planType: null,
      rateLimits: null,
      source: 'structured_provider_error',
    });

    expect(messages).not.toContainEqual(expect.objectContaining({
      type: 'event',
      name: 'connected-service-runtime-auth-recovery',
    }));
  });

  it('keeps retry-scheduled diagnostic fallback out of terminal turn status', async () => {
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValueOnce(
      createScheduledRuntimeAuthRecoveryReport({ includeTranscriptEvent: false }),
    );
    const backend = createBackendWithSelection();
    const priv = backend as unknown as PrivateStderrBackend;
    const messages: unknown[] = [];
    backend.onMessage((message) => messages.push(message));
    const transport = createFakeAcpRuntimeBackend();
    backend.onMessage((message) => transport.emit(message));
    const mutations: SessionTurnMutationV1[] = [];
    const sessionTurnLifecycle = createSessionTurnLifecycle({ sessionId: 'pi-diagnostic-fallback',
      enqueueSessionTurn: async (mutation) => { mutations.push(mutation); } });
    const runtime = createTestAcpRuntime({ provider: 'pi', directory: '/tmp',
      session: { ...createBasicSessionClientWithOverrides({ sendAgentMessage: (provider, body) => {
        void sessionTurnLifecycle.observeAcpLifecycleMarker({ provider, body }).pendingWrite;
      } }), sessionTurnLifecycle }, messageBuffer: new MessageBuffer(), mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(), onThinkingChange: () => {},
      ensureBackend: async () => transport });
    await runtime.startOrLoad({ resumeId: null });
    runtime.beginTurn();
    transport.emit({ type: 'status', status: 'running' });

    await priv.reportPiRuntimeAuthFailureToDaemon({
      kind: 'usage_limit',
      serviceId: 'openai-codex',
      profileId: 'codex1',
      groupId: null,
      resetsAtMs: null,
      planType: null,
      rateLimits: null,
      source: 'structured_provider_error',
    });

    await runtime.flushTurn();
    expect(mutations.filter((mutation) => mutation.action === 'fail')).toEqual([]);
    expect(messages).toContainEqual({
      type: 'terminal-output',
      data: expect.stringContaining('retry scheduled'),
    });
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'status', status: 'error' }));
    await runtime.reset();
  });

  it('detects plain stderr usage-limit marker names', () => {
    const backend = createBackendWithSelection();
    const priv = backend as unknown as PrivateStderrBackend;
    priv.currentModelProvider = 'openai';
    priv.pendingTurn = createPendingTurnForTest();
    const reportSpy = vi.spyOn(priv, 'reportPiRuntimeAuthFailureToDaemon').mockResolvedValue(undefined);

    priv.handleStderrLine('FreeUsageLimitError');

    expect(reportSpy).toHaveBeenCalledTimes(1);
    expect(reportSpy.mock.calls[0]?.[0]).toMatchObject({ kind: 'usage_limit', serviceId: 'openai-codex' });
  });

  it('detects rate-limit marker names without prose', () => {
    const backend = createBackendWithSelection();
    const priv = backend as unknown as PrivateStderrBackend;
    priv.currentModelProvider = 'openai';
    priv.pendingTurn = createPendingTurnForTest();
    const reportSpy = vi.spyOn(priv, 'reportPiRuntimeAuthFailureToDaemon').mockResolvedValue(undefined);

    priv.handleStderrLine('{"type":"rate_limit_error"}');
    priv.pendingTurn = createPendingTurnForTest();
    priv.handleStderrLine('RateLimitError');

    expect(reportSpy).toHaveBeenCalledTimes(2);
    expect(reportSpy.mock.calls[0]?.[0]).toMatchObject({ kind: 'rate_limit', serviceId: 'openai-codex' });
    expect(reportSpy.mock.calls[1]?.[0]).toMatchObject({ kind: 'rate_limit', serviceId: 'openai-codex' });
  });

  it('does not report bare quota diagnostics without exhaustion wording', () => {
    const backend = createBackendWithSelection();
    const priv = backend as unknown as PrivateStderrBackend;
    priv.currentModelProvider = 'openai';
    priv.pendingTurn = createPendingTurnForTest();
    const reportSpy = vi.spyOn(priv, 'reportPiRuntimeAuthFailureToDaemon').mockResolvedValue(undefined);

    priv.handleStderrLine('quota telemetry snapshot refreshed');
    priv.handleStderrLine('quota limit: 100000 remaining: 95000');

    expect(reportSpy).not.toHaveBeenCalled();
  });

  it('reports the same stderr usage limit again on a later pending turn', () => {
    const backend = createBackendWithSelection();
    const priv = backend as unknown as PrivateStderrBackend;
    priv.currentModelProvider = 'openai';
    const reportSpy = vi.spyOn(priv, 'reportPiRuntimeAuthFailureToDaemon').mockResolvedValue(undefined);

    priv.pendingTurn = createPendingTurnForTest();
    priv.handleStderrLine('ERROR: usage limit reached for this account');
    priv.pendingTurn = createPendingTurnForTest();
    priv.handleStderrLine('ERROR: usage limit reached for this account');

    expect(reportSpy).toHaveBeenCalledTimes(2);
  });
});
