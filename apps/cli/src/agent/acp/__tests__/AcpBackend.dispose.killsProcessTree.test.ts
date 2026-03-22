import { describe, it, expect } from 'vitest';

import { isPidAlive, spawnInlineNodeParentWithChild, waitForProcessExit } from '@/testkit/process/spawn';
import { AcpBackend } from '../AcpBackend';
import { killProcessTree } from '../killProcessTree';

describe('AcpBackend.dispose', () => {
  it('kills the whole ACP CLI process tree (posix)', async () => {
    if (process.platform === 'win32') return;

    const { parent, childPid } = await spawnInlineNodeParentWithChild();
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: process.cwd(),
      command: 'noop',
    });

    try {
      (backend as any).process = parent;

      expect(parent.pid).toBeTruthy();
      expect(childPid).toBeGreaterThan(0);
      expect(isPidAlive(parent.pid!)).toBe(true);
      expect(isPidAlive(childPid)).toBe(true);

      await backend.dispose();

      // Run the liveness checks concurrently to avoid brushing up against the test timeout.
      await Promise.all([
        expect(waitForProcessExit(parent.pid!, { timeoutMs: 3_000 })).resolves.toBe(true),
        expect(waitForProcessExit(childPid, { timeoutMs: 3_000 })).resolves.toBe(true),
      ]);
    } finally {
      // Defensive cleanup so a failing test doesn't leak background processes.
      await killProcessTree(parent, { graceMs: 250 });
    }
  }, 15_000);
});
