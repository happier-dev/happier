import { spawn } from 'node:child_process';

import { describe, it, expect } from 'vitest';

import { AcpBackend } from '../AcpBackend';
import { killProcessTree } from '../killProcessTree';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForGone(pid: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Process ${pid} is still alive after ${timeoutMs}ms`);
}

async function spawnParentWithChild(): Promise<{ parent: ReturnType<typeof spawn>; childPid: number }> {
  const parent = spawn(
    process.execPath,
    [
      '-e',
      [
        'const { spawn } = require("node:child_process");',
        'const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { stdio: "ignore" });',
        'console.log(String(child.pid));',
        'setInterval(()=>{}, 1000);',
      ].join('\n'),
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  );

  const childPid = await new Promise<number>((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Timed out waiting for child pid')), 2000);
    parent.stdout?.on('data', (d) => {
      buf += d.toString();
      const line = buf.trim().split('\n')[0]?.trim();
      const parsed = line ? Number.parseInt(line, 10) : NaN;
      if (Number.isFinite(parsed) && parsed > 0) {
        clearTimeout(timer);
        resolve(parsed);
      }
    });
    parent.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });

  return { parent, childPid };
}

describe('AcpBackend.dispose', () => {
  it('kills the whole ACP CLI process tree (posix)', async () => {
    if (process.platform === 'win32') return;

    const { parent, childPid } = await spawnParentWithChild();
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: process.cwd(),
      command: 'noop',
    });

    try {
      (backend as any).process = parent;

      expect(parent.pid).toBeTruthy();
      expect(childPid).toBeGreaterThan(0);
      expect(isAlive(parent.pid!)).toBe(true);
      expect(isAlive(childPid)).toBe(true);

      await backend.dispose();

      // Run the liveness checks concurrently to avoid brushing up against the test timeout.
      await Promise.all([waitForGone(parent.pid!, 3000), waitForGone(childPid, 3000)]);
    } finally {
      // Defensive cleanup so a failing test doesn't leak background processes.
      await killProcessTree(parent, { graceMs: 250 });
    }
  }, 15_000);
});
