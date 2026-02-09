/**
 * Opt-in daemon reattach integration tests.
 *
 * These tests spawn real processes and rely on `ps-list` classification.
 *
 * Enable with: `HAPPIER_CLI_DAEMON_REATTACH_INTEGRATION=1`
 */

import { afterEach, describe, expect, it } from 'vitest';
import { isPidSafeHappySessionProcess } from './pidSafety';
import { findHappyProcessByPid } from './doctor';
import { hashProcessCommand } from './sessionRegistry';
import {
  shouldRunDaemonReattachIntegration,
  spawnHappyLookingProcess,
  waitForPidInspection,
} from './testkit/realIntegration.testkit';

describe.skipIf(!shouldRunDaemonReattachIntegration())('pidSafety (real) integration tests (opt-in)', { timeout: 20_000 }, () => {
  const spawned: Array<() => void> = [];

  afterEach(() => {
    for (const k of spawned.splice(0)) k();
  });

  it('returns true when PID is a Happy session process and command hash matches', async () => {
    const p = spawnHappyLookingProcess();
    spawned.push(p.kill);

    const proc = await waitForPidInspection(findHappyProcessByPid, p.pid);
    expect(proc).not.toBeNull();
    if (!proc) return;

    const expected = hashProcessCommand(proc.command);
    await expect(isPidSafeHappySessionProcess({ pid: p.pid, expectedProcessCommandHash: expected })).resolves.toBe(true);
  });

  it('returns false when command hash mismatches (PID reuse safety)', async () => {
    const p = spawnHappyLookingProcess();
    spawned.push(p.kill);

    const proc = await waitForPidInspection(findHappyProcessByPid, p.pid);
    expect(proc).not.toBeNull();
    if (!proc) return;

    const wrong = '0'.repeat(64);
    expect(hashProcessCommand(proc.command)).not.toBe(wrong);
    await expect(isPidSafeHappySessionProcess({ pid: p.pid, expectedProcessCommandHash: wrong })).resolves.toBe(false);
  });
});
