import { describe, expect, it, vi } from 'vitest';

import {
  ProviderConnectionIdSchema,
  RestartAllSessionRunnersResultV1Schema,
  RestartSessionRunnerResultV1Schema,
} from '@happier-dev/protocol';
import {
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV,
} from '@happier-dev/plugin-sdk/connected-accounts';

import type { TrackedSession } from '@/daemon/types';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

import type { SessionRunnerEntrypointIdentity } from '../sessionRunnerRuntime/types';
import {
  restartAllSessionRunnersOnCurrentRuntime,
  restartSessionRunnerForRequestAuthSourceCutover,
  restartSessionRunnerOnCurrentRuntime,
} from './restartSessionRunnerOnCurrentRuntime';
import {
  resolveRequestAuthSourceCutoverRequirement,
} from './requestAuthSourceCutover';

function currentIdentity(version: string): SessionRunnerEntrypointIdentity {
  return {
    status: 'known',
    source: 'launch_spec',
    comparableId: `version:${version}`,
    entrypointVersion: version,
  };
}

function unknownCurrentIdentity(): SessionRunnerEntrypointIdentity {
  return { status: 'unknown', source: 'unknown', reason: 'entrypoint_not_found' };
}

const gatewayConnectionId = ProviderConnectionIdSchema.parse('pc_gateway');

function trackedSession(overrides: Partial<TrackedSession> = {}): TrackedSession {
  return {
    startedBy: 'daemon',
    pid: 4242,
    happySessionId: 'sess-1',
    processCommandHash: 'hash-1',
    processStartTimeMs: 12_345,
    processCommand:
      'node /Users/alice/.happier/cli-dev/versions/0.2.10/package-dist/index.mjs claude --happy-starting-mode remote --started-by daemon',
    vendorResumeId: 'claude-thread-1',
    spawnOptions: {
      directory: '/tmp/workspace',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      resume: 'claude-thread-1',
    } satisfies SpawnSessionOptions,
    ...overrides,
  };
}

function providerRecoveryRequest() {
  return {
    v: 2 as const,
    sessionId: 'sess-1',
    mode: 'force_current_cli' as const,
    reason: 'provider_binding_change_recovery' as const,
    expectedRunnerPid: 4242,
    expectedProcessCommandHash: 'hash-1',
    expectedRunnerEntrypointIdentity: 'version:0.2.10',
    expectedRunnerProcessIdentity: {
      pid: 4242,
      processStartTimeMs: 12_345,
    },
  };
}

describe('restartSessionRunnerOnCurrentRuntime', () => {
  it('requests a version runtime refresh for stale eligible runners', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'if_stale',
        reason: 'daemon_restart_session_runners_command',
      },
      tracked: trackedSession(),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 'restarted',
      sessionId: 'sess-1',
    }));
    expect(RestartSessionRunnerResultV1Schema.parse(result)).toEqual(result);
    expect(requestRestart).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-1',
      tracked: expect.objectContaining({ pid: 4242 }),
      reason: 'version_runtime_refresh',
      canSignal: expect.any(Function),
    }));
  });

  it('includes the replacement runner summary when respawn completion is reported', async () => {
    const requestRestart = vi.fn(async () => ({
      signaled: true,
      completion: {
        ok: true as const,
        next: {
          pid: 5252,
          cliVersion: '0.2.11',
          entrypointVersion: '0.2.11',
          processCommandHash: 'hash-new',
        },
      },
    }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'if_stale',
        reason: 'daemon_restart_session_runners_command',
      },
      tracked: trackedSession(),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 'restarted',
      previous: expect.objectContaining({ pid: 4242, processCommandHash: 'hash-1' }),
      next: expect.objectContaining({ pid: 5252, processCommandHash: 'hash-new' }),
    }));
    expect(RestartSessionRunnerResultV1Schema.parse(result)).toEqual(result);
  });

  it('returns a typed failure when respawn completion reports a terminal failure', async () => {
    const requestRestart = vi.fn(async () => ({
      signaled: true,
      completion: {
        ok: false as const,
        status: 'spawn_failed' as const,
        reasonCode: 'missing_credentials' as const,
        diagnostics: { respawnTerminalReason: 'not_authenticated' },
      },
    }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'if_stale',
        reason: 'daemon_restart_session_runners_command',
      },
      tracked: trackedSession(),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'spawn_failed',
      reasonCode: 'missing_credentials',
      previous: expect.objectContaining({ pid: 4242 }),
      diagnostics: { respawnTerminalReason: 'not_authenticated' },
    }));
    expect(RestartSessionRunnerResultV1Schema.parse(result)).toEqual(result);
  });

  it('does not restart unknown runner identity in if_stale mode', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'if_stale',
        reason: 'daemon_restart_session_runners_command',
      },
      tracked: trackedSession({ processCommand: 'node --happy-starting-mode remote' }),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'version_unknown',
      reasonCode: 'runner_entrypoint_unknown',
    }));
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it('only force-restarts unknown runner identity when explicitly requested and current identity is known', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'force_current_cli',
        reason: 'daemon_restart_session_runners_command',
      },
      tracked: trackedSession({ processCommand: 'node --happy-starting-mode remote' }),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
    });

    expect(result.status).toBe('restarted');
    expect(requestRestart).toHaveBeenCalledTimes(1);
  });

  it('force-restarts an explicit Provider selection change without manufacturing a security confirmation', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        ...providerRecoveryRequest(),
      },
      tracked: trackedSession(),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
    });

    expect(result.status).toBe('restarted');
    expect(requestRestart).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-1',
      tracked: expect.objectContaining({ pid: 4242 }),
      reason: 'version_runtime_refresh',
      canSignal: expect.any(Function),
    }));
  });

  it('rejects Provider recovery V2 when the observed process birth no longer matches', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: providerRecoveryRequest(),
      tracked: trackedSession({ processStartTimeMs: 12_346 }),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
    });

    expect(result).toMatchObject({
      status: 'runner_identity_changed',
      sessionId: 'sess-1',
    });
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it('scopes an exact Provider security-change confirmation to the requested respawn', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));
    const previousBinding = {
      v: 1 as const,
      connectionId: gatewayConnectionId,
      contributionKey: null,
      connectionRevision: 1,
      protocol: 'openai-responses' as const,
      materialization: 'engineConfig' as const,
      compatibilityFingerprint: 'compatibility:v1:a',
      bindingSecurityFingerprint: 'binding-security:v1:a',
      displaySnapshot: {
        providerName: 'Gateway', connectionName: 'Work', connectionRole: 'named' as const,
        connectionDisplayNameMode: 'custom' as const,
      },
    };
    const tracked = trackedSession({
      spawnOptions: {
        ...trackedSession().spawnOptions!,
        modelSelection: {
          v: 1,
          updatedAt: 1,
          ref: { agentTargetKey: 'backend:claude', providerConnectionId: gatewayConnectionId, modelId: 'model-a' },
        },
        providerBindingMetadataV1: previousBinding,
      },
    });
    const confirmation = {
      v: 1 as const,
      sessionId: 'sess-1',
      connectionId: gatewayConnectionId,
      previousBindingSecurityFingerprint: 'binding-security:v1:a',
      nextBindingSecurityFingerprint: 'binding-security:v1:b',
    };

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        ...providerRecoveryRequest(),
        providerBindingSecurityChangeConfirmationV1: confirmation,
      },
      tracked,
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
    });

    expect(result.status).toBe('restarted');
    expect(requestRestart).toHaveBeenCalledWith(expect.objectContaining({
      transientSpawnOptions: expect.objectContaining({
        providerBindingSecurityChangeConfirmationV1: confirmation,
      }),
    }));
    expect(tracked.spawnOptions).not.toHaveProperty('providerBindingSecurityChangeConfirmationV1');
  });

  it('refuses a Provider recovery confirmation for a different prior runner binding', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));
    const base = trackedSession();
    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        ...providerRecoveryRequest(),
        providerBindingSecurityChangeConfirmationV1: {
          v: 1 as const,
          sessionId: 'sess-1',
          connectionId: gatewayConnectionId,
          previousBindingSecurityFingerprint: 'binding-security:v1:a',
          nextBindingSecurityFingerprint: 'binding-security:v1:b',
        },
      },
      tracked: trackedSession({
        spawnOptions: {
          ...base.spawnOptions!,
          providerBindingMetadataV1: {
            v: 1,
            connectionId: gatewayConnectionId,
            contributionKey: null,
            connectionRevision: 1,
            protocol: 'openai-responses',
            materialization: 'engineConfig',
            compatibilityFingerprint: 'compatibility:v1:a',
            bindingSecurityFingerprint: 'binding-security:v1:other',
            displaySnapshot: {
              providerName: 'Gateway', connectionName: 'Work', connectionRole: 'named',
              connectionDisplayNameMode: 'custom',
            },
          },
        },
      }),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
    });

    expect(result.status).toBe('runner_identity_changed');
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it('does not restart when the runner starting mode cannot be proven remote', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'force_current_cli',
        reason: 'daemon_restart_session_runners_command',
      },
      tracked: trackedSession({
        processCommand:
          'node /Users/alice/.happier/cli-dev/versions/0.2.10/package-dist/index.mjs claude --started-by daemon',
      }),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'ineligible',
      reasonCode: 'not_remote_started',
    }));
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it('does not signal while the runner has in-flight activity', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'force_current_cli',
        reason: 'daemon_restart_session_runners_command',
      },
      tracked: trackedSession(),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
      resolveActivityDisabledReason: () => 'turn_in_progress',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'busy',
      reasonCode: 'turn_in_progress',
    }));
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it.each([
    { activeTurnId: 'turn-active' },
    { reattachedInterruptedTurnId: 'turn-reattached' },
  ])('uses tracked turn custody as the activity owner before signalling (%o)', async (activity) => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'force_current_cli',
        reason: 'daemon_restart_session_runners_command',
      },
      tracked: trackedSession(activity),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
      resolveActivityDisabledReason: () => null,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'busy',
      reasonCode: 'turn_in_progress',
    }));
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it('fails closed when the exact process birth witness is stale despite the same PID', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'force_current_cli',
        reason: 'daemon_restart_session_runners_command',
      },
      expectedRunnerProcessIdentity: {
        pid: 4242,
        processStartTimeMs: 12_344,
        processCommandHash: 'hash-1',
        runnerEntrypointIdentity: 'version:0.2.10',
      },
      tracked: trackedSession(),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'runner_identity_changed',
    }));
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it('rechecks the exact process birth witness at the final signal boundary', async () => {
    const tracked = trackedSession();
    const requestRestart = vi.fn(async (input) => {
      expect(input.canSignal).toEqual(expect.any(Function));
      tracked.processStartTimeMs = 12_346;
      expect(await Promise.resolve(input.canSignal?.())).toBe('runner_identity_changed');
      return {
        signaled: false,
        notSignaledReason: 'runner_identity_changed' as const,
      };
    });

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'force_current_cli',
        reason: 'daemon_restart_session_runners_command',
      },
      expectedRunnerProcessIdentity: {
        pid: 4242,
        processStartTimeMs: 12_345,
        processCommandHash: 'hash-1',
        runnerEntrypointIdentity: 'version:0.2.10',
      },
      tracked,
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'runner_identity_changed',
    }));
  });

  it('rechecks the observed command hash at the final signal boundary', async () => {
    const tracked = trackedSession();
    const requestRestart = vi.fn(async (input) => {
      expect(input.canSignal).toEqual(expect.any(Function));
      tracked.processCommandHash = 'hash-replaced';
      expect(await Promise.resolve(input.canSignal?.())).toBe('runner_identity_changed');
      return {
        signaled: false,
        notSignaledReason: 'runner_identity_changed' as const,
      };
    });

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'force_current_cli',
        reason: 'daemon_restart_session_runners_command',
        expectedRunnerPid: 4242,
        expectedProcessCommandHash: 'hash-1',
        expectedRunnerEntrypointIdentity: 'version:0.2.10',
      },
      expectedRunnerProcessIdentity: {
        pid: 4242,
        processStartTimeMs: 12_345,
        processCommandHash: 'hash-1',
        runnerEntrypointIdentity: 'version:0.2.10',
      },
      tracked,
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'runner_identity_changed',
    }));
  });

  it('re-resolves the current entrypoint at the final signal boundary', async () => {
    let currentEntrypointVersion = '0.2.11';
    const requestRestart = vi.fn(async (input) => {
      expect(input.canSignal).toEqual(expect.any(Function));
      currentEntrypointVersion = '0.2.10';
      expect(await Promise.resolve(input.canSignal?.())).toBe(false);
      return {
        signaled: false,
        notSignaledReason: 'runner_identity_changed' as const,
      };
    });

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'if_stale',
        reason: 'daemon_restart_session_runners_command',
      },
      tracked: trackedSession(),
      currentIdentity: currentIdentity(currentEntrypointVersion),
      resolveCurrentIdentity: () => currentIdentity(currentEntrypointVersion),
      requestRestart,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 'already_current',
    }));
  });

  it('rechecks tracked turn custody after an external deferral queue reports idle', async () => {
    const tracked = trackedSession();
    const requestRestart = vi.fn(async (input) => {
      tracked.activeTurnId = 'turn-started-after-initial-check';
      expect(await Promise.resolve(input.canSignal?.())).toBe('turn_in_progress');
      return {
        signaled: false,
        notSignaledReason: 'turn_in_progress' as const,
      };
    });

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'force_current_cli',
        reason: 'daemon_restart_session_runners_command',
      },
      tracked,
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
      resolveActivityDisabledReason: () => null,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'busy',
      reasonCode: 'turn_in_progress',
    });
  });

  it('fails a direct source-cutover restart closed without the typed pending requirement owner', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'force_current_cli',
        reason: 'daemon_dist_generation_rollout',
        expectedRunnerPid: 4242,
        expectedProcessCommandHash: 'hash-1',
      },
      tracked: trackedSession(),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'ineligible',
      reasonCode: 'runner_generation_unattested',
    });
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it('fails closed when the internal source-cutover requirement is no longer current', async () => {
    const currentCapabilityPath =
      '/tmp/materialized/csm-1/request-auth/capability.json';
    const tracked = trackedSession({
      spawnOptions: {
        ...trackedSession().spawnOptions!,
        environmentVariables: {
          HAPPIER_OPENCODE_BROKER_STATE_PATH:
            '/tmp/materialized/csm-1/connected-service-broker.state.json',
        },
      },
    });
    const resolved = resolveRequestAuthSourceCutoverRequirement({
      tracked,
      currentCapabilityPath,
    });
    if (resolved.status !== 'required') {
      throw new Error('Expected source-cutover requirement');
    }
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result =
      await restartSessionRunnerForRequestAuthSourceCutover({
      tracked,
      currentIdentity: currentIdentity('0.2.10'),
      requestRestart,
      requirement: resolved.requirement,
      resolveCurrentCapabilityPath: () =>
        '/tmp/materialized/csm-2/request-auth/capability.json',
      resolveActivityDisabledReason: () => null,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'ineligible',
      reasonCode: 'runner_generation_unattested',
    }));
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it('routes a same-version exact source mismatch through the final signal gate and revalidates it', async () => {
    const currentCapabilityPath =
      '/tmp/materialized/csm-1/request-auth/capability.json';
    const tracked = trackedSession({
      spawnOptions: {
        ...trackedSession().spawnOptions!,
        environmentVariables: {
          HAPPIER_OPENCODE_BROKER_STATE_PATH:
            '/tmp/materialized/csm-1/connected-service-broker.state.json',
        },
      },
    });
    const resolved = resolveRequestAuthSourceCutoverRequirement({
      tracked,
      currentCapabilityPath,
    });
    if (resolved.status !== 'required') {
      throw new Error('Expected source-cutover requirement');
    }
    const requestRestart = vi.fn(async (input) => {
      expect(input.canSignal).toEqual(expect.any(Function));
      tracked.reattachedInterruptedTurnId =
        'turn-before-daemon-replacement';
      expect(
        await Promise.resolve(input.canSignal?.()),
      ).toBe('turn_in_progress');
      delete tracked.reattachedInterruptedTurnId;
      expect(
        await Promise.resolve(input.canSignal?.()),
      ).toBe(true);
      tracked.spawnOptions = {
        ...tracked.spawnOptions!,
        environmentVariables: {
          [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]:
            currentCapabilityPath,
        },
      };
      expect(
        await Promise.resolve(input.canSignal?.()),
      ).toBe('source_cutover_requirement_missing');
      return {
        signaled: false,
        notSignaledReason: 'source_cutover_requirement_missing' as const,
      };
    });

    const result =
      await restartSessionRunnerForRequestAuthSourceCutover({
      tracked,
      currentIdentity: currentIdentity('0.2.10'),
      requestRestart,
      requirement: resolved.requirement,
      resolveCurrentCapabilityPath: () => currentCapabilityPath,
      resolveActivityDisabledReason: () => null,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'busy',
      reasonCode: 'runner_generation_unattested',
    }));
    expect(requestRestart).toHaveBeenCalledOnce();
  });

  it('rechecks the canonical activity owner immediately before signaling a source cutover', async () => {
    const currentCapabilityPath =
      '/tmp/materialized/csm-1/request-auth/capability.json';
    const tracked = trackedSession({
      spawnOptions: {
        ...trackedSession().spawnOptions!,
        environmentVariables: {
          HAPPIER_OPENCODE_BROKER_STATE_PATH:
            '/tmp/materialized/csm-1/connected-service-broker.state.json',
        },
      },
    });
    const resolved = resolveRequestAuthSourceCutoverRequirement({
      tracked,
      currentCapabilityPath,
    });
    if (resolved.status !== 'required') {
      throw new Error('Expected source-cutover requirement');
    }
    let activityDisabledReason: 'turn_in_progress' | null = null;
    const requestRestart = vi.fn(async (input) => {
      activityDisabledReason = 'turn_in_progress';
      expect(await Promise.resolve(input.canSignal?.())).toBe(
        'turn_in_progress',
      );
      return {
        signaled: false,
        notSignaledReason: 'turn_in_progress' as const,
      };
    });

    const result =
      await restartSessionRunnerForRequestAuthSourceCutover({
        tracked,
        currentIdentity: currentIdentity('0.2.10'),
        requestRestart,
        requirement: resolved.requirement,
        resolveCurrentCapabilityPath: () =>
          currentCapabilityPath,
        resolveActivityDisabledReason: () =>
          activityDisabledReason,
      });

    expect(result).toMatchObject({
      ok: false,
      status: 'busy',
      reasonCode: 'turn_in_progress',
    });
    expect(requestRestart).toHaveBeenCalledOnce();
  });

  it('requires deadline-free canonical respawn completion before accepting a source cutover', async () => {
    const currentCapabilityPath =
      '/tmp/materialized/csm-1/request-auth/capability.json';
    const tracked = trackedSession({
      spawnOptions: {
        ...trackedSession().spawnOptions!,
        environmentVariables: {
          HAPPIER_OPENCODE_BROKER_STATE_PATH:
            '/tmp/materialized/csm-1/connected-service-broker.state.json',
        },
      },
    });
    const resolved = resolveRequestAuthSourceCutoverRequirement({
      tracked,
      currentCapabilityPath,
    });
    if (resolved.status !== 'required') {
      throw new Error('Expected source-cutover requirement');
    }
    const requestRestart = vi.fn(async (input) => {
      expect(input.completionTimeoutMs).toBeNull();
      return { signaled: true };
    });

    const result =
      await restartSessionRunnerForRequestAuthSourceCutover({
        tracked,
        currentIdentity: currentIdentity('0.2.10'),
        requestRestart,
        requirement: resolved.requirement,
        resolveCurrentCapabilityPath: () =>
          currentCapabilityPath,
        resolveActivityDisabledReason: () => null,
      });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'partial_failure',
      diagnostics: {
        respawnTerminalReason:
          'canonical_respawn_completion_missing',
      },
    }));
    expect(requestRestart).toHaveBeenCalledOnce();
  });

  it('preserves exact disabled reason from the final pre-signal activity gate', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: false, notSignaledReason: 'approval_pending' as const }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'force_current_cli',
        reason: 'daemon_restart_session_runners_command',
      },
      tracked: trackedSession(),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'busy',
      reasonCode: 'approval_pending',
    }));
    expect(requestRestart).toHaveBeenCalledTimes(1);
  });

  it('does not force-restart when the current daemon entrypoint is unknown', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'force_current_cli',
        reason: 'daemon_restart_session_runners_command',
      },
      tracked: trackedSession(),
      currentIdentity: unknownCurrentIdentity(),
      requestRestart,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'version_unknown',
      reasonCode: 'current_entrypoint_unknown',
    }));
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it('does not restart daemon-started local mode runners', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'force_current_cli',
        reason: 'daemon_restart_session_runners_command',
      },
      tracked: trackedSession({
        processCommand:
          'node /Users/alice/.happier/cli-dev/versions/0.2.10/package-dist/index.mjs claude --happy-starting-mode local --started-by daemon',
      }),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'ineligible',
      reasonCode: 'not_remote_started',
    }));
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it('does not restart Windows-hosted runners', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));
    const base = trackedSession();
    if (!base.spawnOptions) throw new Error('Expected spawn options fixture');

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'force_current_cli',
        reason: 'daemon_restart_session_runners_command',
      },
      tracked: trackedSession({
        spawnOptions: {
          ...base.spawnOptions,
          windowsRemoteSessionLaunchMode: 'windows_terminal',
        },
      }),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'ineligible',
      reasonCode: 'windows_hosted_runner',
    }));
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it('does not kill a runner whose startup instructions make cold resume unproven', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'force_current_cli',
        reason: 'daemon_restart_session_runners_command',
      },
      tracked: trackedSession({
        agentSessionStartupInstructionsMarkerV1: {
          v: 1,
          id: 'happier.global_voice_agent',
          revision: 7,
        },
      }),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'missing_resume_snapshot',
      reasonCode: 'missing_resume_identity',
    }));
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it.each([
    ['missing command hash', { processCommandHash: undefined }],
    ['missing process birth', { processStartTimeMs: undefined }],
    ['non-finite process birth', { processStartTimeMs: Number.NaN }],
  ] satisfies ReadonlyArray<readonly [string, Partial<TrackedSession>]>) (
    'keeps explicit restart non-mutating for %s',
    async (_label, overrides) => {
      const requestRestart = vi.fn(async () => ({ signaled: true }));

      const result = await restartSessionRunnerOnCurrentRuntime({
        request: {
          sessionId: 'sess-1',
          mode: 'force_current_cli',
          reason: 'daemon_restart_session_runners_command',
        },
        tracked: trackedSession(overrides),
        currentIdentity: currentIdentity('0.2.11'),
        requestRestart,
      });

      expect(result).toMatchObject({
        ok: false,
        status: 'ineligible',
        reasonCode: 'non_destructive_refresh_unsupported',
      });
      expect(requestRestart).not.toHaveBeenCalled();
    },
  );

  it('fails idempotently when expected PID or command hash no longer matches', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'force_current_cli',
        reason: 'ui_stale_runner_banner',
        expectedRunnerPid: 9999,
        expectedProcessCommandHash: 'hash-1',
      },
      tracked: trackedSession(),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
    });

    expect(result.status).toBe('runner_identity_changed');
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it('reports runner identity changed when the planned restart signal rejects an unsafe process', async () => {
    const requestRestart = vi.fn(async () => ({
      signaled: false,
      notSignaledReason: 'unsafe_process' as const,
    }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'force_current_cli',
        reason: 'ui_stale_runner_banner',
      },
      tracked: trackedSession(),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
    });

    expect(result.status).toBe('runner_identity_changed');
    expect(requestRestart).toHaveBeenCalledTimes(1);
  });

  it('supports dry-run without signalling the runner', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId: 'sess-1',
        mode: 'if_stale',
        dryRun: true,
        reason: 'daemon_restart_session_runners_command',
      },
      tracked: trackedSession(),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
    });

    expect(result.status).toBe('dry_run_restartable');
    expect(requestRestart).not.toHaveBeenCalled();
  });
});

describe('restartAllSessionRunnersOnCurrentRuntime', () => {
  it.each([
    [
      'process birth',
      (tracked: TrackedSession) => {
        tracked.processStartTimeMs = 12_346;
      },
    ],
    [
      'command hash',
      (tracked: TrackedSession) => {
        tracked.processCommandHash = 'hash-replaced';
      },
    ],
    [
      'runner entrypoint identity',
      (tracked: TrackedSession) => {
        tracked.processCommand = (tracked.processCommand ?? '').replace(
          '/versions/0.2.10/',
          '/versions/0.2.12/',
        );
      },
    ],
  ] satisfies ReadonlyArray<readonly [string, (tracked: TrackedSession) => void]>) (
    'captures each exact runner process witness before asynchronous currentness resolution when the %s changes',
    async (_label, mutateTracked) => {
    const tracked = trackedSession();
    const requestRestart = vi.fn(async () => ({ signaled: true }));
    const resolveAgentRuntimeCurrentness = vi.fn(async () => {
      mutateTracked(tracked);
      return {
        versionState: 'stale' as const,
        restartUnavailableReason: null,
      };
    });

    const result = await restartAllSessionRunnersOnCurrentRuntime({
      mode: 'force_current_cli',
      reason: 'daemon_restart_session_runners_command',
      currentIdentity: currentIdentity('0.2.11'),
      trackedSessions: [tracked],
      requestRestart,
      resolveAgentRuntimeCurrentness,
    });

    expect(result.results).toEqual([
      expect.objectContaining({
        ok: false,
        status: 'runner_identity_changed',
      }),
    ]);
    expect(requestRestart).not.toHaveBeenCalled();
    },
  );

  it('keeps bulk source-cutover restart requests non-mutating without per-runner requirements', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartAllSessionRunnersOnCurrentRuntime({
      mode: 'force_current_cli',
      reason: 'daemon_dist_generation_rollout',
      currentIdentity: currentIdentity('0.2.11'),
      trackedSessions: [
        trackedSession({ happySessionId: 'sess-1', pid: 4242 }),
        trackedSession({ happySessionId: 'sess-2', pid: 4243 }),
      ],
      requestRestart,
    });

    expect(result).toMatchObject({
      ok: true,
      requestedCount: 2,
      restartedCount: 0,
      skippedCount: 2,
      failedCount: 0,
    });
    expect(result.results).toEqual([
      expect.objectContaining({
        sessionId: 'sess-1',
        status: 'ineligible',
        reasonCode: 'runner_generation_unattested',
      }),
      expect.objectContaining({
        sessionId: 'sess-2',
        status: 'ineligible',
        reasonCode: 'runner_generation_unattested',
      }),
    ]);
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it('threads bulk dry-run into each per-session restart check without signaling runners', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartAllSessionRunnersOnCurrentRuntime({
      mode: 'force_current_cli',
      reason: 'daemon_restart_session_runners_command',
      dryRun: true,
      currentIdentity: currentIdentity('0.2.11'),
      trackedSessions: [
        trackedSession({ happySessionId: 'sess-1', pid: 4242 }),
        trackedSession({ happySessionId: 'sess-2', pid: 4243 }),
      ],
      requestRestart,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      requestedCount: 2,
      restartedCount: 2,
      skippedCount: 0,
      failedCount: 0,
    }));
    expect(result.results.map((entry) => entry.status)).toEqual(['dry_run_restartable', 'dry_run_restartable']);
    expect(RestartAllSessionRunnersResultV1Schema.parse(result)).toEqual(result);
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it('omits tracked runners without session ids from the protocol aggregate', async () => {
    const requestRestart = vi.fn(async () => ({ signaled: true }));

    const result = await restartAllSessionRunnersOnCurrentRuntime({
      mode: 'force_current_cli',
      reason: 'daemon_restart_session_runners_command',
      dryRun: true,
      currentIdentity: currentIdentity('0.2.11'),
      trackedSessions: [
        trackedSession({ happySessionId: 'sess-1', pid: 4242 }),
        trackedSession({ happySessionId: undefined, pid: 4243 }),
      ],
      requestRestart,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      requestedCount: 1,
      restartedCount: 1,
      skippedCount: 0,
      failedCount: 0,
    }));
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toEqual(expect.objectContaining({ sessionId: 'sess-1' }));
    expect(RestartAllSessionRunnersResultV1Schema.parse(result)).toEqual(result);
    expect(requestRestart).not.toHaveBeenCalled();
  });
});
