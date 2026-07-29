import { describe, expect, it, vi } from 'vitest';

import { rehydrateLiveExecutionRunTargets } from './rehydrateExecutionRunTargets';

const launch = {
  v: 1 as const,
  runKey: 'run-1',
  agentId: 'codex',
  materializationKey: 'run-1',
  connectedServicesBindings: {
    v: 1 as const,
    bindingsByServiceId: {
      'openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: 'team' },
    },
  },
  connectedServiceSelectionsEnv: {
    HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
      kind: 'profile',
      serviceId: 'openai-codex',
      profileId: 'team',
    }]),
  },
  sessionDirectory: '/workspace',
  materializedRoot: '/managed/materialized/run-1/codex',
};

describe('rehydrateLiveExecutionRunTargets', () => {
  it('passively adopts the exact remote-dev launch marker with its distinct materialization key', async () => {
    const adopt = vi.fn(async () => true);
    const markerRunId = 'run_22222222-2222-4222-8222-222222222222';
    const connectedServiceSelectionsJson = JSON.stringify([{
      kind: 'profile',
      serviceId: 'openai-codex',
      profileId: 'team',
      credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
    }]);
    const predecessorLaunch = {
      v: 1 as const,
      runKey: 'execution_run:11111111-1111-4111-8111-111111111111',
      agentId: 'codex',
      connectedServicesBindings: launch.connectedServicesBindings,
      brokerSelectionIdentity: 'broker:team',
      runtimeAccountIdentitySelections: [{
        serviceId: 'openai-codex',
        profileId: 'team',
        groupId: null,
        groupGeneration: null,
        providerAccountId: 'acct-team',
        accountLabel: null,
        source: 'spawn_selection',
      }],
      connectedServiceSelectionsJson,
      sessionDirectory: '/workspace',
      materializedRoot: '/managed/materialized/execution_run_one',
    };

    const result = await rehydrateLiveExecutionRunTargets({
      markers: [{
        runId: markerRunId,
        happySessionId: 'session-1',
        pid: 4321,
        status: 'running',
        executionRunConnectedServicesLaunchV1: predecessorLaunch,
      }],
      proveRunnerLive: async () => true,
      adopt,
    });

    expect(result).toEqual({ registeredRunIds: [markerRunId], inactiveRunIds: [] });
    expect(adopt).toHaveBeenCalledWith({
      runId: markerRunId,
      runnerPid: 4321,
      sessionId: 'session-1',
      persistedLaunch: predecessorLaunch,
    });
  });

  it('passively adopts only an exact demonstrably-live launch record', async () => {
    const adopt = vi.fn(async () => true);
    const result = await rehydrateLiveExecutionRunTargets({
      markers: [{
        runId: 'run-1',
        happySessionId: 'session-1',
        pid: 4321,
        status: 'running',
        executionRunConnectedServicesLaunchV1: launch,
      }],
      proveRunnerLive: async (marker) => marker.pid === 4321 && marker.happySessionId === 'session-1',
      adopt,
    });

    expect(result).toEqual({ registeredRunIds: ['run-1'], inactiveRunIds: [] });
    expect(adopt).toHaveBeenCalledWith({
      runId: 'run-1',
      runnerPid: 4321,
      sessionId: 'session-1',
      persistedLaunch: launch,
    });
  });

  it('leaves dead, terminal, malformed, mismatched, non-producer, unknown-agent, and duplicate evidence inactive', async () => {
    const adopt = vi.fn(async () => true);
    const duplicate = { ...launch, runKey: 'duplicate', materializationKey: 'duplicate' };
    const predecessorBase = {
      v: 1 as const,
      runKey: 'execution_run:33333333-3333-4333-8333-333333333333',
      agentId: 'codex',
      connectedServicesBindings: launch.connectedServicesBindings,
      runtimeAccountIdentitySelections: [],
      materializedRoot: null,
    };
    const markers = [
      { runId: 'dead', happySessionId: 's', pid: 1, status: 'running', executionRunConnectedServicesLaunchV1: { ...launch, runKey: 'dead', materializationKey: 'dead' } },
      { runId: 'terminal', happySessionId: 's', pid: 2, status: 'succeeded', executionRunConnectedServicesLaunchV1: { ...launch, runKey: 'terminal', materializationKey: 'terminal' } },
      { runId: 'malformed', happySessionId: 's', pid: 3, status: 'running', executionRunConnectedServicesLaunchV1: { ...launch, credential: 'secret' } },
      { runId: 'mismatched', happySessionId: 's', pid: 4, status: 'running', executionRunConnectedServicesLaunchV1: launch },
      { runId: 'run_not-a-uuid', happySessionId: 's', pid: 8, status: 'running', executionRunConnectedServicesLaunchV1: { ...predecessorBase, runKey: 'execution_run:77777777-7777-4777-8777-777777777777' } },
      { runId: 'run_44444444-4444-4444-8444-444444444444', happySessionId: 's', pid: 9, status: 'running', executionRunConnectedServicesLaunchV1: { ...predecessorBase, runKey: 'execution_run:not-a-uuid' } },
      { runId: 'unknown', happySessionId: 's', pid: 5, status: 'running', executionRunConnectedServicesLaunchV1: { ...launch, runKey: 'unknown', materializationKey: 'unknown', agentId: 'unknown-agent' } },
      { runId: 'duplicate-a', happySessionId: 's', pid: 6, status: 'running', executionRunConnectedServicesLaunchV1: duplicate },
      { runId: 'duplicate-b', happySessionId: 's', pid: 7, status: 'running', executionRunConnectedServicesLaunchV1: duplicate },
      { runId: 'run_55555555-5555-4555-8555-555555555555', happySessionId: 's', pid: 10, status: 'running', executionRunConnectedServicesLaunchV1: predecessorBase },
      { runId: 'run_66666666-6666-4666-8666-666666666666', happySessionId: 's', pid: 11, status: 'running', executionRunConnectedServicesLaunchV1: predecessorBase },
    ];

    const result = await rehydrateLiveExecutionRunTargets({
      markers,
      proveRunnerLive: async (marker) => marker.runId !== 'dead',
      adopt,
    });

    expect(result.registeredRunIds).toEqual([]);
    expect(result.inactiveRunIds).toEqual(markers.map((marker) => marker.runId));
    expect(adopt).not.toHaveBeenCalled();
  });

  it('loads a fresh marker snapshot only when passive rehydration begins', async () => {
    const loadMarkers = vi.fn(async () => [{
      runId: 'run-1',
      happySessionId: 'session-1',
      pid: 4321,
      status: 'succeeded',
      finishedAtMs: 10,
      executionRunConnectedServicesLaunchV1: launch,
    }]);

    const result = await rehydrateLiveExecutionRunTargets({
      markers: loadMarkers,
      proveRunnerLive: async () => true,
      adopt: vi.fn(async () => true),
    });

    expect(loadMarkers).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ registeredRunIds: [], inactiveRunIds: ['run-1'] });
  });
});
