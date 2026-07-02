import { describe, expect, it } from 'vitest';

import { isPidAlive, spawnInlineNodeParentWithChild, waitForProcessExit } from '@/testkit/process/spawn';
import { killProcessTree } from './killProcessTree';

describe('killProcessTree', () => {
  it('kills the root process in the Vitest process sandbox (posix)', async () => {
    if (process.platform === 'win32') return;

    const { parent, childPid } = await spawnInlineNodeParentWithChild();

    expect(parent.pid).toBeTruthy();
    expect(childPid).toBeGreaterThan(0);
    expect(isPidAlive(parent.pid!)).toBe(true);
    expect(isPidAlive(childPid)).toBe(true);

    try {
      await killProcessTree(parent, { graceMs: 250 });

      await expect(waitForProcessExit(parent.pid!, { timeoutMs: 3_000 })).resolves.toBe(true);
    } finally {
      try {
        process.kill(parent.pid!, 'SIGKILL');
      } catch {
        // ignore
      }
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
  }, 20_000);
});
