import { describe, it, expect } from 'vitest';

import { isPidAlive, spawnInlineNodeParentWithChild } from '@/testkit/process/spawn';
import { AcpBackend } from '../AcpBackend';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';

function waitForChildProcessExit(parent: { exitCode: number | null; signalCode: NodeJS.Signals | null; once: (event: 'exit', listener: () => void) => void }, timeoutMs: number): Promise<boolean> {
  if (parent.exitCode !== null || parent.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    parent.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

describe('AcpBackend.dispose', () => {
  it('kills the root ACP CLI process in the Vitest process sandbox (posix)', async () => {
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

      const parentExited = await waitForChildProcessExit(parent, 3_000);
      expect(parentExited, 'parent process exited').toBe(true);
    } finally {
      // Defensive cleanup so a failing test doesn't leak background processes.
      await killProcessTree(parent, { graceMs: 250 });
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
  }, 15_000);
});
