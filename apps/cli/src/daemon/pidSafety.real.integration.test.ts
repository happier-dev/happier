/**
 * Opt-in daemon reattach integration tests.
 *
 * These tests spawn real processes and rely on `ps-list` classification.
 *
 * Enable with: `HAPPIER_CLI_DAEMON_REATTACH_INTEGRATION=1`
 */

import { afterEach, describe, expect, it } from 'vitest';
import { waitForPidInspection } from '@/testkit/process/pidInspection';
import { isPidSafeHappySessionProcess } from './pidSafety';
import { findHappyProcessByPid } from './doctor';
import { hashProcessCommand } from './sessionRegistry';
import { readProcessIdentityByPid } from './processIdentity';
import {
  shouldRunDaemonReattachIntegration,
  spawnHappyLookingProcess,
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

    const processIdentity = await readProcessIdentityByPid(p.pid);
    expect(processIdentity).not.toBeNull();
    if (!processIdentity) return;

    const expected = hashProcessCommand(proc.command);
    await expect(isPidSafeHappySessionProcess({
      pid: p.pid,
      expectedProcessCommandHash: expected,
      expectedProcessStartTimeMs: processIdentity.processStartTimeMs,
    })).resolves.toBe(true);
  });

  it('keeps the same process generation safe despite a different command witness', async () => {
    const p = spawnHappyLookingProcess();
    spawned.push(p.kill);

    const proc = await waitForPidInspection(findHappyProcessByPid, p.pid);
    expect(proc).not.toBeNull();
    if (!proc) return;

    const processIdentity = await readProcessIdentityByPid(p.pid);
    expect(processIdentity).not.toBeNull();
    if (!processIdentity) return;

    const wrong = '0'.repeat(64);
    expect(hashProcessCommand(proc.command)).not.toBe(wrong);
    await expect(isPidSafeHappySessionProcess({
      pid: p.pid,
      expectedProcessCommandHash: wrong,
      expectedProcessStartTimeMs: processIdentity.processStartTimeMs,
    })).resolves.toBe(true);
  });
});
