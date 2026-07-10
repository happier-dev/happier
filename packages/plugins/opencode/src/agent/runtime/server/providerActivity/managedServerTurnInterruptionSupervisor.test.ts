import { describe, expect, it, vi } from 'vitest';

import type { ManagedServerSnapshotV1 } from '@happier-dev/plugin-sdk';

import { resolveOpenCodeManagedServerGenerationIdentity } from './managedServerGeneration.js';
import {
  OPENCODE_SERVER_RESTARTED_DURING_TURN_ISSUE_CODE,
  createOpenCodeManagedServerTurnInterruptionSupervisor,
  type OpenCodeManagedServerTurnInterruptionDeps,
} from './managedServerTurnInterruptionSupervisor.js';

function snapshot(overrides: Partial<ManagedServerSnapshotV1> = {}): ManagedServerSnapshotV1 {
  return {
    id: 'opencode-server',
    state: 'healthy',
    mode: 'managed-spawn',
    baseUrl: 'http://127.0.0.1:49196',
    port: 49196,
    credentialEnvKey: 'OPENCODE_SERVER_PASSWORD',
    pid: 100,
    startedAt: 1000,
    lastHealthyAt: 1200,
    ...overrides,
  } as ManagedServerSnapshotV1;
}

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as OpenCodeManagedServerTurnInterruptionDeps['logger'];

function createSupervisorHarness(overrides: Partial<OpenCodeManagedServerTurnInterruptionDeps> = {}) {
  let identity = resolveOpenCodeManagedServerGenerationIdentity(snapshot());
  let turnActive = true;
  let unreconciled = true;
  const failActiveTurnDueToManagedServerRestart = vi.fn(async () => {});
  const reconcileLiveKnownToolStateFromHistory = vi.fn(async () => {});
  const resetProviderWorkForInterruptedTurn = vi.fn();
  const clearOrphanedProviderWork = vi.fn();
  const setObservedGenerationKey = vi.fn();

  const deps: OpenCodeManagedServerTurnInterruptionDeps = {
    logger: silentLogger,
    isTurnActive: () => turnActive,
    readOpenCodeManagedServerGenerationIdentity: () => identity,
    setObservedGenerationKey,
    reconcileLiveKnownToolStateFromHistory,
    hasUnreconciledActiveLiveKnownToolWork: () => unreconciled,
    failActiveTurnDueToManagedServerRestart,
    resetProviderWorkForInterruptedTurn,
    clearOrphanedProviderWork,
    describeActiveProviderWorkForLog: () => ({}),
    getProviderSessionId: () => 'ses-1',
    ...overrides,
  };

  const supervisor = createOpenCodeManagedServerTurnInterruptionSupervisor(deps);
  return {
    supervisor,
    failActiveTurnDueToManagedServerRestart,
    reconcileLiveKnownToolStateFromHistory,
    resetProviderWorkForInterruptedTurn,
    clearOrphanedProviderWork,
    setObservedGenerationKey,
    advanceGeneration: (overridesForSnapshot: Partial<ManagedServerSnapshotV1>) => {
      identity = resolveOpenCodeManagedServerGenerationIdentity(snapshot(overridesForSnapshot));
    },
    setTurnActive: (value: boolean) => {
      turnActive = value;
    },
    setUnreconciled: (value: boolean) => {
      unreconciled = value;
    },
  };
}

describe('createOpenCodeManagedServerTurnInterruptionSupervisor', () => {
  it('exports the canonical server-restart issue code matching remote-dev/e2e', () => {
    expect(OPENCODE_SERVER_RESTARTED_DURING_TURN_ISSUE_CODE).toBe('opencode_server_restarted_during_turn');
  });

  it('does nothing when the generation is unchanged', () => {
    const h = createSupervisorHarness();
    h.supervisor.captureTurnStartGeneration();
    h.supervisor.observeManagedServerGeneration();
    expect(h.reconcileLiveKnownToolStateFromHistory).not.toHaveBeenCalled();
    expect(h.failActiveTurnDueToManagedServerRestart).not.toHaveBeenCalled();
  });

  it('reconciles once and fails the turn when work stays unreconciled across a generation change', async () => {
    const h = createSupervisorHarness();
    h.supervisor.captureTurnStartGeneration();
    h.advanceGeneration({ pid: 200, startedAt: 2000, baseUrl: 'http://127.0.0.1:49197', port: 49197 });
    h.supervisor.observeManagedServerGeneration();
    await vi.waitFor(() => {
      expect(h.failActiveTurnDueToManagedServerRestart).toHaveBeenCalledTimes(1);
    });
    expect(h.reconcileLiveKnownToolStateFromHistory).toHaveBeenCalledTimes(1);
    expect(h.resetProviderWorkForInterruptedTurn).toHaveBeenCalledTimes(1);
  });

  it('continues the turn (no fail) when reconciliation clears the live-known work', async () => {
    const h = createSupervisorHarness();
    h.supervisor.captureTurnStartGeneration();
    h.setUnreconciled(false);
    h.advanceGeneration({ pid: 200, startedAt: 2000, baseUrl: 'http://127.0.0.1:49197', port: 49197 });
    h.supervisor.observeManagedServerGeneration();
    await vi.waitFor(() => {
      expect(h.reconcileLiveKnownToolStateFromHistory).toHaveBeenCalledTimes(1);
    });
    expect(h.failActiveTurnDueToManagedServerRestart).not.toHaveBeenCalled();
  });

  it('clears orphaned work without failing when no turn is active on a generation change', () => {
    const h = createSupervisorHarness();
    h.supervisor.captureTurnStartGeneration();
    h.setTurnActive(false);
    h.advanceGeneration({ pid: 200, startedAt: 2000, baseUrl: 'http://127.0.0.1:49197', port: 49197 });
    h.supervisor.observeManagedServerGeneration();
    expect(h.clearOrphanedProviderWork).toHaveBeenCalledTimes(1);
    expect(h.failActiveTurnDueToManagedServerRestart).not.toHaveBeenCalled();
  });

  it('fails the turn at most once even when a second generation change arrives', async () => {
    const h = createSupervisorHarness();
    h.supervisor.captureTurnStartGeneration();
    h.advanceGeneration({ pid: 200, startedAt: 2000, baseUrl: 'http://127.0.0.1:49197', port: 49197 });
    h.supervisor.observeManagedServerGeneration();
    await vi.waitFor(() => {
      expect(h.failActiveTurnDueToManagedServerRestart).toHaveBeenCalledTimes(1);
    });
    // After the turn failed, a second replacement must NOT fail again.
    h.setTurnActive(false);
    h.advanceGeneration({ pid: 300, startedAt: 3000, baseUrl: 'http://127.0.0.1:49198', port: 49198 });
    h.supervisor.observeManagedServerGeneration();
    expect(h.failActiveTurnDueToManagedServerRestart).toHaveBeenCalledTimes(1);
  });
});
