import { describe, expect, it, vi } from 'vitest';

import { hashProcessCommand } from './sessionRegistry';
import { isPidSafeHappySessionProcess } from './pidSafety';

describe('isPidSafeHappySessionProcess', () => {
  it('uses the exact process identity read as the final safety linearization point', async () => {
    const pid = 54_321;
    const originalCommand =
      'happier session --existing-session sess-exact-process';
    let currentIdentity = {
      pid,
      processStartTimeMs: 1_000,
      command: originalCommand,
    };
    const findHappyProcessByPidFn = vi.fn(async () => {
      currentIdentity = {
        pid,
        processStartTimeMs: 2_000,
        command:
          'happier session --existing-session sess-reused-process',
      };
      return {
        pid,
        command: originalCommand,
        type: 'daemon-spawned-session',
      };
    });
    const readProcessIdentityByPidFn = vi.fn(
      async () => currentIdentity,
    );

    await expect(isPidSafeHappySessionProcess({
      pid,
      expectedProcessStartTimeMs: 1_000,
      expectedProcessCommandHash:
        hashProcessCommand(originalCommand),
    }, {
      findHappyProcessByPidFn,
      readProcessIdentityByPidFn,
    })).resolves.toBe(false);

    expect(findHappyProcessByPidFn).toHaveBeenCalledOnce();
    expect(readProcessIdentityByPidFn).toHaveBeenCalledOnce();
    expect(
      findHappyProcessByPidFn.mock.invocationCallOrder[0],
    ).toBeLessThan(
      readProcessIdentityByPidFn.mock.invocationCallOrder[0]!,
    );
  });
});
