import { describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1 } from '@happier-dev/protocol';

import { hashAgentRuntimeSessionBridgeToken } from '@/daemon/agentRuntime/sessionBridgeAuthorization';

import {
  createForegroundAgentRuntimeAdmissionOwner,
  type PreparedForegroundAgentRuntimeAdmission,
} from './foregroundAdmission';
import type {
  ForegroundAgentRuntimeAdmissionOwnerRequestV1,
  ForegroundAgentRuntimeClaimRequestV1,
} from './foregroundAdmissionContract';
import type { AgentRuntimeDaemonServiceRequestV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import {
  createAgentSessionRunnerFactoryBinding,
} from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';

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

const runner = Object.freeze({
  pid: 1234,
  processStartTimeMs: 1_717_171_717_000,
  processCommandHash: 'a'.repeat(64),
  snapshotIdentity: 'snapshot:foreground-codex',
});

function retainedAgent() {
  return createAgentSessionRunnerFactoryBinding({
    v: 1,
    pluginId: 'codex-plugin',
    pluginVersion: '1.0.0',
    agentId: 'codex',
    localAgentId: 'codex',
    immutableGenerationId: 'immutable-1',
    locator: {
      module: './runtime.mjs',
      export: 'createRuntime',
      runtimeApiVersion: 1,
    },
    normalizedModulePath: 'runtime.mjs',
    loadMode: 'immutable-js',
  });
}

function claimAuthority() {
  return {
    retainedAgent: retainedAgent(),
    runner,
    capabilityDigest: 'capability-digest-1',
    transferCleanupOwnership: vi.fn(),
  };
}

function invocationContext(
  environment: Readonly<Record<string, string>> = {
    PROVIDER_SECRET: 'secret-value',
  },
) {
  return {
    cwd: '/workspace',
    environment,
    providerBindingActive: true,
  };
}

function createPrepared(
  cleanup: () => Promise<void>,
  retirement: AbortController,
  claim: PreparedForegroundAgentRuntimeAdmission['claim'] =
    vi.fn(async () => ({
      ok: true as const,
      environment: { PROVIDER_SECRET: 'secret-value' },
      unsetEnvironmentVariableNames: ['NATIVE_AUTH'],
      sensitiveEnvironmentVariableNames: [],
      invocationContext: invocationContext(),
      authority: claimAuthority(),
    })),
): PreparedForegroundAgentRuntimeAdmission {
  return {
    authorization: {
      capabilityHash: hashAgentRuntimeSessionBridgeToken('correct-token'),
      foregroundAdmissionFilePath:
        '/private/foreground-admission.json',
      bootstrapFilePath: '/private/bootstrap.json',
      authorityFilePath: '/private/authority.json',
      descriptor: {
        v: 1,
        pluginId: 'codex-plugin',
        pluginVersion: '1.0.0',
        agentId: 'codex',
        backendId: 'codex',
        generation: 'generation-1',
        immutableGenerationId: 'immutable-1',
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

function claimRequest(
  token = 'correct-token',
): ForegroundAgentRuntimeClaimRequestV1 {
  return {
    v: 1,
    attemptId: 'attempt-1',
    provisionalSessionId: 'session-1',
    canonicalSessionId: 'session-1',
    foregroundPid: 1234,
    pluginId: 'codex-plugin',
    agentId: 'codex',
    generation: 'generation-1',
    capability: token,
    foregroundSatisfiedProfileSecretRequirementNames: [],
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
  });

  it('requires the exact scoped bearer and permits one immediate environment claim', async () => {
    const cleanup = vi.fn(async () => undefined);
    const retirement = new AbortController();
    const claim = vi.fn(async () => ({
      ok: true as const,
      environment: { PROVIDER_SECRET: 'secret-value' },
      unsetEnvironmentVariableNames: ['NATIVE_AUTH'],
      sensitiveEnvironmentVariableNames: [],
      invocationContext: invocationContext(),
      authority: claimAuthority(),
    }));
    const owner = createForegroundAgentRuntimeAdmissionOwner({
      prepare: async () => ({
        ok: true,
        prepared: {
          ...createPrepared(cleanup, retirement, claim),
          nativeHomeSourceEnvironmentKey: 'CODEX_HOME',
        },
      }),
    });

    const admitted = await owner.admit(admissionRequest);
    expect(admitted).toMatchObject({
      ok: true,
      launchPolicy: {
        reservedEnvironmentVariableNames: ['OPENAI_API_KEY'],
        nativeHomeSourceEnvironmentKey: 'CODEX_HOME',
      },
    });
    expect(admitted).not.toHaveProperty('environment');
    expect(claim).not.toHaveBeenCalled();

    await expect(
      owner.claimEnvironment(claimRequest('wrong-token')),
    ).rejects.toThrow('unavailable');
    await expect(owner.claimEnvironment({
      ...claimRequest(),
      attemptId: 'attempt-other',
    })).rejects.toThrow('unavailable');
    await expect(owner.claimEnvironment({
      ...claimRequest(),
      nativeHomeSourceEnvironmentValue: '/configured/codex-home',
    })).resolves.toEqual({
      ok: true,
      environment: { PROVIDER_SECRET: 'secret-value' },
      unsetEnvironmentVariableNames: ['NATIVE_AUTH'],
      sensitiveEnvironmentVariableNames: [],
    });
    expect(claim).toHaveBeenCalledWith(expect.objectContaining({
      nativeHomeSourceEnvironmentValue: '/configured/codex-home',
    }));
    await expect(owner.claimEnvironment(claimRequest())).rejects.toThrow(
      'unavailable',
    );
    expect(cleanup).not.toHaveBeenCalled();

    await owner.release('attempt-1', 'session-1');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('binds the one-shot claim to the canonical host session', async () => {
    const cleanup = vi.fn(async () => undefined);
    const retirement = new AbortController();
    const owner = createForegroundAgentRuntimeAdmissionOwner({
      prepare: async () => ({
        ok: true,
        prepared: createPrepared(
          cleanup,
          retirement,
          vi.fn(async () => ({
            ok: true as const,
            environment: {},
            unsetEnvironmentVariableNames: [],
            sensitiveEnvironmentVariableNames: [],
            invocationContext: invocationContext({}),
            authority: claimAuthority(),
          })),
        ),
      }),
    });

    await owner.admit(admissionRequest);
    await expect(owner.claimEnvironment({
      v: 1,
      attemptId: 'attempt-1',
      provisionalSessionId: 'session-1',
      canonicalSessionId: 'canonical-session-1',
      foregroundPid: 1234,
      pluginId: 'codex-plugin',
      agentId: 'codex',
      generation: 'generation-1',
      capability: 'correct-token',
      foregroundSatisfiedProfileSecretRequirementNames: [],
    })).resolves.toMatchObject({
      ok: true,
    });

    await owner.releaseSession('canonical-session-1');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('promotes exact foreground V2 custody before relinquishing admission cleanup ownership', async () => {
    const cleanup = vi.fn(async () => undefined);
    const retirement = new AbortController();
    const transferCleanupOwnership = vi.fn();
    const retained = retainedAgent();
    const promoteDaemonServiceAuthority = vi.fn(async () => true);
    const owner = createForegroundAgentRuntimeAdmissionOwner({
      prepare: async () => ({
        ok: true,
        prepared: createPrepared(
          cleanup,
          retirement,
          vi.fn(async () => ({
            ok: true as const,
            environment: {},
            unsetEnvironmentVariableNames: [],
            sensitiveEnvironmentVariableNames: [],
            invocationContext: {
              cwd: '/workspace',
              environment: {
                PROVIDER_SECRET: 'secret-value',
              },
              agentCliLaunch: {
                localAgentId: 'codex',
                spec: {
                  source: 'override' as const,
                  resolvedPath: '/workspace/.profile/bin/codex',
                  command: '/workspace/.profile/bin/codex',
                  args: [],
                },
              },
              providerBindingActive: true,
            },
            authority: {
              retainedAgent: retained,
              runner,
              capabilityDigest: 'v2-capability-digest',
              transferCleanupOwnership,
            },
          })),
        ),
      }),
      getHttpPort: () => 40123,
      promoteDaemonServiceAuthority,
    });

    await owner.admit(admissionRequest);
    await expect(owner.claimEnvironment({
      ...claimRequest(),
      canonicalSessionId: 'canonical-session-promoted',
    })).resolves.toMatchObject({ ok: true });
    expect(promoteDaemonServiceAuthority).toHaveBeenCalledWith({
      canonicalSessionId: 'canonical-session-promoted',
      foregroundPid: admissionRequest.foregroundPid,
      authorityFilePath: '/private/authority.json',
      retainedAgent: retained,
      runner,
      capabilityDigest: 'v2-capability-digest',
      invocationContext: {
        cwd: '/workspace',
        environment: {},
        agentCliLaunch: {
          localAgentId: 'codex',
          spec: {
            source: 'override',
            resolvedPath: '/workspace/.profile/bin/codex',
            command: '/workspace/.profile/bin/codex',
            args: [],
          },
        },
        providerBindingActive: false,
      },
    });
    expect(transferCleanupOwnership).toHaveBeenCalledOnce();
    expect(owner.authorizeDaemonServiceRequest({
      request: {
        context: {
          sessionId: 'canonical-session-promoted',
          token: 'correct-token',
        },
      } as unknown as AgentRuntimeDaemonServiceRequestV1,
      providedCapability: 'correct-token',
    })).toBeNull();

    await owner.release('attempt-1', 'session-1');
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('allows only one concurrent claimant before late preparation settles', async () => {
    const cleanup = vi.fn(async () => undefined);
    const retirement = new AbortController();
    let settle!: (result: {
      ok: true;
      environment: Record<string, string>;
      unsetEnvironmentVariableNames: string[];
      sensitiveEnvironmentVariableNames: string[];
      invocationContext: ReturnType<typeof invocationContext>;
      authority: ReturnType<typeof claimAuthority>;
    }) => void;
    const claim = vi.fn(() => new Promise<{
      ok: true;
      environment: Record<string, string>;
      unsetEnvironmentVariableNames: string[];
      sensitiveEnvironmentVariableNames: string[];
      invocationContext: ReturnType<typeof invocationContext>;
      authority: ReturnType<typeof claimAuthority>;
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
      invocationContext: invocationContext(),
      authority: claimAuthority(),
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
      invocationContext: ReturnType<typeof invocationContext>;
      authority: ReturnType<typeof claimAuthority>;
    }) => void;
    const claim = vi.fn(() => new Promise<{
      ok: true;
      environment: Record<string, string>;
      unsetEnvironmentVariableNames: string[];
      sensitiveEnvironmentVariableNames: string[];
      invocationContext: ReturnType<typeof invocationContext>;
      authority: ReturnType<typeof claimAuthority>;
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
      invocationContext: invocationContext({
        PROVIDER_SECRET: 'must-not-escape',
      }),
      authority: claimAuthority(),
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
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases a claimed admission through the foreground owner', async () => {
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
      environment: { PROVIDER_SECRET: 'secret-value' },
    });
    await owner.releaseSession('session-1');

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('releases a claimed admission exactly once when the owner shuts down', async () => {
    const cleanup = vi.fn(async () => undefined);
    const retirement = new AbortController();
    const owner = createForegroundAgentRuntimeAdmissionOwner({
      prepare: async () => ({
        ok: true,
        prepared: createPrepared(cleanup, retirement),
      }),
    });
    await owner.admit(admissionRequest);
    await owner.claimEnvironment(claimRequest());

    await Promise.all([owner.dispose(), owner.dispose()]);

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('withholds an in-flight claim result and waits to clean it exactly once on owner shutdown', async () => {
    const cleanup = vi.fn(async () => undefined);
    const retirement = new AbortController();
    let settle!: (result: {
      ok: true;
      environment: Record<string, string>;
      unsetEnvironmentVariableNames: string[];
      sensitiveEnvironmentVariableNames: string[];
      invocationContext: ReturnType<typeof invocationContext>;
      authority: ReturnType<typeof claimAuthority>;
    }) => void;
    const claim = vi.fn(() => new Promise<{
      ok: true;
      environment: Record<string, string>;
      unsetEnvironmentVariableNames: string[];
      sensitiveEnvironmentVariableNames: string[];
      invocationContext: ReturnType<typeof invocationContext>;
      authority: ReturnType<typeof claimAuthority>;
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
    await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(1));
    let disposed = false;
    const disposing = owner.dispose().then(() => {
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
      invocationContext: invocationContext({
        PROVIDER_SECRET: 'must-not-escape',
      }),
      authority: claimAuthority(),
    });

    await expect(claiming).rejects.toThrow(
      'Foreground Agent runtime admission is unavailable',
    );
    await disposing;
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
