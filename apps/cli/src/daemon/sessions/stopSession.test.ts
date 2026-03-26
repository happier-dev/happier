import { describe, expect, it, vi } from 'vitest';

const isPidSafeHappySessionProcess = vi.fn(async () => true);
vi.mock('../pidSafety', () => ({
  isPidSafeHappySessionProcess,
}));

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

describe('createStopSession', () => {
  it('keeps matched tracked sessions until exit is observed', async () => {
    const { createStopSession } = await import('./stopSession');

    tmuxKillWindow.mockReset();
    tmuxExecuteTmuxCommand.mockReset();
    tmuxCtorCalls.length = 0;

    const killDaemonChild = vi.fn();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(123456789);

    const pidToTrackedSession = new Map<number, any>([
      [111, { startedBy: 'daemon', pid: 111, happySessionId: 'sess-1', childProcess: { kill: killDaemonChild }, processCommandHash: 'h1' }],
      [222, { startedBy: 'terminal', pid: 222, happySessionId: 'sess-1', processCommandHash: 'h2' }],
    ]);

    const stop = createStopSession({ pidToTrackedSession });
    const ok = await stop('sess-1');

    expect(ok).toBe(true);
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

  it('keeps tracked daemon sessions when falling back to child-process SIGTERM', async () => {
    const { createStopSession } = await import('./stopSession');

    tmuxKillWindow.mockReset();
    tmuxExecuteTmuxCommand.mockReset();
    tmuxCtorCalls.length = 0;

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

    const stop = createStopSession({ pidToTrackedSession });
    const ok = await stop('sess-1');

    expect(ok).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(-111, 'SIGTERM');
    expect(killDaemonChild).toHaveBeenCalledWith('SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(222, 'SIGTERM');
    expect(pidToTrackedSession.size).toBe(2);
    expect(pidToTrackedSession.has(111)).toBe(true);
    expect(pidToTrackedSession.has(222)).toBe(true);
  });

  it('keeps daemon-owned tracking when both process-group and child-process termination fail', async () => {
    const { createStopSession } = await import('./stopSession');

    tmuxKillWindow.mockReset();
    tmuxExecuteTmuxCommand.mockReset();
    tmuxCtorCalls.length = 0;

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

    expect(ok).toBe(false);
    expect(killSpy).toHaveBeenCalledWith(-111, 'SIGTERM');
    expect(killDaemonChild).toHaveBeenCalledWith('SIGTERM');
    expect(pidToTrackedSession.get(111)).toBe(trackedSession);
  });

  it('keeps tracked in-flight attaches until exit is observed', async () => {
    const { createStopSession } = await import('./stopSession');

    tmuxKillWindow.mockReset();
    tmuxExecuteTmuxCommand.mockReset();
    tmuxCtorCalls.length = 0;

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>([
      [333, { startedBy: 'terminal', pid: 333, spawnOptions: { existingSessionId: 'sess-2' }, processCommandHash: 'h3' }],
    ]);

    const stop = createStopSession({ pidToTrackedSession });
    const ok = await stop('sess-2');

    expect(ok).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(333, 'SIGTERM');
    expect(pidToTrackedSession.size).toBe(1);
    expect(pidToTrackedSession.has(333)).toBe(true);
  });

  it('stops daemon-spawned tmux sessions using a tmux socket derived from the tracked tmpDir', async () => {
    const { createStopSession } = await import('./stopSession');

    tmuxKillWindow.mockReset();
    tmuxExecuteTmuxCommand.mockReset();
    tmuxCtorCalls.length = 0;
    isPidSafeHappySessionProcess.mockResolvedValue(false);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(123456789);

    const tmuxTmpDir = '/tmp/happy-e2e-tmux-test';
    const uid = typeof (process as any).getuid === 'function' ? ((process as any).getuid() as number) : null;
    const expectedSocketPath = uid === null ? undefined : `${tmuxTmpDir}/tmux-${uid}/default`;

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

    expect(ok).toBe(true);
    expect(killSpy).not.toHaveBeenCalled();

    expect(tmuxCtorCalls.length).toBe(1);
    expect(tmuxCtorCalls[0]?.env).toEqual({ TMUX_TMPDIR: tmuxTmpDir });
    if (expectedSocketPath) {
      expect(tmuxCtorCalls[0]?.socketPath).toBe(expectedSocketPath);
    }
    expect(tmuxKillWindow).toHaveBeenCalledWith('happy-e2e:happy-window');
    expect(pidToTrackedSession.get(444)?.stopRequestedAtMs).toBe(123456789);

    nowSpy.mockRestore();
  });

  it('stops daemon-spawned isolated tmux sessions even before a window target is recorded', async () => {
    const { createStopSession } = await import('./stopSession');

    tmuxKillWindow.mockReset();
    tmuxExecuteTmuxCommand.mockReset();
    tmuxCtorCalls.length = 0;
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

    expect(ok).toBe(true);
    expect(killSpy).not.toHaveBeenCalled();
    expect(tmuxKillWindow).not.toHaveBeenCalled();
    expect(tmuxExecuteTmuxCommand).toHaveBeenCalled();
    const call = tmuxExecuteTmuxCommand.mock.calls[0];
    expect(call?.[0]).toEqual(['kill-session']);
    expect(call?.[1]).toBe('happy-e2e');
    expect(pidToTrackedSession.get(555)?.stopRequestedAtMs).toBe(123456789);

    nowSpy.mockRestore();
  });
});
