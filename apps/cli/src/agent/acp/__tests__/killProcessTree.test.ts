import { spawn } from 'node:child_process';

import { describe, it, expect } from 'vitest';

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

describe('killProcessTree', () => {
  it('kills a process and its descendants (posix)', async () => {
    if (process.platform === 'win32') return;

    // Parent spawns a child that would normally outlive the parent if only the parent pid is killed.
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

    let childPid = 0;
    const childPidStr = await new Promise<string>((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for child pid'));
      }, 2000);

      const cleanup = () => {
        clearTimeout(timer);
        parent.stdout?.off('data', onData);
        parent.off('error', onError);
        parent.off('exit', onExit);
      };

      const onData = (d: Buffer) => {
        buf += d.toString();
        const line = buf.trim().split('\n')[0]?.trim();
        const parsed = line ? Number.parseInt(line, 10) : NaN;
        if (Number.isFinite(parsed) && parsed > 0) {
          cleanup();
          resolve(String(parsed));
        }
      };

      const onError = (e: unknown) => {
        cleanup();
        reject(e);
      };

      const onExit = () => {
        cleanup();
        reject(new Error('Parent exited before emitting child pid'));
      };

      parent.stdout?.on('data', onData);
      parent.once('error', onError);
      parent.once('exit', onExit);
    }).catch((err) => {
      // Ensure the parent never leaks if the PID-read fails.
      try {
        parent.kill();
      } catch {
        // ignore
      }
      throw err;
    });
    childPid = Number.parseInt(childPidStr, 10);

    expect(parent.pid).toBeTruthy();
    expect(childPid).toBeGreaterThan(0);
    expect(isAlive(parent.pid!)).toBe(true);
    expect(isAlive(childPid)).toBe(true);

    await killProcessTree(parent, { graceMs: 250 });

    await waitForGone(parent.pid!, 3000);
    await waitForGone(childPid, 3000);
  }, 20_000);
});
