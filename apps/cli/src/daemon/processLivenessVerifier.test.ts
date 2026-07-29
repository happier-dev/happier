import { describe, expect, it, vi } from 'vitest';

import {
  verifyProcessLiveness,
  verifySessionMarkerProcessLiveness,
} from './processLivenessVerifier';

describe('verifyProcessLiveness', () => {
  it.each(['dead', 'zombie'] as const)(
    'treats %s as verified stopped only for the captured process identity',
    async (runState) => {
      const verifyIdentity = vi.fn(async () => 'verified' as const);

      await expect(verifyProcessLiveness({
        pid: 4_242,
        processStartTimeMs: 1_717_171_717_000,
        readRunState: async () => runState,
        verifyIdentity,
      })).resolves.toEqual({
        status: 'verified_stopped',
        pid: 4_242,
        processStartTimeMs: 1_717_171_717_000,
      });
      expect(verifyIdentity).not.toHaveBeenCalled();
    },
  );

  it('requires exact identity before reporting a servable PID as running', async () => {
    await expect(verifyProcessLiveness({
      pid: 4_242,
      processStartTimeMs: 1_717_171_717_000,
      readRunState: async () => 'servable',
      verifyIdentity: async () => 'verified',
    })).resolves.toEqual({
      status: 'verified_running',
      pid: 4_242,
      processStartTimeMs: 1_717_171_717_000,
    });
  });

  it.each(['mismatch', 'unknown'] as const)(
    'reports a servable PID with %s identity as unknown',
    async (identity) => {
      await expect(verifyProcessLiveness({
        pid: 4_242,
        processStartTimeMs: 1_717_171_717_000,
        readRunState: async () => 'servable',
        verifyIdentity: async () => identity,
      })).resolves.toEqual({
        status: 'unknown',
        pid: 4_242,
        processStartTimeMs: 1_717_171_717_000,
      });
    },
  );

  it('reports a stopped process as unknown because it still exists', async () => {
    await expect(verifyProcessLiveness({
      pid: 4_242,
      processStartTimeMs: 1_717_171_717_000,
      readRunState: async () => 'stopped',
      verifyIdentity: async () => 'verified',
    })).resolves.toEqual({
      status: 'unknown',
      pid: 4_242,
      processStartTimeMs: 1_717_171_717_000,
    });
  });

  it('reports inspection failures such as EPERM as unknown', async () => {
    const error = Object.assign(new Error('permission denied'), { code: 'EPERM' });

    await expect(verifyProcessLiveness({
      pid: 4_242,
      processStartTimeMs: 1_717_171_717_000,
      readRunState: async () => {
        throw error;
      },
      verifyIdentity: async () => 'verified',
    })).resolves.toEqual({
      status: 'unknown',
      pid: 4_242,
      processStartTimeMs: 1_717_171_717_000,
    });
  });

  it.each([
    { pid: 0, processStartTimeMs: 1_717_171_717_000 },
    { pid: 4_242, processStartTimeMs: undefined },
    { pid: 4_242, processStartTimeMs: -1 },
  ])('reports invalid or incomplete process identities as unknown without touching the OS owners', async (identity) => {
    const readRunState = vi.fn(async () => 'dead' as const);
    const verifyIdentity = vi.fn(async () => 'verified' as const);

    await expect(verifyProcessLiveness({
      ...identity,
      readRunState,
      verifyIdentity,
    })).resolves.toEqual({
      status: 'unknown',
      pid: identity.pid,
      ...(identity.processStartTimeMs === undefined
        ? {}
        : { processStartTimeMs: identity.processStartTimeMs }),
    });
    expect(readRunState).not.toHaveBeenCalled();
    expect(verifyIdentity).not.toHaveBeenCalled();
  });
});

describe('verifySessionMarkerProcessLiveness', () => {
  it('requires the marker identity owner to have captured a command hash', async () => {
    const verifyHappyProcessIdentity = vi.fn(async () => true);

    await expect(verifySessionMarkerProcessLiveness({
      pid: 4_242,
      processStartTimeMs: 1_717_171_717_000,
    }, {
      readRunState: async () => 'servable',
      verifyHappyProcessIdentity,
    })).resolves.toEqual({
      status: 'unknown',
      pid: 4_242,
      processStartTimeMs: 1_717_171_717_000,
    });
    expect(verifyHappyProcessIdentity).not.toHaveBeenCalled();
  });

  it('requires the marker identity owner to have captured process start time', async () => {
    const verifyHappyProcessIdentity = vi.fn(async () => true);

    await expect(verifySessionMarkerProcessLiveness({
      pid: 4_242,
      processCommandHash: 'a'.repeat(64),
    }, {
      readRunState: async () => 'dead',
      verifyHappyProcessIdentity,
    })).resolves.toEqual({ status: 'unknown', pid: 4_242 });
    expect(verifyHappyProcessIdentity).not.toHaveBeenCalled();
  });

  it('reports a servable marker as running only when its captured PID, start time, and command still match', async () => {
    const processCommandHash = 'a'.repeat(64);
    const processStartTimeMs = 1_717_171_717_000;
    const verifyHappyProcessIdentity = vi.fn(async () => true);

    await expect(verifySessionMarkerProcessLiveness({
      pid: 4_242,
      processCommandHash,
      processStartTimeMs,
    }, {
      readRunState: async () => 'servable',
      verifyHappyProcessIdentity,
    })).resolves.toEqual({
      status: 'verified_running',
      pid: 4_242,
      processStartTimeMs,
    });
    expect(verifyHappyProcessIdentity).toHaveBeenCalledWith({
      pid: 4_242,
      expectedProcessCommandHash: processCommandHash,
      expectedProcessStartTimeMs: processStartTimeMs,
    });
  });

  it('does not trust a reused marker PID whose captured identity no longer matches', async () => {
    await expect(verifySessionMarkerProcessLiveness({
      pid: 4_242,
      processCommandHash: 'a'.repeat(64),
      processStartTimeMs: 1_717_171_717_000,
    }, {
      readRunState: async () => 'servable',
      verifyHappyProcessIdentity: async () => false,
    })).resolves.toEqual({
      status: 'unknown',
      pid: 4_242,
      processStartTimeMs: 1_717_171_717_000,
    });
  });
});
