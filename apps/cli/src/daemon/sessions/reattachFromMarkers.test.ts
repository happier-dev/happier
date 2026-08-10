import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { reattachTrackedSessionsFromMarkers } from './reattachFromMarkers';
import { findAllHappyProcesses, findHappyProcessByPid } from '../doctor';
import { adoptSessionsFromMarkers } from '../reattach';
import {
  clearSessionMarkerConnectedServiceRestartIntent,
  hashProcessCommand,
  listSessionMarkers,
  removeSessionMarker,
  writeSessionMarker,
  type DaemonSessionMarker,
} from '../sessionRegistry';
import type { HappyProcessInfo } from '../doctor';
import type { TrackedSession } from '../types';
import type { Credentials } from '@/persistence';
import type { TerminalHostAdapter, TerminalHostHandle } from '@/integrations/terminalHost/_types';
import {
  removeTerminalAttachmentInfo,
  type TerminalAttachmentInfo,
  type TerminalAttachmentReadState,
} from '@/terminal/attachment/terminalAttachmentInfo';

const emptyAdoptResult = {
  adopted: 0,
  eligible: 0,
  adoptedPids: [],
  respawnRestoreErrors: [],
} satisfies ReturnType<typeof adoptSessionsFromMarkers>;

function mockHappyProcessesForDiscovery(processes: ReadonlyArray<HappyProcessInfo>): void {
  vi.mocked(findAllHappyProcesses).mockResolvedValue([...processes]);
  vi.mocked(findHappyProcessByPid).mockImplementation(async (pid) => processes.find((processInfo) => processInfo.pid === pid) ?? null);
}

type TestConnectedServiceRestartIntentMarker = DaemonSessionMarker & Readonly<{
  connectedServiceRestartIntent: Readonly<{
    v: 1;
    requestedAtMs: number;
  }>;
}>;

const { isOwnedLiveDaemonSessionProcessCommandMock } = vi.hoisted(() => ({
  isOwnedLiveDaemonSessionProcessCommandMock: vi.fn(() => true),
}));
const terminalAttachmentInfoMock = vi.hoisted(() => ({
  readTerminalAttachmentInfo: vi.fn<(_: {
    happyHomeDir: string;
    sessionId: string;
  }) => Promise<TerminalAttachmentInfo | null>>(async () => null),
  readTerminalAttachmentState: vi.fn<(_: {
    happyHomeDir: string;
    sessionId: string;
  }) => Promise<TerminalAttachmentReadState>>(async () => ({ status: 'absent' })),
}));

function mockTerminalAttachmentState(state: TerminalAttachmentReadState): void {
  terminalAttachmentInfoMock.readTerminalAttachmentState.mockResolvedValue(state);
  terminalAttachmentInfoMock.readTerminalAttachmentInfo.mockResolvedValue(
    state.status === 'present' ? state.info : null,
  );
}

vi.mock('../doctor', () => ({
  findAllHappyProcesses: vi.fn(async () => []),
  findHappyProcessByPid: vi.fn(async () => null),
}));

vi.mock('../reattach', () => ({
  adoptSessionsFromMarkers: vi.fn(() => emptyAdoptResult),
  isOwnedLiveDaemonSessionProcessCommand: isOwnedLiveDaemonSessionProcessCommandMock,
}));

vi.mock('../sessionRegistry', () => ({
  clearSessionMarkerConnectedServiceRestartIntent: vi.fn(async () => {}),
  listSessionMarkers: vi.fn(async () => []),
  removeSessionMarker: vi.fn(async () => {}),
  writeSessionMarker: vi.fn(async () => {}),
  hashProcessCommand: vi.fn((command: string) => `hash:${command}`),
}));

vi.mock('@/terminal/attachment/terminalAttachmentInfo', () => ({
  readTerminalAttachmentInfo: terminalAttachmentInfoMock.readTerminalAttachmentInfo,
  readTerminalAttachmentState: terminalAttachmentInfoMock.readTerminalAttachmentState,
  removeTerminalAttachmentInfo: vi.fn(async () => true),
}));

describe('reattachTrackedSessionsFromMarkers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.HAPPIER_DAEMON_MARKERLESS_REATTACH_ENABLED;
    isOwnedLiveDaemonSessionProcessCommandMock.mockReturnValue(true);
    mockTerminalAttachmentState({ status: 'absent' });
  });

  it('returns exact-turn orphan evidence without removing the replayable marker', async () => {
    const marker = {
      pid: 43210,
      happySessionId: 'session-123',
      happyHomeDir: '/tmp/happy',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon' as const,
      cwd: '/tmp/project',
      processCommandHash: 'a'.repeat(64),
      activeTurnId: 'turn-exact-123',
    };

    vi.mocked(listSessionMarkers).mockResolvedValue([marker satisfies DaemonSessionMarker]);
    mockHappyProcessesForDiscovery([]);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });

    const pidToTrackedSession = new Map<number, TrackedSession>();
    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(result).toEqual({
      orphanedDeadDaemonSessions: [
        {
          sessionId: 'session-123',
          pid: 43210,
          activeTurnId: 'turn-exact-123',
        },
      ],
      connectedServiceRestartIntents: [],
    });
    expect(removeSessionMarker).not.toHaveBeenCalledWith(43210);
    expect(adoptSessionsFromMarkers).toHaveBeenCalledWith({
      markers: [],
      happyProcesses: [],
      pidToTrackedSession,
    });
  });

  it('keeps cold-start reconstruction passive across many dead terminal markers', async () => {
    const markers = Array.from({ length: 83 }, (_, index) => ({
      pid: 50_000 + index,
      happySessionId: `session-dead-${index}`,
      happyHomeDir: '/tmp/happy',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon' as const,
      cwd: '/workspace/project',
      respawn: {
        version: 1 as const,
        directory: '/workspace/project',
        backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' },
        resume: `claude-thread-${index}`,
      },
    })) satisfies DaemonSessionMarker[];
    const evaluateLiveness = vi.fn(async () => ({ paneAlive: true, observedAt: 1 }));
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(),
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness,
      dispose: vi.fn(),
    };

    vi.mocked(listSessionMarkers).mockResolvedValue(markers);
    mockTerminalAttachmentState({ status: 'present', info: {
      version: 1,
      sessionId: 'ignored-on-passive-startup',
      terminal: {
        mode: 'zellij',
        zellij: { sessionName: 'legacy-host', paneId: 'terminal_1' },
      },
      updatedAt: 1,
    } });
    mockHappyProcessesForDiscovery([]);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });

    const result = await reattachTrackedSessionsFromMarkers({
      pidToTrackedSession: new Map<number, TrackedSession>(),
      terminalHostAdapters: { zellij: adapter },
    });

    // Cold reconstruction may read immutable local attachment descriptors, but it must not
    // probe or mutate any host until the connected supervision owner runs.
    expect(evaluateLiveness).not.toHaveBeenCalled();
    expect(adapter.dispose).not.toHaveBeenCalled();
    expect(result.orphanedDeadDaemonSessions).toHaveLength(0);
    expect(result.unresolvedTerminalHostSessionIds).toHaveLength(83);
    expect(removeSessionMarker).not.toHaveBeenCalled();
  });

  it('preserves a disconnected session when its bound provider host is still alive', async () => {
    const marker = {
      pid: 43214,
      happySessionId: 'session-live-terminal-dead-runner',
      happyHomeDir: '/tmp/happy',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon' as const,
      activeTurnId: 'turn-live-terminal-dead-runner',
      cwd: '/workspace/project',
      respawn: {
        version: 1,
        directory: '/workspace/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        resume: 'claude-live-terminal-thread',
      },
    } satisfies DaemonSessionMarker;
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-session-live-terminal-dead-runner',
      paneId: 'claude.1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async () => ({ status: 'injected', at: 1, bytesWritten: 1 } as const)),
      interruptTurn: vi.fn(async () => {}),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      dispose: vi.fn(async () => {}),
    };
    vi.mocked(listSessionMarkers).mockResolvedValue([marker]);
    mockTerminalAttachmentState({ status: 'present', info: {
      version: 2,
      attachmentId: 'attachment-live-provider-host' as NonNullable<TerminalHostHandle['attachmentId']>,
      sessionId: 'session-live-terminal-dead-runner',
      handle: {
        ...handle,
        attachmentId: 'attachment-live-provider-host' as NonNullable<TerminalHostHandle['attachmentId']>,
      },
      terminal: {
        mode: 'tmux',
        tmux: {
          target: 'happier-session-live-terminal-dead-runner:claude.1',
        },
      },
      updatedAt: 1,
    } });
    mockHappyProcessesForDiscovery([]);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });

    const pidToTrackedSession = new Map<number, TrackedSession>();
    const result = await reattachTrackedSessionsFromMarkers({
      pidToTrackedSession,
      terminalHostAdapters: { tmux: adapter },
      hasTerminalAttachmentControlDescriptor: async () => true,
    });

    expect(adapter.evaluateLiveness).not.toHaveBeenCalled();
    expect(result).toEqual({
      orphanedDeadDaemonSessions: [],
      disconnectedTerminalHostCandidates: [expect.objectContaining({
        sessionId: 'session-live-terminal-dead-runner',
        pid: 43214,
        attachmentId: 'attachment-live-provider-host',
        activeTurnId: 'turn-live-terminal-dead-runner',
      })],
      connectedServiceRestartIntents: [],
    });
    expect(removeSessionMarker).not.toHaveBeenCalledWith(43214);
  });

  it('does not treat a stale session descriptor as control proof for a successor attachment', async () => {
    const marker = {
      pid: 43216,
      happySessionId: 'session-stale-provider-descriptor',
      happyHomeDir: '/tmp/happy',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon' as const,
      cwd: '/workspace/project',
      flavor: 'claude' as const,
      respawn: {
        version: 1,
        directory: '/workspace/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        resume: 'claude-stale-provider-descriptor',
      },
    } satisfies DaemonSessionMarker;
    const attachmentId = 'attachment-successor-without-control' as NonNullable<TerminalHostHandle['attachmentId']>;
    vi.mocked(listSessionMarkers).mockResolvedValue([marker]);
    mockTerminalAttachmentState({ status: 'present', info: {
      version: 2,
      attachmentId,
      sessionId: marker.happySessionId,
      handle: {
        attachmentId,
        kind: 'tmux',
        sessionName: 'successor-host',
        paneId: 'successor.1',
        attachMetadata: {
          attachStrategy: 'terminal_host',
          topology: 'shared',
          locality: 'same_machine',
          liveProbe: 'required',
        },
      },
      terminal: { mode: 'tmux', tmux: { target: 'successor-host:successor.1' } },
      updatedAt: 2,
    } });
    mockHappyProcessesForDiscovery([]);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });
    const hasTerminalAttachmentControlDescriptor = vi.fn(async () => false);

    const result = await reattachTrackedSessionsFromMarkers({
      pidToTrackedSession: new Map<number, TrackedSession>(),
      terminalHostAdapters: {},
      hasTerminalAttachmentControlDescriptor,
    });

    expect(hasTerminalAttachmentControlDescriptor).toHaveBeenCalledOnce();
    expect(hasTerminalAttachmentControlDescriptor).toHaveBeenCalledWith('claude', {
      happyHomeDir: marker.happyHomeDir,
      sessionId: marker.happySessionId,
      attachmentId,
    });
    expect(result.disconnectedTerminalHostCandidates ?? []).toEqual([
      expect.objectContaining({
        sessionId: marker.happySessionId,
        pid: marker.pid,
        attachmentId,
        controlDescriptorAvailable: false,
      }),
    ]);
    expect(result.orphanedDeadDaemonSessions).toEqual([]);
    expect(removeSessionMarker).not.toHaveBeenCalledWith(marker.pid);
  });

  it('does not probe or destroy a dead legacy terminal attachment during startup reconstruction', async () => {
    const marker = {
      pid: 43215,
      happySessionId: 'session-dead-terminal-dead-runner',
      happyHomeDir: '/tmp/happy',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon' as const,
      cwd: '/workspace/project',
      respawn: {
        version: 1,
        directory: '/workspace/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        resume: 'claude-dead-terminal-thread',
      },
    } satisfies DaemonSessionMarker;
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(),
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: false, paneDead: true, observedAt: 1 })),
      dispose: vi.fn(async () => {}),
    };

    vi.mocked(listSessionMarkers).mockResolvedValue([marker]);
    mockTerminalAttachmentState({ status: 'present', info: {
      version: 1,
      sessionId: 'session-dead-terminal-dead-runner',
      terminal: {
        mode: 'tmux',
        tmux: {
          target: 'happier-session-dead-terminal-dead-runner:claude.1',
        },
      },
      updatedAt: 1,
    } });
    mockHappyProcessesForDiscovery([]);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });

    const result = await reattachTrackedSessionsFromMarkers({
      pidToTrackedSession: new Map<number, TrackedSession>(),
      terminalHostAdapters: { tmux: adapter },
    });

    expect(result.orphanedDeadDaemonSessions).toEqual([]);
    expect(result.unresolvedTerminalHostSessionIds).toEqual(['session-dead-terminal-dead-runner']);
    expect(adapter.evaluateLiveness).not.toHaveBeenCalled();
    expect(adapter.dispose).not.toHaveBeenCalled();
    expect(removeTerminalAttachmentInfo).not.toHaveBeenCalled();
    expect(removeSessionMarker).not.toHaveBeenCalledWith(43215);
  });

  it('preserves a dead-runner marker when terminal attachment state is unreadable', async () => {
    const marker = {
      pid: 43217,
      happySessionId: 'session-unreadable-terminal-topology',
      happyHomeDir: '/tmp/happy',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon' as const,
      cwd: '/workspace/project',
      respawn: {
        version: 1,
        directory: '/workspace/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        resume: 'claude-unreadable-terminal-topology',
      },
    } satisfies DaemonSessionMarker;
    vi.mocked(listSessionMarkers).mockResolvedValue([marker]);
    mockTerminalAttachmentState({ status: 'unreadable', reason: 'invalid' });
    mockHappyProcessesForDiscovery([]);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });

    const result = await reattachTrackedSessionsFromMarkers({
      pidToTrackedSession: new Map<number, TrackedSession>(),
    });

    expect(result.orphanedDeadDaemonSessions).toEqual([]);
    expect(result.unresolvedTerminalHostSessionIds).toEqual([marker.happySessionId]);
    expect(removeSessionMarker).not.toHaveBeenCalledWith(marker.pid);
  });

  it('treats a dead OpenCode daemon marker as passive orphan cleanup state', async () => {
    const marker = {
      pid: 43211,
      happySessionId: 'session-opencode-dead',
      happyHomeDir: '/tmp/happy',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon' as const,
      cwd: 'C:\\Users\\alice\\repo',
      metadata: {
        flavor: 'opencode',
        opencodeSessionId: 'opencode-thread-from-marker-metadata',
      },
      respawn: {
        version: 1,
        directory: 'C:\\Users\\alice\\repo',
        backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
      },
    } satisfies DaemonSessionMarker;

    vi.mocked(listSessionMarkers).mockResolvedValue([marker]);
    mockHappyProcessesForDiscovery([]);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });

    const pidToTrackedSession = new Map<number, TrackedSession>();
    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.size).toBe(0);
    expect(result.orphanedDeadDaemonSessions).toEqual([
      {
        sessionId: 'session-opencode-dead',
        pid: 43211,
      },
    ]);
    expect(removeSessionMarker).not.toHaveBeenCalledWith(43211);
    expect(adoptSessionsFromMarkers).toHaveBeenCalledWith({
      markers: [],
      happyProcesses: [],
      pidToTrackedSession,
    });
  });

  it('dedupes duplicate dead OpenCode daemon markers as passive orphan cleanup state', async () => {
    const firstMarker = {
      pid: 43212,
      happySessionId: 'session-opencode-duplicate-dead',
      happyHomeDir: '/tmp/happy',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon' as const,
      cwd: 'C:\\Users\\alice\\repo',
      metadata: {
        flavor: 'opencode',
        opencodeSessionId: 'opencode-thread-from-first-marker',
      },
      respawn: {
        version: 1,
        directory: 'C:\\Users\\alice\\repo',
        backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
      },
    } satisfies DaemonSessionMarker;
    const secondMarker = {
      ...firstMarker,
      pid: 43213,
      updatedAt: 2,
      metadata: {
        flavor: 'opencode',
        opencodeSessionId: 'opencode-thread-from-second-marker',
      },
    } satisfies DaemonSessionMarker;

    vi.mocked(listSessionMarkers).mockResolvedValue([firstMarker, secondMarker]);
    mockHappyProcessesForDiscovery([]);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });

    const pidToTrackedSession = new Map<number, TrackedSession>();
    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(result.orphanedDeadDaemonSessions).toEqual([
      {
        sessionId: 'session-opencode-duplicate-dead',
        pid: 43213,
      },
    ]);
    expect(removeSessionMarker).not.toHaveBeenCalledWith(43212);
    expect(removeSessionMarker).not.toHaveBeenCalledWith(43213);
  });

  it('reattaches a live marker and clears a stale connected-service restart intent without replaying it', async () => {
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 24680,
        happySessionId: 'session-live-restart',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 2,
        startedBy: 'daemon',
        cwd: '/tmp/project',
        processCommandHash: 'a'.repeat(64),
        respawn: {
          version: 1,
          directory: '/tmp/project',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          resume: 'claude-live-thread',
        },
        connectedServiceRestartIntent: {
          v: 1,
          requestedAtMs: 1_000,
        },
      } satisfies TestConnectedServiceRestartIntentMarker,
    ]);
    mockHappyProcessesForDiscovery([
      {
        pid: 24680,
        type: 'daemon-spawned-session',
        cwd: '/tmp/project',
        command:
          '/home/guest/.happier/cli-preview/current/happier claude --happy-starting-mode remote --started-by daemon --resume claude-live-thread --existing-session session-live-restart',
      } satisfies HappyProcessInfo,
    ]);
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    const pidToTrackedSession = new Map<number, TrackedSession>();
    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.get(24680)).toEqual(expect.objectContaining({
      happySessionId: 'session-live-restart',
      pid: 24680,
      vendorResumeId: 'claude-live-thread',
      reattachedFromDiskMarker: true,
    }));
    expect(result.connectedServiceRestartIntents).toEqual([]);
    expect(result.recoveredLiveSessionIds).toEqual(['session-live-restart']);
    expect(clearSessionMarkerConnectedServiceRestartIntent).toHaveBeenCalledWith(24680);
    expect(removeSessionMarker).not.toHaveBeenCalledWith(24680);
  });

  it('removes a dead connected-service restart marker without returning respawn inputs', async () => {
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 24681,
        happySessionId: 'session-dead-restart',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 2,
        startedBy: 'daemon',
        cwd: '/tmp/project',
        respawn: {
          version: 1,
          directory: '/tmp/project',
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          resume: 'codex-dead-thread',
        },
        connectedServiceRestartIntent: {
          v: 1,
          requestedAtMs: 2_000,
        },
      } satisfies TestConnectedServiceRestartIntentMarker,
    ]);
    mockHappyProcessesForDiscovery([]);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });

    const pidToTrackedSession = new Map<number, TrackedSession>();
    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.size).toBe(0);
    expect(result).toEqual({
      orphanedDeadDaemonSessions: [
        {
          sessionId: 'session-dead-restart',
          pid: 24681,
        },
      ],
      connectedServiceRestartIntents: [],
    });
    expect(removeSessionMarker).not.toHaveBeenCalledWith(24681);
  });

  it('removes a dead connected-service restart marker when resume is only in marker metadata', async () => {
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 24682,
        happySessionId: 'session-dead-metadata-restart',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 2,
        startedBy: 'daemon',
        cwd: '/tmp/project',
        metadata: {
          flavor: 'codex',
          codexSessionId: 'codex-thread-from-marker-metadata',
        },
        respawn: {
          version: 1,
          directory: '/tmp/project',
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        },
        connectedServiceRestartIntent: {
          v: 1,
          requestedAtMs: 2_500,
        },
      } satisfies TestConnectedServiceRestartIntentMarker,
    ]);
    mockHappyProcessesForDiscovery([]);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });

    const pidToTrackedSession = new Map<number, TrackedSession>();
    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.size).toBe(0);
    expect(result).toEqual({
      orphanedDeadDaemonSessions: [
        {
          sessionId: 'session-dead-metadata-restart',
          pid: 24682,
        },
      ],
      connectedServiceRestartIntents: [],
    });
    expect(removeSessionMarker).not.toHaveBeenCalledWith(24682);
  });

  it('removes a dead connected-service restart marker without a vendor resume id', async () => {
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 24684,
        happySessionId: 'session-dead-existing-session-restart',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 2,
        startedBy: 'daemon',
        cwd: '/tmp/project',
        metadata: { flavor: 'codex' },
        respawn: {
          version: 1,
          directory: '/tmp/project',
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          existingSessionId: 'session-dead-existing-session-restart',
        },
        connectedServiceRestartIntent: {
          v: 1,
          requestedAtMs: 2_750,
        },
      } satisfies TestConnectedServiceRestartIntentMarker,
    ]);
    mockHappyProcessesForDiscovery([]);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });

    const pidToTrackedSession = new Map<number, TrackedSession>();
    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.size).toBe(0);
    expect(result).toEqual({
      orphanedDeadDaemonSessions: [
        {
          sessionId: 'session-dead-existing-session-restart',
          pid: 24684,
        },
      ],
      connectedServiceRestartIntents: [],
    });
    expect(removeSessionMarker).not.toHaveBeenCalledWith(24684);
  });

  it('does not convert a dead resumable terminal-injection daemon marker into startup restart inputs', async () => {
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 24683,
        happySessionId: 'session-dead-terminal-restart',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 2,
        startedBy: 'daemon',
        cwd: '/tmp/project',
        metadata: {
          flavor: 'claude',
          claudeSessionId: 'claude-thread-from-marker-metadata',
        },
        respawn: {
          version: 1,
          directory: '/tmp/project',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        },
      } satisfies DaemonSessionMarker,
    ]);
    mockHappyProcessesForDiscovery([]);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });

    const pidToTrackedSession = new Map<number, TrackedSession>();
    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.size).toBe(0);
    expect(result).toEqual({
      orphanedDeadDaemonSessions: [
        {
          sessionId: 'session-dead-terminal-restart',
          pid: 24683,
        },
      ],
      connectedServiceRestartIntents: [],
    });
    expect(removeSessionMarker).not.toHaveBeenCalledWith(24683);
  });

  it('reattaches a live resumable terminal-injection daemon marker without scheduling a startup restart', async () => {
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 24684,
        happySessionId: 'session-live-terminal-restart',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 2,
        startedBy: 'daemon',
        cwd: '/tmp/project',
        processCommandHash: 'a'.repeat(64),
        metadata: {
          flavor: 'claude',
          claudeSessionId: 'claude-live-thread-from-marker-metadata',
        },
        respawn: {
          version: 1,
          directory: '/tmp/project',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        },
      } satisfies DaemonSessionMarker,
    ]);
    mockHappyProcessesForDiscovery([
      {
        pid: 24684,
        type: 'daemon-spawned-session',
        cwd: '/tmp/project',
        command:
          '/home/guest/.happier/cli-preview/current/happier claude --happy-starting-mode remote --started-by daemon --existing-session session-live-terminal-restart',
      } satisfies HappyProcessInfo,
    ]);
    vi.mocked(adoptSessionsFromMarkers).mockImplementationOnce(({ pidToTrackedSession }) => {
      pidToTrackedSession.set(24684, {
        startedBy: 'daemon',
        happySessionId: 'session-live-terminal-restart',
        pid: 24684,
        spawnOptions: {
          directory: '/tmp/project',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          resume: 'claude-live-thread-from-marker-metadata',
          approvedNewDirectoryCreation: true,
        },
        reattachedFromDiskMarker: true,
      });
      return {
        ...emptyAdoptResult,
        adopted: 1,
        adoptedPids: [24684],
      };
    });
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    const pidToTrackedSession = new Map<number, TrackedSession>();
    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.get(24684)).toEqual(expect.objectContaining({
      happySessionId: 'session-live-terminal-restart',
      pid: 24684,
      reattachedFromDiskMarker: true,
    }));
    expect(result).toEqual({
      orphanedDeadDaemonSessions: [],
      recoveredLiveSessionIds: ['session-live-terminal-restart'],
      connectedServiceRestartIntents: [],
    });
    expect(removeSessionMarker).not.toHaveBeenCalledWith(24684);
  });

  it('recovers a markerless daemon-spawned session from the live process command and heals its marker', async () => {
    vi.mocked(listSessionMarkers).mockResolvedValue([]);
    mockHappyProcessesForDiscovery([
      {
        pid: 12345,
        type: 'daemon-spawned-session',
        cwd: '/tmp/project',
        environmentVariables: {
          CLAUDE_CONFIG_DIR: '/tmp/claude-config',
        },
        command:
          '/home/guest/.happier/cli-preview/current/happier opencode --happy-starting-mode remote --started-by daemon --resume vendor-1 --existing-session session-123',
      } as any,
    ]);
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    const pidToTrackedSession = new Map<number, TrackedSession>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(adoptSessionsFromMarkers).toHaveBeenCalledWith(
      expect.objectContaining({
        markers: [],
        happyProcesses: [
          {
            pid: 12345,
            type: 'daemon-spawned-session',
            cwd: '/tmp/project',
            environmentVariables: {
              CLAUDE_CONFIG_DIR: '/tmp/claude-config',
            },
            command:
              '/home/guest/.happier/cli-preview/current/happier opencode --happy-starting-mode remote --started-by daemon --resume vendor-1 --existing-session session-123',
          },
        ],
        pidToTrackedSession,
      }),
    );
    expect(pidToTrackedSession.get(12345)).toEqual(
      expect.objectContaining({
        startedBy: 'daemon',
        happySessionId: 'session-123',
        pid: 12345,
        vendorResumeId: 'vendor-1',
        spawnOptions: {
          directory: '/tmp/project',
          backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
          resume: 'vendor-1',
          environmentVariables: {
            CLAUDE_CONFIG_DIR: '/tmp/claude-config',
          },
        },
        reattachedFromDiskMarker: true,
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
        environmentVariables: {
          CLAUDE_CONFIG_DIR: '/tmp/claude-config',
        },
      },
    });
  });

  it('does not probe a dead-runner terminal attachment during cold startup', async () => {
    const marker = {
      pid: 43216,
      happySessionId: 'session-transient-terminal-probe',
      happyHomeDir: '/tmp/happy',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon' as const,
      cwd: '/workspace/project',
      respawn: {
        version: 1,
        directory: '/workspace/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        resume: 'claude-transient-probe-thread',
      },
    } satisfies DaemonSessionMarker;
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(),
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness: vi
        .fn()
        .mockResolvedValueOnce({ paneAlive: false, probeInconclusive: true, observedAt: 1 })
        .mockResolvedValueOnce({ paneAlive: true, observedAt: 2 }),
      dispose: vi.fn(),
    };

    vi.mocked(listSessionMarkers).mockResolvedValue([marker]);
    mockTerminalAttachmentState({ status: 'present', info: {
      version: 1,
      sessionId: 'session-transient-terminal-probe',
      terminal: {
        mode: 'tmux',
        tmux: {
          target: 'happier-session-transient-terminal-probe:claude.1',
        },
      },
      updatedAt: 1,
    } });
    mockHappyProcessesForDiscovery([]);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });

    const result = await reattachTrackedSessionsFromMarkers({
      pidToTrackedSession: new Map<number, TrackedSession>(),
      terminalHostAdapters: { tmux: adapter },
    });

    expect(adapter.evaluateLiveness).not.toHaveBeenCalled();
    expect(removeTerminalAttachmentInfo).not.toHaveBeenCalled();
    expect(result.orphanedDeadDaemonSessions).toEqual([]);
    expect(result.unresolvedTerminalHostSessionIds).toEqual([marker.happySessionId]);
    expect(removeSessionMarker).not.toHaveBeenCalledWith(marker.pid);
  });

  it('does not let an unavailable terminal probe delay cold startup', async () => {
    const marker = {
      pid: 43217,
      happySessionId: 'session-inconclusive-terminal-probe',
      happyHomeDir: '/tmp/happy',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon' as const,
      cwd: '/workspace/project',
      respawn: {
        version: 1,
        directory: '/workspace/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        resume: 'claude-inconclusive-probe-thread',
      },
    } satisfies DaemonSessionMarker;
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(),
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(async () => {
        throw new Error('zellij list-panes timed out');
      }),
      dispose: vi.fn(),
    };

    vi.mocked(listSessionMarkers).mockResolvedValue([marker]);
    mockTerminalAttachmentState({ status: 'present', info: {
      version: 1,
      sessionId: marker.happySessionId,
      terminal: {
        mode: 'zellij',
        zellij: {
          sessionName: 'happier-session-inconclusive-terminal-probe',
          paneId: 'terminal_7',
        },
      },
      updatedAt: 1,
    } });
    mockHappyProcessesForDiscovery([]);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });

    const result = await reattachTrackedSessionsFromMarkers({
      pidToTrackedSession: new Map<number, TrackedSession>(),
      terminalHostAdapters: { zellij: adapter },
    });

    expect(result.orphanedDeadDaemonSessions).toEqual([]);
    expect(result.unresolvedTerminalHostSessionIds).toEqual([marker.happySessionId]);
    expect(adapter.evaluateLiveness).not.toHaveBeenCalled();
    expect(adapter.dispose).not.toHaveBeenCalled();
    expect(removeTerminalAttachmentInfo).not.toHaveBeenCalled();
    expect(removeSessionMarker).not.toHaveBeenCalledWith(marker.pid);
  });

  it('skips markerless daemon-spawned session recovery when disabled by environment', async () => {
    process.env.HAPPIER_DAEMON_MARKERLESS_REATTACH_ENABLED = '0';
    const markerlessDaemonSessionProcess = {
      pid: 12345,
      type: 'daemon-spawned-session',
      cwd: '/tmp/project',
      command:
        '/home/guest/.happier/cli-preview/current/happier opencode --happy-starting-mode remote --started-by daemon --resume vendor-1 --existing-session session-123',
    } satisfies HappyProcessInfo;

    vi.mocked(listSessionMarkers).mockResolvedValue([]);
    mockHappyProcessesForDiscovery([markerlessDaemonSessionProcess]);
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    const pidToTrackedSession = new Map<number, TrackedSession>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.size).toBe(0);
    expect(writeSessionMarker).not.toHaveBeenCalled();
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
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    const pidToTrackedSession = new Map<number, TrackedSession>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.get(12345)).toEqual(
      expect.objectContaining({
        startedBy: 'daemon',
        happySessionId: 'session-123',
        pid: 12345,
        vendorResumeId: 'vendor-1',
        spawnOptions: {
          directory: '/tmp/project',
          backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
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
      },
    });
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
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    const pidToTrackedSession = new Map<number, TrackedSession>();
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

  it('applies incomplete marker metadata runtime snapshot when recovering markerless daemon sessions', async () => {
    const connectedServices = {
      v: 1,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected',
          selection: 'profile',
          profileId: 'fresh-profile',
        },
      },
    } as const;
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 12346,
        happySessionId: 'session-456',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        cwd: '/tmp/project',
        metadata: {
          permissionMode: 'yolo',
          permissionModeUpdatedAt: 600,
          connectedServices,
          connectedServicesUpdatedAt: 610,
          modelOverrideV1: { v: 1, modelId: 'gpt-5.1-codex', updatedAt: 620 },
        },
        respawn: {
          version: 1,
          directory: '/tmp/project',
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          permissionMode: 'default',
          permissionModeUpdatedAt: 100,
          connectedServices: { v: 1, bindingsByServiceId: {} },
          connectedServicesUpdatedAt: 100,
        },
      } satisfies DaemonSessionMarker,
    ]);
    mockHappyProcessesForDiscovery([
      {
        pid: 12346,
        type: 'daemon-spawned-session',
        cwd: '/tmp/project',
        command:
          '/home/guest/.happier/cli-preview/current/happier codex --happy-starting-mode remote --started-by daemon --existing-session session-456',
      } satisfies HappyProcessInfo,
    ]);
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    const pidToTrackedSession = new Map<number, TrackedSession>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.get(12346)?.spawnOptions).toMatchObject({
      directory: '/tmp/project',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 600,
      connectedServices,
      connectedServicesUpdatedAt: 610,
      modelId: 'gpt-5.1-codex',
      modelUpdatedAt: 620,
    });
    expect(writeSessionMarker).toHaveBeenCalledWith(expect.objectContaining({
      pid: 12346,
      respawn: expect.objectContaining({
        connectedServices,
        connectedServicesUpdatedAt: 610,
        permissionMode: 'yolo',
        permissionModeUpdatedAt: 600,
        modelId: 'gpt-5.1-codex',
        modelUpdatedAt: 620,
      }),
    }));
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
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    const pidToTrackedSession = new Map<number, TrackedSession>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.get(12345)).toEqual(
      expect.objectContaining({
        startedBy: 'daemon',
        happySessionId: 'session-123',
        pid: 12345,
        spawnOptions: {
          directory: '/tmp/project',
          backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
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
        command: 'C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe',
      } as any,
    ]);
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    const pidToTrackedSession = new Map<number, TrackedSession>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.size).toBe(0);
    expect(writeSessionMarker).not.toHaveBeenCalled();
  });

  it('recovers a generic happy user session only when the live command proves the session identity and preserves encrypted respawn env', async () => {
    const credentials: Credentials = {
      token: 't',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
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
            kind: 'builtInAgent',
            agentId: 'opencode',
          },
          sealedEnvironmentVariables: {
            format: 'account_scoped_v1',
            ciphertext: sealAccountScopedBlobCiphertext({
              kind: 'session_respawn_environment',
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
        command:
          'C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\package-dist\\index.mjs opencode --happy-starting-mode remote --started-by daemon --existing-session session-123',
      } as any,
    ]);
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    const pidToTrackedSession = new Map<number, TrackedSession>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession, credentials });

    expect(pidToTrackedSession.get(12345)).toEqual(
      expect.objectContaining({
        startedBy: 'daemon',
        happySessionId: 'session-123',
        pid: 12345,
        spawnOptions: {
          directory: '/tmp/project',
          backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
          environmentVariables: {
            CODEX_HOME: '/tmp/codex-home',
            OPENAI_API_KEY: 'sk-test',
          },
          approvedNewDirectoryCreation: true,
        },
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
      respawn: expect.objectContaining({
        version: 1,
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
        environmentVariables: {
          CODEX_HOME: '/tmp/codex-home',
        },
        sealedEnvironmentVariables: {
          format: 'account_scoped_v1',
          ciphertext: expect.any(String),
        },
      }),
    });
  });

  it('does not recover a live daemon-spawned process when a live marker failed marker adoption safety checks', async () => {
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 12345,
        happySessionId: 'session-123',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        processCommandHash: 'hash:/some/other/process',
      } as any,
    ]);
    mockHappyProcessesForDiscovery([
      {
        pid: 12345,
        type: 'daemon-spawned-session',
        command:
          '/home/guest/.happier/cli-preview/current/happier opencode --happy-starting-mode remote --started-by daemon --resume vendor-1 --existing-session session-123',
      } as any,
    ]);
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.mocked(adoptSessionsFromMarkers).mockReturnValue(emptyAdoptResult);

    const pidToTrackedSession = new Map<number, TrackedSession>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

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
      } satisfies HappyProcessInfo,
    ]);

    const pidToTrackedSession = new Map<number, TrackedSession>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.size).toBe(0);
    expect(writeSessionMarker).not.toHaveBeenCalled();
  });

  it('recovers incomplete daemon markers during cli-update takeover even when the live command belongs to a different runtime root', async () => {
    isOwnedLiveDaemonSessionProcessCommandMock.mockReturnValue(false);
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 54321,
        happySessionId: 'session-123',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        cwd: '/tmp/project',
      } satisfies DaemonSessionMarker,
    ]);
    mockHappyProcessesForDiscovery([
      {
        pid: 54321,
        type: 'daemon-spawned-session',
        cwd: '/tmp/project',
        command:
          '/Users/other/happier/cli-preview/current/package-dist/index.mjs claude --happy-starting-mode remote --started-by daemon',
      } satisfies HappyProcessInfo,
    ]);
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    const pidToTrackedSession = new Map<number, TrackedSession>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

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
  });

  it('reattaches pre-webhook placeholder custody with its spawn nonce after daemon restart', async () => {
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 54322,
        happySessionId: 'PID-54322',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        cwd: '/tmp/project',
        respawn: {
          version: 1,
          directory: '/tmp/project',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          spawnNonce: 'spawn-nonce-pre-webhook-restart',
        },
      } satisfies DaemonSessionMarker,
    ]);
    mockHappyProcessesForDiscovery([
      {
        pid: 54322,
        type: 'daemon-spawned-session',
        cwd: '/tmp/project',
        command:
          '/tmp/happier claude --happy-starting-mode remote --started-by daemon',
      } satisfies HappyProcessInfo,
    ]);
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    const pidToTrackedSession = new Map<number, TrackedSession>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.get(54322)).toEqual(expect.objectContaining({
      startedBy: 'daemon',
      happySessionId: 'PID-54322',
      pid: 54322,
      reattachedFromDiskMarker: true,
      spawnOptions: expect.objectContaining({
        directory: '/tmp/project',
        spawnNonce: 'spawn-nonce-pre-webhook-restart',
      }),
    }));
    expect(writeSessionMarker).toHaveBeenCalledWith(expect.objectContaining({
      pid: 54322,
      happySessionId: 'PID-54322',
      startedBy: 'daemon',
      respawn: expect.objectContaining({
        spawnNonce: 'spawn-nonce-pre-webhook-restart',
      }),
    }));
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
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    const pidToTrackedSession = new Map<number, TrackedSession>();
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
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    const pidToTrackedSession = new Map<number, TrackedSession>();
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

  it('recovers an alive daemon marker missing from bulk process discovery via pid-specific fallback', async () => {
    isOwnedLiveDaemonSessionProcessCommandMock.mockReturnValue(false);
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 76544,
        happySessionId: 'session-pid-fallback',
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
      } satisfies DaemonSessionMarker,
    ]);
    mockHappyProcessesForDiscovery([]);
    vi.mocked(findHappyProcessByPid).mockResolvedValue({
      pid: 76544,
      type: 'user-session',
      cwd: '/tmp/project',
      command: 'node',
    } satisfies HappyProcessInfo);
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    const pidToTrackedSession = new Map<number, TrackedSession>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(findHappyProcessByPid).toHaveBeenCalledWith(76544);
    expect(pidToTrackedSession.get(76544)).toEqual(
      expect.objectContaining({
        startedBy: 'daemon',
        happySessionId: 'session-pid-fallback',
        pid: 76544,
        reattachedFromDiskMarker: true,
      }),
    );
  });

  it('uses marker pid lookups without a full process-table scan when markerless recovery is disabled', async () => {
    process.env.HAPPIER_DAEMON_MARKERLESS_REATTACH_ENABLED = '0';
    isOwnedLiveDaemonSessionProcessCommandMock.mockReturnValue(false);
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 76545,
        happySessionId: 'session-marker-first',
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
      } satisfies DaemonSessionMarker,
    ]);
    mockHappyProcessesForDiscovery([]);
    vi.mocked(findHappyProcessByPid).mockResolvedValue({
      pid: 76545,
      type: 'user-session',
      cwd: '/tmp/project',
      command: 'node',
    } satisfies HappyProcessInfo);
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    const pidToTrackedSession = new Map<number, TrackedSession>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(findHappyProcessByPid).toHaveBeenCalledWith(76545);
    expect(findAllHappyProcesses).not.toHaveBeenCalled();
  });

  it('recovers a markerless daemon session alongside an adopted live marker and heals only the missing marker', async () => {
    const markedProcess = {
      pid: 76546,
      type: 'daemon-spawned-session',
      cwd: '/tmp/project',
      command: 'happier claude --started-by daemon --existing-session session-marker-default',
    } satisfies HappyProcessInfo;
    const markerlessProcess = {
      pid: 99991,
      type: 'daemon-spawned-session',
      cwd: '/tmp/other',
      command: 'happier codex --started-by daemon --existing-session session-markerless',
    } satisfies HappyProcessInfo;
    const marker = {
      pid: markedProcess.pid,
      happySessionId: 'session-marker-default',
      happyHomeDir: '/tmp/happy',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon' as const,
      cwd: markedProcess.cwd,
      respawn: {
        version: 1 as const,
        directory: markedProcess.cwd,
        backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' },
      },
    } satisfies DaemonSessionMarker;
    vi.mocked(listSessionMarkers).mockResolvedValue([marker]);
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
        ...emptyAdoptResult,
        adopted: 1,
        adoptedPids: [markedProcess.pid],
      };
    });
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    const pidToTrackedSession = new Map<number, TrackedSession>();
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

  it('does not report an orphaned dead daemon session when the same happy session was recovered live during startup', async () => {
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 11111,
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
        pid: 22222,
        type: 'daemon-spawned-session',
        cwd: '/tmp/project',
        command:
          '/home/guest/.happier/cli-preview/current/happier opencode --happy-starting-mode remote --started-by daemon --resume vendor-1 --existing-session session-123',
      } as any,
    ]);
    vi.spyOn(process, 'kill').mockImplementation((pid: number) => {
      if (pid === 11111) {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      }
      return true;
    });

    const pidToTrackedSession = new Map<number, TrackedSession>();
    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.get(22222)).toEqual(expect.objectContaining({
      happySessionId: 'session-123',
      pid: 22222,
    }));
    expect(result).toEqual({
      orphanedDeadDaemonSessions: [],
      recoveredLiveSessionIds: ['session-123'],
      connectedServiceRestartIntents: [],
    });
  });

  it('does not report an orphaned dead daemon session when the same happy session has any recovered live owner', async () => {
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 11111,
        happySessionId: 'session-123',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        cwd: '/tmp/project',
      } satisfies DaemonSessionMarker,
      {
        pid: 22222,
        happySessionId: 'session-123',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'terminal',
        cwd: '/tmp/project',
        processCommandHash: 'b'.repeat(64),
      } satisfies DaemonSessionMarker,
    ]);
    mockHappyProcessesForDiscovery([
      {
        pid: 22222,
        type: 'user-session',
        cwd: '/tmp/project',
        command: 'happy codex --existing-session session-123',
      } satisfies HappyProcessInfo,
    ]);
    vi.mocked(adoptSessionsFromMarkers).mockImplementationOnce(({ pidToTrackedSession }) => {
      pidToTrackedSession.set(22222, {
        pid: 22222,
        startedBy: 'terminal',
        happySessionId: 'session-123',
        reattachedFromDiskMarker: true,
      });
      return {
        ...emptyAdoptResult,
        adopted: 1,
        adoptedPids: [22222],
      };
    });
    vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === 11111) {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      }
      return true;
    });

    const pidToTrackedSession = new Map<number, TrackedSession>();
    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.get(22222)).toEqual(expect.objectContaining({
      happySessionId: 'session-123',
      pid: 22222,
    }));
    expect(result).toEqual({
      orphanedDeadDaemonSessions: [],
      recoveredLiveSessionIds: ['session-123'],
      connectedServiceRestartIntents: [],
    });
  });

  it('does not return a startup restart intent when the same OpenCode session has a recovered live owner', async () => {
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 11113,
        happySessionId: 'session-opencode-live-owner',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        cwd: '/tmp/project',
        metadata: {
          flavor: 'opencode',
          opencodeSessionId: 'opencode-live-owner-thread',
        },
        respawn: {
          version: 1,
          directory: '/tmp/project',
          backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
        },
      } satisfies DaemonSessionMarker,
      {
        pid: 22223,
        happySessionId: 'session-opencode-live-owner',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'terminal',
        cwd: '/tmp/project',
        processCommandHash: 'c'.repeat(64),
      } satisfies DaemonSessionMarker,
    ]);
    mockHappyProcessesForDiscovery([
      {
        pid: 22223,
        type: 'user-session',
        cwd: '/tmp/project',
        command: 'happy opencode --existing-session session-opencode-live-owner',
      } satisfies HappyProcessInfo,
    ]);
    vi.mocked(adoptSessionsFromMarkers).mockImplementationOnce(({ pidToTrackedSession }) => {
      pidToTrackedSession.set(22223, {
        pid: 22223,
        startedBy: 'terminal',
        happySessionId: 'session-opencode-live-owner',
        reattachedFromDiskMarker: true,
      });
      return {
        ...emptyAdoptResult,
        adopted: 1,
        adoptedPids: [22223],
      };
    });
    vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === 11113) {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      }
      return true;
    });

    const pidToTrackedSession = new Map<number, TrackedSession>();
    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.get(22223)).toEqual(expect.objectContaining({
      happySessionId: 'session-opencode-live-owner',
      pid: 22223,
    }));
    expect(result).toEqual({
      orphanedDeadDaemonSessions: [],
      recoveredLiveSessionIds: ['session-opencode-live-owner'],
      connectedServiceRestartIntents: [],
    });
  });
});
