import { describe, expect, it, vi } from 'vitest';

import {
  reattestRunningExecutionRunConnectedServices,
  rehydrateLiveExecutionRunTargets,
} from './rehydrateExecutionRunTargets';

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

describe('reattestRunningExecutionRunConnectedServices', () => {
  it('reconstructs only the exact still-running receipt/registration pair', async () => {
    const registration = {
      ...launch,
      activationId: '11111111-1111-4111-8111-111111111111',
      connectedServicesBindings: {
        v: 1 as const,
        bindingsByServiceId: {
          'happier.agent.codex/connected-accounts/openai-codex': {
            source: 'connected' as const,
            selection: 'profile' as const,
            profileId: 'team',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
          kind: 'profile',
          serviceId:
            'happier.agent.codex/connected-accounts/openai-codex',
          profileId: 'team',
        }]),
      },
    };
    const runningMarker = {
      runId: registration.runKey,
      happySessionId: 'session-1',
      pid: 4321,
      status: 'running',
      executionRunConnectedServicesCleanupReceiptV1: {
        v: 1 as const,
        activationId: registration.activationId,
        runKey: registration.runKey,
        agentId: registration.agentId,
      },
    };
    const adopt = vi.fn(async () => true);
    const proveRunnerLive = vi.fn(async () => true);

    await expect(reattestRunningExecutionRunConnectedServices({
      markers: [runningMarker],
      runId: registration.runKey,
      runnerPid: runningMarker.pid,
      registration,
      proveRunnerLive,
      adopt,
    })).resolves.toBe(true);
    expect(adopt).toHaveBeenCalledWith({
      runId: registration.runKey,
      runnerPid: runningMarker.pid,
      sessionId: runningMarker.happySessionId,
      persistedLaunch: registration,
    });

    adopt.mockClear();
    await expect(reattestRunningExecutionRunConnectedServices({
      markers: [{ ...runningMarker, status: 'succeeded', finishedAtMs: 10 }],
      runId: registration.runKey,
      runnerPid: runningMarker.pid,
      registration,
      proveRunnerLive,
      adopt,
    })).resolves.toBe(false);
    await expect(reattestRunningExecutionRunConnectedServices({
      markers: [runningMarker],
      runId: registration.runKey,
      runnerPid: runningMarker.pid,
      registration: {
        ...registration,
        activationId: '22222222-2222-4222-8222-222222222222',
      },
      proveRunnerLive,
      adopt,
    })).resolves.toBe(false);
    expect(adopt).not.toHaveBeenCalled();
  });
});

describe('rehydrateLiveExecutionRunTargets', () => {
  it('retries terminal cleanup from the bounded receipt without reconstructing run authority', async () => {
    const cleanupTerminal = vi.fn(async () => true);
    const clearTerminalCleanupReceipt = vi.fn(async () => undefined);
    const proveRunnerLive = vi.fn(async () => true);
    const adopt = vi.fn(async () => true);
    const receipt = {
      v: 1 as const,
      activationId: '44444444-4444-4444-8444-444444444444',
      runKey: 'run-terminal-cleanup',
      agentId: 'codex',
    };

    const result = await rehydrateLiveExecutionRunTargets({
      markers: [{
        runId: receipt.runKey,
        happySessionId: 'session-1',
        pid: 4321,
        status: 'succeeded',
        finishedAtMs: 20,
        executionRunConnectedServicesCleanupReceiptV1: receipt,
      }],
      proveRunnerLive,
      adopt,
      cleanupTerminal,
      clearTerminalCleanupReceipt,
    });

    expect(result).toEqual({ registeredRunIds: [], inactiveRunIds: [receipt.runKey] });
    expect(cleanupTerminal).toHaveBeenCalledWith({
      runId: receipt.runKey,
      runnerPid: 4321,
      sessionId: 'session-1',
      receipt,
    });
    expect(clearTerminalCleanupReceipt).toHaveBeenCalledWith(receipt.runKey);
    expect(proveRunnerLive).not.toHaveBeenCalled();
    expect(adopt).not.toHaveBeenCalled();
  });

  it('routes a cancelled terminal marker to cleanup-only adoption without reconstructing run authority', async () => {
    const cleanupTerminal = vi.fn(async () => true);
    const clearTerminalCleanupReceipt = vi.fn(async () => undefined);
    const proveRunnerLive = vi.fn(async () => true);
    const adopt = vi.fn(async () => true);
    const receipt = {
      v: 1 as const,
      activationId: '55555555-5555-4555-8555-555555555555',
      runKey: 'run-cancelled-cleanup',
      agentId: 'codex',
    };

    const result = await rehydrateLiveExecutionRunTargets({
      markers: [{
        runId: receipt.runKey,
        happySessionId: 'session-1',
        pid: 4321,
        status: 'cancelled',
        finishedAtMs: 30,
        executionRunConnectedServicesCleanupReceiptV1: receipt,
      }],
      proveRunnerLive,
      adopt,
      cleanupTerminal,
      clearTerminalCleanupReceipt,
    });

    // A run cancelled while daemon A was down stays terminal on daemon B:
    // cleanup-only custody, never a resurrected run target.
    expect(result).toEqual({ registeredRunIds: [], inactiveRunIds: [receipt.runKey] });
    expect(cleanupTerminal).toHaveBeenCalledWith({
      runId: receipt.runKey,
      runnerPid: 4321,
      sessionId: 'session-1',
      receipt,
    });
    expect(clearTerminalCleanupReceipt).toHaveBeenCalledWith(receipt.runKey);
    expect(proveRunnerLive).not.toHaveBeenCalled();
    expect(adopt).not.toHaveBeenCalled();
  });

  it('leaves a detached marker inactive without attempting Session liveness or target adoption', async () => {
    const proveRunnerLive = vi.fn(async () => true);
    const adopt = vi.fn(async () => true);

    const result = await rehydrateLiveExecutionRunTargets({
      markers: [{
        runId: 'run_detached',
        happySessionId: null,
        pid: 4321,
        status: 'running',
        executionRunConnectedServicesLaunchV1: launch,
      }],
      proveRunnerLive,
      adopt,
    });

    expect(result).toEqual({ registeredRunIds: [], inactiveRunIds: ['run_detached'] });
    expect(proveRunnerLive).not.toHaveBeenCalled();
    expect(adopt).not.toHaveBeenCalled();
  });

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
