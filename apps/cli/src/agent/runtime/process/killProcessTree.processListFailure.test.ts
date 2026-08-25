import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('ps-list', () => ({
  default: vi.fn().mockRejectedValue(new Error('process listing unavailable')),
}));

import { killProcessTree } from './killProcessTree';

describe('killProcessTree process-list failure', () => {
  const spawnedPids = new Set<number>();

  afterEach(() => {
    for (const pid of spawnedPids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    spawnedPids.clear();
  });

  it('still terminates the known root without rejecting when descendant enumeration is unavailable', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { stdio: 'ignore' });
    expect(child.pid).toBeTypeOf('number');
    spawnedPids.add(child.pid!);

    await expect(killProcessTree(child, { graceMs: 250 })).resolves.toBeUndefined();

    await vi.waitFor(() => {
      expect(() => process.kill(child.pid!, 0)).toThrow();
    }, { timeout: 3_000 });
    spawnedPids.delete(child.pid!);
  });
});
