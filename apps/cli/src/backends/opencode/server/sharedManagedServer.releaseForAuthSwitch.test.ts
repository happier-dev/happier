import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  decideManagedOpenCodeStartupScanOrphanReapAction,
  decideManagedOpenCodeStartupScanStateAction,
  releaseForAuthSwitchFromState,
  type SharedManagedOpenCodeServerState,
} from './sharedManagedServer';

function hashCommandLine(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function buildState(overrides: Partial<SharedManagedOpenCodeServerState> = {}): SharedManagedOpenCodeServerState {
  return {
    v: 2,
    baseUrl: 'http://127.0.0.1:43111',
    pid: 777,
    startedAtMs: 100,
    status: 'ready',
    launchEnvFingerprint: 'fingerprint-a',
    ownerToken: 'owner-token-a',
    startTimeMs: 2500,
    expectedCmdlineHash: hashCommandLine('opencode serve --hostname=127.0.0.1 --port=43111'),
    activeServerDir: '/tmp/happy/servers/cloud',
    daemonInstanceId: 'cloud',
    ...overrides,
  };
}

describe('releaseForAuthSwitchFromState', () => {
  it.each(['failed termination', 'unavailable claim inventory', 'unavailable turn evidence'] as const)(
    'retains server custody after %s', async (failure) => {
      const state = buildState();
      let retainedState: SharedManagedOpenCodeServerState | null = state;
      const result = await releaseForAuthSwitchFromState({
        withLock: async <T>(fn: () => Promise<T>) => await fn(),
        readState: async () => retainedState,
        removeState: async () => { retainedState = null; },
        isPidAlive: () => true,
        getProcessInfo: async () => ({ name: 'opencode', cmd: 'opencode serve --hostname=127.0.0.1 --port=43111' }),
        readProcessStartTimeMs: async () => 2500,
        killPid: async () => {
          if (failure !== 'failed termination') throw new Error('Protected server must not be signalled');
          return false;
        },
        currentActiveServerDir: '/tmp/happy/servers/cloud',
        expectedOwnerToken: 'owner-token-a',
        drainMs: 9_000,
        trackedClaimCountForLaunchFingerprint: async () => {
          if (failure === 'unavailable claim inventory') throw new Error('Registry unavailable');
          return 0;
        },
        hasInFlightTurnForLaunchFingerprint: async () => {
          if (failure === 'unavailable turn evidence') throw new Error('Turn query unavailable');
          return false;
        },
      });

      expect(result.released).toBe(false);
      expect(retainedState).toBe(state);
    },
  );

  it('releases a validated prior managed server during auth switch', async () => {
    const state = buildState();
    const killPid = vi.fn(async () => true);
    const removeState = vi.fn(async () => {});

    const result = await releaseForAuthSwitchFromState({
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: async () => state,
      removeState,
      isPidAlive: () => true,
      getProcessInfo: async () => ({ name: 'opencode', cmd: 'opencode serve --hostname=127.0.0.1 --port=43111' }),
      readProcessStartTimeMs: async () => 2501,
      killPid,
      currentActiveServerDir: '/tmp/happy/servers/cloud',
      expectedOwnerToken: 'owner-token-a',
      drainMs: 9_000,
    });

    expect(result).toEqual({ released: true, reason: 'released' });
    expect(killPid).toHaveBeenCalledWith(777, 9_000);
    expect(removeState).toHaveBeenCalledTimes(1);
  });

  it('releases an exactly validated prior managed server after daemon replacement', async () => {
    const state = buildState({ daemonInstanceId: 'old-daemon' });
    const killPid = vi.fn(async () => true);
    const removeState = vi.fn(async () => {});

    const result = await releaseForAuthSwitchFromState({
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: async () => state,
      removeState,
      isPidAlive: () => true,
      getProcessInfo: async () => ({ name: 'opencode', cmd: 'opencode serve --hostname=127.0.0.1 --port=43111' }),
      readProcessStartTimeMs: async () => 2501,
      killPid,
      currentActiveServerDir: '/tmp/happy/servers/cloud',
      expectedOwnerToken: 'owner-token-a',
      drainMs: 9_000,
    });

    expect(result).toEqual({ released: true, reason: 'released' });
    expect(killPid).toHaveBeenCalledWith(777, 9_000);
    expect(removeState).toHaveBeenCalledTimes(1);
  });

  it.each(['owner token', 'active server directory'] as const)('retains live custody without signaling when %s mismatches', async (mismatch) => {
    const state = buildState();
    const killPid = vi.fn(async () => true);
    const removeState = vi.fn(async () => {});

    const result = await releaseForAuthSwitchFromState({
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: async () => state,
      removeState,
      isPidAlive: () => true,
      getProcessInfo: async () => ({ name: 'opencode', cmd: 'opencode serve --hostname=127.0.0.1 --port=43111' }),
      readProcessStartTimeMs: async () => 2500,
      killPid,
      currentActiveServerDir: mismatch === 'active server directory' ? '/tmp/happy/servers/other' : '/tmp/happy/servers/cloud',
      expectedOwnerToken: mismatch === 'owner token' ? 'another-owner-token' : 'owner-token-a',
      drainMs: 9_000,
    });

    expect(result).toEqual({ released: false, reason: mismatch === 'owner token' ? 'owner_token_mismatch' : 'active_server_dir_mismatch' });
    expect(killPid).not.toHaveBeenCalled();
    expect(removeState).not.toHaveBeenCalled();
  });

  it('drops stale state without signaling when process validation fails (PID reuse safety)', async () => {
    const state = buildState();
    const killPid = vi.fn(async () => true);
    const removeState = vi.fn(async () => {});

    const result = await releaseForAuthSwitchFromState({
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: async () => state,
      removeState,
      isPidAlive: () => true,
      getProcessInfo: async () => ({ name: 'opencode', cmd: 'python unrelated-worker.py' }),
      readProcessStartTimeMs: async () => 2500,
      killPid,
      currentActiveServerDir: '/tmp/happy/servers/cloud',
      expectedOwnerToken: 'owner-token-a',
      drainMs: 9_000,
    });

    expect(result).toEqual({ released: false, reason: 'process_identity_mismatch' });
    expect(killPid).not.toHaveBeenCalled();
    expect(removeState).toHaveBeenCalledTimes(1);
  });

  it('retains untrusted live v1 state files without signaling', async () => {
    const state = buildState({ v: undefined, ownerToken: undefined, expectedCmdlineHash: undefined });
    const killPid = vi.fn(async () => true);
    const removeState = vi.fn(async () => {});

    const result = await releaseForAuthSwitchFromState({
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: async () => state,
      removeState,
      isPidAlive: () => true,
      getProcessInfo: async () => ({ name: 'opencode', cmd: 'opencode serve --hostname=127.0.0.1 --port=43111' }),
      readProcessStartTimeMs: async () => 2500,
      killPid,
      currentActiveServerDir: '/tmp/happy/servers/cloud',
      expectedOwnerToken: 'owner-token-a',
      drainMs: 9_000,
    });

    expect(result).toEqual({ released: false, reason: 'state_untrusted' });
    expect(killPid).not.toHaveBeenCalled();
    expect(removeState).not.toHaveBeenCalled();
  });

  it('does not reap when another tracked session still claims the same launch fingerprint', async () => {
    const state = buildState();
    const killPid = vi.fn(async () => true);
    const removeState = vi.fn(async () => {});

    const result = await releaseForAuthSwitchFromState({
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: async () => state,
      removeState,
      isPidAlive: () => true,
      getProcessInfo: async () => ({ name: 'opencode', cmd: 'opencode serve --hostname=127.0.0.1 --port=43111' }),
      readProcessStartTimeMs: async () => 2500,
      killPid,
      currentActiveServerDir: '/tmp/happy/servers/cloud',
      expectedOwnerToken: 'owner-token-a',
      drainMs: 9_000,
      trackedClaimCountForLaunchFingerprint: async () => 2,
      allowCurrentSessionClaim: true,
    });

    expect(result).toEqual({ released: false, reason: 'tracked_session_claimed' });
    expect(killPid).not.toHaveBeenCalled();
    expect(removeState).not.toHaveBeenCalled();
  });

  it('allows release when only the current switching session is known as an active claim', async () => {
    const state = buildState();
    const killPid = vi.fn(async () => true);
    const removeState = vi.fn(async () => {});

    const result = await releaseForAuthSwitchFromState({
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: async () => state,
      removeState,
      isPidAlive: () => true,
      getProcessInfo: async () => ({ name: 'opencode', cmd: 'opencode serve --hostname=127.0.0.1 --port=43111' }),
      readProcessStartTimeMs: async () => 2500,
      killPid,
      currentActiveServerDir: '/tmp/happy/servers/cloud',
      expectedOwnerToken: 'owner-token-a',
      drainMs: 9_000,
      trackedClaimCountForLaunchFingerprint: async () => 1,
      allowCurrentSessionClaim: true,
    });

    expect(result).toEqual({ released: true, reason: 'released' });
    expect(killPid).toHaveBeenCalledWith(777, 9_000);
    expect(removeState).toHaveBeenCalledTimes(1);
  });

  it('does NOT kill a sole-claimant server whose switching session still has an in-flight turn', async () => {
    // Lane F prevention: with allowCurrentSessionClaim the only claim (the switching session) is
    // subtracted to 0 and would otherwise fall through to killPid. The in-flight-turn guard must
    // refuse the kill and leave BOTH the process and the state file intact so the turn finishes.
    const state = buildState();
    const killPid = vi.fn(async () => true);
    const removeState = vi.fn(async () => {});

    const result = await releaseForAuthSwitchFromState({
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: async () => state,
      removeState,
      isPidAlive: () => true,
      getProcessInfo: async () => ({ name: 'opencode', cmd: 'opencode serve --hostname=127.0.0.1 --port=43111' }),
      readProcessStartTimeMs: async () => 2500,
      killPid,
      currentActiveServerDir: '/tmp/happy/servers/cloud',
      expectedOwnerToken: 'owner-token-a',
      drainMs: 9_000,
      trackedClaimCountForLaunchFingerprint: async () => 1,
      allowCurrentSessionClaim: true,
      hasInFlightTurnForLaunchFingerprint: async () => true,
    });

    expect(result).toEqual({ released: false, reason: 'in_flight_turn' });
    expect(killPid).not.toHaveBeenCalled();
    expect(removeState).not.toHaveBeenCalled();
  });

  it('releases the sole-claimant server once its in-flight turn has quiesced', async () => {
    const state = buildState();
    const killPid = vi.fn(async () => true);
    const removeState = vi.fn(async () => {});

    const result = await releaseForAuthSwitchFromState({
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: async () => state,
      removeState,
      isPidAlive: () => true,
      getProcessInfo: async () => ({ name: 'opencode', cmd: 'opencode serve --hostname=127.0.0.1 --port=43111' }),
      readProcessStartTimeMs: async () => 2500,
      killPid,
      currentActiveServerDir: '/tmp/happy/servers/cloud',
      expectedOwnerToken: 'owner-token-a',
      drainMs: 9_000,
      trackedClaimCountForLaunchFingerprint: async () => 1,
      allowCurrentSessionClaim: true,
      hasInFlightTurnForLaunchFingerprint: async () => false,
    });

    expect(result).toEqual({ released: true, reason: 'released' });
    expect(killPid).toHaveBeenCalledWith(777, 9_000);
    expect(removeState).toHaveBeenCalledTimes(1);
  });

  it('still short-circuits on remaining tracked claims before consulting the in-flight-turn guard', async () => {
    // A second tracked claim already protects the server (tracked_session_claimed); the in-flight
    // probe must not even be consulted, so a false probe cannot release a multi-claimant server.
    const state = buildState();
    const killPid = vi.fn(async () => true);
    const removeState = vi.fn(async () => {});
    const hasInFlightTurnForLaunchFingerprint = vi.fn(async () => false);

    const result = await releaseForAuthSwitchFromState({
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: async () => state,
      removeState,
      isPidAlive: () => true,
      getProcessInfo: async () => ({ name: 'opencode', cmd: 'opencode serve --hostname=127.0.0.1 --port=43111' }),
      readProcessStartTimeMs: async () => 2500,
      killPid,
      currentActiveServerDir: '/tmp/happy/servers/cloud',
      expectedOwnerToken: 'owner-token-a',
      drainMs: 9_000,
      trackedClaimCountForLaunchFingerprint: async () => 2,
      allowCurrentSessionClaim: true,
      hasInFlightTurnForLaunchFingerprint,
    });

    expect(result).toEqual({ released: false, reason: 'tracked_session_claimed' });
    expect(hasInFlightTurnForLaunchFingerprint).not.toHaveBeenCalled();
    expect(killPid).not.toHaveBeenCalled();
  });
});

describe('decideManagedOpenCodeStartupScanStateAction', () => {
  it.each([
    { state: buildState({ v: undefined }), reason: 'state_untrusted' },
    { state: buildState({ activeServerDir: '/tmp/happy/servers/other' }), reason: 'active_server_dir_mismatch' },
  ] as const)('retains live custody when ownership is unverifiable: $reason', ({ state, reason }) => {
    const input = {
      state, currentActiveServerDir: '/tmp/happy/servers/cloud',
      processInfo: null, observedStartTimeMs: null,
    };
    expect(decideManagedOpenCodeStartupScanStateAction({ ...input, isPidAlive: true }))
      .toEqual({ action: 'defer', reason });
    expect(decideManagedOpenCodeStartupScanStateAction({ ...input, isPidAlive: false }))
      .toEqual({ action: 'drop', reason: 'pid_dead' });
  });
  it.each([
    { processInfo: null, observedStartTimeMs: 2500 },
    { processInfo: { name: 'opencode', cmd: 'opencode serve --hostname=127.0.0.1 --port=43111' }, observedStartTimeMs: null },
  ])('retains custody while live process identity cannot be read', (observation) => {
    expect(decideManagedOpenCodeStartupScanStateAction({
      state: buildState(),
      currentActiveServerDir: '/tmp/happy/servers/cloud',
      isPidAlive: true,
      ...observation,
    })).toEqual({ action: 'defer', reason: 'process_identity_unknown' });
  });

  it('keeps exact live state created by a prior daemon instance', () => {
    const state = buildState({ daemonInstanceId: 'old-daemon' });
    const decision = decideManagedOpenCodeStartupScanStateAction({
      state,
      currentActiveServerDir: '/tmp/happy/servers/cloud',
      isPidAlive: true,
      processInfo: { name: 'opencode', cmd: 'opencode serve --hostname=127.0.0.1 --port=43111' },
      observedStartTimeMs: 2501,
    });

    expect(decision).toEqual({ action: 'keep', reason: 'verified_live_state' });
  });

  it('drops trusted state when live process identity no longer matches (PID reuse safety)', () => {
    const state = buildState();
    const decision = decideManagedOpenCodeStartupScanStateAction({
      state,
      currentActiveServerDir: '/tmp/happy/servers/cloud',
      isPidAlive: true,
      processInfo: { name: 'python', cmd: 'python unrelated-worker.py' },
      observedStartTimeMs: 2500,
    });

    expect(decision).toEqual({ action: 'drop', reason: 'process_identity_mismatch' });
  });
});

describe('decideManagedOpenCodeStartupScanOrphanReapAction', () => {
  it('reaps only when a verified live non-current fingerprint has no tracked claim', () => {
    expect(decideManagedOpenCodeStartupScanOrphanReapAction({
      stateDecision: { action: 'keep', reason: 'verified_live_state' },
      trackedClaimCount: 0,
      hasUnknownOpenCodeTrackedClaims: false,
    })).toEqual({ action: 'reap', reason: 'no_tracked_claims' });
  });

  it('keeps verified state when a tracked session claims the fingerprint', () => {
    expect(decideManagedOpenCodeStartupScanOrphanReapAction({
      stateDecision: { action: 'keep', reason: 'verified_live_state' },
      trackedClaimCount: 1,
      hasUnknownOpenCodeTrackedClaims: false,
    })).toEqual({ action: 'keep', reason: 'tracked_session_claimed' });
  });

  it('keeps verified state when tracked OpenCode sessions exist but fingerprint claim is unknown', () => {
    expect(decideManagedOpenCodeStartupScanOrphanReapAction({
      stateDecision: { action: 'keep', reason: 'verified_live_state' },
      trackedClaimCount: 0,
      hasUnknownOpenCodeTrackedClaims: true,
    })).toEqual({ action: 'keep', reason: 'tracked_claim_unknown' });
  });

  it('propagates drop decisions without attempting orphan reaping logic', () => {
    expect(decideManagedOpenCodeStartupScanOrphanReapAction({
      stateDecision: { action: 'drop', reason: 'pid_dead' },
      trackedClaimCount: 0,
      hasUnknownOpenCodeTrackedClaims: false,
    })).toEqual({ action: 'drop', reason: 'pid_dead' });
  });
});
