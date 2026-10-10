import { afterEach, describe, expect, it, vi } from 'vitest';

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
  it('covers the daemon materialization tail backstop plus the materialization work itself', () => {
    expect(resolveExecutionRunConnectedServiceMaterializeTimeoutMs({})).toBe(600_000);
    expect(resolveExecutionRunConnectedServiceMaterializeTimeoutMs({
      HAPPIER_EXECUTION_RUN_CS_MATERIALIZE_TIMEOUT_MS: '250000',
    })).toBe(250_000);
    expect(resolveExecutionRunConnectedServiceMaterializeTimeoutMs({
      HAPPIER_EXECUTION_RUN_CS_MATERIALIZE_TIMEOUT_MS: '10',
    })).toBe(1_000);
    expect(resolveExecutionRunConnectedServiceMaterializeTimeoutMs({
      HAPPIER_EXECUTION_RUN_CS_MATERIALIZE_TIMEOUT_MS: '9999999',
    })).toBe(600_000);
  });

  it('applies the complete materialization budget to the effective request AbortSignal', async () => {
    const timeoutSignal = new AbortController().signal;
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal);
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBe(timeoutSignal);
      return new Response(JSON.stringify({
        ok: true,
        result: {
          activationId: 'activation-1',
          env: { CODEX_HOME: '/tmp/materialized-codex-home' },
          connectedServicesBindings: {},
          registration: {},
        },
      }), { status: 200 });
    }));

    await expect(requestExecutionRunConnectedServicesMaterialization({
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
    })).resolves.toMatchObject({ ok: true });

    expect(timeoutSpy).toHaveBeenCalledWith(600_000);
  });
});
