import { describe, it, expect } from 'vitest';

import { isPidAlive, spawnInlineNodeParentWithChild, waitForProcessExit } from '@/testkit/process/spawn';
import { killProcessTree } from '../killProcessTree';

describe('killProcessTree', () => {
  it('kills a process and its descendants (posix)', async () => {
    if (process.platform === 'win32') return;

    const { parent, childPid } = await spawnInlineNodeParentWithChild();

    expect(parent.pid).toBeTruthy();
    expect(childPid).toBeGreaterThan(0);
    expect(isPidAlive(parent.pid!)).toBe(true);
    expect(isPidAlive(childPid)).toBe(true);

    await killProcessTree(parent, { graceMs: 250 });

    await expect(waitForProcessExit(parent.pid!, { timeoutMs: 3_000 })).resolves.toBe(true);
    await expect(waitForProcessExit(childPid, { timeoutMs: 3_000 })).resolves.toBe(true);
  }, 20_000);
});
