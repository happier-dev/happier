import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const psListState = vi.hoisted(() => ({
  actual: null as null | (() => Promise<unknown[]>),
  mock: vi.fn<() => Promise<unknown[]>>(),
}));

vi.mock('ps-list', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ps-list')>();
  psListState.actual = actual.default;
  psListState.mock.mockImplementation(actual.default);
  return { default: psListState.mock };
});

import {
  isPidAlive,
  spawnDetachedInlineNodeTestProcess,
  spawnInlineNodeParentWithChild,
  spawnInlineNodeTestProcess,
  waitForProcessExit,
} from '@/testkit/process/spawn';
import { killProcessTree } from './killProcessTree';

afterEach(() => {
  if (psListState.actual) psListState.mock.mockImplementation(psListState.actual);
});

async function waitForPidFile(filePath: string, opts: { timeoutMs: number }): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < opts.timeoutMs) {
    try {
      const parsed = Number.parseInt(readFileSync(filePath, 'utf8').trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for pid file ${filePath}`);
}

describe('killProcessTree', () => {
  it('delegates Windows subtree termination to the canonical taskkill boundary', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!platformDescriptor) throw new Error('Expected process.platform to be configurable');
    const child = spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1000)', {
      stdio: 'ignore',
    });
    const terminateWindowsTree = vi.fn(async ({ pid }: { pid: number }) => {
      process.kill(-pid, 'SIGKILL');
    });

    try {
      Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
      await killProcessTree(child, {
        graceMs: 25,
        terminateWindowsTree,
      });
      expect(terminateWindowsTree).toHaveBeenNthCalledWith(1, {
        pid: child.pid,
        force: false,
      });
      expect(terminateWindowsTree).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor);
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // ignore
        }
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
          // ignore
        }
      }
    }
  }, 20_000);

  it('never signals a replacement PID/group after the original POSIX root exited', async () => {
    if (process.platform === 'win32') return;

    await expect(killProcessTree({
      pid: process.pid,
      exitCode: 0,
      signalCode: null,
    }, { graceMs: 25 })).rejects.toMatchObject({
      code: 'plugin_exec_termination_incomplete',
    });
  });

  it('kills the root process in the Vitest process sandbox (posix)', async () => {
    if (process.platform === 'win32') return;

    const { parent, childPid } = await spawnInlineNodeParentWithChild();

    expect(parent.pid).toBeTruthy();
    expect(childPid).toBeGreaterThan(0);
    expect(isPidAlive(parent.pid!)).toBe(true);
    expect(isPidAlive(childPid)).toBe(true);

    try {
      await killProcessTree(parent, { graceMs: 250 });

      await expect(waitForProcessExit(parent.pid!, { timeoutMs: 3_000 })).resolves.toBe(true);
    } finally {
      try {
        process.kill(parent.pid!, 'SIGKILL');
      } catch {
        // ignore
      }
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
  }, 20_000);

  it('bounds a stalled descendant census for a non-detached subprocess (posix)', async () => {
    if (process.platform === 'win32') return;

    const child = spawnInlineNodeTestProcess('setInterval(() => {}, 1000)', {
      stdio: 'ignore',
    });
    let hasOwnProcessGroup = true;
    try {
      process.kill(-child.pid!, 0);
    } catch {
      hasOwnProcessGroup = false;
    }
    expect(hasOwnProcessGroup).toBe(false);

    psListState.mock.mockImplementation(() => new Promise<unknown[]>(() => {}));
    try {
      const outcome = await Promise.race([
        killProcessTree(child, { graceMs: 100 }).then(() => 'completed' as const),
        new Promise<'timedOut'>((resolve) => {
          setTimeout(() => resolve('timedOut'), 1_500);
        }),
      ]);

      expect(outcome).toBe('completed');
      expect(isPidAlive(child.pid!)).toBe(false);
    } finally {
      try {
        process.kill(child.pid!, 'SIGKILL');
      } catch {
        // ignore
      }
    }
  }, 20_000);

  it('force-kills a TERM-resistant direct child when the descendant census stalls (posix)', async () => {
    if (process.platform === 'win32') return;

    const tempDir = mkdtempSync(join(tmpdir(), 'happier-kill-tree-stalled-census-'));
    const readyFile = join(tempDir, 'child.ready');
    const { parent, childPid } = await spawnInlineNodeParentWithChild(
      [
        'const fs = require("node:fs");',
        'process.on("SIGTERM", () => {});',
        `fs.writeFileSync(${JSON.stringify(readyFile)}, String(process.pid));`,
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );

    await waitForPidFile(readyFile, { timeoutMs: 2_000 });
    psListState.mock.mockImplementation(() => new Promise<unknown[]>(() => {}));

    try {
      const outcome = await Promise.race([
        killProcessTree(parent, { graceMs: 100 }).then(() => 'completed' as const),
        new Promise<'timedOut'>((resolve) => {
          setTimeout(() => resolve('timedOut'), 1_500);
        }),
      ]);

      expect(outcome).toBe('completed');
      if (psListState.actual) psListState.mock.mockImplementation(psListState.actual);
      await expect(waitForProcessExit(parent.pid!, { timeoutMs: 3_000 })).resolves.toBe(true);
      await expect(waitForProcessExit(childPid, { timeoutMs: 3_000 })).resolves.toBe(true);
    } finally {
      if (psListState.actual) psListState.mock.mockImplementation(psListState.actual);
      try {
        process.kill(parent.pid!, 'SIGKILL');
      } catch {
        // ignore
      }
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {
        // ignore
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 20_000);

  it('kills late-forked descendants in a detached process group (posix)', async () => {
    if (process.platform === 'win32') return;

    const tempDir = mkdtempSync(join(tmpdir(), 'happier-kill-tree-'));
    const readyFile = join(tempDir, 'ready');
    const grandchildPidFile = join(tempDir, 'grandchild.pid');
    const childSource = [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      'let spawned = false;',
      'process.on("SIGTERM", () => {});',
      'setTimeout(() => {',
      '  if (spawned) return;',
      '  spawned = true;',
      '  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      `  fs.writeFileSync(${JSON.stringify(grandchildPidFile)}, String(grandchild.pid));`,
      '}, 75);',
      `fs.writeFileSync(${JSON.stringify(readyFile)}, "1");`,
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const parent = spawnDetachedInlineNodeTestProcess(
      [
        'const { spawn } = require("node:child_process");',
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(childSource)}], { stdio: "ignore" });`,
        'console.log(String(child.pid));',
        'setInterval(() => {}, 1000);',
      ].join('\n'),
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );

    const childPid = await new Promise<number>((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('Timed out waiting for child pid')), 2_000);
      parent.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const parsed = Number.parseInt(buffer.trim().split('\n')[0] ?? '', 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          clearTimeout(timer);
          resolve(parsed);
        }
      });
      parent.once('error', reject);
      parent.once('exit', () => reject(new Error('Parent exited before child pid was emitted')));
    });

    let grandchildPid: number | null = null;
    try {
      expect(parent.pid).toBeTruthy();
      expect(isPidAlive(parent.pid!)).toBe(true);
      expect(isPidAlive(childPid)).toBe(true);
      await waitForPidFile(readyFile, { timeoutMs: 2_000 });

      await killProcessTree(parent, { graceMs: 250 });

      grandchildPid = await waitForPidFile(grandchildPidFile, { timeoutMs: 2_000 });
      await expect(waitForProcessExit(grandchildPid, { timeoutMs: 3_000 })).resolves.toBe(true);
    } finally {
      if (parent.pid) {
        try {
          process.kill(-parent.pid, 'SIGKILL');
        } catch {
          // ignore
        }
        try {
          process.kill(parent.pid, 'SIGKILL');
        } catch {
          // ignore
        }
      }
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {
        // ignore
      }
      if (grandchildPid !== null) {
        try {
          process.kill(grandchildPid, 'SIGKILL');
        } catch {
          // ignore
        }
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 20_000);

});
