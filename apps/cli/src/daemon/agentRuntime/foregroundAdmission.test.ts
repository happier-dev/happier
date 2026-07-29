import { describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1 } from '@happier-dev/protocol';

import type { AgentRuntimeDaemonBridgeRequestV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonBridgeProtocol';
import { hashAgentRuntimeSessionBridgeToken } from '@/daemon/agentRuntime/sessionBridgeAuthorization';

import {
  createForegroundAgentRuntimeAdmissionOwner,
  type PreparedForegroundAgentRuntimeAdmission,
} from './foregroundAdmission';
import type { ForegroundAgentRuntimeAdmissionOwnerRequestV1 } from './foregroundAdmissionContract';
import { createAgentRuntimeSessionBridgeRoutes } from './sessionBridgeRoutes';

const admissionRequest: ForegroundAgentRuntimeAdmissionOwnerRequestV1 = {
  v: 1,
  attemptId: 'attempt-1',
  sessionId: 'session-1',
  foregroundPid: 1234,
  machineId: 'machine-1',
  directory: '/workspace',
  agentId: 'codex',
  backendTarget: {
    kind: 'backend',
    backendId: 'codex',
    sourceKind: 'built_in',
  },
};

function createPrepared(
  cleanup: () => Promise<void>,
  retirement: AbortController,
  claim: PreparedForegroundAgentRuntimeAdmission['claim'] =
    vi.fn(async () => ({
      ok: true as const,
      environment: { PROVIDER_SECRET: 'secret-value' },
      unsetEnvironmentVariableNames: ['NATIVE_AUTH'],
      sensitiveEnvironmentVariableNames: [],
    })),
): PreparedForegroundAgentRuntimeAdmission {
  return {
    authorization: {
      tokenHash: hashAgentRuntimeSessionBridgeToken('correct-token'),
      tokenFilePath: '/private/token.json',
      descriptor: {
        v: 1,
        pluginId: 'codex-plugin',
        pluginVersion: '1.0.0',
        agentId: 'codex',
        backendId: 'codex',
        generation: 'generation-1',
        immutableGenerationId: 'immutable-1',
        factoryControls: {
          continuation: false,
          goals: false,
          catalog: false,
          usageLimitRecovery: false,
        },
      },
    },
    reservedEnvironmentVariableNames: ['OPENAI_API_KEY'],
    profileSecretRequirementNamesMissingBinding: [],
    retirementSignal: retirement.signal,
    isCurrent: () => !retirement.signal.aborted,
    claim,
    cleanup,
  };
}

function claimRequest(token = 'correct-token'): AgentRuntimeDaemonBridgeRequestV1 {
  return {
    v: 1,
    context: {
      token,
      sessionId: 'session-1',
      pluginId: 'codex-plugin',
      agentId: 'codex',
      generation: 'generation-1',
    },
    operation: {
      kind: 'foreground.environment.claim',
      requestId: 'request-1',
      attemptId: 'attempt-1',
      foregroundSatisfiedProfileSecretRequirementNames: [],
    },
  };
}

function factoryPrepareRequest(
  sessionId: string,
  token = 'correct-token',
): AgentRuntimeDaemonBridgeRequestV1 {
  const descriptor = createPrepared(
    async () => undefined,
    new AbortController(),
  ).authorization.descriptor;
  return {
    v: 1,
    context: {
      token,
      sessionId,
      pluginId: descriptor.pluginId,
      agentId: descriptor.agentId,
      generation: descriptor.generation,
    },
    operation: {
      kind: 'factory.prepare',
      requestId: `prepare-${sessionId}`,
      descriptor,
      request: {
        kind: 'create',
        sessionId,
        cwd: '/workspace',
      },
    },
  };
}

describe('foreground Agent runtime admission', () => {
  it('reserves an attempt before asynchronous preparation can admit a duplicate', async () => {
    const retirement = new AbortController();
    let settle!: () => void;
    const prepareGate = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const prepare = vi.fn(async () => {
      await prepareGate;
      return {
        ok: true as const,
        prepared: createPrepared(
          vi.fn(async () => undefined),
          retirement,
        ),
      };
    });
    const owner = createForegroundAgentRuntimeAdmissionOwner({ prepare });

    const first = owner.admit(admissionRequest);
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    const duplicate = owner.admit({
      ...admissionRequest,
      sessionId: 'session-other',
    });

    settle();
    await first;
    await expect(duplicate).rejects.toThrow('already exists');
    expect(prepare).toHaveBeenCalledTimes(1);
    await owner.dispose();
  });

  it('reserves a session before asynchronous preparation can admit a different attempt', async () => {
    const retirement = new AbortController();
    let settle!: () => void;
    const prepareGate = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const prepare = vi.fn(async () => {
      await prepareGate;
      return {
        ok: true as const,
        prepared: createPrepared(
          vi.fn(async () => undefined),
          retirement,
        ),
      };
    });
    const owner = createForegroundAgentRuntimeAdmissionOwner({ prepare });

    const first = owner.admit(admissionRequest);
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    const duplicate = owner.admit({
      ...admissionRequest,
      attemptId: 'attempt-other',
    });

    settle();
    await first;
    await expect(duplicate).rejects.toThrow('already exists');
    expect(prepare).toHaveBeenCalledTimes(1);
    await owner.dispose();
  });

  it('closes admission before awaiting pending preparation and cleans a late result', async () => {
    const cleanup = vi.fn(async () => undefined);
    const retirement = new AbortController();
    let settle!: () => void;
    const prepareGate = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const prepare = vi.fn(async () => {
      await prepareGate;
      return {
        ok: true as const,
        prepared: createPrepared(cleanup, retirement),
      };
    });
    const owner = createForegroundAgentRuntimeAdmissionOwner({ prepare });

    const admitting = owner.admit(admissionRequest);
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    let disposed = false;
    const disposing = owner.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    const disposedBeforePreparationSettled = disposed;
    const lateAdmission = owner.admit({
      ...admissionRequest,
      attemptId: 'attempt-after-dispose',
      sessionId: 'session-after-dispose',
    });

    settle();
    expect(disposedBeforePreparationSettled).toBe(false);
    await expect(admitting).rejects.toThrow('disposed');
    await expect(lateAdmission).rejects.toThrow('disposed');
    await disposing;
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(owner.isBridgeRequestAuthorized(claimRequest())).toBe(false);
  });

  it('requires the exact scoped bearer and permits one immediate environment claim', async () => {
    const cleanup = vi.fn(async () => undefined);
    const retirement = new AbortController();
    const claim = vi.fn(async () => ({
      ok: true as const,
      environment: { PROVIDER_SECRET: 'secret-value' },
      unsetEnvironmentVariableNames: ['NATIVE_AUTH'],
      sensitiveEnvironmentVariableNames: [],
    }));
    const owner = createForegroundAgentRuntimeAdmissionOwner({
      prepare: async () => ({
        ok: true,
        prepared: createPrepared(cleanup, retirement, claim),
      }),
    });

    const admitted = await owner.admit(admissionRequest);
    expect(admitted).toMatchObject({
      ok: true,
      launchPolicy: {
        reservedEnvironmentVariableNames: ['OPENAI_API_KEY'],
      },
    });
    expect(admitted).not.toHaveProperty('environment');
    expect(claim).not.toHaveBeenCalled();

    await expect(
      owner.claimEnvironment(claimRequest('wrong-token')),
    ).rejects.toThrow('unavailable');
    await expect(owner.claimEnvironment({
      ...claimRequest(),
      operation: {
        kind: 'foreground.environment.claim',
        requestId: 'request-mismatch',
        attemptId: 'attempt-other',
        foregroundSatisfiedProfileSecretRequirementNames: [],
      },
    })).rejects.toThrow('unavailable');
    await expect(owner.claimEnvironment({
      ...claimRequest(),
      context: {
        ...claimRequest().context,
        sessionId: 'session-other',
      },
    })).rejects.toThrow('unavailable');
    await expect(owner.claimEnvironment(claimRequest())).resolves.toEqual({
      ok: true,
      environment: { PROVIDER_SECRET: 'secret-value' },
      unsetEnvironmentVariableNames: ['NATIVE_AUTH'],
      sensitiveEnvironmentVariableNames: [],
    });
    await expect(owner.claimEnvironment(claimRequest())).rejects.toThrow(
      'unavailable',
    );
    expect(cleanup).not.toHaveBeenCalled();

    await owner.release('attempt-1', 'session-1');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('binds a claimed admission to the canonical host session on first factory prepare', async () => {
    const cleanup = vi.fn(async () => undefined);
    const retirement = new AbortController();
    const owner = createForegroundAgentRuntimeAdmissionOwner({
      prepare: async () => ({
        ok: true,
        prepared: createPrepared(cleanup, retirement),
      }),
    });

    await owner.admit(admissionRequest);
    await expect(owner.claimEnvironment(claimRequest())).resolves.toMatchObject({
      ok: true,
    });

    expect(
      owner.isBridgeRequestAuthorized(
        factoryPrepareRequest('forbidden-session', 'wrong-token'),
      ),
    ).toBe(false);
    expect(
      owner.isBridgeRequestAuthorized(
        factoryPrepareRequest('canonical-session-1'),
      ),
    ).toBe(true);
    expect(
      owner.isBridgeRequestAuthorized(
        factoryPrepareRequest('unrelated-session'),
      ),
    ).toBe(false);
    expect(
      owner.isBridgeRequestAuthorized(
        factoryPrepareRequest(admissionRequest.sessionId),
      ),
    ).toBe(false);

    await owner.releaseSession('canonical-session-1');
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(
      owner.isBridgeRequestAuthorized(
        factoryPrepareRequest('canonical-session-1'),
      ),
    ).toBe(false);
  });

  it('allows only one concurrent claimant before late preparation settles', async () => {
    const cleanup = vi.fn(async () => undefined);
    const retirement = new AbortController();
    let settle!: (result: {
      ok: true;
      environment: Record<string, string>;
      unsetEnvironmentVariableNames: string[];
      sensitiveEnvironmentVariableNames: string[];
    }) => void;
    const claim = vi.fn(() => new Promise<{
      ok: true;
      environment: Record<string, string>;
      unsetEnvironmentVariableNames: string[];
      sensitiveEnvironmentVariableNames: string[];
    }>((resolve) => {
      settle = resolve;
    }));
    const owner = createForegroundAgentRuntimeAdmissionOwner({
      prepare: async () => ({
        ok: true,
        prepared: createPrepared(cleanup, retirement, claim),
      }),
    });

    await owner.admit(admissionRequest);
    const winner = owner.claimEnvironment(claimRequest());
    await expect(owner.claimEnvironment(claimRequest())).rejects.toThrow(
      'unavailable',
    );
    settle({
      ok: true,
      environment: { PROVIDER_SECRET: 'secret-value' },
      unsetEnvironmentVariableNames: [],
      sensitiveEnvironmentVariableNames: [],
    });
    await expect(winner).resolves.toMatchObject({
      ok: true,
      environment: { PROVIDER_SECRET: 'secret-value' },
    });
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it('withholds a late claim result when its generation retires in flight', async () => {
    const cleanup = vi.fn(async () => undefined);
    const retirement = new AbortController();
    let settle!: (result: {
      ok: true;
      environment: Record<string, string>;
      unsetEnvironmentVariableNames: string[];
      sensitiveEnvironmentVariableNames: string[];
    }) => void;
    const claim = vi.fn(() => new Promise<{
      ok: true;
      environment: Record<string, string>;
      unsetEnvironmentVariableNames: string[];
      sensitiveEnvironmentVariableNames: string[];
    }>((resolve) => {
      settle = resolve;
    }));
    const owner = createForegroundAgentRuntimeAdmissionOwner({
      prepare: async () => ({
        ok: true,
        prepared: createPrepared(cleanup, retirement, claim),
      }),
    });

    await owner.admit(admissionRequest);
    const claiming = owner.claimEnvironment(claimRequest());
    retirement.abort();
    expect(cleanup).not.toHaveBeenCalled();
    settle({
      ok: true,
      environment: { PROVIDER_SECRET: 'must-not-escape' },
      unsetEnvironmentVariableNames: [],
      sensitiveEnvironmentVariableNames: [],
    });

    await expect(claiming).rejects.toThrow('unavailable');
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
  });

  it('returns a late typed refusal and releases all admission custody', async () => {
    const cleanup = vi.fn(async () => undefined);
    const retirement = new AbortController();
    const error = createProviderErrorV1(
      'provider_authorization_changed',
      { connectionId: 'pc_gateway', machineId: 'machine-1' },
    );
    const owner = createForegroundAgentRuntimeAdmissionOwner({
      prepare: async () => ({
        ok: true,
        prepared: createPrepared(
          cleanup,
          retirement,
          vi.fn(async () => ({ ok: false as const, error })),
        ),
      }),
    });

    await owner.admit(admissionRequest);
    await expect(owner.claimEnvironment(claimRequest())).resolves.toEqual({
      ok: false,
      error,
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(owner.isBridgeRequestAuthorized(claimRequest())).toBe(false);
  });

  it('releases an unclaimed admission when its applied generation retires', async () => {
    const cleanup = vi.fn(async () => undefined);
    const retirement = new AbortController();
    const owner = createForegroundAgentRuntimeAdmissionOwner({
      prepare: async () => ({
        ok: true,
        prepared: createPrepared(cleanup, retirement),
      }),
    });

    await owner.admit(admissionRequest);
    retirement.abort();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));

    expect(owner.isBridgeRequestAuthorized(claimRequest())).toBe(false);
    await expect(owner.claimEnvironment(claimRequest())).rejects.toThrow(
      'unavailable',
    );
  });

  it('releases admission custody when the foreground owner process exits', async () => {
    vi.useFakeTimers();
    try {
      const cleanup = vi.fn(async () => undefined);
      const retirement = new AbortController();
      let alive = true;
      const owner = createForegroundAgentRuntimeAdmissionOwner({
        prepare: async () => ({
          ok: true,
          prepared: createPrepared(cleanup, retirement),
        }),
        isProcessAlive: () => alive,
      });

      await owner.admit(admissionRequest);
      alive = false;
      await vi.advanceTimersByTimeAsync(1_000);

      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(owner.isBridgeRequestAuthorized(claimRequest())).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases a claimed admission when the private session bridge is lost before open', async () => {
    const cleanup = vi.fn(async () => undefined);
    const retirement = new AbortController();
    const owner = createForegroundAgentRuntimeAdmissionOwner({
      prepare: async () => ({
        ok: true,
        prepared: createPrepared(cleanup, retirement),
      }),
    });
    const bridge = createAgentRuntimeSessionBridgeRoutes({
      foregroundAdmission: owner,
    });

    await owner.admit(admissionRequest);
    await expect(bridge.dispatch(claimRequest())).resolves.toMatchObject({
      ok: true,
      result: {
        ok: true,
        environment: { PROVIDER_SECRET: 'secret-value' },
      },
    });
    await bridge.disposeSession('session-1');

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(owner.isBridgeRequestAuthorized(claimRequest())).toBe(false);
  });

  it('releases a claimed admission exactly once when its successful response is lost and the bridge shuts down', async () => {
    const cleanup = vi.fn(async () => undefined);
    const retirement = new AbortController();
    const owner = createForegroundAgentRuntimeAdmissionOwner({
      prepare: async () => ({
        ok: true,
        prepared: createPrepared(cleanup, retirement),
      }),
    });
    const bridge = createAgentRuntimeSessionBridgeRoutes({
      foregroundAdmission: owner,
    });

    await owner.admit(admissionRequest);
    await bridge.dispatch(claimRequest());

    await Promise.all([bridge.dispose(), bridge.dispose()]);

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(owner.isBridgeRequestAuthorized(claimRequest())).toBe(false);
  });

  it('withholds an in-flight claim result and waits to clean it exactly once on bridge shutdown', async () => {
    const cleanup = vi.fn(async () => undefined);
    const retirement = new AbortController();
    let settle!: (result: {
      ok: true;
      environment: Record<string, string>;
      unsetEnvironmentVariableNames: string[];
      sensitiveEnvironmentVariableNames: string[];
    }) => void;
    const claim = vi.fn(() => new Promise<{
      ok: true;
      environment: Record<string, string>;
      unsetEnvironmentVariableNames: string[];
      sensitiveEnvironmentVariableNames: string[];
    }>((resolve) => {
      settle = resolve;
    }));
    const owner = createForegroundAgentRuntimeAdmissionOwner({
      prepare: async () => ({
        ok: true,
        prepared: createPrepared(cleanup, retirement, claim),
      }),
    });
    const bridge = createAgentRuntimeSessionBridgeRoutes({
      foregroundAdmission: owner,
    });

    await owner.admit(admissionRequest);
    const claiming = bridge.dispatch(claimRequest());
    await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(1));
    let disposed = false;
    const disposing = bridge.dispose().then(() => {
      disposed = true;
    });

    await Promise.resolve();
    expect(disposed).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
    settle({
      ok: true,
      environment: { PROVIDER_SECRET: 'must-not-escape' },
      unsetEnvironmentVariableNames: [],
      sensitiveEnvironmentVariableNames: [],
    });

    await expect(claiming).resolves.toMatchObject({
      ok: false,
    });
    await disposing;
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
