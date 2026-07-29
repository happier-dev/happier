import { describe, expect, it, vi } from 'vitest';

import {
  ProviderConnectionIdSchema,
  RestartAllSessionRunnersResultV1Schema,
  RestartSessionRunnerResultV1Schema,
} from '@happier-dev/protocol';

import type { TrackedSession } from '@/daemon/types';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

import type { SessionRunnerEntrypointIdentity } from '../sessionRunnerRuntime/types';
import {
  restartAllSessionRunnersOnCurrentRuntime,
  restartSessionRunnerOnCurrentRuntime,
} from './restartSessionRunnerOnCurrentRuntime';

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
    expect(requestRestart).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      tracked: expect.objectContaining({ pid: 4242 }),
      reason: 'version_runtime_refresh',
    });
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
        sessionId: 'sess-1',
        mode: 'force_current_cli',
        reason: 'provider_binding_change_recovery',
      },
      tracked: trackedSession(),
      currentIdentity: currentIdentity('0.2.11'),
      requestRestart,
    });

    expect(result.status).toBe('restarted');
    expect(requestRestart).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      tracked: expect.objectContaining({ pid: 4242 }),
      reason: 'version_runtime_refresh',
    });
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
        sessionId: 'sess-1',
        mode: 'force_current_cli',
        reason: 'provider_binding_change_recovery',
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
        sessionId: 'sess-1',
        mode: 'force_current_cli',
        reason: 'provider_binding_change_recovery',
        providerBindingSecurityChangeConfirmationV1: {
          v: 1,
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
