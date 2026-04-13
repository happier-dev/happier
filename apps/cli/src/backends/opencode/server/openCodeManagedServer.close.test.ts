import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
const resolveWindowsCommandInvocationMock = vi.fn((
  { command, args }: { command: string; args: readonly string[] },
): { command: string; args: string[]; windowsVerbatimArguments?: boolean } => ({
  command,
  args: [...args],
}));
const requireProviderCliLaunchSpecMock = vi.fn(() => ({ command: 'opencode', args: [] }));
const resolveOpenCodeServerAuthHeadersFromEnvMock = vi.fn(() => ({}));
const resolveOpenCodeManagedServerChildEnvMock = vi.fn(() => ({ PATH: process.env.PATH ?? '' }));
const resolveOpenCodeManagedServerTrackedPidMock = vi.fn(async ({ spawnPid }: { spawnPid: number }) => spawnPid);
const terminateManagedOpenCodeServerPidBestEffortMock = vi.fn();
const waitForOpenCodeServerHealthMock = vi.fn(async () => {});

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn() },
}));

vi.mock('@happier-dev/cli-common/process', () => ({
  resolveWindowsCommandInvocation: resolveWindowsCommandInvocationMock,
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

vi.mock('./resolveOpenCodeManagedServerTrackedPid', () => ({
  resolveOpenCodeManagedServerTrackedPid: resolveOpenCodeManagedServerTrackedPidMock,
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
    resolveWindowsCommandInvocationMock.mockReset();
    resolveWindowsCommandInvocationMock.mockImplementation((
      { command, args }: { command: string; args: readonly string[] },
    ): { command: string; args: string[]; windowsVerbatimArguments?: boolean } => ({
      command,
      args: [...args],
    }));
    requireProviderCliLaunchSpecMock.mockClear();
    resolveOpenCodeServerAuthHeadersFromEnvMock.mockClear();
    resolveOpenCodeManagedServerChildEnvMock.mockClear();
    resolveOpenCodeManagedServerTrackedPidMock.mockReset();
    resolveOpenCodeManagedServerTrackedPidMock.mockImplementation(async ({ spawnPid }: { spawnPid: number }) => spawnPid);
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

  it('wraps Windows shell shims before spawning the managed server and tracks the real server pid', async () => {
    const { proc } = createManagedServerProcessHarness();
    spawnMock.mockReturnValue(proc);
    const callOrder: string[] = [];
    resolveOpenCodeManagedServerTrackedPidMock.mockResolvedValue(48123);
    resolveOpenCodeManagedServerTrackedPidMock.mockImplementation(async ({ spawnPid }: { spawnPid: number }) => {
      callOrder.push('resolveTrackedPid');
      return spawnPid === 43111 ? 48123 : spawnPid;
    });
    waitForOpenCodeServerHealthMock.mockImplementation(async () => {
      callOrder.push('health');
    });
    requireProviderCliLaunchSpecMock.mockReturnValue({
      command: 'C:\\Users\\natan\\AppData\\Roaming\\npm\\opencode.CMD',
      args: [],
    });
    resolveWindowsCommandInvocationMock.mockReturnValue({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', '"C:\\Users\\natan\\AppData\\Roaming\\npm\\opencode.CMD serve --hostname=127.0.0.1 --port=43111"'],
      windowsVerbatimArguments: true,
    });

    const { startManagedOpenCodeServer } = await import('./openCodeManagedServer');
    const onSpawned = vi.fn(() => {
      callOrder.push('onSpawned');
    });
    const started = await startManagedOpenCodeServer({ port: 43111, timeoutMs: 25, onSpawned });

    expect(resolveWindowsCommandInvocationMock).toHaveBeenCalledWith(expect.objectContaining({
      command: 'C:\\Users\\natan\\AppData\\Roaming\\npm\\opencode.CMD',
      args: ['serve', '--hostname=127.0.0.1', '--port=43111'],
    }));
    expect(resolveOpenCodeManagedServerTrackedPidMock).toHaveBeenCalledWith(expect.objectContaining({
      spawnPid: 43111,
      baseUrl: 'http://127.0.0.1:43111',
      invocationCommand: 'C:\\Windows\\System32\\cmd.exe',
    }));
    expect(spawnMock).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', '"C:\\Users\\natan\\AppData\\Roaming\\npm\\opencode.CMD serve --hostname=127.0.0.1 --port=43111"'],
      expect.objectContaining({ detached: true, windowsVerbatimArguments: true }),
    );
    expect(started.pid).toBe(48123);
    expect(onSpawned).toHaveBeenCalledWith({ baseUrl: 'http://127.0.0.1:43111', pid: 48123 });
    expect(callOrder).toEqual(['health', 'resolveTrackedPid', 'onSpawned']);

    await started.close();
    expect(terminateManagedOpenCodeServerPidBestEffortMock).toHaveBeenCalledWith(48123);
  });
});
