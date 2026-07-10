import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  isPidAlive,
  spawnDetachedInlineNodeTestProcess,
  spawnInlineNodeParentWithChild,
  waitForProcessExit,
} from '@/testkit/process/spawn';
import { killProcessTree } from './killProcessTree';

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
