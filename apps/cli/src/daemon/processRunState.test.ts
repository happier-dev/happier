import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { readProcessRunState } from './processRunState';

const spawnedPids: number[] = [];

function spawnSleeper(): number {
  const child = spawn('sleep', ['120'], { stdio: 'ignore' });
  if (typeof child.pid !== 'number') throw new Error('failed to spawn sleeper');
  spawnedPids.push(child.pid);
  return child.pid;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('waitFor timed out');
}

afterEach(() => {
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already dead
    }
  }
});

describe.skipIf(process.platform === 'win32')('readProcessRunState (posix)', () => {
  it('reports a running process as servable', async () => {
    const pid = spawnSleeper();
    await expect(readProcessRunState(pid)).resolves.toBe('servable');
  });

  it('reports a SIGSTOPped process as stopped (alive but cannot serve)', async () => {
    const pid = spawnSleeper();
    process.kill(pid, 'SIGSTOP');
    await waitFor(async () => (await readProcessRunState(pid)) === 'stopped');
    await expect(readProcessRunState(pid)).resolves.toBe('stopped');
  });

  it('reports a dead pid as dead', async () => {
    const pid = spawnSleeper();
    process.kill(pid, 'SIGKILL');
    await waitFor(async () => (await readProcessRunState(pid)) !== 'servable');
    const state = await readProcessRunState(pid);
    // Depending on reaping timing the pid is either fully gone or a transient zombie;
    // both are non-servable, which is the contract resume guards rely on.
    expect(['dead', 'zombie']).toContain(state);
  });

  it('reports an invalid pid as dead', async () => {
    await expect(readProcessRunState(-1)).resolves.toBe('dead');
    await expect(readProcessRunState(0)).resolves.toBe('dead');
  });
});

describe('readProcessRunState (win32 semantics)', () => {
  it('maps alive to servable and not-alive to dead', async () => {
    await expect(readProcessRunState(1234, { platform: 'win32', isPidAlive: () => true })).resolves.toBe('servable');
    await expect(readProcessRunState(1234, { platform: 'win32', isPidAlive: () => false })).resolves.toBe('dead');
  });
});
