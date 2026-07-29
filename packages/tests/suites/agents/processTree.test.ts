import type { ChildProcess } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { isProcessAlive, terminateProcessTreeByPid } from '../../scripts/processTree.mjs';
import { spawnDetachedTestProcess } from '../../src/testkit/process/testSpawn';

function waitForStdoutLine(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for child stdout line after ${timeoutMs}ms`));
    }, timeoutMs);

    const onData = (chunk: Buffer | string) => {
      const text = chunk.toString('utf8').trim();
      if (!text) return;
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      resolve(text);
    };

    child.stdout?.on('data', onData);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe('providers: process tree termination', () => {
  it('kills parent and spawned child process tree', async () => {
    const child = spawnDetachedTestProcess(
      process.execPath,
      [
        '-e',
        [
          "const { spawn } = require('node:child_process');",
          "const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
          'process.stdout.write(String(worker.pid) + "\\n");',
          'setInterval(() => {}, 1000);',
        ].join(''),
      ],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );

    const workerPidText = await waitForStdoutLine(child, 10_000);
    const workerPid = Number.parseInt(workerPidText, 10);
    expect(Number.isFinite(workerPid)).toBe(true);
    expect(child.pid).toBeTypeOf('number');

    await terminateProcessTreeByPid(child.pid!, { graceMs: 2_000, pollMs: 50 });

    expect(isProcessAlive(child.pid!)).toBe(false);
    expect(isProcessAlive(workerPid)).toBe(false);
  });

  it('is safe to call when process already exited', async () => {
    const child = spawnDetachedTestProcess(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: 'ignore',
    });

    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    });

    await expect(terminateProcessTreeByPid(child.pid!, { graceMs: 200, pollMs: 20 })).resolves.toBeUndefined();
  });

  it('kills tracked additional pids even when the root process already exited', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const child = spawnDetachedTestProcess(
      process.execPath,
      [
        '-e',
        [
          "const { spawn } = require('node:child_process');",
          "const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
          'worker.unref();',
          'process.stdout.write(String(worker.pid) + "\\n");',
          'setTimeout(() => process.exit(0), 50);',
        ].join(''),
      ],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );

    const workerPidText = await waitForStdoutLine(child, 10_000);
    const workerPid = Number.parseInt(workerPidText, 10);
    expect(Number.isFinite(workerPid)).toBe(true);

    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    });

    expect(isProcessAlive(workerPid)).toBe(true);

    await terminateProcessTreeByPid(child.pid!, {
      graceMs: 2_000,
      pollMs: 50,
      additionalPids: [workerPid],
    });

    expect(isProcessAlive(workerPid)).toBe(false);
  });
});
