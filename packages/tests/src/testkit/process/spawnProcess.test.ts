import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { waitFor } from '../timing';
import { isProcessAlive, terminateProcessTreeByPid } from './processTree';
import { runLoggedCommand, runLoggedCommandWithOutcome, spawnLoggedProcess } from './spawnProcess';

async function waitForMarker(path: string, timeoutMs = 10_000): Promise<{ childPid: number; grandchildPid: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw) as { childPid?: unknown; grandchildPid?: unknown };
      const childPid = Number(parsed.childPid);
      const grandchildPid = Number(parsed.grandchildPid);
      if (Number.isInteger(childPid) && childPid > 1 && Number.isInteger(grandchildPid) && grandchildPid > 1) {
        return { childPid, grandchildPid };
      }
    } catch {
      // keep polling until the marker is written
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for marker: ${path}`);
}

describe('spawnLoggedProcess', () => {
  it.each([
    { label: 'successful exit', exitCode: 0 },
    { label: 'failed exit', exitCode: 7 },
    { label: 'explicit teardown', exitCode: null },
  ])('cleans an owned path after $label without touching a sibling', async ({ label, exitCode }) => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-spawn-owned-cleanup-'));
    const ownedPath = join(rootDir, 'owned');
    const siblingPath = join(rootDir, 'sibling');
    const readyPath = join(rootDir, 'child.ready');
    const releasePath = join(rootDir, 'child.release');
    let cleanupCalls = 0;
    const childScript = [
      "const { existsSync, writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(readyPath)}, 'ready', 'utf8');`,
      exitCode === null
        ? 'setInterval(() => {}, 1000);'
        : [
            'const waitForRelease = () => {',
            `  if (existsSync(${JSON.stringify(releasePath)})) process.exit(${exitCode});`,
            '  setTimeout(waitForRelease, 5);',
            '};',
            'waitForRelease();',
          ].join('\n'),
      '',
    ].join('\n');

    try {
      await Promise.all([mkdir(ownedPath), mkdir(siblingPath)]);
      const proc = spawnLoggedProcess({
        command: process.execPath,
        args: ['-e', childScript],
        cwd: rootDir,
        stdoutPath: join(rootDir, 'stdout.log'),
        stderrPath: join(rootDir, 'stderr.log'),
        cleanup: async () => {
          cleanupCalls += 1;
          await rm(ownedPath, { recursive: true, force: true });
        },
      });

      await waitFor(() => existsSync(readyPath), {
        timeoutMs: 10_000,
        intervalMs: 10,
        context: `spawnLoggedProcess ${label} child ready`,
      });
      expect(cleanupCalls).toBe(0);
      expect(existsSync(ownedPath)).toBe(true);

      if (label === 'explicit teardown') {
        await proc.stop();
      } else {
        await writeFile(releasePath, 'release', 'utf8');
        await waitFor(() => proc.child.exitCode !== null, {
          timeoutMs: 10_000,
          intervalMs: 25,
          context: `spawnLoggedProcess ${label}`,
        });
      }
      await waitFor(() => !existsSync(ownedPath), {
        timeoutMs: 10_000,
        intervalMs: 25,
        context: `spawnLoggedProcess ${label} owned cleanup`,
      });

      expect(existsSync(siblingPath)).toBe(true);
      await proc.stop();
      expect(cleanupCalls).toBe(1);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('surfaces a cached owned-cleanup failure from stop without retrying cleanup', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-spawn-owned-cleanup-failure-'));
    let cleanupCalls = 0;

    try {
      const proc = spawnLoggedProcess({
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        cwd: rootDir,
        stdoutPath: join(rootDir, 'stdout.log'),
        stderrPath: join(rootDir, 'stderr.log'),
        cleanup: async () => {
          cleanupCalls += 1;
          throw new Error('synthetic owned cleanup failure');
        },
      });

      await waitFor(() => cleanupCalls === 1, {
        timeoutMs: 10_000,
        intervalMs: 25,
        context: 'spawnLoggedProcess failed owned cleanup attempt',
      });

      await expect(proc.stop()).rejects.toThrow('synthetic owned cleanup failure');
      await expect(proc.stop()).rejects.toThrow('synthetic owned cleanup failure');
      expect(cleanupCalls).toBe(1);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('runs descendant and owned cleanup as cached siblings and aggregates explicit-stop failures', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-spawn-explicit-cleanup-aggregate-'));
    const readyPath = join(rootDir, 'child.ready');
    const terminateProcessTree = vi.fn(async (pid: number) => {
      await terminateProcessTreeByPid(pid, { graceMs: 0, pollMs: 25, skipAliveCheck: true });
      throw new Error('synthetic descendant termination failure');
    });
    const cleanup = vi.fn(async () => {
      throw new Error('synthetic owned cleanup failure');
    });

    try {
      const proc = spawnLoggedProcess({
        command: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, 'ready'); setInterval(() => {}, 1000);`],
        cwd: rootDir,
        stdoutPath: join(rootDir, 'stdout.log'),
        stderrPath: join(rootDir, 'stderr.log'),
        collectDescendants: () => [91_001],
        terminateProcessTree,
        cleanup,
      });
      await waitFor(() => existsSync(readyPath), {
        timeoutMs: 10_000,
        intervalMs: 10,
        context: 'explicit cleanup aggregation child ready',
      });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const error = await proc.stop().then(
          () => null,
          (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors.map(String)).toEqual(expect.arrayContaining([
          expect.stringContaining('synthetic descendant termination failure'),
          expect.stringContaining('synthetic owned cleanup failure'),
        ]));
      }
      expect(terminateProcessTree).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('warns once for automatic-exit cleanup failure and later stop surfaces cached sibling failures', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-spawn-auto-cleanup-aggregate-'));
    const readyPath = join(rootDir, 'child.ready');
    const releasePath = join(rootDir, 'child.release');
    const terminateProcessTree = vi.fn(async (pid: number) => {
      await terminateProcessTreeByPid(pid, { graceMs: 0, pollMs: 25, skipAliveCheck: true });
      throw new Error(`sensitive descendant failure ${rootDir}`);
    });
    const cleanup = vi.fn(async () => {
      throw new Error(`sensitive owned cleanup failure ${rootDir}`);
    });
    const warningSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});

    try {
      const childScript = [
        "const { existsSync, writeFileSync } = require('node:fs');",
        `writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
        `const wait = () => existsSync(${JSON.stringify(releasePath)}) ? process.exit(0) : setTimeout(wait, 5);`,
        'wait();',
      ].join('\n');
      const proc = spawnLoggedProcess({
        command: process.execPath,
        args: ['-e', childScript],
        cwd: rootDir,
        stdoutPath: join(rootDir, 'stdout.log'),
        stderrPath: join(rootDir, 'stderr.log'),
        collectDescendants: () => [91_002],
        terminateProcessTree,
        cleanup,
      });
      await waitFor(() => existsSync(readyPath), {
        timeoutMs: 10_000,
        intervalMs: 10,
        context: 'automatic cleanup aggregation child ready',
      });
      await writeFile(releasePath, 'release', 'utf8');
      await waitFor(() => proc.child.exitCode !== null, {
        timeoutMs: 10_000,
        intervalMs: 10,
        context: 'automatic cleanup aggregation child exit',
      });
      await vi.waitFor(() => {
        expect(warningSpy).toHaveBeenCalledOnce();
      }, { timeout: 5_000, interval: 10 });

      expect(warningSpy).toHaveBeenCalledWith(
        expect.stringContaining('phase=automatic-exit'),
        expect.objectContaining({ code: 'HAPPIER_TEST_PROCESS_AUTO_CLEANUP_FAILED' }),
      );
      expect(String(warningSpy.mock.calls[0]?.[0])).not.toContain(rootDir);
      expect(String(warningSpy.mock.calls[0]?.[0])).not.toContain('sensitive');

      const error = await proc.stop().then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors.map(String)).toEqual(expect.arrayContaining([
        expect.stringContaining('sensitive descendant failure'),
        expect.stringContaining('sensitive owned cleanup failure'),
      ]));
      expect(terminateProcessTree).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalledOnce();
      expect(warningSpy).toHaveBeenCalledOnce();
    } finally {
      warningSpy.mockRestore();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('stops detached descendants even after the direct child has already exited', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const rootDir = await mkdtemp(join(tmpdir(), 'happier-spawn-logged-process-'));
    const markerPath = join(rootDir, 'marker.json');
    const ownedPath = join(rootDir, 'owned');
    const stdoutPath = join(rootDir, 'stdout.log');
    const stderrPath = join(rootDir, 'stderr.log');

    const childScript = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
      'grandchild.unref();',
      `writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ childPid: process.pid, grandchildPid: grandchild.pid }), 'utf8');`,
      'setTimeout(() => process.exit(0), 1000);',
      '',
    ].join('\n');

    try {
      await mkdir(ownedPath);
      const proc = spawnLoggedProcess({
        command: process.execPath,
        args: ['-e', childScript],
        cwd: rootDir,
        stdoutPath,
        stderrPath,
        cleanup: async () => {
          await rm(ownedPath, { recursive: true, force: true });
        },
      });

      const { grandchildPid } = await waitForMarker(markerPath);
      await waitFor(() => proc.child.exitCode !== null, {
        timeoutMs: 10_000,
        intervalMs: 25,
        context: 'spawnLoggedProcess direct child exit',
      });
      expect(proc.child.exitCode).toBe(0);
      await proc.stop();
      await waitFor(() => !isProcessAlive(grandchildPid), {
        timeoutMs: 10_000,
        intervalMs: 50,
        context: 'spawnLoggedProcess explicit stop detached descendant cleanup',
      });
    } finally {
      try {
        const raw = await readFile(markerPath, 'utf8');
        const parsed = JSON.parse(raw) as { grandchildPid?: unknown };
        const grandchildPid = Number(parsed.grandchildPid);
        if (Number.isInteger(grandchildPid) && grandchildPid > 1) {
          await terminateProcessTreeByPid(grandchildPid, { graceMs: 0, pollMs: 25, skipAliveCheck: true }).catch(() => {});
        }
      } catch {
        // ignore cleanup failures
      }
      await rm(rootDir, { recursive: true, force: true });
    }
  }, 15_000);

  it('reaps detached descendants when the direct child exits without an explicit stop call', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const rootDir = await mkdtemp(join(tmpdir(), 'happier-spawn-logged-process-autocleanup-'));
    const markerPath = join(rootDir, 'marker.json');
    const ownedPath = join(rootDir, 'owned');
    const releasePath = join(rootDir, 'release');
    const stdoutPath = join(rootDir, 'stdout.log');
    const stderrPath = join(rootDir, 'stderr.log');
    let resolveDescendantObserved!: () => void;
    const descendantObserved = new Promise<void>((resolveObserved) => {
      resolveDescendantObserved = resolveObserved;
    });

    const childScript = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
      'grandchild.unref();',
      `writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ childPid: process.pid, grandchildPid: grandchild.pid }), 'utf8');`,
      "const { existsSync } = require('node:fs');",
      `const waitForRelease = () => existsSync(${JSON.stringify(releasePath)}) ? process.exit(0) : setTimeout(waitForRelease, 5);`,
      'waitForRelease();',
      '',
    ].join('\n');

    try {
      await mkdir(ownedPath);
      const proc = spawnLoggedProcess({
        command: process.execPath,
        args: ['-e', childScript],
        cwd: rootDir,
        stdoutPath,
        stderrPath,
        onDescendantObserved: () => resolveDescendantObserved(),
        cleanup: async () => {
          await rm(ownedPath, { recursive: true, force: true });
        },
      });

      const { grandchildPid } = await waitForMarker(markerPath);
      await descendantObserved;
      await writeFile(releasePath, 'release', 'utf8');
      await waitFor(() => proc.child.exitCode !== null, {
        timeoutMs: 10_000,
        intervalMs: 25,
        context: 'spawnLoggedProcess auto cleanup direct child exit',
      });
      expect(proc.child.exitCode).toBe(0);

      await waitFor(() => !isProcessAlive(grandchildPid), {
        timeoutMs: 10_000,
        intervalMs: 50,
        context: 'spawnLoggedProcess auto cleanup detached descendant',
      });
      await waitFor(() => !existsSync(ownedPath), {
        timeoutMs: 10_000,
        intervalMs: 25,
        context: 'spawnLoggedProcess owned cleanup after descendant exit',
      });
    } finally {
      try {
        const raw = await readFile(markerPath, 'utf8');
        const parsed = JSON.parse(raw) as { grandchildPid?: unknown };
        const grandchildPid = Number(parsed.grandchildPid);
        if (Number.isInteger(grandchildPid) && grandchildPid > 1) {
          await terminateProcessTreeByPid(grandchildPid, { graceMs: 0, pollMs: 25, skipAliveCheck: true }).catch(() => {});
        }
      } catch {
        // ignore cleanup failures
      }
      await rm(rootDir, { recursive: true, force: true });
    }
  }, 15_000);

  it('can leave detached descendants running when exit cleanup is disabled', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const rootDir = await mkdtemp(join(tmpdir(), 'happier-spawn-logged-process-no-autocleanup-'));
    const markerPath = join(rootDir, 'marker.json');
    const ownedPath = join(rootDir, 'owned');
    const releasePath = join(rootDir, 'release');
    const stdoutPath = join(rootDir, 'stdout.log');
    const stderrPath = join(rootDir, 'stderr.log');
    let cleanupCalls = 0;
    let observedGrandchildPid = 0;
    let resolveDescendantObserved!: () => void;
    const descendantObserved = new Promise<void>((resolveObserved) => {
      resolveDescendantObserved = resolveObserved;
    });

    const childScript = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
      'grandchild.unref();',
      `writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ childPid: process.pid, grandchildPid: grandchild.pid }), 'utf8');`,
      "const { existsSync } = require('node:fs');",
      `const waitForRelease = () => existsSync(${JSON.stringify(releasePath)}) ? process.exit(0) : setTimeout(waitForRelease, 5);`,
      'waitForRelease();',
      '',
    ].join('\n');

    try {
      await mkdir(ownedPath);
      const proc = spawnLoggedProcess({
        command: process.execPath,
        args: ['-e', childScript],
        cwd: rootDir,
        stdoutPath,
        stderrPath,
        cleanupDescendantsOnExit: false,
        onDescendantObserved: () => resolveDescendantObserved(),
        cleanup: async () => {
          cleanupCalls += 1;
          await rm(ownedPath, { recursive: true, force: true });
        },
      });

      const { grandchildPid } = await waitForMarker(markerPath);
      observedGrandchildPid = grandchildPid;
      await descendantObserved;
      await writeFile(releasePath, 'release', 'utf8');
      await waitFor(() => proc.child.exitCode !== null, {
        timeoutMs: 10_000,
        intervalMs: 25,
        context: 'spawnLoggedProcess no auto cleanup direct child exit',
      });
      expect(proc.child.exitCode).toBe(0);

      await waitFor(() => isProcessAlive(grandchildPid), {
        timeoutMs: 1_000,
        intervalMs: 50,
        context: 'spawnLoggedProcess no auto cleanup descendant remains alive',
      });
      expect(cleanupCalls).toBe(0);
      expect(existsSync(ownedPath)).toBe(true);

      await proc.stop();
      expect(cleanupCalls).toBe(1);
      expect(existsSync(ownedPath)).toBe(false);
    } finally {
      try {
        const raw = await readFile(markerPath, 'utf8');
        const parsed = JSON.parse(raw) as { grandchildPid?: unknown };
        const grandchildPid = Number(parsed.grandchildPid);
        if (Number.isInteger(grandchildPid) && grandchildPid > 1) {
          await terminateProcessTreeByPid(grandchildPid, { graceMs: 0, pollMs: 25, skipAliveCheck: true }).catch(() => {});
        }
      } catch {
        // ignore cleanup failures
      }
      await rm(rootDir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe('runLoggedCommand', () => {
  it('returns the actual zero exit tuple after log streams drain', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-run-logged-command-success-'));

    try {
      await expect(runLoggedCommandWithOutcome({
        command: process.execPath,
        args: ['-e', "process.stdout.write('ok\\n')"],
        cwd: rootDir,
        stdoutPath: join(rootDir, 'stdout.log'),
        stderrPath: join(rootDir, 'stderr.log'),
      })).resolves.toEqual({ exitCode: 0, signal: null });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('attaches the actual nonzero exit tuple to command failures', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-run-logged-command-failure-'));

    try {
      const error = await runLoggedCommandWithOutcome({
        command: process.execPath,
        args: ['-e', 'process.exit(7)'],
        cwd: rootDir,
        stdoutPath: join(rootDir, 'stdout.log'),
        stderrPath: join(rootDir, 'stderr.log'),
      }).then(
        () => null,
        (reason: unknown) => reason,
      );

      expect(error).toMatchObject({
        message: expect.stringContaining('code 7'),
        process: { exitCode: 7, signal: null },
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('attaches the actual signal tuple to signal failures', async () => {
    if (process.platform === 'win32') return;
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-run-logged-command-signal-'));

    try {
      const error = await runLoggedCommandWithOutcome({
        command: process.execPath,
        args: ['-e', "process.kill(process.pid, 'SIGTERM')"],
        cwd: rootDir,
        stdoutPath: join(rootDir, 'stdout.log'),
        stderrPath: join(rootDir, 'stderr.log'),
      }).then(
        () => null,
        (reason: unknown) => reason,
      );

      expect(error).toMatchObject({
        message: expect.stringContaining('signal SIGTERM'),
        process: { exitCode: null, signal: 'SIGTERM' },
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('aborts promptly and reaps descendant processes when aborted', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const rootDir = await mkdtemp(join(tmpdir(), 'happier-run-logged-command-abort-'));
    const markerPath = join(rootDir, 'marker.json');
    const stdoutPath = join(rootDir, 'stdout.log');
    const stderrPath = join(rootDir, 'stderr.log');
    const abortController = new AbortController();

    const childScript = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
      'grandchild.unref();',
      `writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ childPid: process.pid, grandchildPid: grandchild.pid }), 'utf8');`,
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n');

    try {
      const runPromise = runLoggedCommand({
        command: process.execPath,
        args: ['-e', childScript],
        cwd: rootDir,
        stdoutPath,
        stderrPath,
        timeoutMs: 30_000,
        abortSignal: abortController.signal,
      });

      const { childPid, grandchildPid } = await waitForMarker(markerPath);
      abortController.abort(new Error('runLoggedCommand aborted for test'));

      const outcome = await Promise.race([
        runPromise.then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error : new Error(String(error)) }),
        ),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('runLoggedCommand did not abort quickly')), 5_000);
        }),
      ]);

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error.message).toMatch(/aborted for test/i);
      }

      await waitFor(() => !isProcessAlive(childPid), {
        timeoutMs: 10_000,
        intervalMs: 50,
        context: 'runLoggedCommand aborted child cleanup',
      });
      await waitFor(() => !isProcessAlive(grandchildPid), {
        timeoutMs: 10_000,
        intervalMs: 50,
        context: 'runLoggedCommand aborted descendant cleanup',
      });
    } finally {
      try {
        const raw = await readFile(markerPath, 'utf8');
        const parsed = JSON.parse(raw) as { grandchildPid?: unknown };
        const grandchildPid = Number(parsed.grandchildPid);
        if (Number.isInteger(grandchildPid) && grandchildPid > 1) {
          await terminateProcessTreeByPid(grandchildPid, { graceMs: 0, pollMs: 25, skipAliveCheck: true }).catch(() => {});
        }
      } catch {
        // ignore cleanup failures
      }
      await rm(rootDir, { recursive: true, force: true });
    }
  }, 20_000);
});
