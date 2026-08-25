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

/**
 * The saturated-daemon condition, made deterministic. This daemon measures event-loop stalls with a
 * p50 of 21 s against a 5 s `ps` budget, so the stall below is the normal case here, not an extreme.
 */
function stallEventLoop(durationMs: number): void {
  const until = Date.now() + durationMs;
  while (Date.now() < until) {
    // Intentionally synchronous: nothing may be serviced while the loop is blocked.
  }
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

  it('still reports a SIGSTOPped process as stopped when the event loop stalls past the ps budget', async () => {
    // `ps` completes in milliseconds and its row is buffered in the pipe. Handing that budget to
    // `child_process.execFile` destroys the buffered row from the timers phase — which runs BEFORE
    // poll — and then reports `code 0, signal null`: a SUCCESS carrying empty stdout. The empty
    // state char classifies as "no ps row" and this function falls back to `alive -> servable`,
    // re-opening the incident it exists to prevent: the daemon refuses a resume as "already
    // running" while the runner is SIGSTOPped and can serve nothing.
    const pid = spawnSleeper();
    process.kill(pid, 'SIGSTOP');
    await waitFor(async () => (await readProcessRunState(pid)) === 'stopped');

    const pending = readProcessRunState(pid);
    stallEventLoop(5_500);

    await expect(pending).resolves.toBe('stopped');
  }, 30_000);

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
