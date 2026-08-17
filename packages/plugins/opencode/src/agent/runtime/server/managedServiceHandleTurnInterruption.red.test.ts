import { describe, expect, it, vi } from 'vitest';
import type { ManagedServiceSnapshot } from '@happier-dev/plugin-sdk/managed-services';

import {
  createOpenCodeManagedServerTurnInterruptionSupervisor,
} from './managedServerTurnInterruptionSupervisor.js';

const snapshot = (state: ManagedServiceSnapshot['state']): ManagedServiceSnapshot => ({
  id: 'opencode-server',
  state,
  mode: 'spawn',
  baseUrl: 'http://127.0.0.1:49196',
  startedAtMs: 1,
  lastHealthyAtMs: state === 'healthy' ? 2 : null,
  diagnostics: [],
  diagnosticsTruncated: false,
});

function createHarness() {
  let current = snapshot('healthy');
  let active = true;
  let unreconciled = true;
  const reconcile = vi.fn(async () => undefined);
  const fail = vi.fn(async () => undefined);
  const reset = vi.fn();
  const clear = vi.fn();
  const supervisor = createOpenCodeManagedServerTurnInterruptionSupervisor({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    isTurnActive: () => active,
    readManagedServiceSnapshot: () => current,
    reconcileLiveKnownToolStateFromHistory: reconcile,
    hasUnreconciledActiveLiveKnownToolWork: () => unreconciled,
    failActiveTurnDueToManagedServiceLoss: fail,
    resetProviderWorkForInterruptedTurn: reset,
    clearOrphanedProviderWork: clear,
    describeActiveProviderWorkForLog: () => ({}),
    getProviderSessionId: () => 'oc-session-1',
  });
  return {
    supervisor,
    reconcile,
    fail,
    reset,
    clear,
    lose(state: 'stopped' | 'failed') {
      current = snapshot(state);
    },
    setState(state: ManagedServiceSnapshot['state']) {
      current = snapshot(state);
    },
    setActive(value: boolean) {
      active = value;
    },
    setUnreconciled(value: boolean) {
      unreconciled = value;
    },
  };
}

describe('OpenCode exact-handle interruption', () => {
  it.each(['stopped', 'failed'] as const)(
    'reconciles an active turn and fails unresolved work exactly once when the handle becomes %s',
    async (state) => {
      const h = createHarness();
      h.supervisor.captureTurnStartSnapshot();
      h.lose(state);
      await h.supervisor.observeManagedServiceSnapshot();
      await h.supervisor.observeManagedServiceSnapshot();

      expect(h.reconcile).toHaveBeenCalledTimes(1);
      expect(h.reset).toHaveBeenCalledTimes(1);
      expect(h.fail).toHaveBeenCalledTimes(1);
    },
  );

  it('does not duplicate failure after terminal history reconciles the active work', async () => {
    const h = createHarness();
    h.supervisor.captureTurnStartSnapshot();
    h.setUnreconciled(false);
    h.lose('failed');
    await h.supervisor.observeManagedServiceSnapshot();
    await h.supervisor.observeManagedServiceSnapshot();

    expect(h.reconcile).toHaveBeenCalledTimes(1);
    expect(h.reset).not.toHaveBeenCalled();
    expect(h.fail).not.toHaveBeenCalled();
  });

  it('does not fail the turn for a nonterminal unhealthy observation', async () => {
    const h = createHarness();
    h.supervisor.captureTurnStartSnapshot();
    h.setState('unhealthy');
    await h.supervisor.observeManagedServiceSnapshot();

    expect(h.reconcile).not.toHaveBeenCalled();
    expect(h.reset).not.toHaveBeenCalled();
    expect(h.fail).not.toHaveBeenCalled();
  });

  it('clears orphaned provider state without manufacturing a turn failure when idle', async () => {
    const h = createHarness();
    h.supervisor.captureTurnStartSnapshot();
    h.setActive(false);
    h.lose('stopped');
    await h.supervisor.observeManagedServiceSnapshot();

    expect(h.clear).toHaveBeenCalledTimes(1);
    expect(h.reconcile).not.toHaveBeenCalled();
    expect(h.fail).not.toHaveBeenCalled();
  });
});
