import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubIssuedFetch } from '@/testkit/http/stubIssuedFetch';

vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readDaemonState: vi.fn(async () => ({
    pid: process.pid,
    httpPort: 43_210,
    controlToken: 'test-control-token',
  })),
}));

import {
  admitDaemonExecutionRunStart,
  requestExecutionRunConnectedServicesMaterialization,
  requestExecutionRunConnectedServiceRuntimeAuthRefresh,
  resolveExecutionRunConnectedServiceMaterializeTimeoutMs,
} from './controlClient';
import { deriveConnectedServiceRunMaterializeToken } from './connectedServices/runs/capabilityToken';
import { readDaemonState } from '@/persistence';
import { logger } from '@/ui/logger';
import { buildConnectedServiceCredentialSpawnErrorResult } from './connectedServices/diagnostics/buildConnectedServiceDiagnosticSpawnErrorResult';
import { ConnectedServiceSpawnProfileActionRequiredError } from './connectedServices/resolveConnectedServiceAuthForSpawn';
import { resolveExecutionRunConnectedServicesEnv } from '@/agent/runtime/bridges/executionRun/runtime/connectedServicesEnv';
import { createLazyExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/hostRuntime/lazy';
import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import { startExecutionRun } from '@/agent/runtime/bridges/executionRun/startExecutionRun';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { ExecutionRunErrorSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('execution Run daemon admission transport', () => {
  it('reads current scoped admission on each start and refuses missing or drained authority', async () => {
    let decision: unknown = { admitted: true };
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      expect(url).toContain('/execution-run/admission');
      expect(init?.headers).toMatchObject({ 'x-happier-daemon-token': deriveConnectedServiceRunMaterializeToken('test-control-token') });
      return new Response(JSON.stringify(decision), { status: 200 });
    });
    await expect(admitDaemonExecutionRunStart()).resolves.toBeUndefined();
    decision = { admitted: false, reason: 'daemon_draining' };
    await expect(admitDaemonExecutionRunStart()).rejects.toMatchObject({ code: 'daemon_draining' });
    decision = { admitted: true };
    await expect(admitDaemonExecutionRunStart()).resolves.toBeUndefined();
    decision = {};
    await expect(admitDaemonExecutionRunStart()).rejects.toMatchObject({ code: 'daemon_admission_unavailable' });
  });
});

describe('execution Run runtime auth refresh transport', () => {
  const request = { runId: 'run-1', runnerPid: process.pid, activationId: '11111111-1111-4111-8111-111111111111',
    serviceId: 'openai-codex', refreshAttemptId: 'attempt-1', expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    selection: { kind: 'group', serviceId: 'openai-codex', groupId: 'pool', activeProfileId: 'member',
      fallbackProfileId: 'fallback', generation: 7, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', policy: { privateHint: true } } };

  it('uses scoped authority, projects selected identity and preserves the caller admission budget', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => { expect(ms).toBe(120_000); return new AbortController().signal; });
    const requests: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ ok: true, result: { status: 'pending', refreshAttemptId: 'attempt-1' } }), { status: 200 });
    });
    await expect(requestExecutionRunConnectedServiceRuntimeAuthRefresh(request, { timeoutMs: 120_000 }))
      .resolves.toEqual({ status: 'pending', refreshAttemptId: 'attempt-1' });
    expect(requests[0]?.url).toContain('/connected-service-run/refresh-runtime-auth');
    expect(requests[0]?.init?.headers).toMatchObject({ 'x-happier-daemon-token': deriveConnectedServiceRunMaterializeToken('test-control-token') });
    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body.selection).toEqual({ kind: 'group', serviceId: 'happier.agent.codex/openai-codex', groupId: 'pool',
      activeProfileId: 'member', fallbackProfileId: 'fallback', generation: 7 });
    expect(body.expectedCredentialRevision).toBe(request.expectedCredentialRevision);
    expect(JSON.stringify(body)).not.toContain('privateHint');
  });

  it('keeps the same refresh attempt pending when the issued HTTP request times out', async () => {
    vi.stubGlobal('fetch', async () => { throw new DOMException('The operation timed out', 'TimeoutError'); });
    await expect(requestExecutionRunConnectedServiceRuntimeAuthRefresh(request, { timeoutMs: 120_000 }))
      .resolves.toEqual({ status: 'pending', refreshAttemptId: 'attempt-1' });
  });
});

describe('resolveExecutionRunConnectedServiceMaterializeTimeoutMs', () => {
  const materializeRequest = {
    runId: 'run-1', runnerPid: process.pid, agentId: 'codex', cwd: '/tmp/workspace',
    connectedServices: { v: 2 as const, bindingsByServiceId: {
      'happier.agent.codex/openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: 'work' },
    } },
  };
  const foreignActivationId = '22222222-2222-4222-8222-222222222222';
  it('carries a daemon profile-action refusal through Voice Run start without retrying', async () => {
    const ownerResult = buildConnectedServiceCredentialSpawnErrorResult({ agentId: 'codex',
      error: new ConnectedServiceSpawnProfileActionRequiredError({
        serviceId: 'happier.agent.codex/openai-codex', profileId: 'work', status: 'needs_reauth',
      }),
    });
    if (ownerResult?.errorDetail?.kind !== 'connected_service_ux_diagnostic') throw new Error('Expected owner diagnostic');
    const uxDiagnostic = ownerResult.errorDetail.uxDiagnostic;
    const paths: string[] = [];
    // Substitute only daemon HTTP. Client parsing, Run credential resolution,
    // lazy startup, Voice adaptation and the public terminal error stay real.
    vi.stubGlobal('fetch', async (url: string) => {
      const path = new URL(url).pathname;
      paths.push(path);
      if (path.endsWith('/release')) return new Response(JSON.stringify({ ok: true, released: false }));
      if (path.endsWith('/materialize')) return new Response(JSON.stringify({ ok: false,
        errorCode: 'connected_service_run_materialization_blocked', errorMessage: uxDiagnostic.code, uxDiagnostic,
      }), { status: 403 });
      throw new Error('Unexpected daemon HTTP request');
    });
    const createRuntime = () => createLazyExecutionRunHostRuntime({ resolveRuntime: async () => {
      await resolveExecutionRunConnectedServicesEnv({ runId: 'voice-profile-refusal', backendId: 'codex',
        backendSourceKind: 'built_in', connectedServices: materializeRequest.connectedServices, cwd: '/repo',
      });
      throw new Error('A refused profile cannot create an Agent runtime');
    } });
    const voiceAgentManager = new VoiceAgentManager({ createRuntime });
    const selection = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'voice-chat' };
    let terminalError: ExecutionRunState['error'];
    try {
      await startExecutionRun({
        params: { sessionId: 'parent_session_1', intent: 'voice_agent', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          modelSelection: selection, connectedServices: materializeRequest.connectedServices,
          intentInput: { commitModelSelection: selection }, permissionMode: 'read_only', retentionPolicy: 'resumable',
          runClass: 'long_lived', ioMode: 'streaming', bootstrapMode: 'none' },
        parentProvider: 'codex', sendAcp: async () => {}, streamedTranscriptSession: null, createRuntime,
        getNowMs: () => 1, budgetRegistry: null, runs: new Map<string, ExecutionRunState>(),
        controllers: new Map<string, ExecutionRunController>(), enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {}, finishRun: async (_id, patch) => { terminalError = patch.error; },
        executeBoundedRun: async () => {}, send: async () => ({ ok: true }), voiceAgentManager,
      }).catch(() => undefined);
      await vi.waitFor(() => expect(terminalError && ExecutionRunErrorSchema.parse(terminalError)).toMatchObject({
        code: uxDiagnostic.code, uxDiagnostic,
      }));
      expect(paths).toEqual(['/connected-service-run/materialize', '/connected-service-run/release']);
    } finally { await voiceAgentManager.dispose(); }
  });
  const successResponse = (activationId: string, registrationActivationId = activationId) => ({
    ok: true, result: { activationId, env: {}, connectedServicesBindings: materializeRequest.connectedServices,
      registration: { v: 1, activationId: registrationActivationId, runKey: materializeRequest.runId,
        agentId: 'codex', materializationKey: materializeRequest.runId,
        connectedServicesBindings: materializeRequest.connectedServices, connectedServiceSelectionsEnv: {},
        sessionDirectory: materializeRequest.cwd, materializedRoot: null },
    },
  });

  it.each([
    { malformed: false, errorCode: 'connected_service_run_materialization_blocked' },
    { malformed: true, errorCode: 'connected_service_run_materialization_blocked' },
    { malformed: false, errorCode: 'provider_session_state_unavailable_for_resume' },
  ])('sanitizes refusal $errorCode diagnostics and logs (malformed: $malformed)', async ({ malformed, errorCode }) => {
    const diagnostics = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const detail = 'Purpose unavailable at /private/runner; accessToken=private-refusal-token';
    let activationId: unknown;
    let released: unknown;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url.endsWith('/materialize')) {
        activationId = body.activationId;
        return new Response(JSON.stringify({ ok: false, errorCode,
          errorMessage: detail, ...(malformed ? { message: detail } : {}) }), { status: 403 });
      }
      released = body;
      return new Response(JSON.stringify({ ok: true, released: false }), { status: 200 });
    });
    const result = await requestExecutionRunConnectedServicesMaterialization(materializeRequest);
    expect(result).toMatchObject({ ok: false, errorCode,
      errorMessage: malformed ? 'Execution-run connected-services materialization failed' : expect.stringContaining('Purpose unavailable') });
    expect(released).toEqual({ runId: materializeRequest.runId, runnerPid: materializeRequest.runnerPid, activationId });
    expect(diagnostics).toHaveBeenCalled();
    for (const value of [result, diagnostics.mock.calls]) {
      expect(JSON.stringify(value)).not.toContain('/private/runner');
      expect(JSON.stringify(value)).not.toContain('private-refusal-token');
    }
  });

  it('does not treat an unvalidated nested body as a materialization refusal', async () => {
    vi.stubGlobal('fetch', async (url: string) => new Response(JSON.stringify(url.endsWith('/materialize')
      ? { ok: 'false', errorCode: 'connected_service_run_materialization_blocked', errorMessage: 'unvalidated detail' }
      : { ok: true, released: false }), { status: url.endsWith('/materialize') ? 403 : 200 }));
    await expect(requestExecutionRunConnectedServicesMaterialization(materializeRequest)).resolves.toMatchObject({
      ok: false, errorMessage: 'Execution-run connected-services materialization failed',
    });
  });

  it('does not dispatch a materialization or release for a pre-aborted caller', async () => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    const controller = new AbortController();
    controller.abort();
    await expect(requestExecutionRunConnectedServicesMaterialization(materializeRequest, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(request).not.toHaveBeenCalled();
  });

  it('releases a lost response on its issuing daemon after local publication changes', async () => {
    const initial = await readDaemonState();
    if (!initial) throw new Error('Expected daemon fixture');
    const original = vi.mocked(readDaemonState).getMockImplementation()!;
    let reads = 0;
    vi.mocked(readDaemonState).mockImplementation(async () => ({ ...initial, httpPort: ++reads === 1 ? 43210 : 54321 }));
    const ports: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      ports.push(new URL(url).port);
      if (url.endsWith('/materialize')) throw new Error('response lost');
      return new Response(JSON.stringify({ ok: true, released: true }), { status: 200 });
    }));
    try {
      await requestExecutionRunConnectedServicesMaterialization(materializeRequest);
      expect(ports).toEqual(['43210', '43210']);
    } finally { vi.mocked(readDaemonState).mockReset().mockImplementation(original); }
  });

  it('preallocates and exact-releases an activation when its response is lost', async () => {
    const controller = new AbortController();
    let offered: unknown;
    let released: unknown;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url.endsWith('/materialize')) {
        offered = body.activationId;
        controller.abort();
        throw controller.signal.reason;
      }
      released = body;
      expect(init?.signal?.aborted).not.toBe(true);
      return new Response(JSON.stringify({ ok: true, released: true }), { status: 200 });
    }));
    const result = await requestExecutionRunConnectedServicesMaterialization(materializeRequest, { signal: controller.signal });
    expect(offered).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(released).toEqual({ runId: materializeRequest.runId, runnerPid: process.pid, activationId: offered });
    expect(result.ok).not.toBe(true);
  });

  it.each(['result', 'registration'] as const)('refuses a mismatched %s activation without releasing foreign custody', async (mismatch) => {
    let offered: unknown;
    let released: unknown;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url.endsWith('/materialize')) {
        offered = body.activationId;
        const response = successResponse(mismatch === 'result' ? foreignActivationId : String(offered),
          mismatch === 'registration' ? foreignActivationId : String(offered));
        return new Response(JSON.stringify(response), { status: 200 });
      }
      released = body;
      return new Response(JSON.stringify({ ok: true, released: true }), { status: 200 });
    }));
    await expect(requestExecutionRunConnectedServicesMaterialization(materializeRequest)).resolves.toMatchObject({
      ok: false, errorCode: 'connected_service_run_activation_mismatch',
    });
    expect(released).toEqual({ runId: materializeRequest.runId, runnerPid: process.pid, activationId: offered });
    expect(offered).not.toBe(foreignActivationId);
  });

  it('keeps abandoned cleanup failures observable without replaying materialization', async () => {
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      paths.push(new URL(url).pathname);
      if (url.endsWith('/materialize')) throw new Error('response lost');
      return new Response(JSON.stringify({ ok: false, errorCode: 'connected_service_run_cleanup_failed' }), { status: 200 });
    }));
    await expect(requestExecutionRunConnectedServicesMaterialization(materializeRequest)).resolves.toMatchObject({
      ok: false, errorCode: 'connected_service_run_cleanup_failed',
    });
    expect(paths).toEqual(['/connected-service-run/materialize', '/connected-service-run/release']);
  });

  it('has no phase-local deadline and preserves an explicitly configured deadline', () => {
    expect(resolveExecutionRunConnectedServiceMaterializeTimeoutMs({})).toBeNull();
    expect(resolveExecutionRunConnectedServiceMaterializeTimeoutMs({
      HAPPIER_EXECUTION_RUN_CS_MATERIALIZE_TIMEOUT_MS: '250000',
    })).toBe(250_000);
    expect(resolveExecutionRunConnectedServiceMaterializeTimeoutMs({
      HAPPIER_EXECUTION_RUN_CS_MATERIALIZE_TIMEOUT_MS: '10',
    })).toBe(10);
    expect(resolveExecutionRunConnectedServiceMaterializeTimeoutMs({
      HAPPIER_EXECUTION_RUN_CS_MATERIALIZE_TIMEOUT_MS: '9999999',
    })).toBe(9_999_999);
  });

  it('accepts materialization after the former ten-minute deadline', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
      return controller.signal;
    });
    const issued = stubIssuedFetch(vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      await new Promise<void>((resolve, reject) => {
        setTimeout(resolve, 601_000);
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
      return new Response(JSON.stringify(successResponse(String(body.activationId))), { status: 200 });
    }));

    const pending = requestExecutionRunConnectedServicesMaterialization({
      runId: 'run-1',
      runnerPid: process.pid,
      agentId: 'codex',
      connectedServices: {
        v: 2,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
      cwd: '/tmp/workspace',
    });
    try {
      await issued;
      await vi.advanceTimersByTimeAsync(601_000);
      await expect(pending).resolves.toMatchObject({ ok: true });
    } finally { vi.useRealTimers(); }
  });
});
