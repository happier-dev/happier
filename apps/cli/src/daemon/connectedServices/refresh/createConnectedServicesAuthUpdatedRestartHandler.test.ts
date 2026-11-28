import { describe, expect, it, vi } from 'vitest';

import type { ConnectedServiceId } from '@happier-dev/protocol';
import type { CatalogAgentId } from '@/backends/types';
import { agent as openCodeAgent } from '@/backends/opencode';
import { agent as piAgent } from '@/backends/pi';
import type { ConnectedServiceCredentialLifecycleDescriptor } from '@/daemon/connectedServices/credentials/lifecycleTypes';
import type { TrackedSession } from '@/daemon/types';
import { requestPlannedRunnerRestart } from '@/daemon/plannedRunnerRestart/requestPlannedRunnerRestart';
import { createRestartCompletionWaiters } from '@/daemon/plannedRunnerRestart/completionWaiters';
import { createConnectedServiceSwitchDeferralQueue } from '@/daemon/connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue';
import { createConnectedServicesAuthUpdatedRestartHandler } from './createConnectedServicesAuthUpdatedRestartHandler';

const directLiveExternalTokenInjectionCapability = {
  supportsInTurnApply: true,
  requiresExactRuntimeIdentity: true,
  refreshSelectionResync: 'required',
  authMode: {
    kind: 'external_token_injection',
    surface: 'codex_chatgpt_auth_tokens',
  },
} as const;

describe('createConnectedServicesAuthUpdatedRestartHandler', () => {
  type RestartHandlerParams = Parameters<typeof createConnectedServicesAuthUpdatedRestartHandler>[0];
  type RestartSignalParams = Parameters<RestartHandlerParams['requestRestartSignal']>[0];

  function createTrackedSession(input: Readonly<{
    pid: number;
    sessionId: string;
    startedBy?: TrackedSession['startedBy'];
    spawnOptions?: TrackedSession['spawnOptions'];
  }>): TrackedSession {
    return {
      pid: input.pid,
      startedBy: input.startedBy ?? 'daemon',
      happySessionId: input.sessionId,
      ...(input.spawnOptions ? { spawnOptions: input.spawnOptions } : {}),
    };
  }

  function createLifecycleDescriptor(
    agentId: CatalogAgentId,
    mode: 'restart_required' | 'no_restart_required',
    options: Readonly<{
      noRestartRequiredWhenAccessTokenCallbackServiceIds?: ReadonlyArray<ConnectedServiceId>;
    }> = {},
  ): ConnectedServiceCredentialLifecycleDescriptor {
    return {
      providerId: agentId,
      serviceIds: ['claude-subscription'],
      generationApplicationScope: 'per_session_runtime',
      spawnPreflightOauthRefresh: { mode: 'expiry_window' },
      refreshedCredentialApplication: {
        mode,
        ...(options.noRestartRequiredWhenAccessTokenCallbackServiceIds
          ? {
              noRestartRequiredWhenAccessTokenCallbackServiceIds:
                options.noRestartRequiredWhenAccessTokenCallbackServiceIds,
            }
          : {}),
      },
      predictiveSoftSwitch: { mode: agentId === 'codex' ? 'supported' : 'unsupported' },
      sameAccountFanoutStrategy: agentId === 'codex' ? 'provider_account_id' : 'none',
      runtimeAuthApply: {
        directLiveHotAuth: agentId === 'codex'
          ? directLiveExternalTokenInjectionCapability
          : 'unsupported',
      },
    };
  }

  function createRestartSignalAdapter(
    restartRequestedPids = new Set<number>(),
    queue = createConnectedServiceSwitchDeferralQueue({ timeoutMs: 60_000, disableDeferral: false }),
    signalError?: Error,
  ) {
    const completionWaiters = createRestartCompletionWaiters({ timeoutMs: 60_000 });
    return vi.fn(async (input: RestartSignalParams) => requestPlannedRunnerRestart({
      sessionId: input.sessionId ?? '', tracked: input.tracked,
      reason: 'connected_service_switch',
      deferral: {
        kind: 'connected_service_switch', source: 'automatic', policy: 'defer_until_turn_boundary',
        target: { ...input.target, generation: input.target.generation ?? 0 }, turnDeferralQueue: queue,
      },
      restartRequestedPids, completionWaiters,
      pidToTrackedSession: new Map([[input.pid, input.tracked]]),
      isProcessSafeToSignal: async () => true,
      canSignal: input.shouldSignal,
      // The OS signal adapter is the only replaced boundary; admission and deferral stay real.
      requestSignal: async ({ shouldSignal, onSignalFailure }) => {
        if (!await shouldSignal()) return { status: 'skipped_stale_owner' };
        if (signalError) { onSignalFailure(signalError); throw signalError; }
        return { status: 'requested' };
      },
      logDebug: () => {},
    }));
  }

  it('marks restart-required targets and requests a restart signal without killing the child directly', async () => {
    const restartRequestedPids = new Set<number>();
    const kill = vi.fn();
    const requestRestartSignal = createRestartSignalAdapter(restartRequestedPids);
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 's1' })],
      [2, createTrackedSession({ pid: 2, sessionId: 's2' })],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) =>
        createLifecycleDescriptor(agentId, agentId === 'claude' ? 'restart_required' : 'no_restart_required'),
      resolveProcessGroupPid: (tracked) => tracked.pid,
      requestRestartSignal,
      restartSignalDelayMs: 250,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work', groupId: 'team', generation: 7 },
      affectedTargets: [
        { pid: 1, agentId: 'claude' },
        { pid: 2, agentId: 'codex' },
      ],
    });

    expect(restartRequestedPids.has(1)).toBe(true);
    expect(restartRequestedPids.has(2)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    expect(requestRestartSignal).toHaveBeenCalledWith(expect.objectContaining({
      pid: 1,
      processGroupPid: 1,
      delayMs: 250,
      restartDiagnostic: expect.objectContaining({
        trigger: 'refresh_triggered_restart',
        sessionId: 's1',
        agentId: 'claude',
        serviceId: 'claude-subscription',
        profileId: 'work',
        groupId: 'team',
        generation: 7,
      }),
    }));
  });

  it('schedules a runtime-directed restart even when the provider default reads credentials live', async () => {
    const restartRequestedPids = new Set<number>();
    const tracked = createTrackedSession({ pid: 1, sessionId: 's1' });
    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      pidToTrackedSession: new Map([[1, tracked]]),
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'no_restart_required'),
      resolveProcessGroupPid: (session) => session.pid,
      requestRestartSignal: createRestartSignalAdapter(restartRequestedPids),
      restartSignalDelayMs: 250,
    });

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
      adapterRestartRequiredPids: new Set([1]),
    });

    expect(restartRequestedPids).toEqual(new Set([1]));
  });

  it('stops a live target on credential deletion instead of applying restart policy', async () => {
    const tracked = createTrackedSession({ pid: 1, sessionId: 's1' });
    const requestRestartSignal = createRestartSignalAdapter();
    const stopSessionForCredentialDeletion = vi.fn(async () => ({ status: 'stopped' as const }));
    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      pidToTrackedSession: new Map([[1, tracked]]),
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'no_restart_required'),
      resolveProcessGroupPid: (session) => session.pid,
      requestRestartSignal,
      stopSessionForCredentialDeletion,
      restartSignalDelayMs: 250,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
      mutation: 'deleted',
      trigger: 'reconnect_propagation',
    });

    expect(stopSessionForCredentialDeletion).toHaveBeenCalledWith({
      tracked,
      target: { pid: 1, agentId: 'claude' },
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
    });
    expect(requestRestartSignal).not.toHaveBeenCalled();
  });

  it('schedules a turn-deferred credential restart without holding refresh propagation open', async () => {
    const tracked = createTrackedSession({ pid: 1, sessionId: 's1' });
    const restartRequestedPids = new Set<number>();
    const queue = createConnectedServiceSwitchDeferralQueue({ timeoutMs: 60_000, disableDeferral: false });
    queue.recordTurnLifecycleEvent({ sessionId: 's1', event: 'task_started' });
    const requestRestartSignal = createRestartSignalAdapter(restartRequestedPids, queue);
    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      pidToTrackedSession: new Map([[1, tracked]]),
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'restart_required'),
      resolveProcessGroupPid: (session) => session.pid,
      requestRestartSignal,
      restartSignalDelayMs: 250,
    } satisfies RestartHandlerParams);

    await expect(handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
    })).resolves.toBeUndefined();

    expect(requestRestartSignal).toHaveBeenCalledOnce();
    expect(restartRequestedPids.has(1)).toBe(false);
    queue.recordTurnLifecycleEvent({ sessionId: 's1', event: 'assistant_message_end' });
    await vi.waitFor(() => expect(restartRequestedPids.has(1)).toBe(true));
  });

  it('rejects credential deletion acknowledgement when canonical stop reports incomplete termination', async () => {
    const tracked = createTrackedSession({ pid: 1, sessionId: 's1' });
    const requestRestartSignal = createRestartSignalAdapter();
    const stopSessionForCredentialDeletion = vi.fn(async () => ({
      status: 'incomplete' as const,
      reason: 'runner_exit_timeout' as const,
    }));
    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      pidToTrackedSession: new Map([[1, tracked]]),
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'no_restart_required'),
      resolveProcessGroupPid: (session) => session.pid,
      requestRestartSignal,
      stopSessionForCredentialDeletion,
      restartSignalDelayMs: 250,
    } satisfies RestartHandlerParams);

    await expect(handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
      mutation: 'deleted',
      trigger: 'reconnect_propagation',
    })).rejects.toMatchObject({
      name: 'ConnectedServiceCredentialDeletionNotSettledError',
      stopResult: {
        status: 'incomplete',
        reason: 'runner_exit_timeout',
      },
    });
    expect(requestRestartSignal).not.toHaveBeenCalled();
  });

  it('rejects credential deletion acknowledgement while canonical stop is only requested', async () => {
    const tracked = createTrackedSession({ pid: 1, sessionId: 's1' });
    const requestRestartSignal = createRestartSignalAdapter();
    const stopSessionForCredentialDeletion = vi.fn(async () => ({ status: 'requested' as const }));
    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      pidToTrackedSession: new Map([[1, tracked]]),
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'no_restart_required'),
      resolveProcessGroupPid: (session) => session.pid,
      requestRestartSignal,
      stopSessionForCredentialDeletion,
      restartSignalDelayMs: 250,
    } satisfies RestartHandlerParams);

    await expect(handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
      mutation: 'deleted',
      trigger: 'reconnect_propagation',
    })).rejects.toMatchObject({
      name: 'ConnectedServiceCredentialDeletionNotSettledError',
      stopResult: { status: 'requested' },
    });
    expect(requestRestartSignal).not.toHaveBeenCalled();
  });

  it('acknowledges not_found only after the canonical lifecycle owner removed the tracked target', async () => {
    const tracked = createTrackedSession({ pid: 1, sessionId: 's1' });
    const pidToTrackedSession = new Map([[1, tracked]]);
    const requestRestartSignal = createRestartSignalAdapter();
    const stopSessionForCredentialDeletion = vi.fn(async () => {
      pidToTrackedSession.delete(1);
      return { status: 'not_found' as const };
    });
    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'no_restart_required'),
      resolveProcessGroupPid: (session) => session.pid,
      requestRestartSignal,
      stopSessionForCredentialDeletion,
      restartSignalDelayMs: 250,
    } satisfies RestartHandlerParams);

    await expect(handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
      mutation: 'deleted',
      trigger: 'reconnect_propagation',
    })).resolves.toBeUndefined();
    expect(requestRestartSignal).not.toHaveBeenCalled();
  });

  it('rejects not_found when the tracked target still survives', async () => {
    const tracked = createTrackedSession({ pid: 1, sessionId: 's1' });
    const requestRestartSignal = createRestartSignalAdapter();
    const stopSessionForCredentialDeletion = vi.fn(async () => ({ status: 'not_found' as const }));
    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      pidToTrackedSession: new Map([[1, tracked]]),
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'no_restart_required'),
      resolveProcessGroupPid: (session) => session.pid,
      requestRestartSignal,
      stopSessionForCredentialDeletion,
      restartSignalDelayMs: 250,
    } satisfies RestartHandlerParams);

    await expect(handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
      mutation: 'deleted',
      trigger: 'reconnect_propagation',
    })).rejects.toMatchObject({
      name: 'ConnectedServiceCredentialDeletionNotSettledError',
      stopResult: { status: 'not_found' },
    });
    expect(requestRestartSignal).not.toHaveBeenCalled();
  });

  it('uses the gated restart path for a demonstrably surviving reattached runner', async () => {
    const restartRequestedPids = new Set<number>();
    const tracked = {
      ...createTrackedSession({ pid: 41, sessionId: 'reattached-session' }),
      reattachedFromDiskMarker: true,
    } satisfies TrackedSession;
    const requestRestartSignal = createRestartSignalAdapter(restartRequestedPids);
    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      pidToTrackedSession: new Map([[tracked.pid, tracked]]),
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'restart_required'),
      resolveProcessGroupPid: () => tracked.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work', groupId: 'team', generation: 7 },
      affectedTargets: [{ pid: tracked.pid, agentId: 'claude' }],
    });

    expect(requestRestartSignal).toHaveBeenCalledOnce();
    expect(restartRequestedPids).toContain(tracked.pid);
  });

  it('does not request a restart for a target that can refresh Claude subscription access tokens through the SDK callback', async () => {
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = createRestartSignalAdapter(restartRequestedPids);
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 's1' })],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) =>
        createLifecycleDescriptor(agentId, 'restart_required', {
          noRestartRequiredWhenAccessTokenCallbackServiceIds: ['claude-subscription'],
        }),
      resolveProcessGroupPid: (tracked) => tracked.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [
        {
          pid: 1,
          agentId: 'claude',
          accessTokenRefresh: { mode: 'daemon_callback', serviceIds: ['claude-subscription'] },
        },
      ],
    });

    expect(requestRestartSignal).not.toHaveBeenCalled();
    expect(restartRequestedPids.has(1)).toBe(false);
  });

  it('never restarts Claude sessions for refreshed claude-subscription credentials with the REAL catalog descriptor (stable home is read live by every runner shape)', async () => {
    // Live incident 2026-07-08: a unified-terminal Claude session (no SDK daemon_callback
    // capability) was restarted on every refresh distribution. The terminal `claude` binary
    // re-reads the stable home's .credentials.json live (user-proven), so NO Claude runner shape
    // needs a restart for a refreshed claude-subscription credential — only account SWITCHES
    // (generation applies, via the switch coordinator) restart sessions.
    const { resolveConnectedServiceCredentialLifecycleDescriptor } = await import('@/backends/catalog');
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = createRestartSignalAdapter(restartRequestedPids);
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 's1' })],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      pidToTrackedSession,
      resolveLifecycleDescriptor: resolveConnectedServiceCredentialLifecycleDescriptor,
      resolveProcessGroupPid: (tracked) => tracked.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    // Unified-terminal shape: NO accessTokenRefresh capability on the target.
    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work', groupId: 'team', generation: 7 },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
    });

    expect(requestRestartSignal).not.toHaveBeenCalled();
    expect(restartRequestedPids.has(1)).toBe(false);
  });

  it('keeps restart fallback for targets without an active access-token callback', async () => {
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = createRestartSignalAdapter(restartRequestedPids);
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 's1' })],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) =>
        createLifecycleDescriptor(agentId, 'restart_required', {
          noRestartRequiredWhenAccessTokenCallbackServiceIds: ['claude-subscription'],
        }),
      resolveProcessGroupPid: (tracked) => tracked.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [
        {
          pid: 1,
          agentId: 'claude',
        },
      ],
    });

    expect(requestRestartSignal).toHaveBeenCalledWith(expect.objectContaining({ pid: 1 }));
    expect(restartRequestedPids.has(1)).toBe(true);
  });

  it('does not let a stale callback marker for another service suppress restart', async () => {
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = createRestartSignalAdapter(restartRequestedPids);
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 's1' })],
    ]);
    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'restart_required', {
        noRestartRequiredWhenAccessTokenCallbackServiceIds: ['claude-subscription'],
      }),
      resolveProcessGroupPid: (tracked) => tracked.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [{
        pid: 1,
        agentId: 'claude',
        accessTokenRefresh: { mode: 'daemon_callback', serviceIds: ['openai-codex'] },
      }],
    });

    expect(requestRestartSignal).toHaveBeenCalledWith(expect.objectContaining({ pid: 1 }));
  });

  it('fails toward a tracked-session deferral when authoritative callback proof cannot be resolved', async () => {
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = createRestartSignalAdapter(restartRequestedPids);
    const onRestartBlocked = vi.fn();
    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      pidToTrackedSession: new Map<number, TrackedSession>(),
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'restart_required', {
        noRestartRequiredWhenAccessTokenCallbackServiceIds: ['claude-subscription'],
      }),
      resolveProcessGroupPid: (tracked) => tracked.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
      onRestartBlocked,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [{
        pid: 1,
        agentId: 'claude',
        accessTokenRefresh: { mode: 'daemon_callback', serviceIds: ['openai-codex'] },
      }],
    });

    expect(requestRestartSignal).not.toHaveBeenCalled();
    expect(onRestartBlocked).toHaveBeenCalledWith(expect.objectContaining({
      pid: 1,
      reason: 'tracked_session_missing',
    }));
  });

  it('uses the registered Codex callback fact to preserve app-server sessions across same-account OAuth refreshes', async () => {
    const { resolveConnectedServiceCredentialLifecycleDescriptor } = await import('@/backends/catalog');
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = createRestartSignalAdapter(restartRequestedPids);
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({
        pid: 1,
        sessionId: 'codex-app-server',
        spawnOptions: { directory: '/tmp/codex-app-server', codexBackendMode: 'appServer' },
      })],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      pidToTrackedSession,
      resolveLifecycleDescriptor: resolveConnectedServiceCredentialLifecycleDescriptor,
      resolveProcessGroupPid: (tracked) => tracked.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'openai-codex', profileId: 'work', groupId: 'team', generation: 7 },
      affectedTargets: [{
        pid: 1,
        agentId: 'codex',
        accessTokenRefresh: { mode: 'daemon_callback', serviceIds: ['openai-codex'] },
      }],
    });

    expect(requestRestartSignal).not.toHaveBeenCalled();
    expect(restartRequestedPids.has(1)).toBe(false);
  });

  it('does not restart Codex when a runtime target lacks the app-server token callback', async () => {
    const { resolveConnectedServiceCredentialLifecycleDescriptor } = await import('@/backends/catalog');
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = createRestartSignalAdapter(restartRequestedPids);
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({
        pid: 1,
        sessionId: 'codex-acp',
        spawnOptions: { directory: '/tmp/codex-acp', codexBackendMode: 'acp' },
      })],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      pidToTrackedSession,
      resolveLifecycleDescriptor: resolveConnectedServiceCredentialLifecycleDescriptor,
      resolveProcessGroupPid: (tracked) => tracked.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'openai-codex', profileId: 'work', groupId: 'team', generation: 7 },
      affectedTargets: [{ pid: 1, agentId: 'codex' }],
    });

    expect(requestRestartSignal).not.toHaveBeenCalled();
    expect(restartRequestedPids.has(1)).toBe(false);
  });

  it('does not restart OpenCode or Pi for brokered same-account OAuth refreshes', async () => {
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = createRestartSignalAdapter(restartRequestedPids);
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 'opencode-session' })],
      [2, createTrackedSession({ pid: 2, sessionId: 'pi-session' })],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => {
        if (agentId === 'opencode') return await openCodeAgent.getConnectedServiceCredentialLifecycleDescriptor();
        if (agentId === 'pi') return await piAgent.getConnectedServiceCredentialLifecycleDescriptor();
        return createLifecycleDescriptor(agentId, 'restart_required');
      },
      resolveProcessGroupPid: (tracked) => tracked.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'openai-codex', profileId: 'work' },
      affectedTargets: [
        { pid: 1, agentId: 'opencode' },
        { pid: 2, agentId: 'pi' },
      ],
      trigger: 'refresh_triggered_restart',
    });

    expect(requestRestartSignal).not.toHaveBeenCalled();
    expect(restartRequestedPids.size).toBe(0);
  });

  it('restarts a Pi claude-subscription SETUP-TOKEN session on reconnect (raw api_key, no broker to hot-apply)', async () => {
    // R3-7: Pi's descriptor no-restart claim for claude-subscription is only truthful for the brokered
    // OAuth shape. A setup-token materializes as a raw api_key baked into auth.json at spawn (no broker
    // env), so a reconnected credential can only reach the running Pi process via a restart. The
    // absence of PI_BROKER_SELECTIONS_ENV on the tracked session marks it as the setup-token shape.
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = createRestartSignalAdapter(restartRequestedPids);
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 'pi-setup-token-session' })],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => {
        if (agentId === 'pi') return await piAgent.getConnectedServiceCredentialLifecycleDescriptor();
        return createLifecycleDescriptor(agentId, 'restart_required');
      },
      resolveProcessGroupPid: (tracked) => tracked.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [{ pid: 1, agentId: 'pi' }],
      trigger: 'reconnect_propagation',
    });

    expect(requestRestartSignal).toHaveBeenCalledWith(expect.objectContaining({ pid: 1 }));
    expect(restartRequestedPids.has(1)).toBe(true);
  });

  it('does not restart a Pi claude-subscription OAuth (brokered) session on reconnect', async () => {
    const { PI_BROKER_SELECTIONS_ENV, serializePiBrokerSelections } = await import('@/backends/pi/brokerExtension');
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = createRestartSignalAdapter(restartRequestedPids);
    const tracked: TrackedSession = {
      ...createTrackedSession({ pid: 1, sessionId: 'pi-brokered-session' }),
      spawnOptions: {
        directory: '/tmp/pi-brokered-session',
        environmentVariables: {
          [PI_BROKER_SELECTIONS_ENV]: serializePiBrokerSelections({
            anthropic: { serviceId: 'claude-subscription', profileId: 'work', accountId: null, planType: null },
          }),
        },
      },
    };
    const pidToTrackedSession = new Map<number, TrackedSession>([[1, tracked]]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => {
        if (agentId === 'pi') return await piAgent.getConnectedServiceCredentialLifecycleDescriptor();
        return createLifecycleDescriptor(agentId, 'restart_required');
      },
      resolveProcessGroupPid: (t) => t.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [{ pid: 1, agentId: 'pi' }],
      trigger: 'reconnect_propagation',
    });

    expect(requestRestartSignal).not.toHaveBeenCalled();
    expect(restartRequestedPids.has(1)).toBe(false);
  });

  it('still restarts OpenCode when a direct API-key connected service is reconnected', async () => {
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = createRestartSignalAdapter(restartRequestedPids);
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 'opencode-session' })],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => {
        if (agentId === 'opencode') return await openCodeAgent.getConnectedServiceCredentialLifecycleDescriptor();
        return createLifecycleDescriptor(agentId, 'restart_required');
      },
      resolveProcessGroupPid: (tracked) => tracked.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'openai', profileId: 'platform-key' },
      affectedTargets: [{ pid: 1, agentId: 'opencode' }],
      trigger: 'reconnect_propagation',
    });

    expect(requestRestartSignal).toHaveBeenCalledTimes(1);
    expect(restartRequestedPids.has(1)).toBe(true);
  });

  it('passes the resolved tracked session and gated-restart target to the restart-signal dependency (K3)', async () => {
    // K3: the wiring site routes the restart through the gated deferral primitive
    // (requestConnectedServiceRestartWithDeferral), which needs the tracked
    // session + the switch target descriptor. The handler must therefore hand
    // both to its requestRestartSignal dependency instead of only a bare pid.
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = createRestartSignalAdapter(restartRequestedPids);
    const tracked = createTrackedSession({ pid: 1, sessionId: 's1' });
    const pidToTrackedSession = new Map<number, TrackedSession>([[1, tracked]]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'restart_required'),
      resolveProcessGroupPid: (target) => target.pid,
      requestRestartSignal,
      restartSignalDelayMs: 250,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work', groupId: 'team', generation: 9 },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
    });

    expect(requestRestartSignal).toHaveBeenCalledWith(expect.objectContaining({
      pid: 1,
      tracked,
      sessionId: 's1',
      target: {
        serviceId: 'claude-subscription',
        profileId: 'work',
        groupId: 'team',
        generation: 9,
      },
    }));
  });

  it('marks external credential updates as reconnect propagation restart diagnostics', async () => {
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = createRestartSignalAdapter(restartRequestedPids);
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 's1' })],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'restart_required'),
      resolveProcessGroupPid: (tracked) => tracked.pid,
      requestRestartSignal,
      restartSignalDelayMs: 250,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work', groupId: 'team', generation: 4 },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
      trigger: 'reconnect_propagation',
    });

    expect(requestRestartSignal).toHaveBeenCalledWith(expect.objectContaining({
      restartDiagnostic: expect.objectContaining({
        trigger: 'reconnect_propagation',
        sessionId: 's1',
        serviceId: 'claude-subscription',
        profileId: 'work',
        groupId: 'team',
        generation: 4,
      }),
    }));
  });

  it('classifies refresh and reconnect propagation as non-account-changing gated restarts', async () => {
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = createRestartSignalAdapter(restartRequestedPids);
    const tracked = createTrackedSession({ pid: 1, sessionId: 's1' });
    const pidToTrackedSession = new Map<number, TrackedSession>([[1, tracked]]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'restart_required'),
      resolveProcessGroupPid: (target) => target.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work', groupId: 'team', generation: 4 },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
      trigger: 'reconnect_propagation',
    });

    expect(requestRestartSignal).toHaveBeenCalledWith(expect.objectContaining({
      tracked,
      target: {
        serviceId: 'claude-subscription',
        profileId: 'work',
        groupId: 'team',
        generation: 4,
      },
      restartDiagnostic: expect.objectContaining({
        trigger: 'reconnect_propagation',
        reason: 'reconnect_propagation',
      }),
    }));
  });

  it('does not let superseded credential scheduling clear the selected restart reservation', async () => {
    const restartRequestedPids = new Set<number>();
    const tracked = createTrackedSession({ pid: 1, sessionId: 's1' });
    const queue = createConnectedServiceSwitchDeferralQueue({ timeoutMs: 60_000, disableDeferral: false });
    queue.recordTurnLifecycleEvent({ sessionId: 's1', event: 'task_started' });
    const requestRestartSignal = createRestartSignalAdapter(restartRequestedPids, queue);
    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      pidToTrackedSession: new Map([[1, tracked]]),
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'restart_required'),
      resolveProcessGroupPid: (target) => target.pid,
      requestRestartSignal, restartSignalDelayMs: 0,
    });
    await handler({ binding: { serviceId: 'claude-subscription', profileId: 'work' }, affectedTargets: [{ pid: 1, agentId: 'claude' }] });
    await handler({ binding: { serviceId: 'claude-subscription', profileId: 'personal' }, affectedTargets: [{ pid: 1, agentId: 'claude' }] });
    expect(restartRequestedPids.size).toBe(0);
    queue.recordTurnLifecycleEvent({ sessionId: 's1', event: 'assistant_message_end' });
    await vi.waitFor(() => expect(restartRequestedPids.has(1)).toBe(true));
    expect(requestRestartSignal.mock.results).toHaveLength(2);
    await expect(requestRestartSignal.mock.results[0]?.value).resolves.toEqual({ signaled: false, notSignaledReason: 'superseded' });
    await expect(requestRestartSignal.mock.results[1]?.value).resolves.toEqual({ signaled: true });
    expect(restartRequestedPids.has(1)).toBe(true);
  });

  it('leaves restart reservation to the shared owner after signalling', async () => {
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = createRestartSignalAdapter(restartRequestedPids);
    const tracked = createTrackedSession({ pid: 1, sessionId: 's1' });
    const pidToTrackedSession = new Map<number, TrackedSession>([[1, tracked]]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'restart_required'),
      resolveProcessGroupPid: (target) => target.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work', groupId: 'team', generation: 9 },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
    });

    expect(restartRequestedPids.has(1)).toBe(true);
  });

  it('does not double-restart the same pid', async () => {
    const restartRequestedPids = new Set<number>([1]);
    const requestRestartSignal = createRestartSignalAdapter(restartRequestedPids);
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 's1' })],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'restart_required'),
      resolveProcessGroupPid: (tracked) => tracked.pid,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
    });

    expect(requestRestartSignal).toHaveBeenCalledOnce();
    await expect(requestRestartSignal.mock.results[0]?.value).resolves.toEqual({ signaled: false, notSignaledReason: 'duplicate_restart' });
    expect(restartRequestedPids.has(1)).toBe(true);
  });

  it('does not mark the pid for restart when restart signaling throws', async () => {
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = createRestartSignalAdapter(restartRequestedPids, undefined, new Error('kill-failed'));
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 's1' })],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'restart_required'),
      resolveProcessGroupPid: () => null,
      requestRestartSignal,
      restartSignalDelayMs: 0,
    } satisfies RestartHandlerParams);

    await expect(handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
    })).resolves.toBeUndefined();

    expect(restartRequestedPids.size).toBe(0);
  });

  it('records a blocked diagnostic when a restart-required target cannot be safely signaled', async () => {
    const restartRequestedPids = new Set<number>();
    const requestRestartSignal = createRestartSignalAdapter(restartRequestedPids);
    const onRestartBlocked = vi.fn();
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, createTrackedSession({ pid: 1, sessionId: 's1' })],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      pidToTrackedSession,
      resolveLifecycleDescriptor: async (agentId) => createLifecycleDescriptor(agentId, 'restart_required'),
      resolveProcessGroupPid: () => null,
      requestRestartSignal,
      restartSignalDelayMs: 0,
      onRestartBlocked,
    } satisfies RestartHandlerParams);

    await handler({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [{ pid: 1, agentId: 'claude' }],
    });

    expect(requestRestartSignal).not.toHaveBeenCalled();
    expect(restartRequestedPids.size).toBe(0);
    expect(onRestartBlocked).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      profileId: 'work',
      agentId: 'claude',
      pid: 1,
      reason: 'unsupported_restart_signal',
      startedBy: 'daemon',
      hasChildProcess: false,
      hasProcessGroupPid: false,
      reattachedFromDiskMarker: false,
    });
  });
});
