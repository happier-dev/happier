import { existsSync, readFileSync } from 'node:fs';
import psList from 'ps-list';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('ps-list', () => ({
  // Process enumeration is an OS boundary; never copy its paths, stderr or argv into diagnostics.
  default: vi.fn().mockRejectedValue(Object.assign(new Error('process listing unavailable: private-native-value'), {
    code: 'ENOENT',
    path: '/private-native-value/fastlist.exe',
    spawnargs: ['private-native-value'],
    stderr: 'private-native-value',
  })),
}));

import { killProcessTree } from './killProcessTree';
import { isPidAlive, spawnInlineNodeParentWithChild, spawnInlineNodeTestProcess, waitForProcessExit } from '@/testkit/process/spawn';
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
      discoveryErrorCode: 'ENOENT',
      probeFailed: false,
      signallingFailed: false,
    });
    await expect(waitForProcessExit(parent.pid!, { timeoutMs: 3_000 })).resolves.toBe(true);
    expect(isPidAlive(childPid)).toBe(true);
    logger.flushSync();
    const diagnostic = readFileSync(logger.getLogPath(), 'utf8').slice(before.length);
    expect(diagnostic).toContain('process_tree_termination_incomplete');
    expect(diagnostic).toMatch(/"discoveryFailed":\s*true/);
    expect(diagnostic).toMatch(/"discoveryErrorCode":\s*"ENOENT"/);
    expect(diagnostic).toMatch(/"probeFailed":\s*false/);
    expect(diagnostic).toMatch(/"signallingFailed":\s*false/);
    expect(diagnostic).not.toContain('private-native-value');
  });

  it.each([
    { code: 'ERR_MODULE_NOT_FOUND', expectedCode: 'ERR_MODULE_NOT_FOUND' },
    { code: 1, expectedCode: 1 },
    { code: 'private-native-value', expectedCode: undefined },
  ])('retains only a recognized discovery error code ($code)', async ({ code, expectedCode }) => {
    vi.mocked(psList).mockRejectedValue(Object.assign(new Error('private-native-value'), { code }));
    const root = spawnInlineNodeTestProcess('setInterval(() => {}, 1000)');
    spawnedPids.add(root.pid!);
    logger.flushSync();
    const before = existsSync(logger.getLogPath()) ? readFileSync(logger.getLogPath(), 'utf8') : '';

    await expect(killProcessTree(root, { graceMs: 25 })).rejects.toMatchObject({
      code: 'process_tree_termination_incomplete',
      discoveryFailed: true,
      discoveryErrorCode: expectedCode,
    });
    await expect(waitForProcessExit(root.pid!, { timeoutMs: 3_000 })).resolves.toBe(true);
    logger.flushSync();
    const diagnostic = readFileSync(logger.getLogPath(), 'utf8').slice(before.length);
    if (expectedCode !== undefined) {
      expect(diagnostic).toMatch(new RegExp(`"discoveryErrorCode":\\s*${JSON.stringify(expectedCode)}`));
    } else {
      expect(diagnostic).not.toContain('discoveryErrorCode');
    }
    expect(diagnostic).not.toContain('private-native-value');
  });
});
