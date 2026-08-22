import { describe, expect, it, vi } from 'vitest';

import type { readProcessIdentityByPid } from '@/daemon/processIdentity';
import type { TrackedSession } from '@/daemon/types';
import type { SessionRunnerRuntimeStateV1 } from '@happier-dev/protocol';

import { resolveSessionRunnerRuntimeStatusV2 } from './resolveRuntimeStatusV2';

const state = {
  v: 1,
  sessionId: 'sess-1',
  machineId: 'machine-1',
  daemonId: null,
  observedAtMs: 100,
  runner: {
    pid: 123,
    runtimeId: null,
    cliVersion: null,
    entrypointVersion: null,
    processCommandHash: null,
    entrypointSource: 'unknown',
    startedBy: 'daemon',
    startingMode: 'remote',
  },
  daemon: {
    cliVersion: null,
    startedWithCliVersion: null,
    currentEntrypointVersion: null,
    currentEntrypointSource: 'unknown',
  },
  versionState: 'unknown',
  statusSource: 'daemon_tracking',
  plannedRestart: {
    supported: true,
    eligible: false,
    disabledReason: 'runner_entrypoint_unknown',
  },
} satisfies SessionRunnerRuntimeStateV1;

function tracked(overrides: Partial<TrackedSession> = {}): TrackedSession {
  return {
    happySessionId: 'sess-1',
    startedBy: 'daemon',
    pid: 123,
    sessionRunnerPid: 456,
    processStartTimeMs: 1_000,
    ...overrides,
  };
}

type UnavailableProcessIdentityCase = readonly [
  label: string,
  tracked: TrackedSession | null,
  readProcessIdentityByPidFn: typeof readProcessIdentityByPid,
];

const unavailableProcessIdentityCases = [
  [
    'missing tracked session',
    null,
    async () => ({ pid: 123, processStartTimeMs: 1_000, command: 'runner' }),
  ],
  [
    'invalid selected PID',
    tracked({ sessionRunnerPid: -1 }),
    async () => ({ pid: -1, processStartTimeMs: 1_000, command: 'runner' }),
  ],
  [
    'missing exact observation',
    tracked(),
    async () => null,
  ],
  [
    'mismatched observed PID',
    tracked(),
    async () => ({ pid: 999, processStartTimeMs: 2_000, command: 'runner' }),
  ],
  [
    'malformed observed birth',
    tracked(),
    async () => ({ pid: 456, processStartTimeMs: -1, command: 'runner' }),
  ],
] satisfies ReadonlyArray<UnavailableProcessIdentityCase>;

describe('resolveSessionRunnerRuntimeStatusV2', () => {
  it('re-observes the selected runner PID instead of pairing it with the wrapper birth', async () => {
    const readProcessIdentityByPidFn = vi.fn(async (pid: number) => ({
      pid,
      processStartTimeMs: 2_000,
      command: 'happier runner',
    }));

    await expect(resolveSessionRunnerRuntimeStatusV2({
      state,
      tracked: tracked(),
      readProcessIdentityByPidFn,
    })).resolves.toEqual({
      v: 2,
      state,
      runnerProcessIdentity: {
        pid: 456,
        processStartTimeMs: 2_000,
      },
    });
    expect(readProcessIdentityByPidFn).toHaveBeenCalledWith(456);
  });

  it('does not reuse the tracked wrapper birth when the exact runner read is unavailable', async () => {
    await expect(resolveSessionRunnerRuntimeStatusV2({
      state,
      tracked: tracked(),
      readProcessIdentityByPidFn: async () => null,
    })).resolves.toEqual({
      v: 2,
      state,
      runnerProcessIdentity: null,
    });
  });

  it('re-observes the direct tracked PID when no separate runner PID exists', async () => {
    const readProcessIdentityByPidFn = vi.fn(async (pid: number) => ({
      pid,
      processStartTimeMs: 1_500,
      command: 'happier runner',
    }));

    await expect(resolveSessionRunnerRuntimeStatusV2({
      state,
      tracked: tracked({ sessionRunnerPid: undefined }),
      readProcessIdentityByPidFn,
    })).resolves.toEqual({
      v: 2,
      state,
      runnerProcessIdentity: {
        pid: 123,
        processStartTimeMs: 1_500,
      },
    });
    expect(readProcessIdentityByPidFn).toHaveBeenCalledWith(123);
  });

  it.each(unavailableProcessIdentityCases)(
    'fails active truth closed for %s while preserving V1 state',
    async (_label, candidate, readProcessIdentityByPidFn) => {
      await expect(resolveSessionRunnerRuntimeStatusV2({
        state,
        tracked: candidate,
        readProcessIdentityByPidFn,
      })).resolves.toEqual({
        v: 2,
        state,
        runnerProcessIdentity: null,
      });
    },
  );

  it('preserves V1 state when the process observation throws', async () => {
    await expect(resolveSessionRunnerRuntimeStatusV2({
      state,
      tracked: tracked(),
      readProcessIdentityByPidFn: async () => {
        throw new Error('process inventory unavailable');
      },
    })).resolves.toEqual({
      v: 2,
      state,
      runnerProcessIdentity: null,
    });
  });
});
