import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
// The OS process and clock are the only mocked boundaries.
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()), spawn: spawnMock,
}));

import { createLocalHappierJsonExecutor } from './happierJsonExecutor.js';
import { scopeHappierJsonExecutor } from './serverScope.js';

function fixture(env: NodeJS.ProcessEnv = {}) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }), kill: vi.fn(),
  });
  spawnMock.mockReturnValue(child);
  const executor = createLocalHappierJsonExecutor({ processEnv: { HAPPIER_BOOTSTRAP_CLI_PATH: process.execPath, ...env } });
  return { child, executor };
}

afterEach(() => { vi.useRealTimers(); spawnMock.mockReset(); });

describe('local Happier command lifecycle budget', () => {
  it('parses the complete JSON response after root exit and pipe closure', async () => {
    vi.useFakeTimers();
    const { child, executor } = fixture();
    const completed = vi.fn();
    const result = executor.runHappierJson(['daemon', 'status', '--json']);
    void result.then(completed, completed);
    await vi.advanceTimersByTimeAsync(0);
    child.stdout.emit('data', Buffer.from('{"ok":'));
    child.emit('exit', 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).not.toHaveBeenCalled();
    child.stdout.emit('data', Buffer.from('true}'));
    child.emit('close', 0);
    await expect(result).resolves.toEqual({ ok: true });
  });

  it('sends explicit Desktop ownership context only to install/status with complete native context', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'happier-executor-desktop-'));
    const { child, executor } = fixture({ HAPPIER_HOME_DIR: join(stateDir, 'home'), HAPPIER_FIRST_PARTY_INSTALL_HOME: join(stateDir, 'install'),
      HAPPIER_DESKTOP_BUNDLE_ID: 'dev.happier.preview', HAPPIER_DESKTOP_STATE_DIR: stateDir });
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => { child.stdout.emit('data', Buffer.from('{"ok":true}')); child.emit('exit', 0); child.emit('close', 0); });
      return child;
    });
    try {
      for (const args of [['service', 'install', '--json'], ['daemon', 'status', '--json'], ['service', 'uninstall', '--json']]) {
        await executor.runHappierJson(args);
        const invokedArgs: string[] = spawnMock.mock.lastCall?.[1] ?? [];
        const shouldRecord = args[1] !== 'uninstall';
        expect(invokedArgs.includes('--desktop-bundle-id')).toBe(shouldRecord);
        if (shouldRecord) expect(invokedArgs.slice(-2)).toEqual(['--desktop-bundle-id', 'dev.happier.preview']);
      }
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });

  it('attributes desktop installs to their bundle and clears inherited attribution on other commands', async () => {
    vi.useFakeTimers();
    const { child, executor } = fixture({
      HAPPIER_DESKTOP_BUNDLE_ID: 'dev.happier.preview',
      HAPPIER_DAEMON_SERVICE_BUNDLE_ID: 'dev.foreign.app',
    });
    for (const [args, expected] of [
      [['service', 'install', '--dry-run', '--json'], 'dev.happier.preview'],
      [['--server', 'home', 'daemon', 'service', 'install', '--json'], 'dev.happier.preview'],
      [['daemon', 'status', '--json'], undefined],
    ] as const) {
      const result = executor.runHappierJson(args);
      await vi.advanceTimersByTimeAsync(0);
      expect(spawnMock.mock.lastCall?.[2]?.env.HAPPIER_DAEMON_SERVICE_BUNDLE_ID).toBe(expected);
      child.stdout.emit('data', Buffer.from('{"ok":true}'));
      child.emit('exit', 0);
      child.emit('close', 0);
      await expect(result).resolves.toEqual({ ok: true });
    }
  });

  it.each([
    ['service', 'install'],
    ['service', 'start'],
    ['service', 'stop'],
    ['service', 'restart'],
    ['daemon', 'system-task'],
  ])('lets scoped %j finish beyond the generic command deadline', async (...args) => {
    vi.useFakeTimers();
    const { child, executor } = fixture();
    const scoped = scopeHappierJsonExecutor(executor, { serverId: 'home', targetMode: 'pinned' }, { HAPPIER_BOOTSTRAP_CLI_PATH: process.execPath });
    const result = scoped.runHappierJson([...args, '--json']).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(spawnMock).toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    child.stdout.emit('data', Buffer.from('{"ok":true}'));
    child.emit('exit', 0);
    child.emit('close', 0);
    await expect(result).resolves.toEqual({ ok: true });
  });

  it.each([
    ['daemon', 'service', 'install'],
    ['daemon', 'system-task'],
  ])('keeps explicit cancellation for %j', async (...args) => {
    vi.useFakeTimers();
    const { child, executor } = fixture();
    const controller = new AbortController();
    const result = executor.runHappierJson([...args, '--json'], { signal: controller.signal }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(child.kill).not.toHaveBeenCalled();
    controller.abort();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(await result).toMatchObject({ name: 'AbortError' });
  });

  it.each([
    ['service', 'status', '--json'],
    ['service', 'install', '--dry-run', '--json'],
    ['auth', 'wait', '--json'],
    ['--version'],
  ])('retains the existing deadline for %j', async (...args) => {
    vi.useFakeTimers();
    const { child, executor } = fixture();
    const result = executor.runHappierText(args).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(await result).toMatchObject({ code: 'cli_spawn_failed', message: expect.stringContaining('timed out') });
  });
});
