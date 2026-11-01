import { existsSync, readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('ps-list', () => ({
  default: vi.fn().mockRejectedValue(new Error('process listing unavailable: private-native-value')),
}));

import { killProcessTree } from './killProcessTree';
import { isPidAlive, spawnInlineNodeParentWithChild, waitForProcessExit } from '@/testkit/process/spawn';
import { logger } from '@/ui/logger';

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

  it('terminates the known root but rejects and records unverified descendant cleanup when process enumeration fails', async () => {
    if (process.platform === 'win32') return; // The survivor falsifier uses POSIX subtree semantics.
    const { parent, childPid } = await spawnInlineNodeParentWithChild();
    spawnedPids.add(parent.pid!);
    spawnedPids.add(childPid);
    logger.flushSync();
    const before = existsSync(logger.getLogPath()) ? readFileSync(logger.getLogPath(), 'utf8') : '';

    await expect(killProcessTree(parent, { graceMs: 250 })).rejects.toMatchObject({
      code: 'process_tree_termination_incomplete',
      discoveryFailed: true,
      probeFailed: false,
      signallingFailed: false,
    });
    await expect(waitForProcessExit(parent.pid!, { timeoutMs: 3_000 })).resolves.toBe(true);
    expect(isPidAlive(childPid)).toBe(true);
    logger.flushSync();
    const diagnostic = readFileSync(logger.getLogPath(), 'utf8').slice(before.length);
    expect(diagnostic).toContain('process_tree_termination_incomplete');
    expect(diagnostic).toMatch(/"discoveryFailed":\s*true/);
    expect(diagnostic).toMatch(/"probeFailed":\s*false/);
    expect(diagnostic).toMatch(/"signallingFailed":\s*false/);
    expect(diagnostic).not.toContain('private-native-value');
  });
});
