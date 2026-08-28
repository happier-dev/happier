import { describe, expect, it, vi } from 'vitest';

import {
  cancelWindowsTerminalLaunch,
  captureExactWindowsTerminalLaunchProcess,
  createExactWindowsProcessCancellation,
} from './windowsProcessCustody';
import { serializeWindowsCommandLine } from './windowsCommandLine';

describe('Windows process launch custody', () => {
  it('taskkills the exact captured birth and reports stopped only after absence', async () => {
    const readIdentity = vi.fn()
      .mockResolvedValueOnce({ processStartTimeMs: 1_000 })
      .mockResolvedValueOnce(null);
    const terminate = vi.fn(async () => undefined);
    const cancel = createExactWindowsProcessCancellation({
      pid: 4_242,
      processStartTimeMs: 1_000,
      readProcessIdentityByPidFn: readIdentity,
      terminateProcessTreeFn: terminate,
      isPidAliveFn: () => false,
    });

    await expect(cancel()).resolves.toEqual({ status: 'stopped' });
    await expect(cancel()).resolves.toEqual({ status: 'stopped' });
    expect(terminate).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledWith({ pid: 4_242, force: true });
  });

  it('retains custody when taskkill loses the exact root before tree disposition', async () => {
    const cancel = createExactWindowsProcessCancellation({
      pid: 4_242,
      processStartTimeMs: 1_000,
      readProcessIdentityByPidFn: vi.fn(async () => ({
        processStartTimeMs: 1_000,
      })),
      terminateProcessTreeFn: vi.fn(async () => 'root_not_found' as const),
      isPidAliveFn: () => false,
    });

    await expect(cancel()).resolves.toEqual({
      status: 'incomplete',
      reason: 'terminal_host_disposition_failed',
    });
  });

  it('does NOT report stopped for an access-denied process when using the default liveness probe', async () => {
    // The bare-`catch` regression, exercised through the REAL default rather than an injected
    // stub: `isPidAliveFn` is deliberately not passed. A process the daemon may not signal is
    // alive (EACCES on Windows, EPERM on POSIX); custody used to read that as dead and report
    // `{ status: 'stopped' }` — claiming a successful termination of a process still running.
    for (const code of ['EACCES', 'EPERM']) {
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('access denied'), { code });
      });
      try {
        const cancel = createExactWindowsProcessCancellation({
          pid: 4_242,
          processStartTimeMs: 1_000,
          // The identity read comes back empty — the access-denied case — so the decision falls
          // entirely to the liveness probe.
          readProcessIdentityByPidFn: vi.fn(async () => null),
          terminateProcessTreeFn: vi.fn(async () => undefined),
        });

        await expect(cancel()).resolves.toEqual({
          status: 'incomplete',
          reason: 'terminal_host_custody_unproven',
        });
      } finally {
        kill.mockRestore();
      }
    }
  });

  it('still reports stopped when the default probe proves the process is genuinely absent', async () => {
    // The other side of the pair: ESRCH must remain a real `stopped`, so the fix above cannot be
    // satisfied by simply never reporting stopped.
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });
    try {
      const cancel = createExactWindowsProcessCancellation({
        pid: 4_242,
        processStartTimeMs: 1_000,
        readProcessIdentityByPidFn: vi.fn(async () => null),
        terminateProcessTreeFn: vi.fn(async () => undefined),
      });

      await expect(cancel()).resolves.toEqual({ status: 'stopped' });
    } finally {
      kill.mockRestore();
    }
  });

  it('does not accept an initial zero inventory before a delayed correlated child appears', async () => {
    const process = {
      pid: 9_999,
      processStartTimeMs: 2_000,
      executablePath: launch.executablePath,
      command,
    };
    const readInventory = vi.fn()
      .mockResolvedValueOnce(new Map())
      .mockResolvedValueOnce(new Map([[process.pid, process]]));
    const readIdentity = vi.fn()
      .mockResolvedValueOnce(process)
      .mockResolvedValueOnce(null);
    const terminate = vi.fn(async () => undefined);

    await expect(cancelWindowsTerminalLaunch({
      launch,
      retirementNotBeforeMs: 1_000,
      nowFn: () => 0,
      sleepFn: async () => undefined,
      readAllWindowsProcessFactsFn: readInventory,
      readProcessIdentityByPidFn: readIdentity,
      terminateProcessTreeFn: terminate,
      isPidAliveFn: () => false,
    })).resolves.toEqual({ status: 'stopped' });
    expect(readInventory).toHaveBeenCalledTimes(2);
    expect(terminate).toHaveBeenCalledOnce();
  });

  it('does not taskkill a reused PID with a different birth', async () => {
    const terminate = vi.fn(async () => undefined);
    const cancel = createExactWindowsProcessCancellation({
      pid: 4_242,
      processStartTimeMs: 1_000,
      readProcessIdentityByPidFn: async () => ({
        processStartTimeMs: 2_000,
      }),
      terminateProcessTreeFn: terminate,
      isPidAliveFn: () => true,
    });

    await expect(cancel()).resolves.toEqual({
      status: 'incomplete',
      reason: 'terminal_host_custody_unproven',
    });
    expect(terminate).not.toHaveBeenCalled();
  });

  it('reports a surviving exact process after taskkill', async () => {
    const cancel = createExactWindowsProcessCancellation({
      pid: 4_242,
      processStartTimeMs: 1_000,
      readProcessIdentityByPidFn: vi.fn(async () => ({
        processStartTimeMs: 1_000,
      })),
      terminateProcessTreeFn: vi.fn(async () => undefined),
      isPidAliveFn: () => true,
    });

    await expect(cancel()).resolves.toEqual({
      status: 'incomplete',
      reason: 'process_still_running',
    });
  });

  it('does not claim stopped when post-taskkill identity is unreadable but the PID is alive', async () => {
    const readIdentity = vi.fn()
      .mockResolvedValueOnce({ processStartTimeMs: 1_000 })
      .mockResolvedValueOnce(null);
    const cancel = createExactWindowsProcessCancellation({
      pid: 4_242,
      processStartTimeMs: 1_000,
      readProcessIdentityByPidFn: readIdentity,
      terminateProcessTreeFn: vi.fn(async () => undefined),
      isPidAliveFn: () => true,
    });

    await expect(cancel()).resolves.toEqual({
      status: 'incomplete',
      reason: 'terminal_host_custody_unproven',
    });
  });

  const launch = {
    executablePath: 'C:\\Program Files\\Happier\\happier.exe',
    argv: [
      'codex',
      '--happy-terminal-mode',
      'windows_terminal',
      '--happy-terminal-launch-correlation',
      'ab'.repeat(16),
    ],
    correlation: 'ab'.repeat(16),
  } as const;
  const command = serializeWindowsCommandLine([
    launch.executablePath,
    ...launch.argv,
  ]);

  it('captures only PID, birth, and command hash from an exact packaged executable/full-argv webhook process', () => {
    expect(captureExactWindowsTerminalLaunchProcess({
      process: {
        pid: 9_999,
        processStartTimeMs: 2_000,
        executablePath: 'c:/program files/happier/HAPPIER.EXE',
        command,
      },
      launch,
    })).toEqual({
      pid: 9_999,
      processStartTimeMs: 2_000,
      processCommandHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it('captures and cancels an exact command beyond the local-service privacy projection limit', async () => {
    const longLaunch = {
      ...launch,
      argv: [...launch.argv, 'x'.repeat(1_500)],
    };
    const longCommand = serializeWindowsCommandLine([
      longLaunch.executablePath,
      ...longLaunch.argv,
    ]);
    const process = {
      pid: 10_001,
      processStartTimeMs: 3_000,
      executablePath: longLaunch.executablePath,
      command: longCommand,
    };
    const captured =
      captureExactWindowsTerminalLaunchProcess({
        process,
        launch: longLaunch,
      });
    expect(captured).toEqual({
      pid: process.pid,
      processStartTimeMs: process.processStartTimeMs,
      processCommandHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const terminate = vi.fn(async () => undefined);
    const readIdentity = vi.fn()
      .mockResolvedValueOnce(process)
      .mockResolvedValueOnce(null);

    await expect(cancelWindowsTerminalLaunch({
      launch: longLaunch,
      capturedIdentity: captured!,
      readProcessIdentityByPidFn: readIdentity,
      terminateProcessTreeFn: terminate,
      isPidAliveFn: () => false,
    })).resolves.toEqual({ status: 'stopped' });
    expect(terminate).toHaveBeenCalledWith({
      pid: process.pid,
      force: true,
    });
  });

  it.each([
    ['wrong executable', {
      pid: 9_999,
      processStartTimeMs: 2_000,
      executablePath: 'C:\\Tools\\forged.exe',
      command,
    }],
    ['missing argument', {
      pid: 9_999,
      processStartTimeMs: 2_000,
      executablePath: launch.executablePath,
      command: serializeWindowsCommandLine([
        launch.executablePath,
        ...launch.argv.slice(0, -1),
      ]),
    }],
    ['forged correlation in different argv', {
      pid: 9_999,
      processStartTimeMs: 2_000,
      executablePath: launch.executablePath,
      command: serializeWindowsCommandLine([
        launch.executablePath,
        '--forged',
        launch.correlation,
      ]),
    }],
  ])('refuses exact launch capture for %s', (_label, process) => {
    expect(captureExactWindowsTerminalLaunchProcess({
      process,
      launch,
    })).toBeNull();
  });

  it('treats zero correlated inventory candidates as already stopped', async () => {
    const terminate = vi.fn(async () => undefined);
    await expect(cancelWindowsTerminalLaunch({
      launch,
      readAllWindowsProcessFactsFn: async () => new Map(),
      readProcessIdentityByPidFn: async () => null,
      terminateProcessTreeFn: terminate,
      isPidAliveFn: () => false,
    })).resolves.toEqual({ status: 'stopped' });
    expect(terminate).not.toHaveBeenCalled();
  });

  it('fails closed when a same-executable inventory row has an unreadable command line', async () => {
    const terminate = vi.fn(async () => undefined);
    const unreadable = {
      pid: 9_999,
      processStartTimeMs: 2_000,
      executablePath: launch.executablePath,
    };

    await expect(cancelWindowsTerminalLaunch({
      launch,
      readAllWindowsProcessFactsFn: async () =>
        new Map([[unreadable.pid, unreadable]]),
      readProcessIdentityByPidFn: async () => null,
      terminateProcessTreeFn: terminate,
      isPidAliveFn: () => true,
    })).resolves.toEqual({
      status: 'incomplete',
      reason: 'terminal_host_custody_unproven',
    });
    expect(terminate).not.toHaveBeenCalled();
  });

  it('cancels one exact surviving inventory process after identity revalidation', async () => {
    const process = {
      pid: 9_999,
      processStartTimeMs: 2_000,
      executablePath: launch.executablePath,
      command,
    };
    const terminate = vi.fn(async () => undefined);
    const readIdentity = vi.fn()
      .mockResolvedValueOnce(process)
      .mockResolvedValueOnce(null);

    await expect(cancelWindowsTerminalLaunch({
      launch,
      readAllWindowsProcessFactsFn: async () =>
        new Map([[process.pid, process]]),
      readProcessIdentityByPidFn: readIdentity,
      terminateProcessTreeFn: terminate,
      isPidAliveFn: () => false,
    })).resolves.toEqual({ status: 'stopped' });
    expect(terminate).toHaveBeenCalledWith({
      pid: process.pid,
      force: true,
    });
  });

  it.each([
    ['unreadable', async () => {
      throw new Error('access denied');
    }],
    ['multiple', async () => new Map([
      [9_998, {
        pid: 9_998,
        processStartTimeMs: 1_999,
        executablePath: launch.executablePath,
        command,
      }],
      [9_999, {
        pid: 9_999,
        processStartTimeMs: 2_000,
        executablePath: launch.executablePath,
        command,
      }],
    ])],
    ['forged', async () => new Map([[9_999, {
      pid: 9_999,
      processStartTimeMs: 2_000,
      executablePath: launch.executablePath,
      command: serializeWindowsCommandLine([
        launch.executablePath,
        '--forged',
        launch.correlation,
      ]),
    }]])],
  ] as const)('does not kill %s correlated inventory evidence', async (_label, readInventory) => {
    const terminate = vi.fn(async () => undefined);
    await expect(cancelWindowsTerminalLaunch({
      launch,
      readAllWindowsProcessFactsFn: readInventory,
      readProcessIdentityByPidFn: async () => null,
      terminateProcessTreeFn: terminate,
      isPidAliveFn: () => true,
    })).resolves.toEqual({
      status: 'incomplete',
      reason: 'terminal_host_custody_unproven',
    });
    expect(terminate).not.toHaveBeenCalled();
  });
});
