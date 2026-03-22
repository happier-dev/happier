import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
const requireProviderCliLaunchSpecMock = vi.fn(() => ({ command: 'opencode', args: [] }));
const resolveOpenCodeServerAuthHeadersFromEnvMock = vi.fn(() => ({}));
const resolveOpenCodeManagedServerChildEnvMock = vi.fn(() => ({ PATH: process.env.PATH ?? '' }));
const terminateManagedOpenCodeServerPidBestEffortMock = vi.fn();
const waitForOpenCodeServerHealthMock = vi.fn(async () => {});

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn() },
}));

vi.mock('@/runtime/managedTools/requireProviderCliLaunchSpec', () => ({
  requireProviderCliLaunchSpec: requireProviderCliLaunchSpecMock,
}));

vi.mock('./openCodeServerAuth', () => ({
  resolveOpenCodeServerAuthHeadersFromEnv: resolveOpenCodeServerAuthHeadersFromEnvMock,
}));

vi.mock('./openCodeManagedServerEnv', () => ({
  resolveOpenCodeManagedServerChildEnv: resolveOpenCodeManagedServerChildEnvMock,
}));

vi.mock('./terminateManagedOpenCodeServerPidBestEffort', () => ({
  terminateManagedOpenCodeServerPidBestEffort: terminateManagedOpenCodeServerPidBestEffortMock,
}));

vi.mock('./waitForOpenCodeServerHealth', () => ({
  waitForOpenCodeServerHealth: waitForOpenCodeServerHealthMock,
}));

function createManagedServerProcessHarness(): {
  proc: EventEmitter & {
    pid: number;
    stdout: EventEmitter & { resume: ReturnType<typeof vi.fn> };
    stderr: EventEmitter & { resume: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
  };
} {
  const stdout = new EventEmitter() as EventEmitter & { resume: ReturnType<typeof vi.fn> };
  stdout.resume = vi.fn();

  const stderr = new EventEmitter() as EventEmitter & { resume: ReturnType<typeof vi.fn> };
  stderr.resume = vi.fn();

  const proc = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: typeof stdout;
    stderr: typeof stderr;
    kill: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
  };
  proc.pid = 43111;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.kill = vi.fn();
  proc.unref = vi.fn();

  return { proc };
}

describe('startManagedOpenCodeServer close fallback', () => {
  afterEach(() => {
    spawnMock.mockReset();
    requireProviderCliLaunchSpecMock.mockClear();
    resolveOpenCodeServerAuthHeadersFromEnvMock.mockClear();
    resolveOpenCodeManagedServerChildEnvMock.mockClear();
    terminateManagedOpenCodeServerPidBestEffortMock.mockReset();
    waitForOpenCodeServerHealthMock.mockReset();
    waitForOpenCodeServerHealthMock.mockResolvedValue(undefined);
  });

  it('falls back to proc.kill when pid termination throws', async () => {
    const { proc } = createManagedServerProcessHarness();
    spawnMock.mockReturnValue(proc);
    terminateManagedOpenCodeServerPidBestEffortMock.mockRejectedValue(new Error('terminate failed'));

    const { startManagedOpenCodeServer } = await import('./openCodeManagedServer');
    const started = await startManagedOpenCodeServer({ port: 43111, timeoutMs: 25 });

    await started.close();

    expect(terminateManagedOpenCodeServerPidBestEffortMock).toHaveBeenCalledWith(43111);
    expect(proc.kill).toHaveBeenCalledTimes(1);
  });
});
