import { afterEach, describe, expect, it, vi } from 'vitest';

const { callMachineRpc } = vi.hoisted(() => ({ callMachineRpc: vi.fn() }));
vi.mock('@/session/transport/rpc/machineRpc', () => ({ callMachineRpc }));

import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { requestInactiveSessionResume } from './requestInactiveSessionResume';

const machineKey = new Uint8Array(32).fill(1);
const credentials = {
  token: 'account-token',
  encryption: { type: 'dataKey' as const, publicKey: machineKey, machineKey },
};

function rawSession(overrides: Record<string, unknown> = {}): RawSessionRecord {
  return {
    id: 'session-1',
    active: false,
    machineId: 'machine-session',
    path: '/repo',
    seq: 17,
    ...overrides,
  } as unknown as RawSessionRecord;
}

describe('requestInactiveSessionResume', () => {
  afterEach(() => {
    callMachineRpc.mockReset();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('targets only the recorded session machine with one fresh user authorization', async () => {
    callMachineRpc.mockResolvedValue({ type: 'success', sessionId: 'session-1' });

    await expect(requestInactiveSessionResume({
      credentials,
      sessionId: 'session-1',
      localId: 'local-1',
      rawSession: rawSession(),
      metadata: {
        agentId: 'claude',
        machineId: 'machine-session',
        path: '/repo',
        claudeSessionId: 'provider-session-1',
      },
    })).resolves.toEqual({ ok: true });

    expect(callMachineRpc).toHaveBeenCalledTimes(1);
    expect(callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      credentials,
      machineId: 'machine-session',
      method: 'spawn-happy-session',
      request: expect.objectContaining({
        type: 'resume-session',
        sessionId: 'session-1',
        directory: '/repo',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        initialTranscriptAfterSeq: 17,
        executionAuthorization: {
          provenance: 'user_request',
          requestId: 'local-1',
        },
      }),
    }));
    expect(callMachineRpc.mock.calls[0]?.[0]?.request).not.toHaveProperty('spawnNonce');
  });

  it('rejects an archived session before contacting its recorded machine', async () => {
    await expect(requestInactiveSessionResume({
      credentials,
      sessionId: 'session-1',
      localId: 'local-1',
      rawSession: rawSession({ archivedAt: 123 }),
      metadata: {
        agentId: 'claude',
        machineId: 'machine-session',
        path: '/repo',
        claudeSessionId: 'provider-session-1',
      },
    })).resolves.toEqual({
      ok: false,
      code: 'session_archived',
      message: 'Archived sessions must be unarchived before resume',
    });

    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('waits for a 1231ms accepted resume to become ready without submitting the resume twice', async () => {
    vi.useFakeTimers();
    vi.stubEnv('HAPPIER_SPAWN_SESSION_ID_RESOLVE_TIMEOUT_MS', '5000');
    vi.stubEnv('HAPPIER_SPAWN_SESSION_ID_RESOLVE_POLL_INTERVAL_MS', '25');
    vi.stubEnv('HAPPIER_SPAWN_SESSION_ID_RESOLVE_NOT_FOUND_GRACE_MS', '5000');
    const startedAt = Date.now();
    callMachineRpc.mockImplementation(async (params: Readonly<{ method: string }>) => {
      if (params.method === 'spawn-happy-session') {
        return {
          type: 'success',
          sessionId: 'session-1',
          sessionIdStatus: 'available',
        };
      }
      if (params.method === 'daemon.spawnSession.resolve') {
        return Date.now() - startedAt >= 1231
          ? { status: 'success', sessionId: 'session-1' }
          : { status: 'pending' };
      }
      throw new Error(`Unexpected machine RPC method: ${params.method}`);
    });
    let settled = false;
    const input = {
      credentials,
      sessionId: 'session-1',
      localId: 'local-1',
      rawSession: rawSession(),
      metadata: {
        agentId: 'claude',
        machineId: 'machine-session',
        path: '/repo',
        claudeSessionId: 'provider-session-1',
      },
      waitForReady: true,
    } as const;

    const result = requestInactiveSessionResume(input).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(1230);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(20);

    await expect(result).resolves.toEqual({ ok: true });
    expect(callMachineRpc.mock.calls.filter(([params]) => params.method === 'spawn-happy-session')).toHaveLength(1);
    expect(callMachineRpc.mock.calls.filter(([params]) => params.method === 'daemon.spawnSession.resolve').length).toBeGreaterThan(1);
    const submittedNonce = callMachineRpc.mock.calls[0]?.[0]?.request?.spawnNonce;
    expect(submittedNonce).toMatch(/^inactive-session\.resume:/u);
    expect(
      callMachineRpc.mock.calls
        .filter(([params]) => params.method === 'daemon.spawnSession.resolve')
        .every(([params]) => params.request?.spawnNonce === submittedNonce),
    ).toBe(true);
  });

  it('fails closed on conflicting machine identity without falling back to another machine', async () => {
    await expect(requestInactiveSessionResume({
      credentials,
      sessionId: 'session-1',
      localId: 'local-1',
      rawSession: rawSession({ machineId: 'machine-server' }),
      metadata: { agentId: 'claude', machineId: 'machine-metadata', path: '/repo' },
    })).resolves.toEqual(expect.objectContaining({ ok: false, code: 'unsupported' }));

    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('fails closed when the selected record or success acknowledgement names another session', async () => {
    const metadata = {
      machineId: 'machine-session',
      path: '/repo',
      claudeSessionId: 'provider-session-1',
    };
    await expect(requestInactiveSessionResume({
      credentials,
      sessionId: 'session-1',
      localId: 'local-1',
      rawSession: rawSession({ id: 'session-other' }),
      metadata,
    })).resolves.toEqual(expect.objectContaining({ ok: false, code: 'unsupported' }));
    expect(callMachineRpc).not.toHaveBeenCalled();

    callMachineRpc.mockResolvedValueOnce({ type: 'success', sessionId: 'session-other' });
    await expect(requestInactiveSessionResume({
      credentials,
      sessionId: 'session-1',
      localId: 'local-1',
      rawSession: rawSession(),
      metadata,
    })).resolves.toEqual(expect.objectContaining({ ok: false, code: 'unsupported' }));
    expect(callMachineRpc).toHaveBeenCalledTimes(1);
  });

  it('fails closed when decrypted metadata does not prove the persisted provider identity', async () => {
    await expect(requestInactiveSessionResume({
      credentials,
      sessionId: 'session-1',
      localId: 'local-1',
      rawSession: rawSession(),
      metadata: { machineId: 'machine-session', path: '/repo' },
    })).resolves.toEqual(expect.objectContaining({ ok: false, code: 'unsupported' }));

    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('fails closed when raw and decrypted directory identities conflict', async () => {
    await expect(requestInactiveSessionResume({
      credentials,
      sessionId: 'session-1',
      localId: 'local-1',
      rawSession: rawSession({ path: '/repo-from-server' }),
      metadata: {
        agentId: 'claude',
        machineId: 'machine-session',
        path: '/repo-from-metadata',
        claudeSessionId: 'provider-session-1',
      },
    })).resolves.toEqual(expect.objectContaining({ ok: false, code: 'unsupported' }));

    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('fails closed when no persisted directory identity exists', async () => {
    await expect(requestInactiveSessionResume({
      credentials,
      sessionId: 'session-1',
      localId: 'local-1',
      rawSession: rawSession({ path: null }),
      metadata: {
        flavor: 'claude',
        machineId: 'machine-session',
        claudeSessionId: 'provider-session-1',
      },
    })).resolves.toEqual(expect.objectContaining({ ok: false, code: 'unsupported' }));

    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('preserves the exact configured ACP backend instead of substituting generic custom ACP', async () => {
    callMachineRpc.mockResolvedValue({ type: 'success', sessionId: 'session-1' });

    await expect(requestInactiveSessionResume({
      credentials,
      sessionId: 'session-1',
      localId: 'local-1',
      rawSession: rawSession(),
      metadata: {
        flavor: 'acp:review-bot',
        machineId: 'machine-session',
        path: '/repo',
        acpConfiguredBackendV1: {
          v: 1,
          updatedAt: 1,
          backendId: 'review-bot',
          title: 'Review bot',
        },
      },
    })).resolves.toEqual({ ok: true });

    expect(callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      }),
    }));
  });

  it('fails closed instead of substituting generic custom ACP for malformed configured identity', async () => {
    await expect(requestInactiveSessionResume({
      credentials,
      sessionId: 'session-1',
      localId: 'local-1',
      rawSession: rawSession(),
      metadata: {
        flavor: 'acp:review-bot',
        machineId: 'machine-session',
        path: '/repo',
        acpConfiguredBackendV1: { v: 1, backendId: '' },
      },
    })).resolves.toEqual(expect.objectContaining({ ok: false, code: 'unsupported' }));

    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('replaces stale persisted execution intent with only the current user authorization', async () => {
    callMachineRpc.mockResolvedValue({ type: 'success', sessionId: 'session-1' });

    await expect(requestInactiveSessionResume({
      credentials,
      sessionId: 'session-1',
      localId: 'local-current',
      rawSession: rawSession(),
      metadata: {
        flavor: 'claude',
        machineId: 'machine-session',
        path: '/repo',
        claudeSessionId: 'provider-session-1',
        executionAuthorization: {
          provenance: 'user_request',
          requestId: 'local-stale',
        },
      },
    })).resolves.toEqual({ ok: true });

    expect(callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        executionAuthorization: {
          provenance: 'user_request',
          requestId: 'local-current',
        },
      }),
    }));
  });

  it('fails closed when persisted provider identity sources conflict', async () => {
    await expect(requestInactiveSessionResume({
      credentials,
      sessionId: 'session-1',
      localId: 'local-1',
      rawSession: rawSession(),
      metadata: {
        flavor: 'gpt',
        machineId: 'machine-session',
        path: '/repo',
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'claude',
          provider: {},
        },
      },
    })).resolves.toEqual(expect.objectContaining({ ok: false, code: 'unsupported' }));

    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('does not retry a timeout or malformed acknowledgement', async () => {
    callMachineRpc.mockRejectedValueOnce(Object.assign(new Error('Machine RPC call timeout'), {
      code: 'MACHINE_RPC_TIMEOUT',
    }));
    const input = {
      credentials,
      sessionId: 'session-1',
      localId: 'local-1',
      rawSession: rawSession(),
      metadata: {
        agentId: 'claude',
        machineId: 'machine-session',
        path: '/repo',
        claudeSessionId: 'provider-session-1',
      },
    } as const;
    await expect(requestInactiveSessionResume(input)).resolves.toEqual(expect.objectContaining({
      ok: false,
      code: 'timeout',
    }));
    expect(callMachineRpc).toHaveBeenCalledTimes(1);

    callMachineRpc.mockReset();
    callMachineRpc.mockResolvedValueOnce({ ok: true });
    await expect(requestInactiveSessionResume(input)).resolves.toEqual(expect.objectContaining({
      ok: false,
      code: 'resume_failed',
    }));
    expect(callMachineRpc).toHaveBeenCalledTimes(1);
  });
});
