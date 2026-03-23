import { afterEach, describe, expect, it } from 'vitest';

describe('process spawn helpers', () => {
  it('spawns a child process and exposes its pid', async () => {
    const processHelpers = await import('@/testkit/process/spawn').catch(() => null);

    expect(processHelpers).not.toBeNull();
    expect(processHelpers?.spawnTestProcess).toBeTypeOf('function');

    const child = processHelpers!.spawnTestProcess(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: 'ignore',
    });

    expect(child.pid).toBeTypeOf('number');

    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => {
        expect(code).toBe(0);
        resolve();
      });
    });
  });

  it('tracks pid liveness and waits for exit', async () => {
    const processHelpers = await import('@/testkit/process/spawn');
    const child = processHelpers.spawnTestProcess(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 50)']);
    const pid = child.pid;

    expect(pid).toBeTypeOf('number');
    expect(processHelpers.isPidAlive(pid!)).toBe(true);
    await expect(processHelpers.waitForProcessExit(pid!, { timeoutMs: 2_000 })).resolves.toBe(true);
    expect(processHelpers.isPidAlive(pid!)).toBe(false);
  });

  it('spawns detached inline node processes', async () => {
    const processHelpers = await import('@/testkit/process/spawn');
    const child = processHelpers.spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1000)');
    const pid = child.pid;

    expect(pid).toBeTypeOf('number');
    expect(processHelpers.isPidAlive(pid!)).toBe(true);

    try {
      process.kill(pid!, 'SIGTERM');
    } catch {
      // ignore
    }

    await expect(processHelpers.waitForProcessExit(pid!, { timeoutMs: 2_000 })).resolves.toBe(true);
  });

  it('spawns a parent node process that reports a child pid', async () => {
    const processHelpers = await import('@/testkit/process/spawn');
    const { parent, childPid } = await processHelpers.spawnInlineNodeParentWithChild();

    expect(parent.pid).toBeTypeOf('number');
    expect(childPid).toBeGreaterThan(0);
    expect(processHelpers.isPidAlive(parent.pid!)).toBe(true);
    expect(processHelpers.isPidAlive(childPid)).toBe(true);

    try {
      process.kill(parent.pid!, 'SIGTERM');
    } catch {
      // ignore
    }

    await expect(processHelpers.waitForProcessExit(parent.pid!, { timeoutMs: 2_000 })).resolves.toBe(true);
  });
});
