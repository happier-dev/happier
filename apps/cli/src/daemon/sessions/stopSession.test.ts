import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  TerminalAttachmentInfo,
  TerminalHostAttachmentInfo,
} from '@/terminal/attachment/terminalAttachmentInfo';

const isPidSafeHappySessionProcess = vi.fn(async () => true);
vi.mock('../pidSafety', () => ({
  isPidSafeHappySessionProcess,
}));

const spawnSyncMock = vi.fn();
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: spawnSyncMock,
  };
});

const tmuxKillWindow = vi.fn(async (_sessionIdentifier: string) => true);
type TmuxExecuteArgs = [cmd: string[], session?: string, window?: string, pane?: string, socketPath?: string];
const tmuxExecuteTmuxCommand = vi.fn(async (..._args: TmuxExecuteArgs) => ({
  returncode: 0,
  stdout: '',
  stderr: '',
  command: [],
}));
const tmuxCtorCalls: Array<{ sessionName?: string; env?: Record<string, string>; socketPath?: string }> = [];
vi.mock('@/integrations/tmux/TmuxUtilities', () => ({
  TmuxUtilities: class {
    constructor(sessionName?: string, env?: Record<string, string>, socketPath?: string) {
      tmuxCtorCalls.push({ sessionName, env, socketPath });
    }
    killWindow(sessionIdentifier: string) {
      return tmuxKillWindow(sessionIdentifier);
    }
    executeTmuxCommand(
      cmd: string[],
      session?: string,
      window?: string,
      pane?: string,
      socketPath?: string,
    ) {
      return tmuxExecuteTmuxCommand(cmd, session, window, pane, socketPath);
    }
  },
}));

function withProcessPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', {
    ...(originalPlatformDescriptor ?? {}),
    configurable: true,
    value: platform,
  });
  return run().finally(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  });
}

function createBoundAttachment(
  sessionId: string,
  attachmentIdRaw: string,
): Extract<TerminalHostAttachmentInfo, { version: 2 }> {
  const attachmentId = attachmentIdRaw as NonNullable<import('@happier-dev/agents').TerminalHostHandle['attachmentId']>;
  return {
    version: 2,
    attachmentId,
    sessionId,
    handle: {
      attachmentId,
      kind: 'zellij',
      sessionName: `happier-${sessionId}`,
      paneId: 'terminal_1',
      socketDir: `/tmp/${sessionId}`,
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    },
    updatedAt: 1,
  };
}

function createWindowsBoundAttachment(sessionId: string, attachmentIdRaw: string): TerminalHostAttachmentInfo {
  const attachmentId = attachmentIdRaw as NonNullable<import('@happier-dev/agents').TerminalHostHandle['attachmentId']>;
  return {
    version: 2,
    attachmentId,
    sessionId,
    handle: {
      attachmentId,
      kind: 'windows_console',
      sessionName: `happier-${sessionId}`,
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'exclusive',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    },
    updatedAt: 1,
  };
}

describe('createStopSession', () => {
  beforeEach(() => {
    isPidSafeHappySessionProcess.mockReset();
    isPidSafeHappySessionProcess.mockResolvedValue(true);
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: 0 });
    tmuxKillWindow.mockReset();
    tmuxKillWindow.mockResolvedValue(true);
    tmuxExecuteTmuxCommand.mockReset();
    tmuxExecuteTmuxCommand.mockResolvedValue({
      returncode: 0,
      stdout: '',
      stderr: '',
      command: [],
    });
    tmuxCtorCalls.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fails closed before signaling when host attachment topology evidence is unreadable', async () => {
    const { createStopSession } = await import('./stopSession');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const stop = createStopSession({
      pidToTrackedSession: new Map<number, any>([[
        110,
        {
          startedBy: 'terminal',
          pid: 110,
          happySessionId: 'sess-unreadable',
          processCommandHash: 'h0',
          spawnOptions: { terminal: { mode: 'plain' } },
        },
      ]]),
      readHostAttachmentState: vi.fn(async () => ({ status: 'unreadable', reason: 'invalid' } as const)),
      waitForTrackedRunnersExit: vi.fn(async () => true),
    });

    await expect(stop('sess-unreadable')).resolves.toEqual({
      status: 'incomplete',
      reason: 'missing_topology_proof',
    });
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('allows descriptor absence only when marker provenance proves a plain runner', async () => {
    const { createStopSession } = await import('./stopSession');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const stop = createStopSession({
      pidToTrackedSession: new Map<number, any>([[
        111,
        {
          startedBy: 'terminal',
          pid: 111,
          happySessionId: 'sess-proven-plain',
          processCommandHash: 'h1',
          spawnOptions: { terminal: { mode: 'plain' } },
        },
      ]]),
      requireTerminalTopologyProof: true,
      readHostAttachmentState: vi.fn(async () => ({ status: 'absent' } as const)),
      waitForTrackedRunnersExit: vi.fn(async () => true),
    });

    await expect(stop('sess-proven-plain')).resolves.toEqual({ status: 'stopped' });
    expect(killSpy).toHaveBeenCalledWith(111, 'SIGTERM');
  });

  it('fails closed when marker provenance cannot prove whether a host exists', async () => {
    const { createStopSession } = await import('./stopSession');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const stop = createStopSession({
      pidToTrackedSession: new Map<number, any>([[
        112,
        {
          startedBy: 'terminal',
          pid: 112,
          happySessionId: 'sess-unknown-topology',
          processCommandHash: 'h2',
        },
      ]]),
      requireTerminalTopologyProof: true,
      readHostAttachmentState: vi.fn(async () => ({ status: 'absent' } as const)),
      waitForTrackedRunnersExit: vi.fn(async () => true),
    });

    await expect(stop('sess-unknown-topology')).resolves.toEqual({
      status: 'incomplete',
      reason: 'missing_topology_proof',
    });
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('delegates descriptor-free stranded serviceability recovery to the daemon recovery owner', async () => {
    const { createStopSession } = await import('./stopSession');
    const recoverStrandedTerminalControlServiceability = vi.fn(async () => ({
      status: 'stopped' as const,
    }));
    const stop = createStopSession({
      pidToTrackedSession: new Map(),
      readHostAttachmentState: vi.fn(async () => ({ status: 'absent' } as const)),
      recoverStrandedTerminalControlServiceability,
    });

    await expect(stop('sess-stranded-dead-host')).resolves.toEqual({ status: 'stopped' });
    expect(recoverStrandedTerminalControlServiceability).toHaveBeenCalledWith({
      sessionId: 'sess-stranded-dead-host',
    });
  });

  it('keeps matched tracked sessions until exit is observed', async () => {
    const { createStopSession } = await import('./stopSession');

    const killDaemonChild = vi.fn();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(123456789);

    const pidToTrackedSession = new Map<number, any>([
      [111, { startedBy: 'daemon', pid: 111, happySessionId: 'sess-1', childProcess: { kill: killDaemonChild }, processCommandHash: 'h1' }],
      [222, { startedBy: 'terminal', pid: 222, happySessionId: 'sess-1', processCommandHash: 'h2' }],
    ]);

    const stop = createStopSession({
      pidToTrackedSession,
      waitForTrackedRunnersExit: vi.fn(async () => true),
    });
    const ok = await stop('sess-1');

    expect(ok).toEqual({ status: 'stopped' });
    expect(killDaemonChild).not.toHaveBeenCalled();
    expect(killSpy).toHaveBeenCalledWith(-111, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(222, 'SIGTERM');
    expect(pidToTrackedSession.size).toBe(2);
    expect(pidToTrackedSession.has(111)).toBe(true);
    expect(pidToTrackedSession.has(222)).toBe(true);
    expect(pidToTrackedSession.get(111)?.stopRequestedAtMs).toBe(123456789);
    expect(pidToTrackedSession.get(222)?.stopRequestedAtMs).toBe(123456789);
    nowSpy.mockRestore();
  });

  it('retires upstream authority before signaling a tracked runner', async () => {
    const { createStopSession } = await import('./stopSession');
    const events: string[] = [];
    const killSpy = vi.spyOn(process, 'kill')
      .mockImplementation(() => {
        events.push('signal');
        return true as any;
      });
    const pidToTrackedSession = new Map<number, any>([[
      113,
      {
        startedBy: 'daemon',
        pid: 113,
        happySessionId: 'sess-authority-order',
        childProcess: {
          pid: 113,
          exitCode: null,
          signalCode: null,
          kill: vi.fn(),
        },
        processCommandHash: 'h3',
      },
    ]]);
    const retireAuthority = vi.fn(async () => {
      events.push('authority');
      return true;
    });
    const stop = createStopSession({
      pidToTrackedSession,
      retireUpstreamAuthorityBeforeProcessStop: retireAuthority,
      waitForTrackedRunnersExit: vi.fn(async () => true),
    });

    await expect(stop('sess-authority-order')).resolves.toEqual({
      status: 'stopped',
    });
    expect(events).toEqual(['authority', 'signal']);
    expect(killSpy).toHaveBeenCalledWith(-113, 'SIGTERM');
  });

  it('does not signal or drop tracking when upstream authority retirement fails', async () => {
    const { createStopSession } = await import('./stopSession');
    const killSpy = vi.spyOn(process, 'kill')
      .mockImplementation(() => true as any);
    const tracked = {
      startedBy: 'daemon',
      pid: 114,
      happySessionId: 'sess-authority-failure',
      childProcess: {
        pid: 114,
        exitCode: null,
        signalCode: null,
        kill: vi.fn(),
      },
      processCommandHash: 'h4',
    };
    const pidToTrackedSession =
      new Map<number, any>([[114, tracked]]);
    const stop = createStopSession({
      pidToTrackedSession,
      retireUpstreamAuthorityBeforeProcessStop:
        vi.fn(async () => false),
      waitForTrackedRunnersExit: vi.fn(async () => true),
    });

    await expect(stop('sess-authority-failure')).resolves.toEqual({
      status: 'incomplete',
      reason: 'runner_signal_incomplete',
    });
    expect(killSpy).not.toHaveBeenCalled();
    expect(pidToTrackedSession.get(114)).toBe(tracked);
  });

  it('keeps tracked daemon sessions when falling back to child-process SIGTERM', async () => {
    const { createStopSession } = await import('./stopSession');

    const killDaemonChild = vi.fn();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (typeof pid === 'number' && pid < 0) {
        throw new Error('no process group');
      }
      return true as any;
    });

    const pidToTrackedSession = new Map<number, any>([
      [111, { startedBy: 'daemon', pid: 111, happySessionId: 'sess-1', childProcess: { kill: killDaemonChild }, processCommandHash: 'h1' }],
      [222, { startedBy: 'terminal', pid: 222, happySessionId: 'sess-1', processCommandHash: 'h2' }],
    ]);

    const stop = createStopSession({
      pidToTrackedSession,
      waitForTrackedRunnersExit: vi.fn(async () => true),
    });
    const ok = await stop('sess-1');

    expect(ok).toEqual({ status: 'stopped' });
    expect(killSpy).toHaveBeenCalledWith(-111, 'SIGTERM');
    expect(killDaemonChild).toHaveBeenCalledWith('SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(222, 'SIGTERM');
    expect(pidToTrackedSession.size).toBe(2);
    expect(pidToTrackedSession.has(111)).toBe(true);
    expect(pidToTrackedSession.has(222)).toBe(true);
  });

  it('does not fall back to a daemon child after process-group failure replaces exact ownership', async () => {
    const { createStopSession } = await import('./stopSession');

    const originalChildKill = vi.fn(() => true);
    const replacementChildKill = vi.fn(() => true);
    const original: import('../types').TrackedSession = {
      startedBy: 'daemon',
      pid: 116,
      sessionRunnerPid: 117,
      happySessionId: 'sess-posix-fallback-owner-race',
      childProcess: {
        pid: 116,
        exitCode: null,
        signalCode: null,
        kill: originalChildKill,
      } as never,
      processStartTimeMs: 5_000,
      processCommandHash: 'original-posix-command',
    };
    const replacement: import('../types').TrackedSession = {
      ...original,
      sessionRunnerPid: 118,
      childProcess: {
        pid: 116,
        exitCode: null,
        signalCode: null,
        kill: replacementChildKill,
      } as never,
      processStartTimeMs: 6_000,
      processCommandHash: 'replacement-posix-command',
    };
    const pidToTrackedSession = new Map([[116, original]]);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === -116) {
        pidToTrackedSession.set(116, replacement);
        throw new Error('group unavailable');
      }
      return true as never;
    });
    const stop = createStopSession({
      pidToTrackedSession,
      readHostAttachmentState: vi.fn(async () => ({ status: 'absent' } as const)),
      waitForTrackedRunnersExit: vi.fn(async () => true),
    });

    await withProcessPlatform('darwin', async () => {
      await expect(stop('sess-posix-fallback-owner-race')).resolves.toEqual({
        status: 'incomplete',
        reason: 'runner_signal_incomplete',
      });
    });

    expect(killSpy).toHaveBeenCalledOnce();
    expect(killSpy).toHaveBeenCalledWith(-116, 'SIGTERM');
    expect(originalChildKill).not.toHaveBeenCalled();
    expect(replacementChildKill).not.toHaveBeenCalled();
    expect(pidToTrackedSession.get(116)).toBe(replacement);
  });

  it('does not fall back to a daemon child after process-group failure changes live identity', async () => {
    const { createStopSession } = await import('./stopSession');

    let liveIdentityIsCurrent = true;
    isPidSafeHappySessionProcess.mockImplementation(async () => liveIdentityIsCurrent);
    const childKill = vi.fn(() => true);
    const trackedSession: import('../types').TrackedSession = {
      startedBy: 'daemon',
      pid: 119,
      happySessionId: 'sess-posix-fallback-identity-race',
      childProcess: {
        pid: 119,
        exitCode: null,
        signalCode: null,
        kill: childKill,
      } as never,
      processStartTimeMs: 7_000,
      processCommandHash: 'expected-posix-command',
    };
    const pidToTrackedSession = new Map([[119, trackedSession]]);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === -119) {
        liveIdentityIsCurrent = false;
        throw new Error('group unavailable');
      }
      return true as never;
    });
    const stop = createStopSession({
      pidToTrackedSession,
      readHostAttachmentState: vi.fn(async () => ({ status: 'absent' } as const)),
      waitForTrackedRunnersExit: vi.fn(async () => true),
    });

    await withProcessPlatform('darwin', async () => {
      await expect(stop('sess-posix-fallback-identity-race')).resolves.toEqual({
        status: 'incomplete',
        reason: 'runner_signal_incomplete',
      });
    });

    expect(isPidSafeHappySessionProcess).toHaveBeenCalledTimes(2);
    expect(isPidSafeHappySessionProcess).toHaveBeenNthCalledWith(2, {
      pid: 119,
      expectedProcessCommandHash: 'expected-posix-command',
      expectedProcessStartTimeMs: 7_000,
    });
    expect(killSpy).toHaveBeenCalledOnce();
    expect(killSpy).toHaveBeenCalledWith(-119, 'SIGTERM');
    expect(childKill).not.toHaveBeenCalled();
    expect(pidToTrackedSession.get(119)).toBe(trackedSession);
  });

  it('keeps daemon-owned tracking when both process-group and child-process termination fail', async () => {
    const { createStopSession } = await import('./stopSession');

    const killDaemonChild = vi.fn(() => {
      throw new Error('child kill failed');
    });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (typeof pid === 'number' && pid < 0) {
        throw new Error('no process group');
      }
      return true as any;
    });

    const trackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-1',
      childProcess: { kill: killDaemonChild },
      processCommandHash: 'h1',
    };
    const pidToTrackedSession = new Map<number, any>([
      [111, trackedSession],
    ]);

    const stop = createStopSession({ pidToTrackedSession });
    const ok = await stop('sess-1');

    expect(ok).toEqual({ status: 'incomplete', reason: 'runner_signal_incomplete' });
    expect(killSpy).toHaveBeenCalledWith(-111, 'SIGTERM');
    expect(killDaemonChild).toHaveBeenCalledWith('SIGTERM');
    expect(pidToTrackedSession.get(111)).toBe(trackedSession);
  });

  it('refuses a POSIX daemon-child signal when the live OS witness fails after authority retirement', async () => {
    await withProcessPlatform('darwin', async () => {
      const { createStopSession } = await import('./stopSession');
      const childKill = vi.fn(() => true);
      const killSpy = vi.spyOn(process, 'kill')
        .mockImplementation(() => true as any);
      const retireUpstreamAuthorityBeforeProcessStop = vi.fn(async () => true);
      isPidSafeHappySessionProcess.mockResolvedValueOnce(false);
      const trackedSession: import('../types').TrackedSession = {
        startedBy: 'daemon',
        pid: 115,
        happySessionId: 'sess-posix-live-witness',
        childProcess: {
          pid: 115,
          exitCode: null,
          signalCode: null,
          kill: childKill,
        } as never,
        processStartTimeMs: 4_000,
        processCommandHash: 'expected-posix-command',
      };
      const pidToTrackedSession = new Map([[115, trackedSession]]);
      const stop = createStopSession({
        pidToTrackedSession,
        retireUpstreamAuthorityBeforeProcessStop,
        waitForTrackedRunnersExit: vi.fn(async () => true),
      });

      await expect(stop('sess-posix-live-witness')).resolves.toEqual({
        status: 'incomplete',
        reason: 'runner_signal_incomplete',
      });
      expect(retireUpstreamAuthorityBeforeProcessStop).toHaveBeenCalledWith(115);
      expect(isPidSafeHappySessionProcess).toHaveBeenCalledWith({
        pid: 115,
        expectedProcessCommandHash: 'expected-posix-command',
        expectedProcessStartTimeMs: 4_000,
      });
      expect(killSpy).not.toHaveBeenCalled();
      expect(childKill).not.toHaveBeenCalled();
      expect(pidToTrackedSession.get(115)).toBe(trackedSession);
    });
  });

  it('treats an exact tracked runner that exits during stop signaling as positively stopped', async () => {
    const { createStopSession } = await import('./stopSession');

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    isPidSafeHappySessionProcess.mockResolvedValueOnce(false);
    const areTrackedRunnersExited = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const waitForTrackedRunnersExit = vi.fn(async () => {
      throw new Error('already-exited runners must not enter the exit wait');
    });
    const pidToTrackedSession = new Map<number, any>([
      [222, {
        startedBy: 'terminal',
        pid: 222,
        happySessionId: 'sess-exited-during-stop',
        processCommandHash: 'expected-command',
      }],
    ]);

    const stop = createStopSession({
      pidToTrackedSession,
      areTrackedRunnersExited,
      waitForTrackedRunnersExit,
    });
    const result = await stop('sess-exited-during-stop');

    expect(result).toEqual({ status: 'stopped' });
    expect(areTrackedRunnersExited).toHaveBeenNthCalledWith(1, {
      sessionId: 'sess-exited-during-stop',
      trackedPids: [222],
    });
    expect(areTrackedRunnersExited).toHaveBeenNthCalledWith(2, {
      sessionId: 'sess-exited-during-stop',
      trackedPids: [222],
    });
    expect(waitForTrackedRunnersExit).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('does not signal a replacement that takes the same pid after exact stop enumeration', async () => {
    const { createStopSession } = await import('./stopSession');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const original: import('../types').TrackedSession = {
      startedBy: 'daemon' as const,
      pid: 333,
      sessionRunnerPid: 334,
      happySessionId: 'sess-exact-stop-race',
      childProcess: {
        pid: 333,
        exitCode: null,
        signalCode: null,
        kill: vi.fn(() => true),
      } as never,
      processStartTimeMs: 1_000,
      processCommandHash: 'original-command',
    };
    const replacementChildKill = vi.fn(() => true);
    const replacement: import('../types').TrackedSession = {
      ...original,
      sessionRunnerPid: 335,
      childProcess: {
        pid: 333,
        exitCode: null,
        signalCode: null,
        kill: replacementChildKill,
      } as never,
      processStartTimeMs: 2_000,
      processCommandHash: 'replacement-command',
    };
    const pidToTrackedSession = new Map<number, any>([[333, original]]);
    const stop = createStopSession({
      pidToTrackedSession,
      retireUpstreamAuthorityBeforeProcessStop: vi.fn(async () => {
        pidToTrackedSession.set(333, replacement);
        return true;
      }),
      waitForTrackedRunnersExit: vi.fn(async () => true),
    });

    await expect(stop('sess-exact-stop-race', {
      expectedTrackedRunner: {
        tracked: original,
        sessionRunnerPid: 334,
        processStartTimeMs: 1_000,
        processCommandHash: 'original-command',
      },
    })).resolves.toEqual({
      status: 'incomplete',
      reason: 'runner_signal_incomplete',
    });
    expect(killSpy).not.toHaveBeenCalled();
    expect(replacementChildKill).not.toHaveBeenCalled();
    expect(replacement.stopRequestedAtMs).toBeUndefined();
    expect(pidToTrackedSession.get(333)).toBe(replacement);
  });

  it('does not taskkill a same-pid Windows replacement after asynchronous PID safety', async () => {
    const { createStopSession } = await import('./stopSession');
    const originalChildKill = vi.fn(() => true);
    const replacementChildKill = vi.fn(() => true);
    const original: import('../types').TrackedSession = {
      startedBy: 'daemon',
      pid: 444,
      sessionRunnerPid: 445,
      happySessionId: 'sess-exact-windows-stop-race',
      childProcess: {
        pid: 444,
        exitCode: null,
        signalCode: null,
        kill: originalChildKill,
      } as never,
      processStartTimeMs: 3_000,
      processCommandHash: 'original-windows-command',
    };
    const replacement: import('../types').TrackedSession = {
      ...original,
      sessionRunnerPid: 446,
      childProcess: {
        pid: 444,
        exitCode: null,
        signalCode: null,
        kill: replacementChildKill,
      } as never,
      processStartTimeMs: 4_000,
      processCommandHash: 'replacement-windows-command',
    };
    const pidToTrackedSession = new Map<number, any>([[444, original]]);
    isPidSafeHappySessionProcess.mockImplementationOnce(async () => {
      pidToTrackedSession.set(444, replacement);
      return true;
    });
    const stop = createStopSession({
      pidToTrackedSession,
      waitForTrackedRunnersExit: vi.fn(async () => true),
    });

    await withProcessPlatform('win32', async () => {
      await expect(stop('sess-exact-windows-stop-race', {
        expectedTrackedRunner: {
          tracked: original,
          sessionRunnerPid: 445,
          processStartTimeMs: 3_000,
          processCommandHash: 'original-windows-command',
        },
      })).resolves.toEqual({
        status: 'incomplete',
        reason: 'runner_signal_incomplete',
      });
    });
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(originalChildKill).not.toHaveBeenCalled();
    expect(replacementChildKill).not.toHaveBeenCalled();
    expect(replacement.stopRequestedAtMs).toBeUndefined();
    expect(pidToTrackedSession.get(444)).toBe(replacement);
  });

  it('keeps tracked in-flight attaches until exit is observed', async () => {
    const { createStopSession } = await import('./stopSession');

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>([
      [333, { startedBy: 'terminal', pid: 333, spawnOptions: { existingSessionId: 'sess-2' }, processCommandHash: 'h3' }],
    ]);

    const stop = createStopSession({
      pidToTrackedSession,
      waitForTrackedRunnersExit: vi.fn(async () => true),
    });
    const ok = await stop('sess-2');

    expect(ok).toEqual({ status: 'stopped' });
    expect(killSpy).toHaveBeenCalledWith(333, 'SIGTERM');
    expect(pidToTrackedSession.size).toBe(1);
    expect(pidToTrackedSession.has(333)).toBe(true);
  });

  it('signals and observes the exact runner before destroying its bound terminal host', async () => {
    const { createStopSession } = await import('./stopSession');
    const attachmentId = 'attachment-dev-stop-1' as NonNullable<import('@happier-dev/agents').TerminalHostHandle['attachmentId']>;
    const attachmentInfo = {
      version: 2,
      attachmentId,
      sessionId: 'sess-dev-disposition',
      handle: {
        attachmentId,
        kind: 'zellij',
        sessionName: 'happier-claude-unified-owned',
        paneId: 'terminal_9',
        socketDir: '/happy-home/terminal/zellij-owned',
        attachMetadata: {
          attachStrategy: 'terminal_host',
          topology: 'shared',
          locality: 'same_machine',
          liveProbe: 'required',
        },
      },
      updatedAt: 1,
    } as const;
    const order: string[] = [];
    const dispose = vi.fn(async () => {
      order.push('dispose-host');
    });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      order.push('signal-runner');
      return true as any;
    });
    const stop = createStopSession({
      pidToTrackedSession: new Map<number, any>([[333, {
        startedBy: 'terminal',
        pid: 333,
        happySessionId: 'sess-dev-disposition',
        processCommandHash: 'h3',
        spawnOptions: { terminal: { mode: 'zellij' } },
      }]]),
      terminalHostAdapters: {
        zellij: {
          kind: 'zellij',
          createOrAttachHost: vi.fn(),
          injectUserPrompt: vi.fn(),
          interruptTurn: vi.fn(),
          evaluateLiveness: vi.fn(),
          dispose,
        } as any,
      },
      readHostAttachmentInfo: vi.fn(async () => attachmentInfo),
      removeHostAttachmentInfo: vi.fn(async () => true),
      waitForTrackedRunnersExit: vi.fn(async () => {
        order.push('observe-runner-exit');
        return true;
      }),
    });

    await expect(stop('sess-dev-disposition')).resolves.toEqual({ status: 'stopped' });
    expect(order).toEqual(['signal-runner', 'observe-runner-exit', 'dispose-host']);
  });

  it('preserves an exact host when no tracked runner exit can be proven', async () => {
    const { createStopSession } = await import('./stopSession');
    const attachmentId = 'attachment-untracked' as NonNullable<import('@happier-dev/agents').TerminalHostHandle['attachmentId']>;
    const dispose = vi.fn(async () => undefined);
    const stop = createStopSession({
      pidToTrackedSession: new Map(),
      terminalHostAdapters: { zellij: { kind: 'zellij', dispose } as any },
      readHostAttachmentInfo: vi.fn(async () => ({
        version: 2,
        attachmentId,
        sessionId: 'sess-untracked-host',
        handle: {
          attachmentId,
          kind: 'zellij',
          sessionName: 'owned',
          paneId: 'pane-1',
          attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' },
        },
        updatedAt: 1,
      } satisfies TerminalHostAttachmentInfo)),
    });

    await expect(stop('sess-untracked-host')).resolves.toEqual({
      status: 'incomplete',
      reason: 'tracked_runner_absent',
    });
    expect(dispose).not.toHaveBeenCalled();
  });

  it('retires the exact local host descriptor when canonical recovery proves the stranded host is dead', async () => {
    const { createStopSession } = await import('./stopSession');
    const attachment = createBoundAttachment('sess-dead-stranded', 'attachment-dead-stranded');
    const recoverStrandedTerminalControlServiceability = vi.fn(async () => ({ status: 'stopped' as const }));
    const removeHostAttachmentInfo = vi.fn(async () => true);
    const onExactTerminalAttachmentRetired = vi.fn(async () => undefined);
    const stop = createStopSession({
      pidToTrackedSession: new Map(),
      readHostAttachmentInfo: vi.fn(async () => attachment),
      recoverStrandedTerminalControlServiceability,
      removeHostAttachmentInfo,
      onExactTerminalAttachmentRetired,
    });

    await expect(stop(attachment.sessionId)).resolves.toEqual({ status: 'stopped' });
    expect(recoverStrandedTerminalControlServiceability).toHaveBeenCalledWith({
      sessionId: attachment.sessionId,
      expectedAttachmentId: attachment.attachmentId,
    });
    expect(removeHostAttachmentInfo).toHaveBeenCalledWith({
      happyHomeDir: expect.any(String),
      sessionId: attachment.sessionId,
      expectedAttachmentId: attachment.attachmentId,
      expectedHandle: attachment.handle,
    });
    expect(onExactTerminalAttachmentRetired).toHaveBeenCalledWith({
      happyHomeDir: expect.any(String),
      sessionId: attachment.sessionId,
      attachmentInfo: attachment,
    });
  });

  it('stops the exact tracked runner and retires a legacy host descriptor after the host is proven dead', async () => {
    const { createStopSession } = await import('./stopSession');
    const legacy = {
      version: 1 as const,
      sessionId: 'sess-legacy-tracked-dead',
      handle: {
        kind: 'tmux' as const,
        sessionName: 'happy',
        paneId: 'legacy-window',
        attachMetadata: {
          attachStrategy: 'terminal_host' as const,
          topology: 'shared' as const,
          locality: 'same_machine' as const,
          liveProbe: 'required' as const,
        },
      },
      updatedAt: 1,
    } satisfies Extract<TerminalHostAttachmentInfo, { version: 1 }>;
    const removeHostAttachmentInfo = vi.fn(async () => true);
    const dispose = vi.fn(async () => undefined);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const stop = createStopSession({
      pidToTrackedSession: new Map([[620, {
        startedBy: 'terminal',
        pid: 620,
        happySessionId: legacy.sessionId,
        spawnOptions: { terminal: { mode: 'tmux' } },
      } as any]]),
      terminalHostAdapters: {
        tmux: {
          kind: 'tmux',
          evaluateLiveness: vi.fn(async () => ({ paneAlive: false, paneDead: true, observedAt: 1 })),
          dispose,
        } as any,
      },
      readHostAttachmentInfo: vi.fn(async () => legacy),
      removeHostAttachmentInfo,
      waitForTrackedRunnersExit: vi.fn(async () => true),
    });

    await expect(stop(legacy.sessionId)).resolves.toEqual({ status: 'stopped' });
    expect(dispose).not.toHaveBeenCalled();
    expect(removeHostAttachmentInfo).toHaveBeenCalledWith({
      happyHomeDir: expect.any(String),
      sessionId: legacy.sessionId,
      expectedHandle: legacy.handle,
    });
  });

  it('retires a Remote predecessor tmux metadata record when its exact host is already dead', async () => {
    const { createStopSession } = await import('./stopSession');
    const metadata = {
      version: 1 as const,
      sessionId: 'sess-remote-predecessor-dead',
      terminal: {
        mode: 'tmux' as const,
        tmux: { target: 'happy:legacy-window', tmpDir: '/tmp/legacy-tmux-root' },
      },
      updatedAt: 1,
    } satisfies TerminalAttachmentInfo;
    const removeTerminalAttachmentInfo = vi.fn(async () => true);
    const stop = createStopSession({
      pidToTrackedSession: new Map(),
      terminalHostAdapters: {
        tmux: {
          kind: 'tmux',
          evaluateLiveness: vi.fn(async () => ({ paneAlive: false, paneDead: true, observedAt: 1 })),
        } as any,
      },
      readHostAttachmentInfo: vi.fn(async () => null),
      readTerminalAttachmentInfo: vi.fn(async () => metadata),
      removeTerminalAttachmentInfo,
    });

    await expect(stop(metadata.sessionId)).resolves.toEqual({ status: 'stopped' });
    expect(removeTerminalAttachmentInfo).toHaveBeenCalledWith({
      happyHomeDir: expect.any(String),
      sessionId: metadata.sessionId,
      expected: metadata,
    });
  });

  it('retires Windows display metadata after the exact persisted runner is proven exited', async () => {
    const { createStopSession } = await import('./stopSession');
    const metadata = {
      version: 1 as const,
      sessionId: 'sess-windows-display-metadata',
      terminal: {
        mode: 'windows_terminal' as const,
        requested: 'windows_terminal' as const,
        windows: {
          host: 'windows_terminal' as const,
          pid: 621,
          windowId: 'happier-window-1',
        },
      },
      updatedAt: 1,
    } satisfies TerminalAttachmentInfo;
    const removeTerminalAttachmentInfo = vi.fn(async () => true);
    const stop = createStopSession({
      pidToTrackedSession: new Map([[621, {
        startedBy: 'daemon',
        pid: 621,
        happySessionId: metadata.sessionId,
        spawnOptions: { terminal: { mode: 'windows_terminal' } },
      } as any]]),
      readHostAttachmentInfo: vi.fn(async () => null),
      readTerminalAttachmentInfo: vi.fn(async () => metadata),
      removeTerminalAttachmentInfo,
      areTrackedRunnersExited: vi.fn(async () => true),
      waitForTrackedRunnersExit: vi.fn(async () => true),
    });

    await expect(stop(metadata.sessionId)).resolves.toEqual({ status: 'stopped' });
    expect(removeTerminalAttachmentInfo).toHaveBeenCalledWith({
      happyHomeDir: expect.any(String),
      sessionId: metadata.sessionId,
      expected: metadata,
    });
  });

  it('destroys an exact reconstructed host without signaling when its old runner is positively dead', async () => {
    const { createStopSession } = await import('./stopSession');
    const attachment = createBoundAttachment('sess-dead-reconstructed', 'attachment-dead-reconstructed');
    const dispose = vi.fn(async () => undefined);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const stop = createStopSession({
      pidToTrackedSession: new Map([[552, {
        startedBy: 'daemon',
        pid: 552,
        happySessionId: 'sess-dead-reconstructed',
      } as any]]),
      terminalHostAdapters: { zellij: { kind: 'zellij', dispose } as any },
      provenTerminalHostKindsByPid: new Map([[552, 'zellij']]),
      requireTerminalTopologyProof: true,
      readHostAttachmentInfo: vi.fn(async () => attachment),
      removeHostAttachmentInfo: vi.fn(async () => true),
      areTrackedRunnersExited: vi.fn(async () => true),
      waitForTrackedRunnersExit: vi.fn(async () => true),
    });

    await expect(stop('sess-dead-reconstructed')).resolves.toEqual({ status: 'stopped' });
    expect(killSpy).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledWith(attachment.handle);
  });

  it('force-terminates a verified runner that ignores SIGTERM before destroying its exact host', async () => {
    const { createStopSession } = await import('./stopSession');
    const attachmentId = 'attachment-timeout' as NonNullable<import('@happier-dev/agents').TerminalHostHandle['attachmentId']>;
    const dispose = vi.fn(async () => undefined);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const waitForTrackedRunnersExit = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const stop = createStopSession({
      pidToTrackedSession: new Map([[551, {
        startedBy: 'terminal',
        pid: 551,
        happySessionId: 'sess-timeout',
        processStartTimeMs: 1_000,
        processCommandHash: 'runner-command',
        spawnOptions: { terminal: { mode: 'zellij' } },
      } as any]]),
      terminalHostAdapters: { zellij: { kind: 'zellij', dispose } as any },
      removeHostAttachmentInfo: vi.fn(async () => true),
      readHostAttachmentInfo: vi.fn(async () => ({
        version: 2,
        attachmentId,
        sessionId: 'sess-timeout',
        handle: {
          attachmentId,
          kind: 'zellij',
          sessionName: 'owned',
          paneId: 'pane-1',
          attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' },
        },
        updatedAt: 1,
      } satisfies TerminalHostAttachmentInfo)),
      waitForTrackedRunnersExit,
    });

    await expect(stop('sess-timeout')).resolves.toEqual({ status: 'stopped' });
    expect(killSpy).toHaveBeenCalledWith(551, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(551, 'SIGKILL');
    expect(isPidSafeHappySessionProcess).toHaveBeenCalledTimes(2);
    expect(waitForTrackedRunnersExit).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('does not force-signal a replacement runner after the graceful wait', async () => {
    const { createStopSession } = await import('./stopSession');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const original: import('../types').TrackedSession = {
      startedBy: 'terminal',
      pid: 553,
      happySessionId: 'sess-timeout-replaced',
      processStartTimeMs: 2_000,
      processCommandHash: 'original-command',
    };
    const replacement: import('../types').TrackedSession = {
      ...original,
      processStartTimeMs: 3_000,
      processCommandHash: 'replacement-command',
    };
    const pidToTrackedSession = new Map([[553, original]]);
    const waitForTrackedRunnersExit = vi.fn(async () => {
      pidToTrackedSession.set(553, replacement);
      return false;
    });
    const stop = createStopSession({
      pidToTrackedSession,
      waitForTrackedRunnersExit,
    });

    await expect(stop('sess-timeout-replaced')).resolves.toEqual({
      status: 'incomplete',
      reason: 'runner_exit_timeout',
    });
    expect(killSpy).toHaveBeenCalledWith(553, 'SIGTERM');
    expect(killSpy).not.toHaveBeenCalledWith(553, 'SIGKILL');
    expect(waitForTrackedRunnersExit).toHaveBeenCalledTimes(1);
  });

  it('accepts positive runner death observed between the graceful timeout and force escalation', async () => {
    const { createStopSession } = await import('./stopSession');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const areTrackedRunnersExited = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const waitForTrackedRunnersExit = vi.fn(async () => false);
    const stop = createStopSession({
      pidToTrackedSession: new Map([[554, {
        startedBy: 'terminal',
        pid: 554,
        happySessionId: 'sess-exited-before-force',
        processStartTimeMs: 4_000,
        processCommandHash: 'runner-command',
      } as any]]),
      areTrackedRunnersExited,
      waitForTrackedRunnersExit,
    });

    await expect(stop('sess-exited-before-force')).resolves.toEqual({ status: 'stopped' });
    expect(killSpy).toHaveBeenCalledWith(554, 'SIGTERM');
    expect(killSpy).not.toHaveBeenCalledWith(554, 'SIGKILL');
    expect(waitForTrackedRunnersExit).toHaveBeenCalledTimes(1);
  });

  it('does not destroy a replacement attachment installed after runner exit', async () => {
    const { createStopSession } = await import('./stopSession');
    const original = createBoundAttachment('sess-replaced', 'attachment-original');
    const replacement = createBoundAttachment('sess-replaced', 'attachment-replacement');
    const readHostAttachmentInfo = vi.fn()
      .mockResolvedValueOnce(original)
      .mockResolvedValue(replacement);
    const dispose = vi.fn(async () => undefined);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const stop = createStopSession({
      pidToTrackedSession: new Map([[553, {
        startedBy: 'terminal',
        pid: 553,
        happySessionId: 'sess-replaced',
        spawnOptions: { terminal: { mode: 'zellij' } },
      } as any]]),
      terminalHostAdapters: { zellij: { kind: 'zellij', dispose } as any },
      readHostAttachmentInfo,
      waitForTrackedRunnersExit: vi.fn(async () => true),
    });

    await expect(stop('sess-replaced')).resolves.toEqual({
      status: 'incomplete',
      reason: 'attachment_mismatch',
    });
    expect(dispose).not.toHaveBeenCalled();
  });

  it('fails before signaling when the exact terminal-host adapter is unavailable', async () => {
    const { createStopSession } = await import('./stopSession');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const stop = createStopSession({
      pidToTrackedSession: new Map([[554, {
        startedBy: 'terminal',
        pid: 554,
        happySessionId: 'sess-adapter-missing',
        spawnOptions: { terminal: { mode: 'zellij' } },
      } as any]]),
      terminalHostAdapters: {},
      readHostAttachmentInfo: vi.fn(async () => createBoundAttachment('sess-adapter-missing', 'attachment-adapter-missing')),
      waitForTrackedRunnersExit: vi.fn(async () => true),
    });

    await expect(stop('sess-adapter-missing')).resolves.toEqual({
      status: 'incomplete',
      reason: 'terminal_host_adapter_unavailable',
    });
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('fails before signaling when terminal-host adapter acquisition fails', async () => {
    const { createStopSession } = await import('./stopSession');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const waitForTrackedRunnersExit = vi.fn(async () => true);
    const stop = createStopSession({
      pidToTrackedSession: new Map([[557, {
        startedBy: 'terminal',
        pid: 557,
        happySessionId: 'sess-adapter-load-failed',
        spawnOptions: { terminal: { mode: 'zellij' } },
      } as any]]),
      loadTerminalHostAdapters: vi.fn(async () => {
        throw new Error('adapter inventory unavailable');
      }),
      readHostAttachmentInfo: vi.fn(async () =>
        createBoundAttachment('sess-adapter-load-failed', 'attachment-adapter-load-failed')),
      waitForTrackedRunnersExit,
    });

    await expect(stop('sess-adapter-load-failed')).resolves.toEqual({
      status: 'incomplete',
      reason: 'terminal_host_adapter_unavailable',
    });
    expect(killSpy).not.toHaveBeenCalled();
    expect(waitForTrackedRunnersExit).not.toHaveBeenCalled();
  });

  it('refuses a replacement attachment that does not match the caller-pinned identity', async () => {
    const { createStopSession } = await import('./stopSession');
    const dispose = vi.fn(async () => undefined);
    const stop = createStopSession({
      pidToTrackedSession: new Map([[556, {
        startedBy: 'terminal',
        pid: 556,
        happySessionId: 'sess-pinned-original',
        spawnOptions: { terminal: { mode: 'zellij' } },
      } as any]]),
      expectedTerminalAttachmentId: 'attachment-pinned-original',
      terminalHostAdapters: { zellij: { kind: 'zellij', dispose } as any },
      readHostAttachmentInfo: vi.fn(async () => createBoundAttachment('sess-pinned-original', 'attachment-pinned-replacement')),
      waitForTrackedRunnersExit: vi.fn(async () => true),
    });

    await expect(stop('sess-pinned-original')).resolves.toEqual({ status: 'incomplete', reason: 'attachment_mismatch' });
    expect(dispose).not.toHaveBeenCalled();
  });

  it('reports terminal-host destroy failure as incomplete after runner exit', async () => {
    const { createStopSession } = await import('./stopSession');
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const stop = createStopSession({
      pidToTrackedSession: new Map([[555, {
        startedBy: 'terminal',
        pid: 555,
        happySessionId: 'sess-destroy-failed',
        spawnOptions: { terminal: { mode: 'zellij' } },
      } as any]]),
      terminalHostAdapters: {
        zellij: { kind: 'zellij', dispose: vi.fn(async () => { throw new Error('destroy failed'); }) } as any,
      },
      readHostAttachmentInfo: vi.fn(async () => createBoundAttachment('sess-destroy-failed', 'attachment-destroy-failed')),
      waitForTrackedRunnersExit: vi.fn(async () => true),
    });

    await expect(stop('sess-destroy-failed')).resolves.toEqual({
      status: 'incomplete',
      reason: 'destroy_failed',
    });
  });

  it('reports a concurrent exact disposition as incomplete instead of claiming success', async () => {
    const { createStopSession } = await import('./stopSession');
    const attachment = createBoundAttachment('sess-disposition-running', 'attachment-disposition-running');
    let releaseDispose!: () => void;
    const disposePending = new Promise<void>((resolve) => { releaseDispose = resolve; });
    const adapter = { kind: 'zellij', dispose: vi.fn(async () => await disposePending) } as any;
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const createStop = () => createStopSession({
      pidToTrackedSession: new Map([[556, {
        startedBy: 'terminal',
        pid: 556,
        happySessionId: 'sess-disposition-running',
        spawnOptions: { terminal: { mode: 'zellij' } },
      } as any]]),
      terminalHostAdapters: { zellij: adapter },
      readHostAttachmentInfo: vi.fn(async () => attachment),
      removeHostAttachmentInfo: vi.fn(async () => true),
      waitForTrackedRunnersExit: vi.fn(async () => true),
    });

    const firstStop = createStop()('sess-disposition-running');
    await vi.waitFor(() => expect(adapter.dispose).toHaveBeenCalledTimes(1));
    await expect(createStop()('sess-disposition-running')).resolves.toEqual({
      status: 'incomplete',
      reason: 'disposition_in_progress',
    });
    releaseDispose();
    await expect(firstStop).resolves.toEqual({ status: 'stopped' });
  });

  it('keeps Stop successful when provider cleanup fails after exact retirement', async () => {
    const { createStopSession } = await import('./stopSession');
    const attachmentId = 'attachment-cleanup' as NonNullable<import('@happier-dev/agents').TerminalHostHandle['attachmentId']>;
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const onExactTerminalAttachmentRetired = vi.fn(async () => {
      throw new Error('provider cleanup unavailable');
    });
    const stop = createStopSession({
      pidToTrackedSession: new Map([[552, {
        startedBy: 'terminal',
        pid: 552,
        happySessionId: 'sess-cleanup',
        spawnOptions: { terminal: { mode: 'zellij' } },
      } as any]]),
      terminalHostAdapters: { zellij: { kind: 'zellij', dispose: vi.fn(async () => undefined) } as any },
      readHostAttachmentInfo: vi.fn(async () => ({
        version: 2,
        attachmentId,
        sessionId: 'sess-cleanup',
        handle: {
          attachmentId,
          kind: 'zellij',
          sessionName: 'owned',
          paneId: 'pane-1',
          attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' },
        },
        updatedAt: 1,
      } satisfies TerminalHostAttachmentInfo)),
      removeHostAttachmentInfo: vi.fn(async () => true),
      waitForTrackedRunnersExit: vi.fn(async () => true),
      onExactTerminalAttachmentRetired,
    });

    await expect(stop('sess-cleanup')).resolves.toEqual({ status: 'stopped' });
    expect(onExactTerminalAttachmentRetired).toHaveBeenCalledTimes(1);
  });

  it('does not report fully stopped when required serviceability retirement fails after exact host destruction', async () => {
    const { createStopSession } = await import('./stopSession');
    const attachment = createBoundAttachment(
      'sess-serviceability-retirement-failure',
      'attachment-serviceability-retirement-failure',
    );
    const dispose = vi.fn(async () => undefined);
    const retireExactTerminalControlServiceability = vi.fn(async () => {
      throw new Error('metadata persistence unavailable');
    });
    const onExactTerminalAttachmentRetired = vi.fn(async () => undefined);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const stop = createStopSession({
      pidToTrackedSession: new Map([
        [552, {
          startedBy: 'terminal',
          pid: 552,
          happySessionId: attachment.sessionId,
          spawnOptions: { terminal: { mode: 'plain' } },
        } as any],
        [553, {
          startedBy: 'terminal',
          pid: 553,
          happySessionId: attachment.sessionId,
          spawnOptions: { terminal: { mode: 'zellij' } },
        } as any],
      ]),
      terminalHostAdapters: { zellij: { kind: 'zellij', dispose } as any },
      readHostAttachmentInfo: vi.fn(async () => attachment),
      removeHostAttachmentInfo: vi.fn(async () => true),
      waitForTrackedRunnersExit: vi.fn(async () => true),
      retireExactTerminalControlServiceability,
      onExactTerminalAttachmentRetired,
    });

    await expect(stop(attachment.sessionId)).resolves.toEqual({
      status: 'incomplete',
      reason: 'terminal_control_serviceability_retirement_failed',
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(retireExactTerminalControlServiceability).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: attachment.sessionId,
      attachmentInfo: attachment,
      terminalMode: 'zellij',
    }));
    expect(onExactTerminalAttachmentRetired).not.toHaveBeenCalled();
  });

  it('retires only the old local evidence when serviceability was superseded by a replacement attachment', async () => {
    const { createStopSession } = await import('./stopSession');
    const attachment = createBoundAttachment(
      'sess-serviceability-superseded',
      'attachment-serviceability-superseded',
    );
    const removeHostAttachmentInfo = vi.fn(async () => true);
    const onExactTerminalAttachmentRetired = vi.fn(async () => undefined);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const stop = createStopSession({
      pidToTrackedSession: new Map([[554, {
        startedBy: 'terminal',
        pid: 554,
        happySessionId: attachment.sessionId,
        spawnOptions: { terminal: { mode: 'zellij' } },
      } as any]]),
      terminalHostAdapters: { zellij: { kind: 'zellij', dispose: vi.fn(async () => undefined) } as any },
      readHostAttachmentInfo: vi.fn(async () => attachment),
      removeHostAttachmentInfo,
      waitForTrackedRunnersExit: vi.fn(async () => true),
      retireExactTerminalControlServiceability: vi.fn(async () => 'superseded' as const),
      onExactTerminalAttachmentRetired,
    });

    await expect(stop(attachment.sessionId)).resolves.toEqual({ status: 'stopped' });
    expect(removeHostAttachmentInfo).toHaveBeenCalledWith(expect.objectContaining({
      expectedAttachmentId: attachment.attachmentId,
    }));
    expect(onExactTerminalAttachmentRetired).toHaveBeenCalledWith(expect.objectContaining({
      attachmentInfo: attachment,
    }));
  });

  it('retires Windows Terminal from actual webhook metadata regardless of reversed PID insertion order', async () => {
    const { createStopSession } = await import('./stopSession');
    const attachment = createWindowsBoundAttachment('sess-windows-terminal', 'attachment-windows-terminal');
    const dispose = vi.fn(async () => undefined);
    const retireExactTerminalControlServiceability = vi.fn(async () => undefined);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const stop = createStopSession({
      pidToTrackedSession: new Map([
        [602, {
          startedBy: 'terminal',
          pid: 602,
          happySessionId: attachment.sessionId,
          spawnOptions: { terminal: { mode: 'windows_console' } },
        } as any],
        [601, {
          startedBy: 'terminal',
          pid: 601,
          happySessionId: attachment.sessionId,
          spawnOptions: { terminal: { mode: 'windows_console' } },
          happySessionMetadataFromLocalWebhook: { terminal: { mode: 'windows_terminal' } },
        } as any],
      ]),
      terminalHostAdapters: { windows_console: { kind: 'windows_console', dispose } as any },
      readHostAttachmentInfo: vi.fn(async () => attachment),
      removeHostAttachmentInfo: vi.fn(async () => true),
      waitForTrackedRunnersExit: vi.fn(async () => true),
      retireExactTerminalControlServiceability,
    });

    await expect(stop(attachment.sessionId)).resolves.toEqual({ status: 'stopped' });
    expect(retireExactTerminalControlServiceability).toHaveBeenCalledWith(expect.objectContaining({
      attachmentInfo: attachment,
      terminalMode: 'windows_terminal',
    }));
  });

  it('retires the actual Windows console after a requested Windows Terminal launch falls back', async () => {
    const { createStopSession } = await import('./stopSession');
    const attachment = createWindowsBoundAttachment('sess-windows-fallback', 'attachment-windows-fallback');
    const dispose = vi.fn(async () => undefined);
    const retireExactTerminalControlServiceability = vi.fn(async () => undefined);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const stop = createStopSession({
      pidToTrackedSession: new Map([[603, {
        startedBy: 'terminal',
        pid: 603,
        happySessionId: attachment.sessionId,
        spawnOptions: { terminal: { mode: 'windows_terminal' } },
        happySessionMetadataFromLocalWebhook: {
          terminal: {
            mode: 'windows_console',
            requested: 'windows_terminal',
            fallbackReason: 'wt.exe unavailable',
          },
        },
      } as any]]),
      terminalHostAdapters: { windows_console: { kind: 'windows_console', dispose } as any },
      readHostAttachmentInfo: vi.fn(async () => attachment),
      removeHostAttachmentInfo: vi.fn(async () => true),
      waitForTrackedRunnersExit: vi.fn(async () => true),
      retireExactTerminalControlServiceability,
    });

    await expect(stop(attachment.sessionId)).resolves.toEqual({ status: 'stopped' });
    expect(retireExactTerminalControlServiceability).toHaveBeenCalledWith(expect.objectContaining({
      attachmentInfo: attachment,
      terminalMode: 'windows_console',
    }));
  });

  it('carries a disconnected marker actual mode through exact Windows host retirement', async () => {
    const { createStopSession } = await import('./stopSession');
    const attachment = createWindowsBoundAttachment('sess-windows-disconnected', 'attachment-windows-disconnected');
    const dispose = vi.fn(async () => undefined);
    const retireExactTerminalControlServiceability = vi.fn(async () => undefined);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const stop = createStopSession({
      pidToTrackedSession: new Map([[605, {
        startedBy: 'daemon',
        pid: 605,
        happySessionId: attachment.sessionId,
      } as any]]),
      terminalHostAdapters: { windows_console: { kind: 'windows_console', dispose } as any },
      provenTerminalHostKindsByPid: new Map([[605, 'windows_console']]),
      provenTerminalModesByPid: new Map([[605, 'windows_terminal']]),
      requireTerminalTopologyProof: true,
      readHostAttachmentInfo: vi.fn(async () => attachment),
      removeHostAttachmentInfo: vi.fn(async () => true),
      areTrackedRunnersExited: vi.fn(async () => true),
      waitForTrackedRunnersExit: vi.fn(async () => true),
      retireExactTerminalControlServiceability,
    });

    await expect(stop(attachment.sessionId)).resolves.toEqual({ status: 'stopped' });
    expect(killSpy).not.toHaveBeenCalled();
    expect(retireExactTerminalControlServiceability).toHaveBeenCalledWith(expect.objectContaining({
      attachmentInfo: attachment,
      terminalMode: 'windows_terminal',
    }));
  });

  it('fails closed before signaling when a Windows host has only requested-mode evidence', async () => {
    const { createStopSession } = await import('./stopSession');
    const attachment = createWindowsBoundAttachment('sess-windows-unproven', 'attachment-windows-unproven');
    const dispose = vi.fn(async () => undefined);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const stop = createStopSession({
      pidToTrackedSession: new Map([[604, {
        startedBy: 'terminal',
        pid: 604,
        happySessionId: attachment.sessionId,
        spawnOptions: { terminal: { mode: 'windows_terminal' } },
      } as any]]),
      terminalHostAdapters: { windows_console: { kind: 'windows_console', dispose } as any },
      readHostAttachmentInfo: vi.fn(async () => attachment),
      waitForTrackedRunnersExit: vi.fn(async () => true),
      retireExactTerminalControlServiceability: vi.fn(async () => undefined),
    });

    await expect(stop(attachment.sessionId)).resolves.toEqual({
      status: 'incomplete',
      reason: 'missing_topology_proof',
    });
    expect(killSpy).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });

  it('rejects actual-mode evidence bound to a replacement Windows attachment', async () => {
    const { createStopSession } = await import('./stopSession');
    const attachment = createWindowsBoundAttachment('sess-windows-stale-mode', 'attachment-windows-current');
    const dispose = vi.fn(async () => undefined);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const stop = createStopSession({
      pidToTrackedSession: new Map([[606, {
        startedBy: 'terminal',
        pid: 606,
        happySessionId: attachment.sessionId,
        happySessionMetadataFromLocalWebhook: {
          terminal: {
            mode: 'windows_terminal',
            controlServiceabilityV1: {
              v: 1,
              attachmentId: 'attachment-windows-replaced',
              state: 'servable',
              observedAt: 1,
            },
          },
        },
      } as any]]),
      terminalHostAdapters: { windows_console: { kind: 'windows_console', dispose } as any },
      readHostAttachmentInfo: vi.fn(async () => attachment),
      waitForTrackedRunnersExit: vi.fn(async () => true),
      retireExactTerminalControlServiceability: vi.fn(async () => undefined),
    });

    await expect(stop(attachment.sessionId)).resolves.toEqual({
      status: 'incomplete',
      reason: 'missing_topology_proof',
    });
    expect(killSpy).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });

  it('returns typed incomplete after host destruction when exact descriptor retirement fails', async () => {
    const { createStopSession } = await import('./stopSession');
    const attachment = createBoundAttachment(
      'sess-descriptor-retirement-failure',
      'attachment-descriptor-retirement-failure',
    );
    const dispose = vi.fn(async () => undefined);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const stop = createStopSession({
      pidToTrackedSession: new Map([[554, {
        startedBy: 'terminal',
        pid: 554,
        happySessionId: attachment.sessionId,
        spawnOptions: { terminal: { mode: 'zellij' } },
      } as any]]),
      terminalHostAdapters: { zellij: { kind: 'zellij', dispose } as any },
      readHostAttachmentInfo: vi.fn(async () => attachment),
      removeHostAttachmentInfo: vi.fn(async () => {
        throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
      }),
      waitForTrackedRunnersExit: vi.fn(async () => true),
    });

    await expect(stop(attachment.sessionId)).resolves.toEqual({
      status: 'incomplete',
      reason: 'terminal_attachment_descriptor_retirement_failed',
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('parks a tracked tmux host when no committed attachment identity exists', async () => {
    const { createStopSession } = await import('./stopSession');
    isPidSafeHappySessionProcess.mockResolvedValue(false);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(123456789);

    const tmuxTmpDir = '/tmp/happy-e2e-tmux-test';

    const pidToTrackedSession = new Map<number, any>([
      [
        444,
        {
          startedBy: 'daemon',
          pid: 444,
          happySessionId: 'sess-3',
          tmuxSessionId: 'happy-e2e:happy-window',
          tmuxTmpDir,
          processCommandHash: 'h4',
        },
      ],
    ]);

    const stop = createStopSession({ pidToTrackedSession });
    const ok = await stop('sess-3');

    expect(ok).toEqual({ status: 'incomplete', reason: 'missing_attachment_identity' });
    expect(killSpy).not.toHaveBeenCalled();
    expect(tmuxCtorCalls).toHaveLength(0);
    expect(tmuxKillWindow).not.toHaveBeenCalled();
    expect(pidToTrackedSession.get(444)?.stopRequestedAtMs).toBeUndefined();

    nowSpy.mockRestore();
  });

  it('parks an isolated tmux host before a committed attachment identity exists', async () => {
    const { createStopSession } = await import('./stopSession');
    isPidSafeHappySessionProcess.mockResolvedValue(false);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(123456789);

    const tmuxTmpDir = '/tmp/happy-e2e-tmux-test';
    tmuxExecuteTmuxCommand.mockResolvedValueOnce({ returncode: 0, stdout: '', stderr: '', command: [] });

    const pidToTrackedSession = new Map<number, any>([
      [
        555,
        {
          startedBy: 'daemon',
          pid: 555,
          happySessionId: 'sess-4',
          tmuxSessionId: '',
          tmuxTmpDir,
          spawnOptions: {
            terminal: { mode: 'tmux', tmux: { sessionName: 'happy-e2e', isolated: true, tmpDir: tmuxTmpDir } },
          },
          processCommandHash: 'h5',
        },
      ],
    ]);

    const stop = createStopSession({ pidToTrackedSession });
    const ok = await stop('sess-4');

    expect(ok).toEqual({ status: 'incomplete', reason: 'missing_attachment_identity' });
    expect(killSpy).not.toHaveBeenCalled();
    expect(tmuxKillWindow).not.toHaveBeenCalled();
    expect(tmuxExecuteTmuxCommand).not.toHaveBeenCalled();
    expect(pidToTrackedSession.get(555)?.stopRequestedAtMs).toBeUndefined();

    nowSpy.mockRestore();
  });

  it('refuses Windows daemon-child tree kill when PID safety fails', async () => {
    await withProcessPlatform('win32', async () => {
      const { createStopSession } = await import('./stopSession');

      isPidSafeHappySessionProcess.mockResolvedValueOnce(false);
      const logPidReuseRefusal = vi.fn();
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw new Error('no posix process group on windows');
      });
      const childKill = vi.fn();
      const pidToTrackedSession = new Map<number, any>([
        [
          777,
          {
            startedBy: 'daemon',
            pid: 777,
            happySessionId: 'sess-win',
            childProcess: { pid: 777, exitCode: null, signalCode: null, kill: childKill },
            processCommandHash: 'expected-hash',
          },
        ],
      ]);

      const stop = createStopSession({ pidToTrackedSession, logPidReuseRefusal });
      const ok = await stop('sess-win');

      expect(ok).toEqual({ status: 'incomplete', reason: 'runner_signal_incomplete' });
      expect(isPidSafeHappySessionProcess).toHaveBeenCalledWith({
        pid: 777,
        expectedProcessCommandHash: 'expected-hash',
      });
      expect(spawnSyncMock).not.toHaveBeenCalled();
      expect(childKill).not.toHaveBeenCalled();
      expect(logPidReuseRefusal).toHaveBeenCalledWith(expect.stringContaining('777'));

      killSpy.mockRestore();
    });
  });

  it('uses taskkill for a safe live Windows daemon child process tree', async () => {
    await withProcessPlatform('win32', async () => {
      const { createStopSession } = await import('./stopSession');

      isPidSafeHappySessionProcess.mockResolvedValueOnce(true);
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw new Error('no posix process group on windows');
      });
      const childKill = vi.fn();
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(123456789);
      const pidToTrackedSession = new Map<number, any>([
        [
          778,
          {
            startedBy: 'daemon',
            pid: 778,
            happySessionId: 'sess-win-safe',
            childProcess: { pid: 778, exitCode: null, signalCode: null, kill: childKill },
            processCommandHash: 'expected-hash',
          },
        ],
      ]);

      const stop = createStopSession({
        pidToTrackedSession,
        waitForTrackedRunnersExit: vi.fn(async () => true),
      });
      const ok = await stop('sess-win-safe');

      expect(ok).toEqual({ status: 'stopped' });
      expect(spawnSyncMock).toHaveBeenCalledWith('taskkill', ['/F', '/T', '/PID', '778'], { stdio: 'ignore' });
      expect(childKill).not.toHaveBeenCalled();
      expect(pidToTrackedSession.get(778)?.stopRequestedAtMs).toBe(123456789);

      nowSpy.mockRestore();
      killSpy.mockRestore();
    });
  });
});
