import { describe, expect, it, vi } from 'vitest';

import type { TerminalHostAdapter } from '@/integrations/terminalHost/_types';
import type {
  BoundTerminalAttachmentInfo,
  TerminalAttachmentInfo,
} from '@/terminal/attachment/terminalAttachmentInfo';

/** Legacy-retirement tests only probe liveness; every other adapter surface must stay unreached. */
function createLivenessProbeAdapterFixture(
  kind: TerminalHostAdapter['kind'],
  evaluateLiveness: TerminalHostAdapter['evaluateLiveness'],
): TerminalHostAdapter {
  return {
    kind,
    createOrAttachHost: async () => {
      throw new Error('createOrAttachHost must not be reached by legacy retirement');
    },
    injectUserPrompt: async () => {
      throw new Error('injectUserPrompt must not be reached by legacy retirement');
    },
    interruptTurn: async () => {
      throw new Error('interruptTurn must not be reached by legacy retirement');
    },
    evaluateLiveness,
    dispose: async () => undefined,
  };
}

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: spawnSyncMock,
  };
});

const isPidSafeHappySessionProcess = vi.fn(async () => true);
vi.mock('../pidSafety', () => ({
  isPidSafeHappySessionProcess,
}));

const readTerminalAttachmentInfo = vi.fn<(_: {
  happyHomeDir: string;
  sessionId: string;
}) => Promise<TerminalAttachmentInfo | null>>(async () => null);
const readTerminalAttachmentState = vi.fn(async (params: {
  happyHomeDir: string;
  sessionId: string;
}) => {
  const info = await readTerminalAttachmentInfo(params);
  return info ? { status: 'present' as const, info } : { status: 'absent' as const };
});
const removeTerminalAttachmentInfo = vi.fn(async () => true);
vi.mock('@/terminal/attachment/terminalAttachmentInfo', () => ({
  readTerminalAttachmentInfo,
  readTerminalAttachmentState,
  removeTerminalAttachmentInfo,
}));

const resolveZellijRuntimeBinary = vi.fn<(params?: { expectedVersion?: string }) => Promise<string | null>>(
  async () => null,
);
vi.mock('@/integrations/zellij/runtimeBinary', () => ({
  resolveZellijRuntimeBinary,
}));

const prepareZellijSocketDir = vi.fn(async () => {});
const resolveZellijSocketDir = vi.fn(() => '/happy-home/terminal/zellij');
vi.mock('@/integrations/zellij/socketDir', () => ({
  prepareZellijSocketDir,
  resolveZellijSocketDir,
}));

const zellijKillSession = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
const zellijDeleteSession = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
vi.mock('@/integrations/zellij/actions', () => ({
  defaultZellijActions: {
    killSession: zellijKillSession,
    deleteSession: zellijDeleteSession,
  },
}));

const recordTerminalHostKillAudit = vi.fn();
vi.mock('@/daemon/sessionKillAudit', () => ({
  recordTerminalHostKillAudit,
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

function withProcessPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!originalPlatformDescriptor?.configurable) {
    throw new Error('Expected process.platform to be configurable for this test');
  }
  Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: platform });
  return fn().finally(() => {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
  });
}

function createBoundAttachment(sessionId: string, attachmentIdRaw: string): BoundTerminalAttachmentInfo {
  const attachmentId = attachmentIdRaw as BoundTerminalAttachmentInfo['attachmentId'];
  const sessionName = `happier-${sessionId}`;
  const socketDir = `/tmp/${sessionId}`;
  return {
    version: 2,
    attachmentId,
    sessionId,
    handle: {
      attachmentId,
      kind: 'zellij',
      sessionName,
      paneId: 'terminal_1',
      socketDir,
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    },
    terminal: {
      mode: 'zellij',
      zellij: { sessionName, paneId: 'terminal_1', socketDirV1: socketDir },
    },
    updatedAt: 1,
  };
}

describe('createStopSession', () => {
  it('fails closed before signaling when attachment topology evidence is unreadable', async () => {
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
      readAttachmentState: vi.fn(async () => ({ status: 'unreadable', reason: 'invalid' } as const)),
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
      readAttachmentState: vi.fn(async () => ({ status: 'absent' } as const)),
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
      readAttachmentState: vi.fn(async () => ({ status: 'absent' } as const)),
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
      readAttachmentState: vi.fn(async () => ({ status: 'absent' } as const)),
      recoverStrandedTerminalControlServiceability,
    });

    await expect(stop('sess-stranded-dead-host')).resolves.toEqual({ status: 'stopped' });
    expect(recoverStrandedTerminalControlServiceability).toHaveBeenCalledWith({
      sessionId: 'sess-stranded-dead-host',
    });
  });

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

    expect(ok).toEqual({ status: 'incomplete', reason: 'runner_signal_incomplete' });
    expect(killSpy).toHaveBeenCalledWith(-111, 'SIGTERM');
    expect(killDaemonChild).toHaveBeenCalledWith('SIGTERM');
    expect(pidToTrackedSession.get(111)).toBe(trackedSession);
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

  it('keeps tracked in-flight attaches until exit is observed', async () => {
    const { createStopSession } = await import('./stopSession');

    tmuxKillWindow.mockReset();
    tmuxExecuteTmuxCommand.mockReset();
    tmuxCtorCalls.length = 0;

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

  it('stops a legacy zellij v1 session when host is confirmed dead after runner exit', async () => {
    const { createStopSession } = await import('./stopSession');

    const terminal = {
      mode: 'zellij' as const,
      zellij: {
        sessionName: 'happier-claude-unified-123',
        paneId: 'terminal_1',
      },
    };
    const legacyAttachment = {
      version: 1 as const,
      sessionId: 'sess-zellij',
      terminal,
      updatedAt: 1,
    };
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>([
      [333, { startedBy: 'terminal', pid: 333, happySessionId: 'sess-zellij', processCommandHash: 'h3' }],
    ]);

    const stop = createStopSession({
      pidToTrackedSession,
      readAttachmentInfo: vi.fn(async () => legacyAttachment),
      removeAttachmentInfo: vi.fn(async () => true),
      waitForTrackedRunnersExit: vi.fn(async () => true),
      terminalHostAdapters: {
        zellij: createLivenessProbeAdapterFixture(
          'zellij',
          vi.fn(async () => ({ paneAlive: false, paneDead: true, observedAt: Date.now() })),
        ),
      },
    });
    const ok = await stop('sess-zellij');

    expect(ok).toEqual({ status: 'stopped' });
    expect(zellijKillSession).not.toHaveBeenCalled();
    expect(zellijDeleteSession).not.toHaveBeenCalled();
    // Runners ARE signaled (v1 no longer blocks pre-signaling)
    expect(killSpy).toHaveBeenCalledWith(333, 'SIGTERM');
  });

  it('does not destroy an exact host when no tracked runner exit can be proven', async () => {
    const { createStopSession } = await import('./stopSession');
    const attachmentId = 'attachment-untracked-host' as NonNullable<import('@/integrations/terminalHost/_types').TerminalHostHandle['attachmentId']>;
    const dispose = vi.fn(async () => undefined);
    const stop = createStopSession({
      pidToTrackedSession: new Map(),
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
      readAttachmentInfo: vi.fn(async () => ({
        version: 2,
        attachmentId,
        sessionId: 'sess-untracked-host',
        handle: {
          attachmentId,
          kind: 'zellij',
          sessionName: 'happier-untracked-host',
          paneId: 'terminal_1',
          socketDir: '/tmp/happier-untracked-host',
          attachMetadata: {
            attachStrategy: 'terminal_host',
            topology: 'shared',
            locality: 'same_machine',
            liveProbe: 'required',
          },
        },
        terminal: {
          mode: 'zellij',
          zellij: {
            sessionName: 'happier-untracked-host',
            paneId: 'terminal_1',
            socketDirV1: '/tmp/happier-untracked-host',
          },
        },
        updatedAt: 1,
      } as const)),
    });

    await expect(stop('sess-untracked-host')).resolves.toEqual({
      status: 'incomplete',
      reason: 'tracked_runner_absent',
    });
    expect(dispose).not.toHaveBeenCalled();
  });

  it('signals and observes the exact runner before destroying its exact terminal attachment', async () => {
    const { createStopSession } = await import('./stopSession');
    const attachmentId = 'attachment-stop-1' as NonNullable<import('@/integrations/terminalHost/_types').TerminalHostHandle['attachmentId']>;
    const handle = {
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
    } as const;
    const attachmentInfo = {
      version: 2,
      attachmentId,
      sessionId: 'sess-disposition',
      handle,
      terminal: {
        mode: 'zellij',
        zellij: {
          sessionName: handle.sessionName,
          paneId: handle.paneId,
          socketDirV1: handle.socketDir,
        },
      },
      updatedAt: 1,
    } as const;
    const order: string[] = [];
    const dispose = vi.fn(async () => {
      order.push('dispose-host');
    });
    const adapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(),
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(),
      dispose,
    } as any;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      order.push('signal-runner');
      return true as any;
    });
    const waitForTrackedRunnersExit = vi.fn(async () => {
      order.push('observe-runner-exit');
      return true;
    });
    const onExactTerminalAttachmentRetired = vi.fn(async () => {
      order.push('cleanup-retired-artifacts');
    });
    const pidToTrackedSession = new Map<number, any>([
      [333, {
        startedBy: 'terminal',
        pid: 333,
        happySessionId: 'sess-disposition',
        processCommandHash: 'h3',
        spawnOptions: { terminal: { mode: 'zellij' } },
      }],
    ]);

    const stop = createStopSession({
      pidToTrackedSession,
      loadTerminalHostAdapters: vi.fn(async () => {
        order.push('resolve-adapter');
        return { zellij: adapter };
      }),
      readAttachmentInfo: vi.fn(async () => attachmentInfo),
      waitForTrackedRunnersExit,
      onExactTerminalAttachmentRetired,
    });
    await expect(stop('sess-disposition')).resolves.toEqual({ status: 'stopped' });

    expect(killSpy).toHaveBeenCalledWith(333, 'SIGTERM');
    expect(waitForTrackedRunnersExit).toHaveBeenCalledWith({
      sessionId: 'sess-disposition',
      trackedPids: [333],
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith(expect.objectContaining({
      attachmentId: 'attachment-stop-1',
      paneId: 'terminal_9',
      socketDir: '/happy-home/terminal/zellij-owned',
    }));
    expect(onExactTerminalAttachmentRetired).toHaveBeenCalledWith({
      happyHomeDir: expect.any(String),
      sessionId: 'sess-disposition',
      attachmentInfo,
    });
    expect(order).toEqual([
      'resolve-adapter',
      'signal-runner',
      'observe-runner-exit',
      'dispose-host',
      'cleanup-retired-artifacts',
    ]);
  });

  it('does not destroy the terminal attachment when the exact runner does not exit before the bound', async () => {
    const { createStopSession } = await import('./stopSession');
    const attachmentId = 'attachment-stop-timeout' as NonNullable<import('@/integrations/terminalHost/_types').TerminalHostHandle['attachmentId']>;
    const attachmentInfo = {
      version: 2,
      attachmentId,
      sessionId: 'sess-timeout',
      handle: {
        attachmentId,
        kind: 'zellij',
        sessionName: 'happier-claude-unified-timeout',
        paneId: 'terminal_1',
        socketDir: '/happy-home/terminal/zellij-timeout',
        attachMetadata: {
          attachStrategy: 'terminal_host',
          topology: 'shared',
          locality: 'same_machine',
          liveProbe: 'required',
        },
      },
      terminal: {
        mode: 'zellij',
        zellij: {
          sessionName: 'happier-claude-unified-timeout',
          paneId: 'terminal_1',
          socketDirV1: '/happy-home/terminal/zellij-timeout',
        },
      },
      updatedAt: 1,
    } as const;
    const dispose = vi.fn(async () => undefined);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const waitForTrackedRunnersExit = vi.fn(async () => false);
    const stop = createStopSession({
      pidToTrackedSession: new Map<number, any>([
        [444, { startedBy: 'terminal', pid: 444, happySessionId: 'sess-timeout', processCommandHash: 'h4' }],
      ]),
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
      readAttachmentInfo: vi.fn(async () => attachmentInfo),
      waitForTrackedRunnersExit,
    });

    await expect(stop('sess-timeout')).resolves.toEqual({
      status: 'incomplete',
      reason: 'runner_exit_timeout',
    });

    expect(killSpy).toHaveBeenCalledWith(444, 'SIGTERM');
    expect(waitForTrackedRunnersExit).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('does not destroy a replacement attachment installed after the runner exits', async () => {
    const { createStopSession } = await import('./stopSession');
    const attachmentId = 'attachment-stop-original' as NonNullable<import('@/integrations/terminalHost/_types').TerminalHostHandle['attachmentId']>;
    const replacementAttachmentId = 'attachment-stop-replacement' as NonNullable<import('@/integrations/terminalHost/_types').TerminalHostHandle['attachmentId']>;
    const attachmentInfo = {
      version: 2,
      attachmentId,
      sessionId: 'sess-replaced',
      handle: {
        attachmentId,
        kind: 'zellij',
        sessionName: 'happier-claude-unified-original',
        paneId: 'terminal_1',
        socketDir: '/happy-home/terminal/zellij-original',
        attachMetadata: {
          attachStrategy: 'terminal_host',
          topology: 'shared',
          locality: 'same_machine',
          liveProbe: 'required',
        },
      },
      terminal: {
        mode: 'zellij',
        zellij: {
          sessionName: 'happier-claude-unified-original',
          paneId: 'terminal_1',
          socketDirV1: '/happy-home/terminal/zellij-original',
        },
      },
      updatedAt: 1,
    } as const;
    const replacementAttachmentInfo = {
      ...attachmentInfo,
      attachmentId: replacementAttachmentId,
      handle: {
        ...attachmentInfo.handle,
        attachmentId: replacementAttachmentId,
        sessionName: 'happier-claude-unified-replacement',
      },
      terminal: {
        mode: 'zellij',
        zellij: {
          ...attachmentInfo.terminal.zellij,
          sessionName: 'happier-claude-unified-replacement',
        },
      },
      updatedAt: 2,
    } as const;
    const readAttachmentInfo = vi.fn()
      .mockResolvedValueOnce(attachmentInfo)
      .mockResolvedValue(replacementAttachmentInfo);
    const dispose = vi.fn(async () => undefined);
    const onExactTerminalAttachmentRetired = vi.fn(async () => undefined);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const stop = createStopSession({
      pidToTrackedSession: new Map<number, any>([
        [555, { startedBy: 'terminal', pid: 555, happySessionId: 'sess-replaced', processCommandHash: 'h5' }],
      ]),
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
      readAttachmentInfo,
      waitForTrackedRunnersExit: vi.fn(async () => true),
      onExactTerminalAttachmentRetired,
    });

    await expect(stop('sess-replaced')).resolves.toEqual({
      status: 'incomplete',
      reason: 'attachment_mismatch',
    });

    expect(dispose).not.toHaveBeenCalled();
    expect(onExactTerminalAttachmentRetired).not.toHaveBeenCalled();
  });

  it('fails before signaling when the exact terminal-host adapter is unavailable', async () => {
    const { createStopSession } = await import('./stopSession');
    const attachmentId = 'attachment-adapter-missing' as NonNullable<import('@/integrations/terminalHost/_types').TerminalHostHandle['attachmentId']>;
    const attachmentInfo = {
      version: 2,
      attachmentId,
      sessionId: 'sess-adapter-missing',
      handle: {
        attachmentId,
        kind: 'zellij',
        sessionName: 'happier-adapter-missing',
        paneId: 'terminal_1',
        socketDir: '/tmp/happier-adapter-missing',
        attachMetadata: {
          attachStrategy: 'terminal_host',
          topology: 'shared',
          locality: 'same_machine',
          liveProbe: 'required',
        },
      },
      terminal: {
        mode: 'zellij',
        zellij: {
          sessionName: 'happier-adapter-missing',
          paneId: 'terminal_1',
          socketDirV1: '/tmp/happier-adapter-missing',
        },
      },
      updatedAt: 1,
    } as const;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const stop = createStopSession({
      pidToTrackedSession: new Map<number, any>([
        [777, { startedBy: 'terminal', pid: 777, happySessionId: 'sess-adapter-missing', processCommandHash: 'h7' }],
      ]),
      terminalHostAdapters: {},
      readAttachmentInfo: vi.fn(async () => attachmentInfo),
      waitForTrackedRunnersExit: vi.fn(async () => true),
    });

    await expect(stop('sess-adapter-missing')).resolves.toEqual({
      status: 'incomplete',
      reason: 'terminal_host_adapter_unavailable',
    });
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('fails before signaling when injected adapter registry acquisition fails', async () => {
    const { createStopSession } = await import('./stopSession');
    const attachmentInfo = createBoundAttachment('sess-adapter-load-failure', 'attachment-adapter-load-failure');
    const loadTerminalHostAdapters = vi.fn(async () => {
      throw new Error('registry load failed');
    });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const stop = createStopSession({
      pidToTrackedSession: new Map<number, any>([
        [778, {
          startedBy: 'terminal',
          pid: 778,
          happySessionId: 'sess-adapter-load-failure',
          processCommandHash: 'h8',
          spawnOptions: { terminal: { mode: 'zellij' } },
        }],
      ]),
      loadTerminalHostAdapters,
      readAttachmentInfo: vi.fn(async () => attachmentInfo),
      waitForTrackedRunnersExit: vi.fn(async () => true),
    });

    await expect(stop('sess-adapter-load-failure')).resolves.toEqual({
      status: 'incomplete',
      reason: 'terminal_host_adapter_unavailable',
    });
    expect(loadTerminalHostAdapters).toHaveBeenCalledTimes(1);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('refuses a replacement attachment that does not match the caller-pinned identity', async () => {
    const { createStopSession } = await import('./stopSession');
    const replacementAttachmentId = 'attachment-pinned-replacement' as NonNullable<import('@/integrations/terminalHost/_types').TerminalHostHandle['attachmentId']>;
    const replacement = {
      version: 2,
      attachmentId: replacementAttachmentId,
      sessionId: 'sess-pinned-original',
      handle: {
        attachmentId: replacementAttachmentId,
        kind: 'zellij',
        sessionName: 'replacement',
        paneId: 'terminal_1',
        socketDir: '/tmp/replacement',
        attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' },
      },
      terminal: { mode: 'zellij', zellij: { sessionName: 'replacement', paneId: 'terminal_1', socketDirV1: '/tmp/replacement' } },
      updatedAt: 2,
    } as const;
    const dispose = vi.fn(async () => undefined);
    const stop = createStopSession({
      pidToTrackedSession: new Map([[556, { startedBy: 'terminal', pid: 556, happySessionId: 'sess-pinned-original' } as any]]),
      expectedTerminalAttachmentId: 'attachment-pinned-original',
      terminalHostAdapters: { zellij: { kind: 'zellij', dispose } as any },
      readAttachmentInfo: vi.fn(async () => replacement),
      waitForTrackedRunnersExit: vi.fn(async () => true),
    });

    await expect(stop('sess-pinned-original')).resolves.toEqual({ status: 'incomplete', reason: 'attachment_mismatch' });
    expect(dispose).not.toHaveBeenCalled();
  });

  it('reports destroy failure as incomplete after proving the exact runner exited', async () => {
    const { createStopSession } = await import('./stopSession');
    const attachmentId = 'attachment-destroy-failure' as NonNullable<import('@/integrations/terminalHost/_types').TerminalHostHandle['attachmentId']>;
    const attachmentInfo = {
      version: 2,
      attachmentId,
      sessionId: 'sess-destroy-failure',
      handle: {
        attachmentId,
        kind: 'zellij',
        sessionName: 'happier-destroy-failure',
        paneId: 'terminal_1',
        socketDir: '/tmp/happier-destroy-failure',
        attachMetadata: {
          attachStrategy: 'terminal_host',
          topology: 'shared',
          locality: 'same_machine',
          liveProbe: 'required',
        },
      },
      terminal: {
        mode: 'zellij',
        zellij: {
          sessionName: 'happier-destroy-failure',
          paneId: 'terminal_1',
          socketDirV1: '/tmp/happier-destroy-failure',
        },
      },
      updatedAt: 1,
    } as const;
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const stop = createStopSession({
      pidToTrackedSession: new Map<number, any>([
        [778, { startedBy: 'terminal', pid: 778, happySessionId: 'sess-destroy-failure', processCommandHash: 'h8' }],
      ]),
      terminalHostAdapters: {
        zellij: {
          kind: 'zellij',
          createOrAttachHost: vi.fn(),
          injectUserPrompt: vi.fn(),
          interruptTurn: vi.fn(),
          evaluateLiveness: vi.fn(),
          dispose: vi.fn(async () => { throw new Error('destroy failed'); }),
        } as any,
      },
      readAttachmentInfo: vi.fn(async () => attachmentInfo),
      waitForTrackedRunnersExit: vi.fn(async () => true),
    });

    await expect(stop('sess-destroy-failure')).resolves.toEqual({
      status: 'incomplete',
      reason: 'destroy_failed',
    });
  });

  it('reports an in-flight exact disposition as incomplete instead of claiming success', async () => {
    const { createStopSession } = await import('./stopSession');
    const attachmentId = 'attachment-disposition-in-progress' as NonNullable<import('@/integrations/terminalHost/_types').TerminalHostHandle['attachmentId']>;
    const attachmentInfo = {
      version: 2,
      attachmentId,
      sessionId: 'sess-disposition-in-progress',
      handle: {
        attachmentId,
        kind: 'zellij',
        sessionName: 'happier-disposition-in-progress',
        paneId: 'terminal_1',
        socketDir: '/tmp/happier-disposition-in-progress',
        attachMetadata: {
          attachStrategy: 'terminal_host',
          topology: 'shared',
          locality: 'same_machine',
          liveProbe: 'required',
        },
      },
      terminal: {
        mode: 'zellij',
        zellij: {
          sessionName: 'happier-disposition-in-progress',
          paneId: 'terminal_1',
          socketDirV1: '/tmp/happier-disposition-in-progress',
        },
      },
      updatedAt: 1,
    } as const;
    let releaseDispose!: () => void;
    const disposePending = new Promise<void>((resolve) => { releaseDispose = resolve; });
    const adapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(),
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(),
      dispose: vi.fn(async () => await disposePending),
    } as any;
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const createStop = () => createStopSession({
      pidToTrackedSession: new Map<number, any>([
        [779, { startedBy: 'terminal', pid: 779, happySessionId: 'sess-disposition-in-progress', processCommandHash: 'h9' }],
      ]),
      terminalHostAdapters: { zellij: adapter },
      readAttachmentInfo: vi.fn(async () => attachmentInfo),
      removeAttachmentInfo: vi.fn(async () => true),
      waitForTrackedRunnersExit: vi.fn(async () => true),
    });

    const firstStop = createStop()('sess-disposition-in-progress');
    await vi.waitFor(() => expect(adapter.dispose).toHaveBeenCalledTimes(1));
    await expect(createStop()('sess-disposition-in-progress')).resolves.toEqual({
      status: 'incomplete',
      reason: 'disposition_in_progress',
    });

    releaseDispose();
    await expect(firstStop).resolves.toEqual({ status: 'stopped' });
  });

  it('keeps stop successful when provider artifact cleanup fails after exact host retirement', async () => {
    const { createStopSession } = await import('./stopSession');
    const attachmentId = 'attachment-stop-cleanup-failure' as NonNullable<import('@/integrations/terminalHost/_types').TerminalHostHandle['attachmentId']>;
    const attachmentInfo = {
      version: 2,
      attachmentId,
      sessionId: 'sess-cleanup-failure',
      handle: {
        attachmentId,
        kind: 'zellij',
        sessionName: 'happier-claude-unified-cleanup-failure',
        paneId: 'terminal_1',
        socketDir: '/happy-home/terminal/zellij-cleanup-failure',
        attachMetadata: {
          attachStrategy: 'terminal_host',
          topology: 'shared',
          locality: 'same_machine',
          liveProbe: 'required',
        },
      },
      terminal: {
        mode: 'zellij',
        zellij: {
          sessionName: 'happier-claude-unified-cleanup-failure',
          paneId: 'terminal_1',
          socketDirV1: '/happy-home/terminal/zellij-cleanup-failure',
        },
      },
      updatedAt: 1,
    } as const;
    const dispose = vi.fn(async () => undefined);
    const onExactTerminalAttachmentRetired = vi.fn(async () => {
      throw new Error('endpoint cleanup unavailable');
    });
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const stop = createStopSession({
      pidToTrackedSession: new Map<number, any>([
        [666, { startedBy: 'terminal', pid: 666, happySessionId: 'sess-cleanup-failure', processCommandHash: 'h6' }],
      ]),
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
      readAttachmentInfo: vi.fn(async () => attachmentInfo),
      waitForTrackedRunnersExit: vi.fn(async () => true),
      onExactTerminalAttachmentRetired,
    });

    await expect(stop('sess-cleanup-failure')).resolves.toEqual({ status: 'stopped' });

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(onExactTerminalAttachmentRetired).toHaveBeenCalledTimes(1);
  });

  it('does not report fully stopped when required serviceability retirement fails after exact host destruction', async () => {
    const { createStopSession } = await import('./stopSession');
    const attachmentInfo = createBoundAttachment(
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
      pidToTrackedSession: new Map<number, any>([[
        667,
        {
          startedBy: 'terminal',
          pid: 667,
          happySessionId: attachmentInfo.sessionId,
          processCommandHash: 'h7',
        },
      ]]),
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
      readAttachmentInfo: vi.fn(async () => attachmentInfo),
      removeAttachmentInfo: vi.fn(async () => true),
      waitForTrackedRunnersExit: vi.fn(async () => true),
      retireExactTerminalControlServiceability,
      onExactTerminalAttachmentRetired,
    });

    await expect(stop(attachmentInfo.sessionId)).resolves.toEqual({
      status: 'incomplete',
      reason: 'terminal_control_serviceability_retirement_failed',
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(retireExactTerminalControlServiceability).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: attachmentInfo.sessionId,
      attachmentInfo,
    }));
    expect(onExactTerminalAttachmentRetired).not.toHaveBeenCalled();
  });

  it('does not retire local evidence when serviceability retirement is superseded by a replacement attachment', async () => {
    const { createStopSession } = await import('./stopSession');
    const attachmentInfo = createBoundAttachment(
      'sess-serviceability-superseded',
      'attachment-serviceability-superseded',
    );
    const removeAttachmentInfo = vi.fn(async () => true);
    const onExactTerminalAttachmentRetired = vi.fn(async () => undefined);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const stop = createStopSession({
      pidToTrackedSession: new Map<number, any>([[
        668,
        {
          startedBy: 'terminal',
          pid: 668,
          happySessionId: attachmentInfo.sessionId,
          processCommandHash: 'h8',
        },
      ]]),
      terminalHostAdapters: {
        zellij: {
          kind: 'zellij',
          createOrAttachHost: vi.fn(),
          injectUserPrompt: vi.fn(),
          interruptTurn: vi.fn(),
          evaluateLiveness: vi.fn(),
          dispose: vi.fn(async () => undefined),
        } as any,
      },
      readAttachmentInfo: vi.fn(async () => attachmentInfo),
      removeAttachmentInfo,
      waitForTrackedRunnersExit: vi.fn(async () => true),
      retireExactTerminalControlServiceability: vi.fn(async () => 'superseded' as const),
      onExactTerminalAttachmentRetired,
    });

    await expect(stop(attachmentInfo.sessionId)).resolves.toEqual({
      status: 'incomplete',
      reason: 'terminal_control_serviceability_retirement_failed',
    });
    expect(removeAttachmentInfo).not.toHaveBeenCalled();
    expect(onExactTerminalAttachmentRetired).not.toHaveBeenCalled();
  });

  it('stops a v1 tmux session whose runners have exited and attachment is confirmed dead', async () => {
    const { createStopSession } = await import('./stopSession');

    const terminal = {
      mode: 'tmux' as const,
      tmux: { target: 'happy:legacy-window', tmpDir: '/tmp/happier-tmux' },
    };
    const legacyAttachment = {
      version: 1 as const,
      sessionId: 'sess-legacy-tmux',
      terminal,
      updatedAt: 1,
    };
    const legacyReadAttachmentInfo = vi.fn(async () => legacyAttachment);
    const legacyRemoveAttachmentInfo = vi.fn(async () => true);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>([
      [444, { startedBy: 'terminal', pid: 444, happySessionId: 'sess-legacy-tmux', processCommandHash: 'h4' }],
    ]);

    const stop = createStopSession({
      pidToTrackedSession,
      waitForTrackedRunnersExit: vi.fn(async () => true),
      readAttachmentInfo: legacyReadAttachmentInfo,
      removeAttachmentInfo: legacyRemoveAttachmentInfo,
      terminalHostAdapters: {
        tmux: createLivenessProbeAdapterFixture(
          'tmux',
          vi.fn(async () => ({ paneAlive: false, paneDead: true, observedAt: Date.now() })),
        ),
      },
    });
    const result = await stop('sess-legacy-tmux');

    expect(result).toEqual({ status: 'stopped' });
    expect(killSpy).toHaveBeenCalledWith(444, 'SIGTERM');
    expect(legacyRemoveAttachmentInfo).toHaveBeenCalledWith(expect.objectContaining({
      legacyTerminalMetadataRemoval: true,
    }));
  });

  it('refuses legacy v1 host retirement when the host is still alive', async () => {
    const { createStopSession } = await import('./stopSession');

    const terminal = {
      mode: 'zellij' as const,
      zellij: {
        sessionName: 'happier-claude-unified-123',
        paneId: 'terminal_1',
      },
    };
    const legacyAttachment = {
      version: 1 as const,
      sessionId: 'sess-zellij',
      terminal,
      updatedAt: 1,
    };
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>([
      [333, { startedBy: 'terminal', pid: 333, happySessionId: 'sess-zellij', processCommandHash: 'h3' }],
    ]);

    const stop = createStopSession({
      pidToTrackedSession,
      waitForTrackedRunnersExit: vi.fn(async () => true),
      readAttachmentInfo: vi.fn(async () => legacyAttachment),
      terminalHostAdapters: {
        zellij: createLivenessProbeAdapterFixture(
          'zellij',
          vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
        ),
      },
    });
    const ok = await stop('sess-zellij');

    expect(ok).toEqual({ status: 'incomplete', reason: 'legacy_attachment' });
    expect(zellijKillSession).not.toHaveBeenCalled();
    // Runners ARE signaled (v1 no longer blocks pre-signaling)
    expect(killSpy).toHaveBeenCalledWith(333, 'SIGTERM');
  });

  it('refuses legacy v1 host retirement when liveness probe is inconclusive (not positively dead)', async () => {
    const { createStopSession } = await import('./stopSession');

    const terminal = {
      mode: 'tmux' as const,
      tmux: { target: 'happy:legacy-window', tmpDir: '/tmp/happier-tmux' },
    };
    const legacyAttachment = {
      version: 1 as const,
      sessionId: 'sess-inconclusive',
      terminal,
      updatedAt: 1,
    };
    const legacyRemoveAttachmentInfo = vi.fn(async () => true);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>([
      [445, { startedBy: 'terminal', pid: 445, happySessionId: 'sess-inconclusive', processCommandHash: 'h4' }],
    ]);

    // Both probes return inconclusive (paneAlive:false, probeInconclusive:true)
    const evaluateLiveness = vi.fn(async () => ({
      paneAlive: false,
      probeInconclusive: true,
      observedAt: Date.now(),
    }));

    const stop = createStopSession({
      pidToTrackedSession,
      waitForTrackedRunnersExit: vi.fn(async () => true),
      readAttachmentInfo: vi.fn(async () => legacyAttachment),
      removeAttachmentInfo: legacyRemoveAttachmentInfo,
      terminalHostAdapters: {
        tmux: createLivenessProbeAdapterFixture('tmux', evaluateLiveness),
      },
    });
    const result = await stop('sess-inconclusive');

    expect(result).toEqual({ status: 'incomplete', reason: 'legacy_attachment' });
    // The descriptor must NOT be removed
    expect(legacyRemoveAttachmentInfo).not.toHaveBeenCalled();
  });

  it('reports legacy_attachment when no adapter is available for legacy v1 host liveness probe', async () => {
    const { createStopSession } = await import('./stopSession');

    const terminal = {
      mode: 'zellij' as const,
      zellij: {
        sessionName: 'happier-claude-unified-123',
        paneId: 'terminal_1',
      },
    };
    const legacyAttachment = {
      version: 1 as const,
      sessionId: 'sess-zellij-no-adapter',
      terminal,
      updatedAt: 1,
    };
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>([
      [334, { startedBy: 'terminal', pid: 334, happySessionId: 'sess-zellij-no-adapter', processCommandHash: 'h3' }],
    ]);

    const stop = createStopSession({
      pidToTrackedSession,
      waitForTrackedRunnersExit: vi.fn(async () => true),
      readAttachmentInfo: vi.fn(async () => legacyAttachment),
      terminalHostAdapters: {},
    });
    const ok = await stop('sess-zellij-no-adapter');

    expect(ok).toEqual({ status: 'incomplete', reason: 'legacy_attachment' });
    expect(killSpy).toHaveBeenCalledWith(334, 'SIGTERM');
  });

  it('retires a stale v1 tmux descriptor when zero runners are tracked and host is confirmed dead', async () => {
    const { createStopSession } = await import('./stopSession');

    const terminal = {
      mode: 'tmux' as const,
      tmux: { target: 'happy:stale-window', tmpDir: '/tmp/happier-tmux' },
    };
    const legacyAttachment = {
      version: 1 as const,
      sessionId: 'sess-stale-tmux',
      terminal,
      updatedAt: 1,
    };
    const legacyRemoveAttachmentInfo = vi.fn(async () => true);

    const stop = createStopSession({
      pidToTrackedSession: new Map(),
      readAttachmentInfo: vi.fn(async () => legacyAttachment),
      removeAttachmentInfo: legacyRemoveAttachmentInfo,
      terminalHostAdapters: {
        tmux: createLivenessProbeAdapterFixture(
          'tmux',
          vi.fn(async () => ({ paneAlive: false, paneDead: true, observedAt: Date.now() })),
        ),
      },
    });
    const result = await stop('sess-stale-tmux');

    expect(result).toEqual({ status: 'not_found' });
    expect(legacyRemoveAttachmentInfo).toHaveBeenCalledWith(expect.objectContaining({
      legacyTerminalMetadataRemoval: true,
    }));
  });

  it('refuses stale v1 tmux descriptor retirement when zero runners are tracked and host is alive', async () => {
    const { createStopSession } = await import('./stopSession');

    const terminal = {
      mode: 'tmux' as const,
      tmux: { target: 'happy:stale-window', tmpDir: '/tmp/happier-tmux' },
    };
    const legacyAttachment = {
      version: 1 as const,
      sessionId: 'sess-stale-alive',
      terminal,
      updatedAt: 1,
    };
    const legacyRemoveAttachmentInfo = vi.fn(async () => true);

    const stop = createStopSession({
      pidToTrackedSession: new Map(),
      readAttachmentInfo: vi.fn(async () => legacyAttachment),
      removeAttachmentInfo: legacyRemoveAttachmentInfo,
      terminalHostAdapters: {
        tmux: createLivenessProbeAdapterFixture(
          'tmux',
          vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
        ),
      },
    });
    const result = await stop('sess-stale-alive');

    expect(result).toEqual({ status: 'incomplete', reason: 'legacy_attachment' });
    expect(legacyRemoveAttachmentInfo).not.toHaveBeenCalled();
  });

  it('parks a tracked tmux host when no committed attachment identity exists', async () => {
    const { createStopSession } = await import('./stopSession');

    tmuxKillWindow.mockReset();
    tmuxExecuteTmuxCommand.mockReset();
    tmuxCtorCalls.length = 0;
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

  it('parks an isolated tmux host before a window target is recorded', async () => {
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

    expect(ok).toEqual({ status: 'incomplete', reason: 'missing_attachment_identity' });
    expect(killSpy).not.toHaveBeenCalled();
    expect(tmuxKillWindow).not.toHaveBeenCalled();
    expect(tmuxExecuteTmuxCommand).not.toHaveBeenCalled();
    expect(pidToTrackedSession.get(555)?.stopRequestedAtMs).toBeUndefined();

    nowSpy.mockRestore();
  });

  it('refuses Windows daemon-child tree kill when PID safety does not match the tracked command hash', async () => {
    await withProcessPlatform('win32', async () => {
      vi.resetModules();
      spawnSyncMock.mockReset();
      isPidSafeHappySessionProcess.mockReset();
      isPidSafeHappySessionProcess.mockResolvedValueOnce(false);
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw new Error('process.kill should not run for Windows daemon children');
      });

      const { createStopSession } = await import('./stopSession');
      const childKill = vi.fn();
      const pidToTrackedSession = new Map<number, any>([
        [
          777,
          {
            startedBy: 'daemon',
            pid: 777,
            happySessionId: 'sess-win',
            childProcess: {
              pid: 777,
              exitCode: null,
              signalCode: null,
              kill: childKill,
            },
            processCommandHash: 'expected-hash',
          },
        ],
      ]);

      const stop = createStopSession({ pidToTrackedSession });
      const ok = await stop('sess-win');

      expect(ok).toEqual({ status: 'incomplete', reason: 'runner_signal_incomplete' });
      expect(isPidSafeHappySessionProcess).toHaveBeenCalledWith({
        pid: 777,
        expectedProcessCommandHash: 'expected-hash',
      });
      expect(spawnSyncMock).not.toHaveBeenCalled();
      expect(childKill).not.toHaveBeenCalled();
      expect(killSpy).not.toHaveBeenCalled();
      killSpy.mockRestore();
    });
  });

  it('uses Windows taskkill for a verified daemon-child process tree', async () => {
    await withProcessPlatform('win32', async () => {
      vi.resetModules();
      spawnSyncMock.mockReset();
      isPidSafeHappySessionProcess.mockReset();
      spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });
      isPidSafeHappySessionProcess.mockResolvedValueOnce(true);
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw new Error('process.kill should not run for Windows daemon children');
      });

      const { createStopSession } = await import('./stopSession');
      const childKill = vi.fn();
      const pidToTrackedSession = new Map<number, any>([
        [
          778,
          {
            startedBy: 'daemon',
            pid: 778,
            happySessionId: 'sess-win',
            childProcess: {
              pid: 778,
              exitCode: null,
              signalCode: null,
              kill: childKill,
            },
            processCommandHash: 'expected-hash',
          },
        ],
      ]);

      const stop = createStopSession({
        pidToTrackedSession,
        waitForTrackedRunnersExit: vi.fn(async () => true),
      });
      const ok = await stop('sess-win');

      expect(ok).toEqual({ status: 'stopped' });
      expect(isPidSafeHappySessionProcess).toHaveBeenCalledWith({
        pid: 778,
        expectedProcessCommandHash: 'expected-hash',
      });
      expect(spawnSyncMock).toHaveBeenCalledWith('taskkill', ['/F', '/T', '/PID', '778'], expect.objectContaining({
        stdio: 'ignore',
      }));
      expect(childKill).not.toHaveBeenCalled();
      expect(killSpy).not.toHaveBeenCalled();
      killSpy.mockRestore();
    });
  });
});
