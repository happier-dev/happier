import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
// Exercise acquisition, command policy and capture; only OS spawn and clock are replaced.
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()), spawn: spawnMock,
}));

import { runLocalHappierJsonCommand } from './happierCli.js';
import { createLocalSetupFlowExecutor } from './kinds/localSetupFlowExecutor.js';
import { createDaemonServiceStartHandler, createDaemonServiceStopHandler, createDaemonServiceRestartHandler } from './kinds/daemonService.js';

function childFixture() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }), kill: vi.fn(),
  });
  spawnMock.mockReturnValue(child);
  vi.stubEnv('HAPPIER_BOOTSTRAP_CLI_PATH', process.execPath);
  return child;
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); spawnMock.mockReset(); });

it('lets a legacy local service install finish beyond 60 seconds without changing its environment', async () => {
  vi.useFakeTimers();
  const child = childFixture();
  const processEnv = { HAPPIER_BOOTSTRAP_CLI_PATH: process.execPath, HAPPIER_RELEASE_RING: 'preview' };
  const result = runLocalHappierJsonCommand({ args: ['daemon', 'service', 'install', '--json'], processEnv }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(60_001);
  expect(spawnMock).toHaveBeenCalled();
  expect(spawnMock.mock.calls[0]?.[2].env).toEqual(processEnv);
  expect(child.kill).not.toHaveBeenCalled();
  child.stdout.emit('data', Buffer.from('{"ok":true}'));
  child.emit('close', 0);
  await expect(result).resolves.toEqual({ ok: true });
});

it('cancels an in-flight local flow service command using the task signal', async () => {
  vi.useFakeTimers();
  const child = childFixture();
  const controller = new AbortController();
  const params = { releaseRing: 'stable' as const, signal: controller.signal };
  const flow = createLocalSetupFlowExecutor(params);
  const result = flow.startDaemonService!().catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(1);
  expect(spawnMock).toHaveBeenCalled();
  controller.abort();
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  expect(await result).toMatchObject({ name: 'AbortError' });
});

it.each([createDaemonServiceStartHandler, createDaemonServiceStopHandler, createDaemonServiceRestartHandler])('propagates standalone task cancellation to the service child (%#)', async (createHandler) => {
  vi.useFakeTimers();
  const child = childFixture();
  const statusChild = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
  spawnMock.mockImplementationOnce(() => {
    Promise.resolve().then(() => {
      statusChild.stdout.emit('data', Buffer.from(JSON.stringify({ service: { installed: true }, daemon: { running: true }, auth: { needsAuth: false } })));
      statusChild.emit('close', 0);
    });
    return statusChild;
  });
  const controller = new AbortController();
  const result = (async () => {
    for await (const event of createHandler()({ target: { kind: 'local' } }, {
      taskId: 'service-cancellation-test', signal: controller.signal, now: Date.now, emit: () => {},
    })) { void event; }
  })().catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(1);
  expect(spawnMock).toHaveBeenCalledTimes(2);
  controller.abort();
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  expect(await result).toMatchObject({ name: 'AbortError' });
});
