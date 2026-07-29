import {
  readAccountScopedCiphertextKindByte,
} from '@happier-dev/protocol';
import {
  sealHistoricalSessionRespawnEnvironmentAliasFixtureCiphertext,
} from '@happier-dev/protocol/testing/accountScopedCipherFixtures';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { reattachTrackedSessionsFromMarkers } from './reattachFromMarkers';
import { findAllHappyProcesses, findHappyProcessByPid } from '../doctor';
import { adoptSessionsFromMarkers } from '../reattach';
import {
  clearSessionMarkerConnectedServiceRestartIntent,
  hashProcessCommand,
  listSessionMarkers,
  removeSessionMarker,
  rewriteSessionMarkerRespawnEnvironmentCiphertextIfOwned,
  writeSessionMarker,
} from '../sessionRegistry';
import { createSessionRunnerRespawnManager } from '../processSupervision/sessionRunnerRespawn';
import type { Credentials } from '@/persistence';
import type { TerminalHostAdapter, TerminalHostHandle } from '@happier-dev/agents';
import type {
  TerminalHostAttachmentInfo,
  TerminalHostAttachmentReadState,
} from '@/terminal/attachment/terminalAttachmentInfo';

const terminalHostAttachmentMocks = vi.hoisted(() => ({
  read: vi.fn<() => Promise<TerminalHostAttachmentInfo | null>>(async () => null),
  readState: vi.fn<() => Promise<TerminalHostAttachmentReadState>>(async () => ({ status: 'absent' })),
  remove: vi.fn(async () => true),
  disposeSession: vi.fn(async () => undefined),
}));
const sessionHookArtifactMocks = vi.hoisted(() => ({
  disposeSession: vi.fn(async () => undefined),
}));

const emptyAdoptResult = {
  adopted: 0,
  eligible: 0,
} satisfies ReturnType<typeof adoptSessionsFromMarkers>;

function mockHappyProcessesForDiscovery(processes: ReadonlyArray<any>): void {
  vi.mocked(findAllHappyProcesses).mockResolvedValue([...processes]);
  vi.mocked(findHappyProcessByPid).mockImplementation(async (pid) => processes.find((processInfo) => processInfo.pid === pid) ?? null);
}

const {
  isOwnedLiveDaemonSessionProcessCommandMock,
} = vi.hoisted(() => ({
  isOwnedLiveDaemonSessionProcessCommandMock: vi.fn(() => true),
}));

vi.mock('../doctor', () => ({
  findAllHappyProcesses: vi.fn(async () => []),
  findHappyProcessByPid: vi.fn(async () => null),
}));

vi.mock('../reattach', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../reattach')>();
  return {
    ...actual,
    adoptSessionsFromMarkers: vi.fn(() => emptyAdoptResult),
    isOwnedLiveDaemonSessionProcessCommand: isOwnedLiveDaemonSessionProcessCommandMock,
  };
});

vi.mock('../sessionRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sessionRegistry')>();
    return {
    ...actual,
    clearSessionMarkerConnectedServiceRestartIntent: vi.fn(async () => {}),
    listSessionMarkers: vi.fn(async () => []),
    removeSessionMarker: vi.fn(async () => {}),
    rewriteSessionMarkerRespawnEnvironmentCiphertextIfOwned:
      vi.fn(async () => true),
    writeSessionMarker: vi.fn(async () => {}),
    hashProcessCommand: vi.fn((command: string) => `hash:${command}`),
  };
});

vi.mock('@/terminal/attachment/terminalAttachmentInfo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/terminal/attachment/terminalAttachmentInfo')>();
  return {
    ...actual,
    readTerminalHostAttachmentInfo: terminalHostAttachmentMocks.read,
    readTerminalHostAttachmentState: terminalHostAttachmentMocks.readState,
    removeTerminalHostAttachmentInfo: terminalHostAttachmentMocks.remove,
    disposeTerminalAttachmentInfoForSession: terminalHostAttachmentMocks.disposeSession,
  };
});

vi.mock('@/plugins/runtime/hooks/session/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/plugins/runtime/hooks/session/service')>();
  return {
    ...actual,
    disposeSessionHookArtifactsForSession: sessionHookArtifactMocks.disposeSession,
  };
});

describe('reattachTrackedSessionsFromMarkers', () => {
  beforeEach(() => {
    if (vi.isMockFunction(process.kill)) {
      vi.mocked(process.kill).mockRestore();
    }
    vi.clearAllMocks();
    delete process.env.HAPPIER_DAEMON_MARKERLESS_REATTACH_ENABLED;
    isOwnedLiveDaemonSessionProcessCommandMock.mockReturnValue(true);
    vi.mocked(findHappyProcessByPid).mockResolvedValue(null);
    terminalHostAttachmentMocks.read.mockReset();
    terminalHostAttachmentMocks.read.mockResolvedValue(null);
    terminalHostAttachmentMocks.readState.mockReset();
    terminalHostAttachmentMocks.readState.mockResolvedValue({ status: 'absent' });
    terminalHostAttachmentMocks.remove.mockReset();
    terminalHostAttachmentMocks.remove.mockResolvedValue(true);
    terminalHostAttachmentMocks.disposeSession.mockClear();
    sessionHookArtifactMocks.disposeSession.mockClear();
  });

  it('reconstructs required startup identity across both daemon reattach paths and suppresses every unproven restart', async () => {
    vi.useFakeTimers();
    try {
      const startupInstructionsSentinel =
        'PRIV-R01 raw startup instructions must not survive Agent session open';
      const appliedStartupInstructions = {
        v: 1 as const,
        id: 'happier.global_voice_agent',
        revision: 7,
        instructions: startupInstructionsSentinel,
      };
      const startupInstructionsMarker = {
        v: appliedStartupInstructions.v,
        id: appliedStartupInstructions.id,
        revision: appliedStartupInstructions.revision,
      };
      const exactCommand =
        'happier codex --happy-starting-mode remote --started-by daemon --existing-session session-startup-exact';
      const incompleteCommand =
        'happier codex --happy-starting-mode remote --started-by daemon --existing-session session-startup-incomplete';
      const exactMarker = {
        pid: 43_301,
        happySessionId: 'session-startup-exact',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon' as const,
        cwd: '/workspace/exact',
        processCommandHash: `hash:${exactCommand}`,
        processCommand: exactCommand,
        agentSessionStartupInstructionsMarkerV1: startupInstructionsMarker,
        respawn: {
          version: 1 as const,
          directory: '/workspace/exact',
          backendTarget: {
            kind: 'builtInAgent' as const,
            agentId: 'codex' as const,
          },
          vendorResumeId: 'codex-thread-exact',
        },
      };
      const incompleteMarker = {
        pid: 43_302,
        happySessionId: 'session-startup-incomplete',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon' as const,
        cwd: '/workspace/incomplete',
        processCommand: incompleteCommand,
        agentSessionStartupInstructionsMarkerV1: startupInstructionsMarker,
        respawn: {
          version: 1 as const,
          directory: '/workspace/incomplete',
          backendTarget: {
            kind: 'builtInAgent' as const,
            agentId: 'codex' as const,
          },
          vendorResumeId: 'codex-thread-incomplete',
        },
      };
      vi.mocked(listSessionMarkers).mockResolvedValue([
        exactMarker,
        incompleteMarker,
      ] as never);
      mockHappyProcessesForDiscovery([
        {
          pid: exactMarker.pid,
          type: 'daemon-spawned-session',
          cwd: exactMarker.cwd,
          command: exactCommand,
        },
        {
          pid: incompleteMarker.pid,
          type: 'daemon-spawned-session',
          cwd: incompleteMarker.cwd,
          command: incompleteCommand,
        },
      ]);
      const actualReattach =
        await vi.importActual<typeof import('../reattach')>(
          '../reattach',
        );
      vi.mocked(adoptSessionsFromMarkers).mockImplementationOnce(
        actualReattach.adoptSessionsFromMarkers,
      );
      vi.spyOn(process, 'kill').mockImplementation(() => true as never);

      const pidToTrackedSession = new Map<number, any>();
      await reattachTrackedSessionsFromMarkers({
        pidToTrackedSession,
      });

      const exactTracked =
        pidToTrackedSession.get(exactMarker.pid);
      const incompleteTracked =
        pidToTrackedSession.get(incompleteMarker.pid);
      expect(exactTracked).toEqual(expect.objectContaining({
        happySessionId: exactMarker.happySessionId,
        agentSessionStartupInstructionsMarkerV1:
          startupInstructionsMarker,
        reattachedFromDiskMarker: true,
      }));
      expect(incompleteTracked).toEqual(
        expect.objectContaining({
          happySessionId: incompleteMarker.happySessionId,
          agentSessionStartupInstructionsMarkerV1:
            startupInstructionsMarker,
          reattachedFromDiskMarker: true,
        }),
      );
      expect(JSON.stringify({
        exactMarker,
        incompleteMarker,
        exactTracked,
        incompleteTracked,
      })).not.toContain(startupInstructionsSentinel);
      expect(writeSessionMarker).toHaveBeenCalledWith(
        expect.objectContaining({
          pid: incompleteMarker.pid,
          happySessionId: incompleteMarker.happySessionId,
          agentSessionStartupInstructionsMarkerV1:
            startupInstructionsMarker,
        }),
      );
      expect(
        JSON.stringify(vi.mocked(writeSessionMarker).mock.calls),
      ).not.toContain(startupInstructionsSentinel);

      const spawnSession = vi.fn(async () => ({
        type: 'success' as const,
        pid: 43_303,
      }));
      const onRespawnTerminal = vi.fn();
      const respawnManager = createSessionRunnerRespawnManager({
        enabled: true,
        maxRestarts: 1,
        baseDelayMs: 50,
        maxDelayMs: 50,
        jitterMs: 0,
        isSessionAlreadyRunning: async () => false,
        spawnSession,
        onRespawnTerminal,
        random: () => 0,
        logDebug: () => {},
        logWarn: () => {},
      });

      expect(respawnManager.handleUnexpectedExit(
        exactTracked,
        {
          reason: 'process-missing',
          code: null,
          signal: null,
        },
      )).toBe('terminal');
      expect(respawnManager.handleUnexpectedExit(
        incompleteTracked,
        {
          reason: 'connected-service-restart',
          code: null,
          signal: 'SIGTERM',
        },
        { forceRestart: true },
      )).toBe('terminal');
      await vi.advanceTimersByTimeAsync(51);

      expect(spawnSession).not.toHaveBeenCalled();
      expect(onRespawnTerminal).toHaveBeenCalledTimes(2);
      expect(onRespawnTerminal).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          sessionId: exactMarker.happySessionId,
          reason:
            'startup_instructions_cold_resume_unproven',
        }),
      );
      expect(onRespawnTerminal).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          sessionId: incompleteMarker.happySessionId,
          reason:
            'startup_instructions_cold_resume_unproven',
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns orphaned dead daemon sessions when removing dead markers', async () => {
    const marker = {
      pid: 43210,
      happySessionId: 'session-123',
      happyHomeDir: '/tmp/happy',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon',
      cwd: '/tmp/project',
      processCommandHash: 'a'.repeat(64),
      activeTurnId: 'turn-exact-reattach',
    };

    vi.mocked(listSessionMarkers).mockResolvedValue([marker as any]);
    mockHappyProcessesForDiscovery([]);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });

    const pidToTrackedSession = new Map<number, any>();
    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(result).toEqual({
      orphanedDeadDaemonSessions: [
        {
          sessionId: 'session-123',
          pid: 43210,
          activeTurnId: 'turn-exact-reattach',
          processCommandHash: 'a'.repeat(64),
        },
      ],
      connectedServiceRestartIntents: [],
    });
    expect(removeSessionMarker).not.toHaveBeenCalledWith(43210);
    expect(adoptSessionsFromMarkers).toHaveBeenCalledWith({
      markers: [],
      happyProcesses: [],
      processIdentityByPid: new Map(),
      pidToTrackedSession,
      credentials: undefined,
    });
  });

  it('preserves legacy terminal topology as explicitly unresolved during cold startup', async () => {
    const marker = {
      pid: 43214,
      happySessionId: 'session-live-terminal-dead-runner',
      happyHomeDir: '/tmp/happy',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon',
      cwd: '/workspace/project',
      respawn: {
        version: 1,
        directory: '/workspace/project',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        resume: 'claude-live-terminal-thread',
      },
    };
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-live-terminal-dead-runner',
      paneId: 'claude.1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'exclusive',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(),
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      dispose: vi.fn(async () => undefined),
    };
    vi.mocked(listSessionMarkers).mockResolvedValue([marker as any]);
    terminalHostAttachmentMocks.readState.mockResolvedValue({ status: 'present', info: {
      version: 1,
      sessionId: marker.happySessionId,
      handle,
      updatedAt: 1,
    } });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });

    const result = await reattachTrackedSessionsFromMarkers({
      pidToTrackedSession: new Map(),
      terminalHostAdapters: { tmux: adapter },
    } as Parameters<typeof reattachTrackedSessionsFromMarkers>[0] & {
      terminalHostAdapters: { tmux: TerminalHostAdapter };
    });

    expect(adapter.evaluateLiveness).not.toHaveBeenCalled();
    expect(result).toEqual({
      orphanedDeadDaemonSessions: [],
      unresolvedTerminalHostSessionIds: [marker.happySessionId],
      connectedServiceRestartIntents: [],
    });
    expect(adapter.dispose).not.toHaveBeenCalled();
    expect(terminalHostAttachmentMocks.remove).not.toHaveBeenCalled();
    expect(sessionHookArtifactMocks.disposeSession).not.toHaveBeenCalled();
    expect(terminalHostAttachmentMocks.disposeSession).not.toHaveBeenCalled();
    expect(removeSessionMarker).not.toHaveBeenCalled();
  });

  it('preserves unreadable terminal topology as explicitly unresolved without orphan cleanup', async () => {
    const marker = {
      pid: 43216,
      happySessionId: 'session-unreadable-terminal',
      happyHomeDir: '/tmp/happy',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon',
      cwd: '/workspace/project',
    };
    vi.mocked(listSessionMarkers).mockResolvedValue([marker as any]);
    terminalHostAttachmentMocks.readState.mockResolvedValue({ status: 'unreadable', reason: 'invalid' });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });

    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession: new Map() });

    expect(result).toEqual({
      orphanedDeadDaemonSessions: [],
      unresolvedTerminalHostSessionIds: [marker.happySessionId],
      connectedServiceRestartIntents: [],
    });
    expect(removeSessionMarker).not.toHaveBeenCalled();
  });

  it('reconstructs an exact V2 terminal host independently from plugin control availability', async () => {
    const marker = {
      pid: 43217,
      happySessionId: 'session-exact-terminal',
      happyHomeDir: '/tmp/happy',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon',
      cwd: '/workspace/project',
    };
    const attachmentId = 'attachment-exact-terminal' as NonNullable<TerminalHostHandle['attachmentId']>;
    const handle: TerminalHostHandle & { attachmentId: NonNullable<TerminalHostHandle['attachmentId']> } = {
      attachmentId,
      kind: 'zellij',
      sessionName: 'happier-exact-terminal',
      paneId: 'pane-1',
      attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' },
    };
    vi.mocked(listSessionMarkers).mockResolvedValue([marker as any]);
    terminalHostAttachmentMocks.readState.mockResolvedValue({ status: 'present', info: {
      version: 2,
      attachmentId,
      sessionId: marker.happySessionId,
      handle,
      updatedAt: 1,
    } });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });

    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession: new Map() });

    expect(result).toEqual({
      orphanedDeadDaemonSessions: [],
      disconnectedTerminalHostCandidates: [{
        sessionId: marker.happySessionId,
        pid: marker.pid,
        happyHomeDir: marker.happyHomeDir,
        attachmentId,
        handle,
        terminalMode: 'zellij',
        controlDescriptorAvailable: false,
      }],
      connectedServiceRestartIntents: [],
    });
    expect(removeSessionMarker).not.toHaveBeenCalled();
  });

  it('binds the marker-authored actual Windows mode to a disconnected host candidate', async () => {
    const marker = {
      pid: 43218,
      happySessionId: 'session-exact-windows-terminal',
      happyHomeDir: '/tmp/happy',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon',
      cwd: 'C:\\workspace\\project',
      metadata: {
        terminal: {
          mode: 'windows_terminal',
          requested: 'windows_terminal',
          windows: { host: 'windows_terminal', pid: 43218 },
          controlServiceabilityV1: {
            v: 1,
            attachmentId: 'attachment-exact-windows-terminal',
            state: 'recoverable_unservable',
            observedAt: 2,
          },
        },
      },
    };
    const attachmentId = 'attachment-exact-windows-terminal' as NonNullable<TerminalHostHandle['attachmentId']>;
    const handle: TerminalHostHandle & { attachmentId: NonNullable<TerminalHostHandle['attachmentId']> } = {
      attachmentId,
      kind: 'windows_console',
      sessionName: 'happier-exact-windows-terminal',
      attachMetadata: { attachStrategy: 'terminal_host', topology: 'exclusive', locality: 'same_machine', liveProbe: 'required' },
    };
    vi.mocked(listSessionMarkers).mockResolvedValue([marker as any]);
    terminalHostAttachmentMocks.readState.mockResolvedValue({ status: 'present', info: {
      version: 2,
      attachmentId,
      sessionId: marker.happySessionId,
      handle,
      updatedAt: 1,
    } });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });

    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession: new Map() });

    expect(result.disconnectedTerminalHostCandidates).toEqual([expect.objectContaining({
      sessionId: marker.happySessionId,
      attachmentId,
      handle,
      terminalMode: 'windows_terminal',
    })]);
  });

  it('keeps a disconnected Windows host unresolved when marker mode evidence names a replaced attachment', async () => {
    const marker = {
      pid: 43219,
      happySessionId: 'session-stale-windows-terminal',
      happyHomeDir: '/tmp/happy',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon',
      cwd: 'C:\\workspace\\project',
      metadata: {
        terminal: {
          mode: 'windows_terminal',
          controlServiceabilityV1: {
            v: 1,
            attachmentId: 'attachment-replaced-windows-terminal',
            state: 'servable',
            observedAt: 2,
          },
        },
      },
    };
    const attachmentId = 'attachment-current-windows-terminal' as NonNullable<TerminalHostHandle['attachmentId']>;
    const handle: TerminalHostHandle & { attachmentId: NonNullable<TerminalHostHandle['attachmentId']> } = {
      attachmentId,
      kind: 'windows_console',
      sessionName: 'happier-stale-windows-terminal',
      attachMetadata: { attachStrategy: 'terminal_host', topology: 'exclusive', locality: 'same_machine', liveProbe: 'required' },
    };
    vi.mocked(listSessionMarkers).mockResolvedValue([marker as any]);
    terminalHostAttachmentMocks.readState.mockResolvedValue({ status: 'present', info: {
      version: 2,
      attachmentId,
      sessionId: marker.happySessionId,
      handle,
      updatedAt: 1,
    } });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });

    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession: new Map() });

    expect(result).toEqual({
      orphanedDeadDaemonSessions: [],
      unresolvedTerminalHostSessionIds: [marker.happySessionId],
      connectedServiceRestartIntents: [],
    });
    expect(removeSessionMarker).not.toHaveBeenCalled();
  });

  it('retains dead-runner marker evidence without waiting on terminal liveness during cold startup', async () => {
    const marker = {
      pid: 43215,
      happySessionId: 'session-inconclusive-terminal',
      happyHomeDir: '/tmp/happy',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon',
      cwd: '/workspace/project',
      respawn: {
        version: 1,
        directory: '/workspace/project',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        resume: 'claude-inconclusive-thread',
      },
    };
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-inconclusive-terminal',
      paneId: 'terminal_7',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'exclusive',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(),
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(async () => {
        throw new Error('list-panes timed out');
      }),
      dispose: vi.fn(),
    };
    vi.mocked(listSessionMarkers).mockResolvedValue([marker as any]);
    terminalHostAttachmentMocks.read.mockResolvedValue({
      version: 1,
      sessionId: marker.happySessionId,
      handle,
      updatedAt: 1,
    });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });

    const result = await reattachTrackedSessionsFromMarkers({
      pidToTrackedSession: new Map(),
      terminalHostAdapters: { zellij: adapter },
    });

    expect(adapter.evaluateLiveness).not.toHaveBeenCalled();
    expect(result).toEqual({
      orphanedDeadDaemonSessions: [{ sessionId: marker.happySessionId, pid: marker.pid }],
      connectedServiceRestartIntents: [],
    });
    expect(adapter.dispose).not.toHaveBeenCalled();
    expect(removeSessionMarker).not.toHaveBeenCalledWith(marker.pid);
    expect(terminalHostAttachmentMocks.remove).not.toHaveBeenCalled();
    expect(sessionHookArtifactMocks.disposeSession).not.toHaveBeenCalled();
  });

  it('reports a dead runner as orphan while retaining marker evidence for terminal publication', async () => {
    const marker = {
      pid: 43216,
      happySessionId: 'session-dead-terminal',
      happyHomeDir: '/tmp/happy',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon',
      cwd: '/workspace/project',
    };
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-dead-terminal',
      paneId: 'dead-pane',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'exclusive',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(),
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(async () => ({
        paneAlive: false,
        paneDead: true,
        paneExitStatus: 1,
        observedAt: 1,
      })),
      dispose: vi.fn(async () => undefined),
    };
    vi.mocked(listSessionMarkers).mockResolvedValue([marker as any]);
    terminalHostAttachmentMocks.read.mockResolvedValue({
      version: 1,
      sessionId: marker.happySessionId,
      handle,
      updatedAt: 1,
    });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });

    const result = await reattachTrackedSessionsFromMarkers({
      pidToTrackedSession: new Map(),
      terminalHostAdapters: { tmux: adapter },
    });

    expect(result.orphanedDeadDaemonSessions).toEqual([{ sessionId: marker.happySessionId, pid: marker.pid }]);
    expect(adapter.evaluateLiveness).not.toHaveBeenCalled();
    expect(adapter.dispose).not.toHaveBeenCalled();
    expect(terminalHostAttachmentMocks.remove).not.toHaveBeenCalled();
    expect(sessionHookArtifactMocks.disposeSession).not.toHaveBeenCalled();
    expect(terminalHostAttachmentMocks.disposeSession).not.toHaveBeenCalled();
    expect(removeSessionMarker).not.toHaveBeenCalledWith(marker.pid);
  });

  it('retains a dead OpenCode daemon marker as orphan evidence without returning a startup restart intent', async () => {
    const marker = {
      pid: 43211,
      happySessionId: 'session-opencode-dead',
      happyHomeDir: '/tmp/happy',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon',
      cwd: 'C:\\Users\\alice\\repo',
      processCommandHash: 'a'.repeat(64),
      respawn: {
        version: 1,
        directory: 'C:\\Users\\alice\\repo',
        backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
        resume: 'opencode-thread-from-respawn',
      },
    };

    vi.mocked(listSessionMarkers).mockResolvedValue([marker as any]);
    mockHappyProcessesForDiscovery([]);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });

    const pidToTrackedSession = new Map<number, any>();
    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.size).toBe(0);
    expect(result.orphanedDeadDaemonSessions).toEqual([
      {
        sessionId: 'session-opencode-dead',
        pid: 43211,
        processCommandHash: 'a'.repeat(64),
      },
    ]);
    expect((result as {
      sessionRestartIntents?: unknown;
    }).sessionRestartIntents).toBeUndefined();
    expect(removeSessionMarker).not.toHaveBeenCalledWith(43211);
    expect(adoptSessionsFromMarkers).toHaveBeenCalledWith({
      markers: [],
      happyProcesses: [],
      processIdentityByPid: new Map(),
      pidToTrackedSession,
      credentials: undefined,
    });
  });

  it('retains every duplicate dead OpenCode daemon marker for downstream release', async () => {
    const firstMarker = {
      pid: 43212,
      happySessionId: 'session-opencode-duplicate-dead',
      happyHomeDir: '/tmp/happy',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon',
      cwd: 'C:\\Users\\alice\\repo',
      processCommandHash: 'b'.repeat(64),
      respawn: {
        version: 1,
        directory: 'C:\\Users\\alice\\repo',
        backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
        resume: 'opencode-thread-from-first-marker',
      },
    };
    const secondMarker = {
      ...firstMarker,
      pid: 43213,
      updatedAt: 2,
      respawn: {
        ...firstMarker.respawn,
        resume: 'opencode-thread-from-second-marker',
      },
    };

    vi.mocked(listSessionMarkers).mockResolvedValue([firstMarker as any, secondMarker as any]);
    mockHappyProcessesForDiscovery([]);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });

    const pidToTrackedSession = new Map<number, any>();
    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(result.orphanedDeadDaemonSessions).toEqual([
      expect.objectContaining({
        sessionId: 'session-opencode-duplicate-dead',
        pid: 43212,
      }),
      expect.objectContaining({
        sessionId: 'session-opencode-duplicate-dead',
        pid: 43213,
      }),
    ]);
    const sessionRestartIntents = (result as {
      sessionRestartIntents?: ReadonlyArray<Record<string, unknown>>;
    }).sessionRestartIntents;
    expect(sessionRestartIntents).toBeUndefined();
    expect(removeSessionMarker).not.toHaveBeenCalledWith(43212);
    expect(removeSessionMarker).not.toHaveBeenCalledWith(43213);
  });

  it('retains dead marker evidence without a startup restart intent when the same OpenCode session has a recovered live owner', async () => {
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 11113,
        happySessionId: 'session-opencode-live-owner',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        cwd: '/tmp/project',
        processCommandHash: 'c'.repeat(64),
        respawn: {
          version: 1,
          directory: '/tmp/project',
          backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
          resume: 'opencode-live-owner-thread',
        },
      } as any,
      {
        pid: 22223,
        happySessionId: 'session-opencode-live-owner',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        cwd: '/tmp/project',
      } as any,
    ]);
    mockHappyProcessesForDiscovery([
      {
        pid: 22223,
        type: 'daemon-spawned-session',
        cwd: '/tmp/project',
        command:
          '/home/guest/.happier/current/happier opencode --happy-starting-mode remote --started-by daemon --resume opencode-live-owner-thread --existing-session session-opencode-live-owner',
      } as any,
    ]);
    vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === 11113) {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      }
      return true;
    });

    const pidToTrackedSession = new Map<number, any>();
    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(result.orphanedDeadDaemonSessions).toEqual([
      expect.objectContaining({
        sessionId: 'session-opencode-live-owner',
        pid: 11113,
        recoveredLiveSession: true,
      }),
    ]);
    expect((result as {
      sessionRestartIntents?: unknown;
    }).sessionRestartIntents).toBeUndefined();
    expect(removeSessionMarker).not.toHaveBeenCalledWith(11113);
    expect(pidToTrackedSession.get(22223)).toEqual(expect.objectContaining({
      happySessionId: 'session-opencode-live-owner',
      vendorResumeId: 'opencode-live-owner-thread',
    }));
  });

  it('reattaches a live marker and clears a stale connected-service restart intent', async () => {
    const marker = {
      pid: 43210,
      happySessionId: 'session-live-restart',
      happyHomeDir: '/tmp/happy',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon',
      cwd: '/tmp/project',
      processCommandHash: 'a'.repeat(64),
      connectedServiceRestartIntent: {
        v: 1,
        requestedAtMs: 1234,
      },
      respawn: {
        version: 1,
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        resume: 'codex-vendor-session',
      },
    };

    vi.mocked(listSessionMarkers).mockResolvedValue([marker as any]);
    mockHappyProcessesForDiscovery([
      {
        pid: 43210,
        type: 'daemon-spawned-session',
        cwd: '/tmp/project',
        command:
          '/home/guest/.happier/cli-preview/current/happier claude --happy-starting-mode remote --started-by daemon --resume claude-vendor-session --existing-session session-live-restart',
      } as any,
    ]);
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    const pidToTrackedSession = new Map<number, any>();
    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.get(43210)).toEqual(expect.objectContaining({
      happySessionId: 'session-live-restart',
      pid: 43210,
      vendorResumeId: 'claude-vendor-session',
      reattachedFromDiskMarker: true,
    }));
    expect(result.connectedServiceRestartIntents).toEqual([]);
    expect(clearSessionMarkerConnectedServiceRestartIntent).toHaveBeenCalledWith(43210);
    expect(removeSessionMarker).not.toHaveBeenCalledWith(43210);
  });

  it('returns an exact retained managed Provider candidate only after marker adoption proves the runner identity', async () => {
    const processCommandHash = 'b'.repeat(64);
    const processStartTimeMs = 1_717_171_717_321;
    const attachment = {
      v: 1 as const,
      process: {
        pid: 54321,
        processStartTimeMs: 1_717_171_717_654,
        processCommandHash: 'c'.repeat(64),
      },
      endpoint: {
        host: '127.0.0.1' as const,
        port: 45_321,
      },
      materialization: {
        rootDir: '/tmp/managed-provider-session-retained',
        materializationId: 'managed-provider-session-retained',
      },
    };
    const marker = {
      pid: 54321,
      happySessionId: 'session-managed-provider-retained',
      happyHomeDir: '/tmp/happy',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon',
      cwd: '/tmp/project',
      processCommandHash,
      processStartTimeMs,
      managedLocalServiceRunAttachment: attachment,
    };
    vi.mocked(listSessionMarkers).mockResolvedValue([marker as never]);
    mockHappyProcessesForDiscovery([{
      pid: marker.pid,
      type: 'daemon-spawned-session',
      cwd: marker.cwd,
      command:
        'happier codex --started-by daemon --existing-session session-managed-provider-retained',
    }]);
    vi.mocked(adoptSessionsFromMarkers).mockImplementationOnce(
      ({ pidToTrackedSession }) => {
        pidToTrackedSession.set(marker.pid, {
          pid: marker.pid,
          startedBy: 'daemon',
          happySessionId: marker.happySessionId,
          processCommandHash,
          processStartTimeMs,
          reattachedFromDiskMarker: true,
        });
        return { adopted: 1, eligible: 1 };
      },
    );
    vi.spyOn(process, 'kill').mockImplementation(() => true as never);

    const pidToTrackedSession = new Map<number, any>();
    const result = await reattachTrackedSessionsFromMarkers({
      pidToTrackedSession,
      readProcessIdentityByPidFn: vi.fn(async () => ({
        pid: marker.pid,
        ppid: 1,
        processStartTimeMs,
        command: 'happier codex',
        executablePath: '/tmp/happier',
      })),
    });

    expect(result.managedProviderRecoveryCandidates).toEqual([{
      pid: marker.pid,
      sessionId: marker.happySessionId,
      attachment,
      markerOwnership: {
        happySessionId: marker.happySessionId,
        processCommandHash,
        processStartTimeMs,
      },
    }]);

    const placeholderSessionId = `PID-${marker.pid}`;
    vi.mocked(listSessionMarkers).mockResolvedValue([{
      ...marker,
      happySessionId: placeholderSessionId,
    } as never]);
    vi.mocked(adoptSessionsFromMarkers).mockImplementationOnce(
      ({ pidToTrackedSession }) => {
        pidToTrackedSession.set(marker.pid, {
          pid: marker.pid,
          startedBy: 'daemon',
          happySessionId: placeholderSessionId,
          processCommandHash,
          processStartTimeMs,
          reattachedFromDiskMarker: true,
        });
        return { adopted: 1, eligible: 1 };
      },
    );
    const placeholderResult =
      await reattachTrackedSessionsFromMarkers({
        pidToTrackedSession: new Map<number, any>(),
        readProcessIdentityByPidFn: vi.fn(async () => ({
          pid: marker.pid,
          ppid: 1,
          processStartTimeMs,
          command: 'happier codex',
          executablePath: '/tmp/happier',
        })),
      });
    expect(
      placeholderResult.managedProviderRecoveryCandidates,
    ).toBeUndefined();
  });

  it('retains a dead connected-service restart marker for downstream release without returning respawn inputs', async () => {
    const marker = {
      pid: 43211,
      happySessionId: 'session-restart',
      happyHomeDir: '/tmp/happy',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon',
      cwd: '/tmp/project',
      processCommandHash: 'a'.repeat(64),
      connectedServiceRestartIntent: {
        v: 1,
        requestedAtMs: 1234,
      },
      respawn: {
        version: 1,
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        resume: 'codex-vendor-session',
      },
    };

    vi.mocked(listSessionMarkers).mockResolvedValue([marker as any]);
    mockHappyProcessesForDiscovery([]);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });

    const pidToTrackedSession = new Map<number, any>();
    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(result).toEqual({
      orphanedDeadDaemonSessions: [
        {
          sessionId: 'session-restart',
          pid: 43211,
          processCommandHash: 'a'.repeat(64),
        },
      ],
      connectedServiceRestartIntents: [],
    });
    expect(removeSessionMarker).not.toHaveBeenCalledWith(43211);
  });

  it('retains a dead connected-service restart marker when resume is only in marker metadata', async () => {
    const marker = {
      pid: 43212,
      happySessionId: 'session-metadata-restart',
      happyHomeDir: '/tmp/happy',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon',
      cwd: '/tmp/project',
      processCommandHash: 'b'.repeat(64),
      metadata: {
        flavor: 'codex',
        codexSessionId: 'codex-thread-from-marker-metadata',
      },
      connectedServiceRestartIntent: {
        v: 1,
        requestedAtMs: 2345,
      },
      respawn: {
        version: 1,
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      },
    };

    vi.mocked(listSessionMarkers).mockResolvedValue([marker as any]);
    mockHappyProcessesForDiscovery([]);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });

    const pidToTrackedSession = new Map<number, any>();
    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(result).toEqual({
      orphanedDeadDaemonSessions: [
        {
          sessionId: 'session-metadata-restart',
          pid: 43212,
          processCommandHash: 'b'.repeat(64),
        },
      ],
      connectedServiceRestartIntents: [],
    });
    expect(removeSessionMarker).not.toHaveBeenCalledWith(43212);
  });

  it('retains a dead connected-service restart marker when only existingSessionId is resumable', async () => {
    const marker = {
      pid: 43214,
      happySessionId: 'session-existing-session-restart',
      happyHomeDir: '/tmp/happy',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon',
      cwd: '/tmp/project',
      processCommandHash: 'd'.repeat(64),
      connectedServiceRestartIntent: {
        v: 1,
        requestedAtMs: 3456,
      },
      respawn: {
        version: 1,
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        existingSessionId: 'session-existing-session-restart',
      },
    };

    vi.mocked(listSessionMarkers).mockResolvedValue([marker as any]);
    mockHappyProcessesForDiscovery([]);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });

    const pidToTrackedSession = new Map<number, any>();
    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(result).toEqual({
      orphanedDeadDaemonSessions: [
        {
          sessionId: 'session-existing-session-restart',
          pid: 43214,
          processCommandHash: 'd'.repeat(64),
        },
      ],
      connectedServiceRestartIntents: [],
    });
    expect(removeSessionMarker).not.toHaveBeenCalledWith(43214);
  });

  it('retains a dead resumable terminal-injection marker as orphan evidence instead of replaying startup restart', async () => {
    const marker = {
      pid: 43213,
      happySessionId: 'session-terminal-restart',
      happyHomeDir: '/tmp/happy',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon',
      cwd: '/tmp/project',
      processCommandHash: 'c'.repeat(64),
      respawn: {
        version: 1,
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        resume: 'claude-terminal-thread',
      },
    };

    vi.mocked(listSessionMarkers).mockResolvedValue([marker as any]);
    mockHappyProcessesForDiscovery([]);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });

    const pidToTrackedSession = new Map<number, any>();
    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(result).toEqual({
      orphanedDeadDaemonSessions: [
        {
          sessionId: 'session-terminal-restart',
          pid: 43213,
          processCommandHash: 'c'.repeat(64),
        },
      ],
      connectedServiceRestartIntents: [],
    });
    expect(removeSessionMarker).not.toHaveBeenCalledWith(43213);
  });

  it('reattaches a live resumable terminal-injection marker without replaying startup restart', async () => {
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 43214,
        happySessionId: 'session-terminal-live',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        cwd: '/tmp/project',
        processCommandHash: 'd'.repeat(64),
      } as any,
    ]);
    mockHappyProcessesForDiscovery([]);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>([
      [
        43214,
        {
          startedBy: 'daemon',
          happySessionId: 'session-terminal-live',
          pid: 43214,
          spawnOptions: {
            directory: '/tmp/project',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            resume: 'claude-terminal-live-thread',
          },
          vendorResumeId: 'claude-terminal-live-thread',
        },
      ],
    ]);
    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(result).toEqual({
      orphanedDeadDaemonSessions: [],
      connectedServiceRestartIntents: [],
    });
  });

  it('recovers a markerless daemon-spawned session from the live process command and heals its marker', async () => {
    vi.mocked(listSessionMarkers).mockResolvedValue([]);
    mockHappyProcessesForDiscovery([
      {
        pid: 54321,
        type: 'daemon-spawned-session',
        cwd: '/tmp/project',
        environmentVariables: {
          CLAUDE_CONFIG_DIR: '/tmp/claude-config',
        },
        command:
          '/home/guest/.happier/cli-preview/current/happier opencode --happy-starting-mode remote --started-by daemon --resume vendor-1 --existing-session session-123',
      } as any,
    ]);

    const pidToTrackedSession = new Map<number, any>();
    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(result).toEqual({ orphanedDeadDaemonSessions: [], connectedServiceRestartIntents: [] });
    expect(pidToTrackedSession.get(54321)).toMatchObject({
      pid: 54321,
      startedBy: 'daemon',
      happySessionId: 'session-123',
      vendorResumeId: 'vendor-1',
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
        resume: 'vendor-1',
        environmentVariables: {
          CLAUDE_CONFIG_DIR: '/tmp/claude-config',
        },
      },
      processCommandHash:
        'hash:/home/guest/.happier/cli-preview/current/happier opencode --happy-starting-mode remote --started-by daemon --resume vendor-1 --existing-session session-123',
    });
    expect(writeSessionMarker).toHaveBeenCalledWith(
      {
        pid: 54321,
        happySessionId: 'session-123',
        startedBy: 'daemon',
        cwd: '/tmp/project',
        processCommandHash:
          'hash:/home/guest/.happier/cli-preview/current/happier opencode --happy-starting-mode remote --started-by daemon --resume vendor-1 --existing-session session-123',
        processCommand:
          '/home/guest/.happier/cli-preview/current/happier opencode --happy-starting-mode remote --started-by daemon --resume vendor-1 --existing-session session-123',
        respawn: {
          version: 1,
          directory: '/tmp/project',
          backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
          resume: 'vendor-1',
          vendorResumeId: 'vendor-1',
          environmentVariables: {
            CLAUDE_CONFIG_DIR: '/tmp/claude-config',
          },
        },
      },
    );
  });

  it('recovers a live daemon-spawned process when its live marker is missing process identity fields', async () => {
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 12345,
        happySessionId: 'session-123',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        cwd: '/tmp/project',
      } as any,
    ]);
    mockHappyProcessesForDiscovery([
      {
        pid: 12345,
        type: 'daemon-spawned-session',
        cwd: '/tmp/project',
        command:
          '/home/guest/.happier/cli-preview/current/happier opencode --happy-starting-mode remote --started-by daemon --resume vendor-1 --existing-session session-123',
      } as any,
    ]);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.get(12345)).toEqual(
      expect.objectContaining({
        startedBy: 'daemon',
        happySessionId: 'session-123',
        pid: 12345,
        vendorResumeId: 'vendor-1',
        spawnOptions: {
          directory: '/tmp/project',
          backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
          resume: 'vendor-1',
        },
        reattachedFromDiskMarker: true,
        processCommand:
          '/home/guest/.happier/cli-preview/current/happier opencode --happy-starting-mode remote --started-by daemon --resume vendor-1 --existing-session session-123',
        processCommandHash:
          'hash:/home/guest/.happier/cli-preview/current/happier opencode --happy-starting-mode remote --started-by daemon --resume vendor-1 --existing-session session-123',
      }),
    );
    expect(writeSessionMarker).toHaveBeenCalledWith({
      pid: 12345,
      happySessionId: 'session-123',
      startedBy: 'daemon',
      cwd: '/tmp/project',
      processCommandHash:
        'hash:/home/guest/.happier/cli-preview/current/happier opencode --happy-starting-mode remote --started-by daemon --resume vendor-1 --existing-session session-123',
      processCommand:
        '/home/guest/.happier/cli-preview/current/happier opencode --happy-starting-mode remote --started-by daemon --resume vendor-1 --existing-session session-123',
      respawn: {
        version: 1,
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
        resume: 'vendor-1',
        vendorResumeId: 'vendor-1',
      },
    });
  });

  it('recovers a live marker through PID-specific lookup when bulk discovery misses it', async () => {
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 12347,
        happySessionId: 'session-pid-specific',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        cwd: '/tmp/project',
      } as any,
    ]);
    mockHappyProcessesForDiscovery([]);
    vi.mocked(findHappyProcessByPid).mockResolvedValue({
      pid: 12347,
      type: 'daemon-spawned-session',
      cwd: '/tmp/project',
      command:
        '/home/guest/.happier/cli-preview/current/happier claude --happy-starting-mode remote --started-by daemon --resume vendor-pid --existing-session session-pid-specific',
    } as any);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(findHappyProcessByPid).toHaveBeenCalledWith(12347);
    expect(pidToTrackedSession.get(12347)).toEqual(
      expect.objectContaining({
        startedBy: 'daemon',
        happySessionId: 'session-pid-specific',
        pid: 12347,
        vendorResumeId: 'vendor-pid',
        spawnOptions: {
          directory: '/tmp/project',
          backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
          resume: 'vendor-pid',
        },
        reattachedFromDiskMarker: true,
      }),
    );
  });

  it('uses marker pid lookup without a full process-table scan when markerless recovery is disabled', async () => {
    process.env.HAPPIER_DAEMON_MARKERLESS_REATTACH_ENABLED = '0';
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 12349,
        happySessionId: 'session-marker-disabled-scan',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        cwd: '/tmp/project',
      } as any,
    ]);
    mockHappyProcessesForDiscovery([
      {
        pid: 12349,
        type: 'daemon-spawned-session',
        cwd: '/tmp/project',
        command:
          'happier claude --started-by daemon --existing-session session-marker-disabled-scan',
      },
    ]);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession: new Map<number, any>() });

    expect(findHappyProcessByPid).toHaveBeenCalledWith(12349);
    expect(findAllHappyProcesses).not.toHaveBeenCalled();
  });

  it('recovers a markerless daemon session alongside an adopted live marker and heals only the missing marker', async () => {
    const markedProcess = {
      pid: 12348,
      type: 'daemon-spawned-session',
      cwd: '/tmp/project',
      command: 'happier claude --started-by daemon --existing-session session-marker-default',
    };
    const markerlessProcess = {
      pid: 99991,
      type: 'daemon-spawned-session',
      cwd: '/tmp/other',
      command: 'happier codex --started-by daemon --existing-session session-markerless',
    };
    const marker = {
      pid: markedProcess.pid,
      happySessionId: 'session-marker-default',
      happyHomeDir: '/tmp/happy',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon',
      cwd: markedProcess.cwd,
      respawn: {
        version: 1,
        directory: markedProcess.cwd,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      },
    };
    vi.mocked(listSessionMarkers).mockResolvedValue([marker as any]);
    mockHappyProcessesForDiscovery([
      markedProcess,
      markerlessProcess,
    ]);
    vi.mocked(adoptSessionsFromMarkers).mockImplementationOnce(({ pidToTrackedSession }) => {
      pidToTrackedSession.set(markedProcess.pid, {
        pid: markedProcess.pid,
        startedBy: 'daemon',
        happySessionId: marker.happySessionId,
        reattachedFromDiskMarker: true,
      });
      return {
        adopted: 1,
        eligible: 1,
      };
    });
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(findAllHappyProcesses).toHaveBeenCalledOnce();
    expect(pidToTrackedSession.get(markedProcess.pid)).toEqual(expect.objectContaining({
      happySessionId: marker.happySessionId,
      pid: markedProcess.pid,
    }));
    expect(pidToTrackedSession.get(markerlessProcess.pid)).toEqual(expect.objectContaining({
      happySessionId: 'session-markerless',
      pid: markerlessProcess.pid,
      reattachedFromDiskMarker: true,
    }));
    expect(writeSessionMarker).toHaveBeenCalledOnce();
    expect(writeSessionMarker).toHaveBeenCalledWith(expect.objectContaining({
      pid: markerlessProcess.pid,
      happySessionId: 'session-markerless',
      startedBy: 'daemon',
    }));
  });

  it('restores local-services bridge authorization from a live incomplete daemon marker', async () => {
    const localServicesBridgeAuthorization = {
      v: 1,
      tokenHash: `sha256:${'a'.repeat(64)}`,
      pluginId: 'acme.plugin',
      contributionId: 'acme.plugin.backend',
      tokenFilePath: '/tmp/happier-bridge-token',
    };
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 12346,
        happySessionId: 'session-bridge',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        cwd: '/tmp/project',
        localServicesBridgeAuthorization,
      } as any,
    ]);
    mockHappyProcessesForDiscovery([
      {
        pid: 12346,
        type: 'daemon-spawned-session',
        cwd: '/tmp/project',
        command:
          '/home/guest/.happier/cli-preview/current/happier opencode --happy-starting-mode remote --started-by daemon --existing-session session-bridge',
      } as any,
    ]);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.get(12346)).toEqual(
      expect.objectContaining({
        startedBy: 'daemon',
        happySessionId: 'session-bridge',
        localServicesBridgeTokenHash: `sha256:${'a'.repeat(64)}`,
        localServicesBridgePluginId: 'acme.plugin',
        localServicesBridgeContributionId: 'acme.plugin.backend',
        localServicesBridgeTokenFilePath: '/tmp/happier-bridge-token',
      }),
    );
    expect(writeSessionMarker).toHaveBeenCalledWith(expect.objectContaining({
      pid: 12346,
      happySessionId: 'session-bridge',
      localServicesBridgeAuthorization,
    }));
  });

  it('recovers a daemon session from a non-adopted hashed marker when takeover adoption returns zero', async () => {
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 23456,
        happySessionId: 'session-hash-fallback',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        cwd: '/tmp/project',
        processCommandHash: 'a'.repeat(64),
        respawn: {
          version: 1,
          directory: '/tmp/project',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        },
      } as any,
    ]);
    mockHappyProcessesForDiscovery([
      {
        pid: 23456,
        type: 'daemon-spawned-session',
        cwd: '/tmp/project',
        command:
          '/home/guest/.happier/cli-preview/current/happier claude --happy-starting-mode remote --started-by daemon --existing-session session-hash-fallback',
      } as any,
    ]);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.get(23456)).toEqual(
      expect.objectContaining({
        startedBy: 'daemon',
        happySessionId: 'session-hash-fallback',
        pid: 23456,
        reattachedFromDiskMarker: true,
      }),
    );
    expect(writeSessionMarker).toHaveBeenCalledWith(
      expect.objectContaining({
        pid: 23456,
        happySessionId: 'session-hash-fallback',
        startedBy: 'daemon',
      }),
    );
  });

  it('recovers a live daemon-spawned process from its marker when the live command lacks --existing-session', async () => {
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 12345,
        happySessionId: 'session-123',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        cwd: '/tmp/project',
      } as any,
    ]);
    mockHappyProcessesForDiscovery([
      {
        pid: 12345,
        type: 'daemon-spawned-session',
        command:
          'C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\package-dist\\index.mjs opencode --happy-starting-mode remote --started-by daemon',
      } as any,
    ]);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.get(12345)).toEqual(
      expect.objectContaining({
        startedBy: 'daemon',
        happySessionId: 'session-123',
        pid: 12345,
        spawnOptions: {
          directory: '/tmp/project',
          backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
        },
        reattachedFromDiskMarker: true,
        processCommand:
          'C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\package-dist\\index.mjs opencode --happy-starting-mode remote --started-by daemon',
        processCommandHash:
          'hash:C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\package-dist\\index.mjs opencode --happy-starting-mode remote --started-by daemon',
      }),
    );
    expect(writeSessionMarker).toHaveBeenCalledWith({
      pid: 12345,
      happySessionId: 'session-123',
      startedBy: 'daemon',
      cwd: '/tmp/project',
      processCommandHash:
        'hash:C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\package-dist\\index.mjs opencode --happy-starting-mode remote --started-by daemon',
      processCommand:
        'C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\package-dist\\index.mjs opencode --happy-starting-mode remote --started-by daemon',
      respawn: {
        version: 1,
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
      },
    });
  });

  it('recovers a live daemon marker from marker respawn data when the live process proves the session identity', async () => {
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 12345,
        happySessionId: 'session-123',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        cwd: '/tmp/project',
        respawn: {
          version: 1,
          directory: '/tmp/project',
          vendorResumeId: 'remote-runtime-learned-123',
          terminal: {
            mode: 'zellij',
          },
          backendTarget: {
            kind: 'builtInAgent',
            agentId: 'opencode',
          },
        },
      } as any,
    ]);
    mockHappyProcessesForDiscovery([
      {
        pid: 12345,
        type: 'user-session',
        command:
          'C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\package-dist\\index.mjs opencode --happy-starting-mode remote --started-by daemon --existing-session session-123',
      } as any,
    ]);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.get(12345)).toEqual(
      expect.objectContaining({
        startedBy: 'daemon',
        happySessionId: 'session-123',
        pid: 12345,
        spawnOptions: {
          directory: '/tmp/project',
          backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
          terminal: {
            mode: 'zellij',
          },
          approvedNewDirectoryCreation: true,
        },
        vendorResumeId: 'remote-runtime-learned-123',
        reattachedFromDiskMarker: true,
        processCommand:
          'C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\package-dist\\index.mjs opencode --happy-starting-mode remote --started-by daemon --existing-session session-123',
        processCommandHash:
          'hash:C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\package-dist\\index.mjs opencode --happy-starting-mode remote --started-by daemon --existing-session session-123',
      }),
    );
    expect(writeSessionMarker).toHaveBeenCalledWith({
      pid: 12345,
      happySessionId: 'session-123',
      startedBy: 'daemon',
      cwd: '/tmp/project',
      processCommandHash:
        'hash:C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\package-dist\\index.mjs opencode --happy-starting-mode remote --started-by daemon --existing-session session-123',
      processCommand:
        'C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\package-dist\\index.mjs opencode --happy-starting-mode remote --started-by daemon --existing-session session-123',
      respawn: {
        version: 1,
        directory: '/tmp/project',
        vendorResumeId: 'remote-runtime-learned-123',
        backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
        terminal: {
          mode: 'zellij',
        },
      },
    });
  });

  it('reattaches accepted pre-webhook placeholder custody with its spawn nonce after daemon restart', async () => {
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 12346,
        happySessionId: 'PID-12346',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        cwd: '/tmp/project',
        respawn: {
          version: 1,
          directory: '/tmp/project',
          backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
          spawnNonce: 'nonce-pre-webhook-restart',
        },
      } as any,
    ]);
    mockHappyProcessesForDiscovery([
      {
        pid: 12346,
        type: 'daemon-spawned-session',
        cwd: '/tmp/project',
        command: '/tmp/happier opencode --happy-starting-mode remote --started-by daemon',
      },
    ]);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.get(12346)).toEqual(expect.objectContaining({
      startedBy: 'daemon',
      happySessionId: 'PID-12346',
      pid: 12346,
      reattachedFromDiskMarker: true,
      spawnOptions: expect.objectContaining({
        directory: '/tmp/project',
        spawnNonce: 'nonce-pre-webhook-restart',
      }),
    }));
    expect(writeSessionMarker).toHaveBeenCalledWith(expect.objectContaining({
      pid: 12346,
      happySessionId: 'PID-12346',
      startedBy: 'daemon',
      respawn: expect.objectContaining({
        spawnNonce: 'nonce-pre-webhook-restart',
      }),
    }));
  });

  it('refuses marker recovery when newer metadata would downgrade Provider V2 continuity to native', async () => {
    const providerBindingMetadataV1 = {
      v: 1,
      connectionId: 'pc_gateway',
      contributionKey: 'plugin.gateway/gateway',
      connectionRevision: 2,
      protocol: 'openai-responses',
      materialization: 'engineConfig',
      adapterBindingKey: 'gateway',
      compatibilityFingerprint: 'compatibility-v1',
      bindingSecurityFingerprint: 'security-v1',
      displaySnapshot: {
        providerName: 'Gateway',
        connectionName: 'Work',
        connectionRole: 'named',
        connectionDisplayNameMode: 'custom',
      },
    };
    vi.mocked(listSessionMarkers).mockResolvedValue([{
      pid: 12346,
      happySessionId: 'session-provider-v2',
      happyHomeDir: '/tmp/happy',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon',
      cwd: '/tmp/project',
      metadata: {
        modelSelectionIntentV1: {
          v: 1,
          updatedAt: 10,
          selection: {
            agentTargetKey: 'backend:codex',
            providerConnectionId: null,
            modelId: 'native-newer',
          },
        },
      },
      respawn: {
        version: 2,
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        modelSelection: {
          v: 1,
          updatedAt: 9,
          ref: {
            agentTargetKey: 'backend:codex',
            providerConnectionId: 'pc_gateway',
            modelId: 'provider-model',
          },
        },
        providerBindingMetadataV1,
      },
    } as never]);
    mockHappyProcessesForDiscovery([{
      pid: 12346,
      type: 'user-session',
      cwd: '/tmp/project',
      command: 'happier codex --happy-starting-mode remote --started-by daemon --existing-session session-provider-v2',
    }]);
    vi.spyOn(process, 'kill').mockImplementation(() => true as never);
    const pidToTrackedSession = new Map<number, never>();

    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.size).toBe(0);
    expect(writeSessionMarker).not.toHaveBeenCalled();
  });

  it('refuses incomplete-marker recovery when Provider continuity is carried by a V1 marker', async () => {
    const providerBindingMetadataV1 = {
      v: 1,
      connectionId: 'pc_gateway',
      contributionKey: 'plugin.gateway/gateway',
      connectionRevision: 2,
      protocol: 'openai-responses',
      materialization: 'engineConfig',
      adapterBindingKey: 'gateway',
      compatibilityFingerprint: 'compatibility-v1',
      bindingSecurityFingerprint: 'security-v1',
      displaySnapshot: {
        providerName: 'Gateway',
        connectionName: 'Work',
        connectionRole: 'named',
        connectionDisplayNameMode: 'custom',
      },
    };
    vi.mocked(listSessionMarkers).mockResolvedValue([{
      pid: 12347,
      happySessionId: 'session-provider-v1-downgrade',
      happyHomeDir: '/tmp/happy',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon',
      cwd: '/tmp/project',
      metadata: {
        providerBindingV1: providerBindingMetadataV1,
        modelSelectionIntentV1: {
          v: 1,
          updatedAt: 10,
          selection: {
            agentTargetKey: 'backend:codex',
            providerConnectionId: 'pc_gateway',
            modelId: 'provider-model',
          },
        },
      },
      respawn: {
        version: 1,
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      },
    } as never]);
    mockHappyProcessesForDiscovery([{
      pid: 12347,
      type: 'user-session',
      cwd: '/tmp/project',
      command: 'happier codex --happy-starting-mode remote --started-by daemon --existing-session session-provider-v1-downgrade',
    }]);
    vi.spyOn(process, 'kill').mockImplementation(() => true as never);
    const pidToTrackedSession = new Map<number, never>();

    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.size).toBe(0);
    expect(writeSessionMarker).not.toHaveBeenCalled();
  });

  it('does not recover a weak incomplete marker when the live process only classifies as a generic happy user session', async () => {
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 12345,
        happySessionId: 'session-123',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        cwd: '/tmp/project',
        respawn: {
          version: 1,
          directory: '/tmp/project',
          backendTarget: {
            kind: 'backend',
            backendId: 'opencode',
            sourceKind: 'built_in',
          },
        },
      } as any,
    ]);
    mockHappyProcessesForDiscovery([
      {
        pid: 12345,
        type: 'user-session',
        command: 'C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe',
      } as any,
    ]);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.size).toBe(0);
    expect(writeSessionMarker).not.toHaveBeenCalled();
  });

  it('recovers a generic happy user session only when the live command proves the session identity and preserves encrypted respawn env', async () => {
    const credentials: Credentials = {
      token: 't',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const command =
      'C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\package-dist\\index.mjs opencode --happy-starting-mode remote --started-by daemon --existing-session session-123';
    const processStartTimeMs = 1_717_171_717_123;
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 12345,
        happySessionId: 'session-123',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        cwd: '/tmp/project',
        processCommandHash: `hash:${command}`,
        processStartTimeMs,
        processCommand: command,
        respawn: {
          version: 1,
          directory: '/tmp/project',
          backendTarget: {
            kind: 'builtInAgent',
            agentId: 'opencode',
          },
          sealedEnvironmentVariables: {
            format: 'account_scoped_v1',
            ciphertext: sealHistoricalSessionRespawnEnvironmentAliasFixtureCiphertext({
              material: credentials.encryption,
              payload: {
                CODEX_HOME: '/tmp/codex-home',
                OPENAI_API_KEY: 'sk-test',
              },
              randomBytes: (length) => new Uint8Array(length).fill(4),
            }),
          },
        },
      } as any,
    ]);
    mockHappyProcessesForDiscovery([
      {
        pid: 12345,
        type: 'user-session',
        command,
      } as any,
    ]);
    const actualReattach =
      await vi.importActual<typeof import('../reattach')>(
        '../reattach',
      );
    vi.mocked(adoptSessionsFromMarkers).mockImplementationOnce(
      actualReattach.adoptSessionsFromMarkers,
    );
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>();
    await reattachTrackedSessionsFromMarkers({
      pidToTrackedSession,
      credentials,
      readProcessIdentityByPidFn: vi.fn(async () => ({
        pid: 12345,
        ppid: 1,
        processStartTimeMs,
        command,
        executablePath:
          'C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe',
      })),
    });

    expect(pidToTrackedSession.get(12345)).toEqual(
      expect.objectContaining({
        startedBy: 'daemon',
        happySessionId: 'session-123',
        pid: 12345,
        spawnOptions: {
          directory: '/tmp/project',
          backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
          environmentVariables: {
            CODEX_HOME: '/tmp/codex-home',
            OPENAI_API_KEY: 'sk-test',
          },
          approvedNewDirectoryCreation: true,
        },
        reattachedFromDiskMarker: true,
        processCommand: command,
        processCommandHash: `hash:${command}`,
      }),
    );
    expect(writeSessionMarker).not.toHaveBeenCalled();
    expect(
      rewriteSessionMarkerRespawnEnvironmentCiphertextIfOwned,
    ).toHaveBeenCalledOnce();
    const rewriteRequest = vi.mocked(
      rewriteSessionMarkerRespawnEnvironmentCiphertextIfOwned,
    ).mock.calls[0]?.[0];
    expect(rewriteRequest).toMatchObject({
      pid: 12345,
      ownership: {
        happySessionId: 'session-123',
        processCommandHash: `hash:${command}`,
        processStartTimeMs,
      },
      expectedCiphertext: expect.any(String),
      replacementCiphertext: expect.any(String),
    });
    expect(
      readAccountScopedCiphertextKindByte(
        rewriteRequest?.replacementCiphertext ?? '',
      ),
    ).toBe(5);
  });

  it('continues startup restart-intent reconciliation when an exact adopted respawn alias rewrite fails', async () => {
    const credentials: Credentials = {
      token: 't',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array(32).fill(9),
      },
    };
    const command =
      'happier opencode --happy-starting-mode remote --started-by daemon --existing-session session-rewrite-failure';
    const processStartTimeMs = 1_717_171_717_124;
    const marker = {
      pid: 12347,
      happySessionId: 'session-rewrite-failure',
      happyHomeDir: '/tmp/happy',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon',
      cwd: '/tmp/project',
      processCommandHash: `hash:${command}`,
      processStartTimeMs,
      processCommand: command,
      connectedServiceRestartIntent: {
        v: 1,
        requestedAtMs: 1_234,
      },
      respawn: {
        version: 1,
        directory: '/tmp/project',
        backendTarget: {
          kind: 'builtInAgent',
          agentId: 'opencode',
        },
        sealedEnvironmentVariables: {
          format: 'account_scoped_v1',
          ciphertext:
            sealHistoricalSessionRespawnEnvironmentAliasFixtureCiphertext({
              material: credentials.encryption,
              payload: {
                OPENAI_API_KEY: 'must-remain-sealed',
              },
              randomBytes: (length) =>
                new Uint8Array(length).fill(4),
            }),
        },
      },
    };
    vi.mocked(listSessionMarkers).mockResolvedValue([
      marker as any,
    ]);
    mockHappyProcessesForDiscovery([{
      pid: marker.pid,
      type: 'user-session',
      command,
    }]);
    const actualReattach =
      await vi.importActual<typeof import('../reattach')>(
        '../reattach',
      );
    vi.mocked(adoptSessionsFromMarkers).mockImplementationOnce(
      actualReattach.adoptSessionsFromMarkers,
    );
    vi.mocked(
      rewriteSessionMarkerRespawnEnvironmentCiphertextIfOwned,
    ).mockRejectedValueOnce(
      new Error('marker rewrite failed'),
    );
    vi.spyOn(process, 'kill').mockImplementation(
      () => true as never,
    );

    const pidToTrackedSession = new Map<number, any>();
    await expect(
      reattachTrackedSessionsFromMarkers({
        pidToTrackedSession,
        credentials,
        readProcessIdentityByPidFn: vi.fn(async () => ({
          pid: marker.pid,
          ppid: 1,
          processStartTimeMs,
          command,
          executablePath: '/tmp/happier',
        })),
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        connectedServiceRestartIntents: [],
      }),
    );

    expect(pidToTrackedSession.has(marker.pid)).toBe(
      true,
    );
    expect(
      rewriteSessionMarkerRespawnEnvironmentCiphertextIfOwned,
    ).toHaveBeenCalledOnce();
    expect(
      clearSessionMarkerConnectedServiceRestartIntent,
    ).toHaveBeenCalledWith(marker.pid);
  });

  it('does not rewrite a respawn alias when the live PID has a different process birth identity', async () => {
    const credentials: Credentials = {
      token: 't',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array(32).fill(9),
      },
    };
    const command =
      'happier opencode --happy-starting-mode remote --started-by daemon --existing-session session-birth-mismatch';
    const aliasCiphertext =
      sealHistoricalSessionRespawnEnvironmentAliasFixtureCiphertext({
        material: credentials.encryption,
        payload: {
          OPENAI_API_KEY: 'must-remain-sealed',
        },
        randomBytes: (length) =>
          new Uint8Array(length).fill(4),
      });
    vi.mocked(listSessionMarkers).mockResolvedValue([{
      pid: 12346,
      happySessionId: 'session-birth-mismatch',
      happyHomeDir: '/tmp/happy',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon',
      cwd: '/tmp/project',
      processCommandHash: `hash:${command}`,
      processStartTimeMs: 1_000,
      processCommand: command,
      respawn: {
        version: 1,
        directory: '/tmp/project',
        backendTarget: {
          kind: 'builtInAgent',
          agentId: 'opencode',
        },
        sealedEnvironmentVariables: {
          format: 'account_scoped_v1',
          ciphertext: aliasCiphertext,
        },
      },
    } as any]);
    mockHappyProcessesForDiscovery([{
      pid: 12346,
      type: 'user-session',
      cwd: '/tmp/project',
      command,
    }]);
    vi.spyOn(process, 'kill').mockImplementation(
      () => true as never,
    );

    const pidToTrackedSession = new Map<number, any>();
    await reattachTrackedSessionsFromMarkers({
      pidToTrackedSession,
      credentials,
      readProcessIdentityByPidFn: vi.fn(async () => ({
        pid: 12346,
        ppid: 1,
        processStartTimeMs: 1_001,
        command,
        executablePath: '/tmp/happier',
      })),
    });

    expect(pidToTrackedSession.has(12346)).toBe(true);
    const preservedRespawn =
      vi.mocked(writeSessionMarker).mock.calls[0]?.[0].respawn;
    expect(
      preservedRespawn?.sealedEnvironmentVariables?.ciphertext,
    ).toBe(aliasCiphertext);
    expect(
      readAccountScopedCiphertextKindByte(
        preservedRespawn?.sealedEnvironmentVariables
          ?.ciphertext ?? '',
      ),
    ).toBe(6);
    expect(
      rewriteSessionMarkerRespawnEnvironmentCiphertextIfOwned,
    ).not.toHaveBeenCalled();
  });

  it('does not recover a live daemon-spawned process when a live marker failed marker adoption safety checks', async () => {
    const command = `${process.execPath} -e "setInterval(()=>{}, 1000)"`;

    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 54322,
        happySessionId: 'session-123',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        processCommandHash: 'hash:/some/other/process',
      } as any,
    ]);
    mockHappyProcessesForDiscovery([
      { pid: 54322, command, type: 'daemon-spawned-session' } as any,
    ]);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>();
    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(result).toEqual({ orphanedDeadDaemonSessions: [], connectedServiceRestartIntents: [] });
    expect(pidToTrackedSession.size).toBe(0);
    expect(writeSessionMarker).not.toHaveBeenCalled();
  });

  it('does not recover a markerless daemon-spawned session when the live command belongs to a different cli runtime root', async () => {
    isOwnedLiveDaemonSessionProcessCommandMock.mockReturnValue(false);
    vi.mocked(listSessionMarkers).mockResolvedValue([]);
    mockHappyProcessesForDiscovery([
      {
        pid: 54321,
        type: 'daemon-spawned-session',
        cwd: '/tmp/project',
        command:
          '/Users/other/happier/remote-dev/apps/cli/src/index.ts opencode --happy-starting-mode remote --started-by daemon --resume vendor-1 --existing-session session-123',
      } as any,
    ]);

    const pidToTrackedSession = new Map<number, any>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.size).toBe(0);
    expect(writeSessionMarker).not.toHaveBeenCalled();
  });

  it('recovers incomplete daemon markers during cli-update takeover even when the live command belongs to a different runtime root', async () => {
    isOwnedLiveDaemonSessionProcessCommandMock.mockReturnValue(false);
    const credentials: Credentials = {
      token: 't',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array(32).fill(9),
      },
    };
    const aliasCiphertext =
      sealHistoricalSessionRespawnEnvironmentAliasFixtureCiphertext({
        material: credentials.encryption,
        payload: {
          OPENAI_API_KEY: 'must-remain-sealed',
        },
        randomBytes: (length) =>
          new Uint8Array(length).fill(4),
      });
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 54321,
        happySessionId: 'session-123',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        cwd: '/tmp/project',
        respawn: {
          version: 1,
          directory: '/tmp/project',
          backendTarget: {
            kind: 'builtInAgent',
            agentId: 'claude',
          },
          sealedEnvironmentVariables: {
            format: 'account_scoped_v1',
            ciphertext: aliasCiphertext,
          },
        },
      } as any,
    ]);
    mockHappyProcessesForDiscovery([
      {
        pid: 54321,
        type: 'daemon-spawned-session',
        cwd: '/tmp/project',
        command:
          '/Users/other/happier/cli-preview/current/package-dist/index.mjs claude --happy-starting-mode remote --started-by daemon',
      } as any,
    ]);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>();
    await reattachTrackedSessionsFromMarkers({
      pidToTrackedSession,
      credentials,
    });

    expect(pidToTrackedSession.get(54321)).toEqual(
      expect.objectContaining({
        startedBy: 'daemon',
        happySessionId: 'session-123',
        pid: 54321,
        reattachedFromDiskMarker: true,
      }),
    );
    expect(writeSessionMarker).toHaveBeenCalledWith(
      expect.objectContaining({
        pid: 54321,
        happySessionId: 'session-123',
        startedBy: 'daemon',
      }),
    );
    const preservedRespawn =
      vi.mocked(writeSessionMarker).mock.calls[0]?.[0].respawn;
    expect(
      preservedRespawn?.sealedEnvironmentVariables?.ciphertext,
    ).toBe(aliasCiphertext);
    expect(
      readAccountScopedCiphertextKindByte(
        preservedRespawn?.sealedEnvironmentVariables
          ?.ciphertext ?? '',
      ),
    ).toBe(6);
    expect(
      rewriteSessionMarkerRespawnEnvironmentCiphertextIfOwned,
    ).not.toHaveBeenCalled();
  });

  it('recovers incomplete daemon markers during takeover when the live command degrades to a bare runtime command', async () => {
    isOwnedLiveDaemonSessionProcessCommandMock.mockReturnValue(false);
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 76543,
        happySessionId: 'session-789',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        cwd: '/tmp/project',
        respawn: {
          version: 1,
          directory: '/tmp/project',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        },
      } as any,
    ]);
    mockHappyProcessesForDiscovery([
      {
        pid: 76543,
        type: 'user-session',
        cwd: '/tmp/project',
        command: 'node',
      } as any,
    ]);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.get(76543)).toEqual(
      expect.objectContaining({
        startedBy: 'daemon',
        happySessionId: 'session-789',
        pid: 76543,
        reattachedFromDiskMarker: true,
      }),
    );
  });

  it('recovers incomplete daemon markers when process classification falls back to user-session but command still declares --started-by daemon', async () => {
    isOwnedLiveDaemonSessionProcessCommandMock.mockReturnValue(false);
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 65432,
        happySessionId: 'session-456',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        cwd: '/tmp/project',
      } as any,
    ]);
    mockHappyProcessesForDiscovery([
      {
        pid: 65432,
        type: 'user-session',
        cwd: '/tmp/project',
        command:
          'node "/Users/other/happier/cli-preview/current/package-dist/index.mjs" claude "--happy-starting-mode" "remote" "--started-by" "daemon"',
      } as any,
    ]);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.get(65432)).toEqual(
      expect.objectContaining({
        startedBy: 'daemon',
        happySessionId: 'session-456',
        pid: 65432,
        reattachedFromDiskMarker: true,
      }),
    );
  });
});
