import { describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import type { TrackedSession } from '@/daemon/types';
import {
  SPAWN_SESSION_ERROR_CODES,
  type SpawnSessionResult,
} from '@/session/shared/spawnSessionContract';
import os from 'node:os';
import path from 'node:path';

import {
  createOnDaemonSessionStartupFailure,
  createOnHappySessionWebhook,
  resolveSessionWebhookPath,
} from './onHappySessionWebhook';
import {
  markSessionWebhookPidTimedOut,
  waitForSessionWebhook,
} from '../spawn/waitForSessionWebhook';
import { hashProcessCommand } from '../sessionRegistry';
import { serializeWindowsCommandLine } from '../platform/windows/windowsCommandLine';

function createMetadata(pid: number, startedBy: 'daemon' | 'terminal', rootPath = '/tmp'): Metadata {
  return {
    path: rootPath,
    host: 'test-host',
    homeDir: '/tmp/home',
    happyHomeDir: configuration.happyHomeDir,
    happyLibDir: '/tmp/lib',
    happyToolsDir: '/tmp/tools',
    hostPid: pid,
    startedBy,
    machineId: 'machine-test',
  };
}

describe('createOnHappySessionWebhook', () => {
  it('settles only the exact pending daemon spawn awaiter with a typed organization refusal', async () => {
    const pid = 808;
    const tracked: TrackedSession = {
      pid,
      startedBy: 'daemon',
      happySessionId: `PID-${pid}`,
      spawnOptions: { directory: '/tmp', spawnNonce: 'creation-attempt-808' },
    };
    const pidToTrackedSession = new Map<number, TrackedSession>([[pid, tracked]]);
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();
    const resultPromise = waitForSessionWebhook({
      pid,
      pidToAwaiter,
      pidToTrackedSession,
      pidToSpawnResultResolver: new Map(),
      pidToSpawnWebhookTimeout: new Map(),
      timeoutMs: 10_000,
      timeoutErrorMessage: 'not expected',
    });
    const onStartupFailure = createOnDaemonSessionStartupFailure({
      pidToTrackedSession,
      pidToAwaiter,
    });

    expect(onStartupFailure({
      spawnNonce: 'other-attempt',
      errorDetail: {
        kind: 'session_creation_organization_invalid',
        code: 'organization_invalid',
      },
    })).toBe(false);
    expect(pidToAwaiter.has(pid)).toBe(true);

    expect(onStartupFailure({
      spawnNonce: 'creation-attempt-808',
      errorDetail: {
        kind: 'session_creation_organization_invalid',
        code: 'organization_invalid',
      },
    })).toBe(true);
    await expect(resultPromise).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'Session creation organization placement is invalid',
      errorDetail: {
        kind: 'session_creation_organization_invalid',
        code: 'organization_invalid',
      },
    });
    expect(pidToAwaiter.has(pid)).toBe(false);
    // A duplicated or late terminal callback cannot settle the same waiter twice.
    expect(onStartupFailure({
      spawnNonce: 'creation-attempt-808',
      errorDetail: {
        kind: 'session_creation_organization_invalid',
        code: 'organization_invalid',
      },
    })).toBe(false);
  });

  it('settles the exact pending daemon spawn awaiter with a typed correspondence conflict', async () => {
    const pid = 810;
    const tracked: TrackedSession = {
      pid,
      startedBy: 'daemon',
      happySessionId: `PID-${pid}`,
      spawnOptions: { directory: '/tmp', spawnNonce: 'creation-conflict-attempt-810' },
    };
    const pidToTrackedSession = new Map<number, TrackedSession>([[pid, tracked]]);
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();
    const resultPromise = waitForSessionWebhook({
      pid,
      pidToAwaiter,
      pidToTrackedSession,
      pidToSpawnResultResolver: new Map(),
      pidToSpawnWebhookTimeout: new Map(),
      timeoutMs: 10_000,
      timeoutErrorMessage: 'not expected',
    });
    const onStartupFailure = createOnDaemonSessionStartupFailure({
      pidToTrackedSession,
      pidToAwaiter,
    });

    expect(onStartupFailure({
      spawnNonce: 'creation-conflict-attempt-810',
      errorDetail: {
        kind: 'session_creation_correspondence_conflict',
        code: 'creation_conflict',
      },
    })).toBe(true);
    await expect(resultPromise).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'Session creation correspondence conflicts with the existing Session',
      errorDetail: {
        kind: 'session_creation_correspondence_conflict',
        code: 'creation_conflict',
      },
    });
  });

  it('does not settle a terminal failure against a timed-out spawn attempt', () => {
    const pid = 809;
    const tracked: TrackedSession = {
      pid,
      startedBy: 'daemon',
      happySessionId: `PID-${pid}`,
      spawnOptions: { directory: '/tmp', spawnNonce: 'creation-attempt-timed-out' },
      sessionWebhookTimedOutAtMs: 123,
    };
    const awaiter = vi.fn();
    const onStartupFailure = createOnDaemonSessionStartupFailure({
      pidToTrackedSession: new Map([[pid, tracked]]),
      pidToAwaiter: new Map([[pid, awaiter]]),
    });

    expect(onStartupFailure({
      spawnNonce: 'creation-attempt-timed-out',
      errorDetail: {
        kind: 'session_creation_organization_invalid',
        code: 'organization_invalid',
      },
    })).toBe(false);
    expect(awaiter).not.toHaveBeenCalled();
    expect(tracked.spawnStartupReadinessFailure).toBeUndefined();
  });

  it('registers an externally started session when PID is unknown', () => {
    const pidToTrackedSession = new Map<number, TrackedSession>();
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
    });

    onWebhook('PID-123', createMetadata(123, 'terminal'));

    const tracked = pidToTrackedSession.get(123);
    expect(tracked).toBeDefined();
    expect(tracked?.startedBy).toBe('happy directly - likely by user from terminal');
    expect(tracked?.happySessionId).toBe('PID-123');
  });

  it('exposes externally started canonical marker persistence to foreground promotion before acknowledgement', async () => {
    const pid = 124;
    let releaseMarkerWrite!: () => void;
    const markerWriteBlocked = new Promise<void>((resolve) => {
      releaseMarkerWrite = resolve;
    });
    let markerWriteStarted!: () => void;
    const markerWriteObserved = new Promise<void>((resolve) => {
      markerWriteStarted = resolve;
    });
    const writeSessionMarkerFn = vi.fn(async () => {
      markerWriteStarted();
      await markerWriteBlocked;
    });
    const pidToTrackedSession =
      new Map<number, TrackedSession>();
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter: new Map(),
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      readProcessIdentityByPidFn: async () => ({
        pid,
        processStartTimeMs: 2_000,
        processCommandHash: hashProcessCommand('happier codex'),
        command: 'happier codex',
      }),
      writeSessionMarkerFn,
    });

    let acknowledged = false;
    const webhook = onWebhook(
      'session-foreground-124',
      createMetadata(pid, 'terminal'),
    ).then(() => {
      acknowledged = true;
    });

    await markerWriteObserved;
    expect(acknowledged).toBe(true);
    const tracked = pidToTrackedSession.get(pid);
    expect(tracked?.sessionMarkerPersistence).toBeDefined();

    releaseMarkerWrite();
    await webhook;

    expect(acknowledged).toBe(true);
    await expect(
      tracked!.sessionMarkerPersistence,
    ).resolves.toBe(true);
    expect(writeSessionMarkerFn).toHaveBeenCalledOnce();
  });

  it('coalesces duplicate canonical Windows Terminal webhooks while transferring host custody before ACK', async () => {
    const windowsTerminalHostPid = 8_888;
    const agentPid = 9_999;
    const spawnCleanup = vi.fn();
    const attachCleanup = vi.fn(async () => undefined);
    const executablePath =
      'C:\\Program Files\\Happier\\happier.exe';
    const launchArgv = [
      'codex',
      '--happy-terminal-mode',
      'windows_terminal',
      '--happy-terminal-launch-correlation',
      'ab'.repeat(16),
    ];
    const processCommand = serializeWindowsCommandLine([
      executablePath,
      ...launchArgv,
    ]);
    const tracked: TrackedSession = {
      pid: windowsTerminalHostPid,
      startedBy: 'daemon',
      happySessionId: `PID-${windowsTerminalHostPid}`,
      hostedTerminal: {
        mode: 'windows_terminal',
        requested: 'windows_terminal',
        windows: {
          host: 'windows_terminal',
          pid: windowsTerminalHostPid,
          windowId: 'happier-cli',
          title: 'Happier codex spawn-unique',
        },
      },
      windowsTerminalLaunchCustody: {
        executablePath,
        argv: launchArgv,
        correlation: 'ab'.repeat(16),
      },
    };
    const pidToTrackedSession =
      new Map<number, TrackedSession>([[
        windowsTerminalHostPid,
        tracked,
      ]]);
    const pidToAwaiter =
      new Map<number, (session: TrackedSession) => void>();
    const pidToSpawnResultResolver =
      new Map<number, (result: SpawnSessionResult) => void>();
    const pidToSpawnWebhookTimeout =
      new Map<number, NodeJS.Timeout>();
    const spawnResourceCleanupByPid =
      new Map([[windowsTerminalHostPid, spawnCleanup]]);
    const sessionAttachCleanupByPid =
      new Map([[windowsTerminalHostPid, attachCleanup]]);
    const lifecycleTargets = new Map<number, string>([[
      windowsTerminalHostPid,
      'known-or-resumed-session',
    ]]);
    const onPidPromoted = vi.fn(({
      fromPid,
      toPid,
    }: Readonly<{
      fromPid: number;
      toPid: number;
      trackedSession: TrackedSession;
    }>) => {
      const target = lifecycleTargets.get(fromPid);
      lifecycleTargets.delete(fromPid);
      if (target) lifecycleTargets.set(toPid, target);
    });
    const wait = waitForSessionWebhook({
      pid: windowsTerminalHostPid,
      pidToTrackedSession,
      pidToAwaiter,
      pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout,
      timeoutMs: 1_000,
      timeoutErrorMessage:
        `Session webhook timeout for PID ${windowsTerminalHostPid}`,
    });
    let resolveInventoryBarrier!: () => void;
    const inventoryBarrier = new Promise<void>((resolve) => {
      resolveInventoryBarrier = resolve;
    });
    let inventoryReadCount = 0;
    const onTrackedSessionReady = vi.fn(async () => undefined);
    const promoteSessionMarkerFn = vi.fn(async () => ({
      sourceMarkerOwnership: {
        happySessionId: `PID-${windowsTerminalHostPid}`,
      },
      targetMarkerOwnership: {
        happySessionId: `PID-${agentPid}`,
        processCommandHash: hashProcessCommand(processCommand),
        processStartTimeMs: 2_000,
      },
      targetProcessCommand: processCommand,
    }));
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      readProcessIdentityByPidFn: async () => ({
        pid: agentPid,
        processStartTimeMs: 2_000,
        executablePath,
        command: processCommand,
      }),
      readAllWindowsProcessFactsFn: async () => {
        inventoryReadCount += 1;
        if (inventoryReadCount === 2) {
          resolveInventoryBarrier();
        }
        await inventoryBarrier;
        return new Map([
          [agentPid, {
            pid: agentPid,
            processStartTimeMs: 2_000,
            executablePath,
            command: processCommand,
          }],
        ]);
      },
      writeSessionMarkerFn: async () => {},
      promoteSessionMarkerFn,
      removeSessionMarkerIfOwnedFn: vi.fn(async () => true),
      onTrackedSessionReady,
      onPidPromoted,
    });

    const metadata: Metadata = {
        ...createMetadata(agentPid, 'daemon'),
        terminal: {
          mode: 'windows_terminal',
          requested: 'windows_terminal',
          windows: {
            host: 'windows_terminal',
            windowId: 'happier-cli',
            title: 'Happier codex spawn-unique',
          },
        },
      };
    await Promise.all([
      onWebhook(
        'session-agent-windows-terminal',
        metadata,
      ),
      onWebhook(
        'session-agent-windows-terminal',
        metadata,
      ),
    ]);

    await expect(wait).resolves.toEqual({
      type: 'success',
      sessionId: 'session-agent-windows-terminal',
    });
    expect(pidToTrackedSession.has(windowsTerminalHostPid)).toBe(false);
    expect(pidToTrackedSession.get(agentPid)).toBe(tracked);
    expect(tracked).toEqual(expect.objectContaining({
      pid: agentPid,
      happySessionId: 'session-agent-windows-terminal',
      startedBy: 'daemon',
    }));
    expect(spawnResourceCleanupByPid.has(windowsTerminalHostPid))
      .toBe(false);
    expect(spawnResourceCleanupByPid.get(agentPid)).toBe(spawnCleanup);
    expect(sessionAttachCleanupByPid.has(windowsTerminalHostPid))
      .toBe(false);
    expect(sessionAttachCleanupByPid.get(agentPid)).toBe(attachCleanup);
    expect(tracked.windowsTerminalCancellationIdentity).toEqual({
      pid: agentPid,
      processStartTimeMs: 2_000,
      processCommandHash: hashProcessCommand(processCommand),
    });
    expect(onPidPromoted).toHaveBeenCalledOnce();
    expect(onPidPromoted).toHaveBeenCalledWith({
      fromPid: windowsTerminalHostPid,
      toPid: agentPid,
      trackedSession: tracked,
    });
    expect(lifecycleTargets).toEqual(new Map([[
      agentPid,
      'known-or-resumed-session',
    ]]));
    expect(promoteSessionMarkerFn).toHaveBeenCalledOnce();
    expect(onTrackedSessionReady).toHaveBeenCalledOnce();
    expect(tracked.spawnStartupReadinessFailure).toBeUndefined();
  });

  it('correlates duplicate-title Windows Terminal launches by exact full argv and private correlation', async () => {
    const firstHostPid = 8_881;
    const secondHostPid = 8_882;
    const agentPid = 9_991;
    const firstAwaiter = vi.fn();
    const secondAwaiter = vi.fn();
    const createTracked = (
      pid: number,
      title: string,
      correlation: string,
    ): TrackedSession => ({
      pid,
      startedBy: 'daemon',
      happySessionId: `PID-${pid}`,
      hostedTerminal: {
        mode: 'windows_terminal',
        requested: 'windows_terminal',
        windows: {
          host: 'windows_terminal',
          pid,
          windowId: 'happier-cli',
          title,
        },
      },
      windowsTerminalLaunchCustody: {
        executablePath:
          'C:\\Program Files\\Happier\\happier.exe',
        argv: [
          'codex',
          '--happy-terminal-mode',
          'windows_terminal',
          '--happy-terminal-title',
          title,
          '--happy-terminal-launch-correlation',
          correlation,
        ],
        correlation,
      },
    });
    const duplicateTitle = 'Happier codex session-known';
    const firstTracked =
      createTracked(firstHostPid, duplicateTitle, '11'.repeat(16));
    const secondTracked =
      createTracked(secondHostPid, duplicateTitle, '22'.repeat(16));
    const secondLaunch = secondTracked.windowsTerminalLaunchCustody!;
    const processCommand = serializeWindowsCommandLine([
      secondLaunch.executablePath,
      ...secondLaunch.argv,
    ]);
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [firstHostPid, firstTracked],
      [secondHostPid, secondTracked],
    ]);
    const pidToAwaiter =
      new Map<number, (session: TrackedSession) => void>([
        [firstHostPid, firstAwaiter],
        [secondHostPid, secondAwaiter],
      ]);
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      readProcessIdentityByPidFn: async () => ({
        pid: agentPid,
        processStartTimeMs: 3_000,
        executablePath: secondLaunch.executablePath,
        command: processCommand,
      }),
      readAllWindowsProcessFactsFn: async () => new Map([
        [agentPid, {
          pid: agentPid,
          processStartTimeMs: 3_000,
          executablePath: secondLaunch.executablePath,
          command: processCommand,
        }],
      ]),
      writeSessionMarkerFn: async () => {},
      promoteSessionMarkerFn: vi.fn(async (fromPid, toPid) => ({
        sourceMarkerOwnership: {
          happySessionId: `PID-${fromPid}`,
        },
        targetMarkerOwnership: {
          happySessionId: `PID-${toPid}`,
          processCommandHash: hashProcessCommand(processCommand),
          processStartTimeMs: 3_000,
        },
        targetProcessCommand: processCommand,
      })),
      removeSessionMarkerIfOwnedFn: vi.fn(async () => true),
    });

    await onWebhook('session-second', {
      ...createMetadata(agentPid, 'daemon'),
      terminal: {
        mode: 'windows_terminal',
        requested: 'windows_terminal',
        windows: {
          host: 'windows_terminal',
          windowId: 'happier-cli',
          title: duplicateTitle,
        },
      },
    });

    expect(firstAwaiter).not.toHaveBeenCalled();
    expect(secondAwaiter).toHaveBeenCalledWith(secondTracked);
    expect(pidToTrackedSession.get(firstHostPid)).toBe(firstTracked);
    expect(pidToTrackedSession.has(secondHostPid)).toBe(false);
    expect(pidToTrackedSession.get(agentPid)).toBe(secondTracked);
  });

  it('keeps an exact late Windows Terminal webhook fail-closed after the spawn awaiter is removed', async () => {
    const hostPid = 8_883;
    const agentPid = 9_993;
    const correlation = '33'.repeat(16);
    const executablePath =
      'C:\\Program Files\\Happier\\happier.exe';
    const argv = [
      'codex',
      '--happy-terminal-launch-correlation',
      correlation,
    ];
    const processCommand = serializeWindowsCommandLine([
      executablePath,
      ...argv,
    ]);
    const tracked: TrackedSession = {
      pid: hostPid,
      startedBy: 'daemon',
      happySessionId: `PID-${hostPid}`,
      acceptedSpawnMarkerGate: Promise.resolve(false),
      hostedTerminal: {
        mode: 'windows_terminal',
        requested: 'windows_terminal',
        windows: {
          host: 'windows_terminal',
          pid: hostPid,
          windowId: 'happier-cli',
          title: 'Happier codex delayed',
        },
      },
      windowsTerminalLaunchCustody: {
        executablePath,
        argv,
        correlation,
      },
    };
    const pidToTrackedSession =
      new Map<number, TrackedSession>([[hostPid, tracked]]);
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter: new Map(),
      spawnResourceCleanupByPid: new Map([
        [hostPid, vi.fn()],
      ]),
      sessionAttachCleanupByPid: new Map([
        [hostPid, vi.fn(async () => undefined)],
      ]),
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      readProcessIdentityByPidFn: async () => ({
        pid: agentPid,
        processStartTimeMs: 3_300,
        executablePath,
        command: processCommand,
      }),
      readAllWindowsProcessFactsFn: async () => new Map([
        [agentPid, {
          pid: agentPid,
          processStartTimeMs: 3_300,
          executablePath,
          command: processCommand,
        }],
      ]),
      writeSessionMarkerFn: async () => {},
    });

    await expect(onWebhook('session-delayed', {
      ...createMetadata(agentPid, 'daemon'),
      terminal: {
        mode: 'windows_terminal',
        requested: 'windows_terminal',
        windows: {
          host: 'windows_terminal',
          windowId: 'happier-cli',
          title: 'Happier codex delayed',
        },
      },
    })).rejects.toThrow('Daemon spawn custody was not accepted');

    expect(pidToTrackedSession.get(hostPid)).toBe(tracked);
    expect(pidToTrackedSession.has(agentPid)).toBe(false);
    expect(tracked.startedBy).toBe('daemon');
    expect(tracked.windowsTerminalCancellationIdentity).toEqual({
      pid: agentPid,
      processStartTimeMs: 3_300,
      processCommandHash: hashProcessCommand(processCommand),
    });
  });

  it('carries Windows Terminal host custody from a PID placeholder report into canonical marker acceptance', async () => {
    const hostPid = 8_885;
    const agentPid = 9_995;
    const correlation = '55'.repeat(16);
    const executablePath = 'C:\\Happier\\happier.exe';
    const argv = [
      'codex',
      '--happy-terminal-launch-correlation',
      correlation,
    ];
    const command = serializeWindowsCommandLine([
      executablePath,
      ...argv,
    ]);
    let acceptMarker!: (accepted: boolean) => void;
    const acceptedSpawnMarkerGate =
      new Promise<boolean>((resolve) => {
        acceptMarker = resolve;
      });
    const persistTargetMarker = vi.fn(async () => {
      acceptMarker(true);
    });
    const tracked: TrackedSession = {
      pid: hostPid,
      startedBy: 'daemon',
      happySessionId: `PID-${hostPid}`,
      acceptedSpawnMarkerGate,
      persistWindowsTerminalAcceptedAgentMarker:
        persistTargetMarker,
      windowsTerminalLaunchCustody: {
        executablePath,
        argv,
        correlation,
      },
      hostedTerminal: {
        mode: 'windows_terminal',
        requested: 'windows_terminal',
        windows: {
          host: 'windows_terminal',
          windowId: 'happier',
          title: 'Happier codex placeholder',
        },
      },
    };
    const awaiter = vi.fn();
    const pidToTrackedSession =
      new Map<number, TrackedSession>([[hostPid, tracked]]);
    const pidToAwaiter = new Map([[hostPid, awaiter]]);
    const promotion = vi.fn(async () => ({
      sourceMarkerOwnership: null,
      targetMarkerOwnership: {
        happySessionId: 'session-canonical',
        processCommandHash: hashProcessCommand(command),
        processStartTimeMs: 5_500,
      },
      targetProcessCommand: command,
    }));
    const process = {
      pid: agentPid,
      processStartTimeMs: 5_500,
      executablePath,
      command,
    };
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      spawnResourceCleanupByPid:
        new Map([[hostPid, vi.fn()]]),
      sessionAttachCleanupByPid:
        new Map([[hostPid, vi.fn(async () => undefined)]]),
      getParentPidFn: () => null,
      readProcessIdentityByPidFn: async () => process,
      readAllWindowsProcessFactsFn: async () =>
        new Map([[agentPid, process]]),
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
      promoteSessionMarkerFn: promotion,
    });
    const terminal = tracked.hostedTerminal;

    await onWebhook(`PID-${agentPid}`, {
      ...createMetadata(agentPid, 'daemon'),
      terminal,
    });
    expect(tracked.sessionRunnerPid).toBe(agentPid);
    expect(persistTargetMarker).not.toHaveBeenCalled();

    await onWebhook('session-canonical', {
      ...createMetadata(agentPid, 'daemon'),
      terminal,
    });

    expect(persistTargetMarker).toHaveBeenCalledWith({
      pid: agentPid,
      processStartTimeMs: 5_500,
      processCommandHash: hashProcessCommand(command),
    });
    expect(promotion).toHaveBeenCalledWith(
      hostPid,
      agentPid,
    );
    expect(awaiter).toHaveBeenCalledWith(tracked);
  });

  it('rescans the complete Windows inventory before canonical marker acceptance and refuses a duplicate that appeared after the placeholder webhook', async () => {
    const hostPid = 8_886;
    const agentPid = 9_996;
    const duplicatePid = 9_997;
    const correlation = '66'.repeat(16);
    const executablePath = 'C:\\Happier\\happier.exe';
    const argv = [
      'codex',
      '--happy-terminal-launch-correlation',
      correlation,
    ];
    const command = serializeWindowsCommandLine([
      executablePath,
      ...argv,
    ]);
    const persistTargetMarker = vi.fn(async () => {});
    const activate = vi.fn(async () => null);
    const tracked: TrackedSession = {
      pid: hostPid,
      startedBy: 'daemon',
      happySessionId: `PID-${hostPid}`,
      acceptedSpawnMarkerGate: Promise.resolve(true),
      persistWindowsTerminalAcceptedAgentMarker:
        persistTargetMarker,
      activateConnectedAccountSessionBindingOnCanonicalSession:
        activate,
      windowsTerminalLaunchCustody: {
        executablePath,
        argv,
        correlation,
      },
      hostedTerminal: {
        mode: 'windows_terminal',
        requested: 'windows_terminal',
        windows: {
          host: 'windows_terminal',
          windowId: 'happier',
          title: 'Happier codex placeholder-duplicate',
        },
      },
    };
    const process = {
      pid: agentPid,
      processStartTimeMs: 6_600,
      executablePath,
      command,
    };
    let inventoryReadCount = 0;
    const awaiter = vi.fn();
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession:
        new Map<number, TrackedSession>([[hostPid, tracked]]),
      pidToAwaiter: new Map([[hostPid, awaiter]]),
      spawnResourceCleanupByPid:
        new Map([[hostPid, vi.fn()]]),
      sessionAttachCleanupByPid:
        new Map([[hostPid, vi.fn(async () => undefined)]]),
      getParentPidFn: () => null,
      readProcessIdentityByPidFn: async () => process,
      readAllWindowsProcessFactsFn: async () => {
        inventoryReadCount += 1;
        return new Map([
          [agentPid, process],
          ...(inventoryReadCount > 1
            ? [[duplicatePid, {
                ...process,
                pid: duplicatePid,
              }] as const]
            : []),
        ]);
      },
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: vi.fn(async () => {}),
      promoteSessionMarkerFn: vi.fn(async () => {
        throw new Error('promotion must remain unreachable');
      }),
    });
    const metadata = {
      ...createMetadata(agentPid, 'daemon'),
      terminal: tracked.hostedTerminal,
    };

    await onWebhook(`PID-${agentPid}`, metadata);
    expect(tracked.sessionRunnerPid).toBe(agentPid);

    await expect(
      onWebhook('session-canonical-duplicate', metadata),
    ).rejects.toThrow(
      'Windows Terminal Agent launch custody could not be revalidated',
    );
    expect(inventoryReadCount).toBe(2);
    expect(persistTargetMarker).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect(awaiter).not.toHaveBeenCalled();
    expect(tracked.happySessionId).toBe(`PID-${agentPid}`);
  });

  it.each([
    ['absent', undefined],
    ['different', {
      mode: 'windows_terminal' as const,
      requested: 'windows_terminal' as const,
      windows: {
        host: 'windows_terminal' as const,
        windowId: 'happier',
        title: 'Happier codex another-correlation',
      },
    }],
  ])('lets a daemon webhook with %s Windows Terminal correlation fall through to ordinary PPID matching while another Terminal startup is pending', async (_variant, unrelatedTerminal) => {
    const windowsTerminalHostPid = 8_887;
    const ordinaryWrapperPid = 7_771;
    const ordinaryAgentPid = 7_772;
    const correlation = '77'.repeat(16);
    const pendingTerminal: TrackedSession = {
      pid: windowsTerminalHostPid,
      startedBy: 'daemon',
      happySessionId: `PID-${windowsTerminalHostPid}`,
      windowsTerminalLaunchCustody: {
        executablePath: 'C:\\Happier\\happier.exe',
        argv: [
          'codex',
          '--happy-terminal-launch-correlation',
          correlation,
        ],
        correlation,
      },
      hostedTerminal: {
        mode: 'windows_terminal',
        requested: 'windows_terminal',
        windows: {
          host: 'windows_terminal',
          windowId: 'happier',
          title: 'Happier codex pending-unrelated',
        },
      },
    };
    const ordinary: TrackedSession = {
      pid: ordinaryWrapperPid,
      startedBy: 'daemon',
    };
    const ordinaryAwaiter = vi.fn();
    const pidToTrackedSession =
      new Map<number, TrackedSession>([
        [windowsTerminalHostPid, pendingTerminal],
        [ordinaryWrapperPid, ordinary],
      ]);
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter:
        new Map([[ordinaryWrapperPid, ordinaryAwaiter]]),
      spawnResourceCleanupByPid: new Map([
        [windowsTerminalHostPid, vi.fn()],
        [ordinaryWrapperPid, vi.fn()],
      ]),
      sessionAttachCleanupByPid: new Map([
        [windowsTerminalHostPid, vi.fn(async () => undefined)],
        [ordinaryWrapperPid, vi.fn(async () => undefined)],
      ]),
      getParentPidFn: (pid) =>
        pid === ordinaryAgentPid ? ordinaryWrapperPid : null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
      readProcessIdentityByPidFn: async () => null,
      readAllWindowsProcessFactsFn: async () => {
        throw new Error(
          'unrelated webhook must not enter Windows inventory',
        );
      },
    });

    await onWebhook(
      'session-ordinary-while-terminal-pending',
      {
        ...createMetadata(ordinaryAgentPid, 'daemon'),
        ...(unrelatedTerminal
          ? { terminal: unrelatedTerminal }
          : {}),
      },
    );

    expect(ordinaryAwaiter).toHaveBeenCalledWith(ordinary);
    expect(ordinary.sessionRunnerPid).toBe(ordinaryAgentPid);
    expect(ordinary.happySessionId).toBe(
      'session-ordinary-while-terminal-pending',
    );
    expect(pidToTrackedSession.get(windowsTerminalHostPid))
      .toBe(pendingTerminal);
  });

  it.each([
    'unreadable identity',
    'wrong executable',
    'forged argv',
    'duplicate exact process',
    'missing terminal metadata',
    'wrong title',
  ] as const)(
    'rejects %s without ACK, activation, marker effects, or external adoption',
    async (variant) => {
      const hostPid = 8_884;
      const agentPid = 9_994;
      const correlation = '44'.repeat(16);
      const executablePath =
        'C:\\Program Files\\Happier\\happier.exe';
      const argv = [
        'codex',
        '--happy-terminal-launch-correlation',
        correlation,
      ];
      const processCommand = serializeWindowsCommandLine([
        executablePath,
        ...argv,
      ]);
      const activate = vi.fn(async () => null);
      const awaiter = vi.fn();
      const writeSessionMarker = vi.fn(async () => {});
      const tracked: TrackedSession = {
        pid: hostPid,
        startedBy: 'daemon',
        happySessionId: `PID-${hostPid}`,
        activateConnectedAccountSessionBindingOnCanonicalSession:
          activate,
        hostedTerminal: {
          mode: 'windows_terminal',
          requested: 'windows_terminal',
          windows: {
            host: 'windows_terminal',
            pid: hostPid,
            windowId: 'happier-cli',
            title: 'Happier codex exact',
          },
        },
        windowsTerminalLaunchCustody: {
          executablePath,
          argv,
          correlation,
        },
      };
      const pidToTrackedSession =
        new Map<number, TrackedSession>([[hostPid, tracked]]);
      const onWebhook = createOnHappySessionWebhook({
        pidToTrackedSession,
        pidToAwaiter: new Map([[hostPid, awaiter]]),
        spawnResourceCleanupByPid: new Map([
          [hostPid, vi.fn()],
        ]),
        sessionAttachCleanupByPid: new Map([
          [hostPid, vi.fn(async () => undefined)],
        ]),
        getParentPidFn: () => null,
        findHappyProcessByPidFn: async () => null,
        readProcessIdentityByPidFn: async () => {
          if (variant === 'unreadable identity') return null;
          return {
            pid: agentPid,
            processStartTimeMs: 4_400,
            executablePath:
              variant === 'wrong executable'
                ? 'C:\\forged.exe'
                : executablePath,
            command:
              variant === 'forged argv'
                ? serializeWindowsCommandLine([
                    executablePath,
                    '--forged',
                    correlation,
                  ])
                : processCommand,
          };
        },
        readAllWindowsProcessFactsFn: async () => {
          if (variant === 'unreadable identity') {
            return new Map();
          }
          const process = {
            pid: agentPid,
            processStartTimeMs: 4_400,
            executablePath:
              variant === 'wrong executable'
                ? 'C:\\forged.exe'
                : executablePath,
            command:
              variant === 'forged argv'
                ? serializeWindowsCommandLine([
                    executablePath,
                    '--forged',
                    correlation,
                  ])
                : processCommand,
          };
          return new Map([
            [agentPid, process],
            ...(variant === 'duplicate exact process'
              ? [[agentPid + 1, {
                  ...process,
                  pid: agentPid + 1,
                }] as const]
              : []),
          ]);
        },
        writeSessionMarkerFn: writeSessionMarker,
      });
      const metadata: Metadata = {
        ...createMetadata(agentPid, 'daemon'),
        ...(variant === 'missing terminal metadata'
          ? {}
          : {
              terminal: {
                mode: 'windows_terminal' as const,
                requested: 'windows_terminal' as const,
                windows: {
                  host: 'windows_terminal' as const,
                  windowId: 'happier-cli',
                  title:
                    variant === 'wrong title'
                      ? 'Happier codex wrong'
                      : 'Happier codex exact',
                },
              },
            }),
      };

      await expect(
        onWebhook('session-forged', metadata),
      ).rejects.toThrow(
        'Windows Terminal Agent launch custody could not be verified',
      );
      expect(activate).not.toHaveBeenCalled();
      expect(awaiter).not.toHaveBeenCalled();
      expect(writeSessionMarker).not.toHaveBeenCalled();
      expect(pidToTrackedSession.get(hostPid)).toBe(tracked);
      expect(pidToTrackedSession.has(agentPid)).toBe(false);
      expect(tracked.happySessionId).toBe(`PID-${hostPid}`);
    },
  );

  it('updates an already tracked external session when a new session id is reported', () => {
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [
        456,
        {
          pid: 456,
          startedBy: 'happy directly - likely by user from terminal',
          happySessionId: 'PID-456',
        },
      ],
    ]);
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
    });

    onWebhook('session-real-456', createMetadata(456, 'terminal'));

    expect(pidToTrackedSession.get(456)?.happySessionId).toBe('session-real-456');
  });

  it('updates daemon-spawned session id and resolves spawn awaiter', async () => {
    const tracked: TrackedSession = {
      pid: 789,
      startedBy: 'daemon',
    };
    const pidToTrackedSession = new Map<number, TrackedSession>([[789, tracked]]);
    const awaiter = vi.fn();
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>([[789, awaiter]]);

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
    });

    await onWebhook('session-daemon-789', createMetadata(789, 'daemon'));

    expect(pidToTrackedSession.get(789)?.happySessionId).toBe('session-daemon-789');
    expect(awaiter).toHaveBeenCalledTimes(1);
    expect(pidToAwaiter.has(789)).toBe(false);
  });

  it('stores the separate create-or-rejoin outcome on the matched daemon runner before resolving', async () => {
    const tracked: TrackedSession = {
      pid: 790,
      startedBy: 'daemon',
    };
    const pidToTrackedSession = new Map<number, TrackedSession>([[790, tracked]]);
    const awaiter = vi.fn();
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter: new Map([[790, awaiter]]),
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
    });
    const sessionCreationOutcome = {
      disposition: 'rejoined' as const,
      organizationPlacement: { folderId: 'folder-1', tagIds: ['tag-1'] },
    };

    await onWebhook(
      'session-daemon-790',
      createMetadata(790, 'daemon'),
      undefined,
      sessionCreationOutcome,
    );

    expect(tracked.sessionCreationOutcome).toEqual(sessionCreationOutcome);
    expect(awaiter).toHaveBeenCalledWith(tracked);
  });

  it('ignores a late webhook from a daemon spawn that already timed out', async () => {
    const tracked: TrackedSession = {
      pid: 791,
      startedBy: 'daemon',
      happySessionId: 'PID-791',
      sessionWebhookTimedOutAtMs: 123,
    };
    const pidToTrackedSession = new Map<number, TrackedSession>([[791, tracked]]);
    const awaiter = vi.fn();
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>([[791, awaiter]]);
    const onTrackedSessionReported = vi.fn();
    const writeSessionMarkerFn = vi.fn(async () => {});

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn,
      onTrackedSessionReported,
    });

    onWebhook('session-daemon-791', createMetadata(791, 'daemon'));
    await Promise.resolve();

    expect(pidToTrackedSession.get(791)?.happySessionId).toBe('PID-791');
    expect(pidToTrackedSession.get(791)?.happySessionMetadataFromLocalWebhook).toBeUndefined();
    expect(awaiter).not.toHaveBeenCalled();
    expect(pidToAwaiter.has(791)).toBe(true);
    expect(onTrackedSessionReported).not.toHaveBeenCalled();
    expect(writeSessionMarkerFn).not.toHaveBeenCalled();
  });

  it('ignores a late webhook from an unknown daemon PID that already timed out and exited', async () => {
    markSessionWebhookPidTimedOut(792);
    const pidToTrackedSession = new Map<number, TrackedSession>();
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();
    const writeSessionMarkerFn = vi.fn(async () => {});

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn,
    });

    onWebhook('session-daemon-792', createMetadata(792, 'daemon'));
    await Promise.resolve();

    expect(pidToTrackedSession.has(792)).toBe(false);
    expect(writeSessionMarkerFn).not.toHaveBeenCalled();
  });

  it('allows a fresh daemon retry that reuses a previously timed-out PID', async () => {
    markSessionWebhookPidTimedOut(795);
    const tracked: TrackedSession = {
      pid: 795,
      startedBy: 'daemon',
      happySessionId: 'PID-795',
    };
    const pidToTrackedSession = new Map<number, TrackedSession>([[795, tracked]]);
    const awaiter = vi.fn();
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>([[795, awaiter]]);
    const onTrackedSessionReported = vi.fn();
    let resolveMarker!: () => void;
    const markerWritten = new Promise<void>((resolve) => {
      resolveMarker = resolve;
    });
    const writeSessionMarkerFn = vi.fn(async () => {
      resolveMarker();
    });

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn,
      onTrackedSessionReported,
    });

    onWebhook('session-daemon-795', createMetadata(795, 'daemon'));
    await markerWritten;

    expect(pidToTrackedSession.get(795)?.happySessionId).toBe('session-daemon-795');
    expect(awaiter).toHaveBeenCalledTimes(1);
    expect(onTrackedSessionReported).toHaveBeenCalledWith(expect.objectContaining({
      happySessionId: 'session-daemon-795',
      pid: 795,
    }));
    expect(writeSessionMarkerFn).toHaveBeenCalledTimes(1);
  });

  it('ignores a late wrapper-child webhook after the daemon wrapper PID timed out and exited', async () => {
    markSessionWebhookPidTimedOut(793);
    const pidToTrackedSession = new Map<number, TrackedSession>();
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();
    const writeSessionMarkerFn = vi.fn(async () => {});

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => 793,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn,
    });

    onWebhook('session-daemon-794', createMetadata(794, 'daemon'));
    await Promise.resolve();

    expect(pidToTrackedSession.has(794)).toBe(false);
    expect(writeSessionMarkerFn).not.toHaveBeenCalled();
  });

  it('allows a fresh wrapper retry whose parent PID reuses a timed-out PID', async () => {
    markSessionWebhookPidTimedOut(796);
    const tracked: TrackedSession = {
      pid: 796,
      startedBy: 'daemon',
      happySessionId: 'PID-796',
    };
    const pidToTrackedSession = new Map<number, TrackedSession>([[796, tracked]]);
    const awaiter = vi.fn();
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>([[796, awaiter]]);
    let resolveMarker!: () => void;
    const markerWritten = new Promise<void>((resolve) => {
      resolveMarker = resolve;
    });
    const writeSessionMarkerFn = vi.fn(async () => {
      resolveMarker();
    });

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => 796,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn,
    });

    onWebhook('session-daemon-797', createMetadata(797, 'daemon'));
    await markerWritten;

    expect(pidToTrackedSession.get(796)?.happySessionId).toBe('session-daemon-797');
    expect(awaiter).toHaveBeenCalledTimes(1);
    expect(writeSessionMarkerFn).toHaveBeenCalledTimes(1);
  });

  it('notifies when a tracked daemon session reports its canonical session id', async () => {
    const tracked: TrackedSession = {
      pid: 790,
      startedBy: 'daemon',
    };
    const pidToTrackedSession = new Map<number, TrackedSession>([[790, tracked]]);
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();
    const onTrackedSessionReported = vi.fn();

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
      onTrackedSessionReported,
    });

    await onWebhook('session-daemon-790', createMetadata(790, 'daemon'));

    expect(onTrackedSessionReported).toHaveBeenCalledWith(expect.objectContaining({
      happySessionId: 'session-daemon-790',
      pid: 790,
    }));
  });

  it('waits for accepted spawn custody and required readiness before resolving the spawn awaiter', async () => {
    const tracked: TrackedSession = {
      pid: 798,
      startedBy: 'daemon',
      happySessionId: 'session-daemon-798',
      agentRuntimeDaemonServiceAuthorityFilePath:
        '/tmp/runner-authority-readiness-798.json',
    };
    let resolveAcceptedSpawnMarker!: (accepted: boolean) => void;
    tracked.acceptedSpawnMarkerGate = new Promise<boolean>((resolve) => {
      resolveAcceptedSpawnMarker = resolve;
    });
    let resolveReadiness!: () => void;
    const readiness = new Promise<void>((resolve) => {
      resolveReadiness = resolve;
    });
    const awaiter = vi.fn();
    let canonicalMarkerPersisted = false;
    const onTrackedSessionReady = vi.fn(async () => {
      expect(canonicalMarkerPersisted).toBe(true);
      await readiness;
    });
    const onTrackedSessionReported = vi.fn();
    let resolveCanonicalMarker!: () => void;
    const canonicalMarker = new Promise<void>((resolve) => {
      resolveCanonicalMarker = resolve;
    });
    const writeSessionMarkerFn = vi.fn(async () => {
      await canonicalMarker;
      canonicalMarkerPersisted = true;
    });
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession: new Map<number, TrackedSession>([[798, tracked]]),
      pidToAwaiter: new Map<number, (session: TrackedSession) => void>([[798, awaiter]]),
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      readProcessIdentityByPidFn: async () => ({
        pid: tracked.pid,
        processStartTimeMs: 1_717_171_717_798,
        command: '/usr/bin/happier-agent',
      }),
      writeSessionMarkerFn,
      onTrackedSessionReady,
      onTrackedSessionReported,
    });

    const registration = onWebhook('session-daemon-798', createMetadata(798, 'daemon'));

    expect(awaiter).not.toHaveBeenCalled();
    expect(onTrackedSessionReady).not.toHaveBeenCalled();
    expect(onTrackedSessionReported).not.toHaveBeenCalled();

    resolveAcceptedSpawnMarker(true);
    await vi.waitFor(() => expect(writeSessionMarkerFn).toHaveBeenCalledWith(
      expect.objectContaining({
        pid: tracked.pid,
        happySessionId: 'session-daemon-798',
        processStartTimeMs: 1_717_171_717_798,
      }),
    ));
    expect(awaiter).not.toHaveBeenCalled();
    expect(onTrackedSessionReported).toHaveBeenCalledWith(tracked);
    expect(onTrackedSessionReady).not.toHaveBeenCalled();

    resolveCanonicalMarker();
    await vi.waitFor(() => expect(onTrackedSessionReady).toHaveBeenCalledWith(tracked));
    expect(awaiter).not.toHaveBeenCalled();
    expect(onTrackedSessionReported).toHaveBeenCalledOnce();

    resolveReadiness();
    await expect(registration).resolves.toBeUndefined();
    expect(awaiter).toHaveBeenCalledOnce();
    expect(onTrackedSessionReported).toHaveBeenCalledWith(tracked);
  });

  it('waits for report-scoped canonical readiness before resolving the spawn awaiter', async () => {
    const tracked: TrackedSession = {
      pid: 796,
      startedBy: 'daemon',
      acceptedSpawnMarkerGate: Promise.resolve(true),
      agentRuntimeDaemonServiceAuthorityFilePath:
        '/tmp/runner-authority-readiness.json',
    };
    const awaiter = vi.fn();
    let resolveCanonicalReadiness!: () => void;
    const canonicalReadiness = new Promise<void>((resolve) => {
      resolveCanonicalReadiness = resolve;
    });
    let canonicalMarkerPersisted = false;
    const reconcileCanonicalReadiness = vi.fn(async () => {
      expect(canonicalMarkerPersisted).toBe(true);
      await canonicalReadiness;
    });
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession: new Map([[tracked.pid, tracked]]),
      pidToAwaiter: new Map([[tracked.pid, awaiter]]),
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      listSessionMarkersFn: async () => [],
      readProcessIdentityByPidFn: async () => ({
        pid: tracked.pid,
        processStartTimeMs: 1_717_171_717_796,
        command: '/usr/bin/happier-agent',
      }),
      writeSessionMarkerFn: vi.fn(async () => {
        canonicalMarkerPersisted = true;
      }),
    });

    const registration = onWebhook(
      'session-daemon-796',
      createMetadata(tracked.pid, 'daemon'),
      reconcileCanonicalReadiness,
    );

    await vi.waitFor(() => {
      expect(reconcileCanonicalReadiness).toHaveBeenCalledWith(tracked);
    });
    expect(awaiter).not.toHaveBeenCalled();

    resolveCanonicalReadiness();
    await expect(registration).resolves.toBeUndefined();
    expect(awaiter).toHaveBeenCalledOnce();
  });

  it('joins concurrent non-Windows canonical reports into one fresh-spawn readiness reconciliation', async () => {
    const tracked: TrackedSession = {
      pid: 7_961,
      startedBy: 'daemon',
      acceptedSpawnMarkerGate: Promise.resolve(true),
      agentRuntimeDaemonServiceAuthorityFilePath:
        '/tmp/runner-authority-readiness-concurrent.json',
    };
    const awaiter = vi.fn();
    let releaseReadiness!: () => void;
    const readiness = new Promise<void>((resolve) => {
      releaseReadiness = resolve;
    });
    const reconcileCanonicalReadiness = vi.fn(async () => {
      await readiness;
    });
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession: new Map([[tracked.pid, tracked]]),
      pidToAwaiter: new Map([[tracked.pid, awaiter]]),
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      listSessionMarkersFn: async () => [],
      readProcessIdentityByPidFn: async () => ({
        pid: tracked.pid,
        processStartTimeMs: 1_717_171_717_961,
        command: '/usr/bin/happier-agent',
      }),
      writeSessionMarkerFn: vi.fn(async () => undefined),
    });

    const first = onWebhook(
      'session-daemon-7961',
      createMetadata(tracked.pid, 'daemon'),
      reconcileCanonicalReadiness,
    );
    await vi.waitFor(() => {
      expect(reconcileCanonicalReadiness).toHaveBeenCalledOnce();
    });
    const retry = onWebhook(
      'session-daemon-7961',
      createMetadata(tracked.pid, 'daemon'),
      reconcileCanonicalReadiness,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reconcileCanonicalReadiness).toHaveBeenCalledOnce();
    releaseReadiness();
    await expect(Promise.all([first, retry])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(awaiter).toHaveBeenCalledOnce();

    await expect(onWebhook(
      'session-daemon-7961',
      createMetadata(tracked.pid, 'daemon'),
      reconcileCanonicalReadiness,
    )).resolves.toBeUndefined();
    expect(reconcileCanonicalReadiness).toHaveBeenCalledOnce();
    expect(tracked.spawnStartupReadinessFailure).toBeUndefined();
  });

  it('does not apply fresh-spawn readiness reconciliation to reattached runners', async () => {
    const tracked: TrackedSession = {
      pid: 7_962,
      startedBy: 'daemon',
      happySessionId: 'session-daemon-7962',
      reattachedFromDiskMarker: true,
      agentRuntimeDaemonServiceAuthorityFilePath:
        '/tmp/runner-authority-readiness-reattached.json',
    };
    const reconcileCanonicalReadiness = vi.fn(async () => {
      throw new Error('fresh-spawn readiness must not run');
    });
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession: new Map([[tracked.pid, tracked]]),
      pidToAwaiter: new Map(),
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      listSessionMarkersFn: async () => [],
      readProcessIdentityByPidFn: async () => ({
        pid: tracked.pid,
        processStartTimeMs: 1_717_171_717_962,
        command: '/usr/bin/happier-agent',
      }),
      writeSessionMarkerFn: vi.fn(async () => undefined),
    });

    await expect(onWebhook(
      tracked.happySessionId!,
      createMetadata(tracked.pid, 'daemon'),
      reconcileCanonicalReadiness,
    )).resolves.toBeUndefined();
    expect(reconcileCanonicalReadiness).not.toHaveBeenCalled();
    expect(tracked.spawnStartupReadinessFailure).toBeUndefined();
  });

  it('fails the existing spawn readiness result when report-scoped canonical readiness rejects', async () => {
    const tracked: TrackedSession = {
      pid: 795,
      startedBy: 'daemon',
      acceptedSpawnMarkerGate: Promise.resolve(true),
      agentRuntimeDaemonServiceAuthorityFilePath:
        '/tmp/runner-authority-readiness-failure.json',
    };
    const pidToTrackedSession = new Map([[tracked.pid, tracked]]);
    const pidToAwaiter =
      new Map<number, (session: TrackedSession) => void>();
    const pidToSpawnResultResolver =
      new Map<number, (result: SpawnSessionResult) => void>();
    const pidToSpawnWebhookTimeout = new Map<number, NodeJS.Timeout>();
    const spawnResult = waitForSessionWebhook({
      pid: tracked.pid,
      pidToTrackedSession,
      pidToAwaiter,
      pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout,
      timeoutErrorMessage: 'unexpected timeout',
    });
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      listSessionMarkersFn: async () => [],
      readProcessIdentityByPidFn: async () => ({
        pid: tracked.pid,
        processStartTimeMs: 1_717_171_717_795,
        command: '/usr/bin/happier-agent',
      }),
      writeSessionMarkerFn: vi.fn(async () => undefined),
    });

    await expect(onWebhook(
      'session-daemon-795',
      createMetadata(tracked.pid, 'daemon'),
      async () => {
        throw new Error('runner authority refresh failed');
      },
    )).rejects.toThrow('runner authority refresh failed');
    await expect(spawnResult).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      errorMessage: 'Session startup reconciliation failed',
    });
    expect(pidToAwaiter.size).toBe(0);
    expect(pidToSpawnResultResolver.size).toBe(0);
    expect(pidToSpawnWebhookTimeout.size).toBe(0);
  });

  it('returns canonical-session activation failure through the spawn awaiter and rejects startup acknowledgement', async () => {
    const failure = {
      type: 'error' as const,
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'connected_account_request_auth_activation_failed',
    };
    const activateConnectedAccountSessionBindingOnCanonicalSession =
      vi.fn(async () => failure);
    const tracked: TrackedSession = {
      pid: 797,
      startedBy: 'daemon',
      acceptedSpawnMarkerGate: Promise.resolve(true),
      activateConnectedAccountSessionBindingOnCanonicalSession,
    };
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [tracked.pid, tracked],
    ]);
    const pidToAwaiter =
      new Map<number, (session: TrackedSession) => void>();
    const pidToSpawnResultResolver =
      new Map<number, (result: SpawnSessionResult) => void>();
    const pidToSpawnWebhookTimeout = new Map<number, NodeJS.Timeout>();
    const spawnResult = waitForSessionWebhook({
      pid: tracked.pid,
      pidToTrackedSession,
      pidToAwaiter,
      pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout,
      timeoutErrorMessage: 'unexpected timeout',
    });
    const onTrackedSessionReady = vi.fn();
    const writeSessionMarkerFn = vi.fn(async () => {});
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn,
      onTrackedSessionReady,
    });

    await expect(
      onWebhook(
        'session-from-server',
        createMetadata(tracked.pid, 'daemon'),
      ),
    ).rejects.toThrow(failure.errorMessage);
    await expect(spawnResult).resolves.toEqual(failure);
    expect(
      activateConnectedAccountSessionBindingOnCanonicalSession,
    ).toHaveBeenCalledWith('session-from-server');
    expect(onTrackedSessionReady).not.toHaveBeenCalled();
    expect(
      tracked.activateConnectedAccountSessionBindingOnCanonicalSession,
    ).toBeUndefined();
    expect(pidToAwaiter.size).toBe(0);
    expect(pidToSpawnResultResolver.size).toBe(0);
    expect(pidToSpawnWebhookTimeout.size).toBe(0);

    await expect(
      onWebhook(
        'session-from-server',
        createMetadata(tracked.pid, 'daemon'),
      ),
    ).rejects.toThrow(failure.errorMessage);
    expect(
      activateConnectedAccountSessionBindingOnCanonicalSession,
    ).toHaveBeenCalledOnce();
    expect(onTrackedSessionReady).not.toHaveBeenCalled();
    expect(writeSessionMarkerFn).not.toHaveBeenCalled();
  });

  it('keeps ordinary fresh-daemon marker refresh failure best effort', async () => {
    const tracked: TrackedSession = {
      pid: 793,
      startedBy: 'daemon',
      acceptedSpawnMarkerGate: Promise.resolve(true),
      activateConnectedAccountSessionBindingOnCanonicalSession:
        vi.fn(async () => null),
    };
    const awaiter = vi.fn();
    const writeSessionMarkerFn = vi.fn(async () => {
      throw new Error('ordinary marker refresh failed');
    });
    const onTrackedSessionReady = vi.fn(async () => undefined);
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession: new Map([[tracked.pid, tracked]]),
      pidToAwaiter: new Map([[tracked.pid, awaiter]]),
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      readProcessIdentityByPidFn: async () => ({
        pid: tracked.pid,
        processStartTimeMs: 1_717_171_717_793,
        command: '/usr/bin/happier-agent',
      }),
      writeSessionMarkerFn,
      onTrackedSessionReady,
    });

    await expect(onWebhook(
      'session-daemon-793',
      createMetadata(tracked.pid, 'daemon'),
    )).resolves.toBeUndefined();
    await vi.waitFor(() => expect(writeSessionMarkerFn).toHaveBeenCalledOnce());
    expect(writeSessionMarkerFn).toHaveBeenCalledWith(
      expect.objectContaining({
        happySessionId: 'session-daemon-793',
      }),
    );
    expect(onTrackedSessionReady).toHaveBeenCalledWith(tracked);
    expect(tracked.spawnStartupReadinessFailure).toBeUndefined();
    expect(awaiter).toHaveBeenCalledOnce();
  });

  it('completes original startup waiter custody after pre-canonical wrapper promotion', async () => {
    const wrapperPid = 792;
    const runnerPid = 793;
    const trackedBeforePromotion: TrackedSession = {
      pid: wrapperPid,
      startedBy: 'daemon',
      happySessionId: `PID-${wrapperPid}`,
      sessionRunnerPid: runnerPid,
      agentRuntimeDaemonServiceAuthorityFilePath:
        '/tmp/runner-authority-readiness-promoted.json',
      activateConnectedAccountSessionBindingOnCanonicalSession:
        vi.fn(async () => null),
    };
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [wrapperPid, trackedBeforePromotion],
    ]);
    const pidToAwaiter =
      new Map<number, (session: TrackedSession) => void>();
    const pidToSpawnResultResolver =
      new Map<number, (result: SpawnSessionResult) => void>();
    const pidToSpawnWebhookTimeout =
      new Map<number, NodeJS.Timeout>();
    const spawnResult = waitForSessionWebhook({
      pid: wrapperPid,
      pidToTrackedSession,
      pidToAwaiter,
      pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout,
      timeoutMs: 1_000,
      timeoutErrorMessage: 'unexpected timeout',
    });
    const promoted: TrackedSession = {
      ...trackedBeforePromotion,
      pid: runnerPid,
      happySessionId: `PID-${runnerPid}`,
      sessionRunnerPid: undefined,
      spawnStartupAwaiterPid: wrapperPid,
    };
    pidToTrackedSession.delete(wrapperPid);
    pidToTrackedSession.set(runnerPid, promoted);
    const writeSessionMarkerFn = vi.fn(async () => undefined);
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      readProcessIdentityByPidFn: async () => ({
        pid: runnerPid,
        processStartTimeMs: 1_717_171_717_793,
        command: '/usr/bin/happier-agent',
      }),
      writeSessionMarkerFn,
      onTrackedSessionReady: vi.fn(async () => undefined),
    });

    await expect(onWebhook(
      'session-daemon-promoted',
      createMetadata(runnerPid, 'daemon'),
    )).resolves.toBeUndefined();
    await expect(spawnResult).resolves.toEqual({
      type: 'success',
      sessionId: 'session-daemon-promoted',
    });
    expect(writeSessionMarkerFn).toHaveBeenCalledWith(
      expect.objectContaining({
        pid: runnerPid,
        happySessionId: 'session-daemon-promoted',
      }),
      { adoptCanonicalSessionIdFromPidPlaceholder: true },
    );
    expect(pidToAwaiter).toHaveLength(0);
    expect(pidToSpawnResultResolver).toHaveLength(0);
    expect(pidToSpawnWebhookTimeout).toHaveLength(0);
    expect(promoted.spawnStartupAwaiterPid).toBeUndefined();
  });

  it('locks the first canonical daemon session identity across concurrent webhooks', async () => {
    let resolveActivation!: () => void;
    const activation = new Promise<void>((resolve) => {
      resolveActivation = resolve;
    });
    const activateConnectedAccountSessionBindingOnCanonicalSession =
      vi.fn(async () => {
        await activation;
        return null;
      });
    const tracked: TrackedSession = {
      pid: 796,
      startedBy: 'daemon',
      acceptedSpawnMarkerGate: Promise.resolve(true),
      activateConnectedAccountSessionBindingOnCanonicalSession,
    };
    const onTrackedSessionReady = vi.fn();
    const writeSessionMarkerFn = vi.fn(async () => {});
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession: new Map<number, TrackedSession>([
        [tracked.pid, tracked],
      ]),
      pidToAwaiter: new Map(),
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn,
      onTrackedSessionReady,
    });

    const first = onWebhook(
      'session-first',
      createMetadata(tracked.pid, 'daemon'),
    );
    await vi.waitFor(() => {
      expect(
        activateConnectedAccountSessionBindingOnCanonicalSession,
      ).toHaveBeenCalledOnce();
    });
    const conflicting = onWebhook(
      'session-conflict',
      createMetadata(tracked.pid, 'daemon'),
    );
    await expect(conflicting).rejects.toThrow(
      'connected_account_canonical_session_identity_conflict',
    );
    expect(tracked.happySessionId).toBe('session-first');

    resolveActivation();
    await expect(first).rejects.toThrow(
      'connected_account_canonical_session_identity_conflict',
    );
    expect(onTrackedSessionReady).not.toHaveBeenCalled();
    expect(writeSessionMarkerFn).not.toHaveBeenCalled();
  });

  it('rejects a canonical webhook that conflicts with a known daemon session before readiness effects', async () => {
    const tracked: TrackedSession = {
      pid: 797,
      startedBy: 'daemon',
      happySessionId: 'session-expected',
      acceptedSpawnMarkerGate:
        Promise.resolve(true),
    };
    const onTrackedSessionReady = vi.fn();
    const writeSessionMarkerFn =
      vi.fn(async () => undefined);
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession:
        new Map([[tracked.pid, tracked]]),
      pidToAwaiter: new Map(),
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn,
      onTrackedSessionReady,
    });

    await expect(onWebhook(
      'session-conflict',
      createMetadata(tracked.pid, 'daemon'),
    )).rejects.toThrow(
      'connected_account_canonical_session_identity_conflict',
    );
    expect(tracked.happySessionId)
      .toBe('session-expected');
    expect(tracked.spawnStartupReadinessFailure)
      .toMatchObject({
        errorCode:
          SPAWN_SESSION_ERROR_CODES
            .SPAWN_VALIDATION_FAILED,
        errorMessage:
          'connected_account_canonical_session_identity_conflict',
      });
    expect(onTrackedSessionReady)
      .not.toHaveBeenCalled();
    expect(writeSessionMarkerFn)
      .not.toHaveBeenCalled();
  });

  it('rejects required readiness when accepted spawn custody is declined', async () => {
    const tracked: TrackedSession = {
      pid: 799,
      startedBy: 'daemon',
    };
    let resolveAcceptedSpawnMarker!: (accepted: boolean) => void;
    tracked.acceptedSpawnMarkerGate = new Promise<boolean>((resolve) => {
      resolveAcceptedSpawnMarker = resolve;
    });
    const onTrackedSessionReady = vi.fn();
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession: new Map<number, TrackedSession>([[799, tracked]]),
      pidToAwaiter: new Map<number, (session: TrackedSession) => void>(),
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
      onTrackedSessionReady,
    });

    const registration = onWebhook('session-daemon-799', createMetadata(799, 'daemon'));
    resolveAcceptedSpawnMarker(false);

    await expect(registration).rejects.toThrow('spawn custody');
    expect(onTrackedSessionReady).not.toHaveBeenCalled();
  });

  it('does not fail session registration when a best-effort tracked-session observer throws synchronously', () => {
    const tracked: TrackedSession = {
      pid: 791,
      startedBy: 'daemon',
    };
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession: new Map<number, TrackedSession>([[791, tracked]]),
      pidToAwaiter: new Map<number, (session: TrackedSession) => void>(),
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
      onTrackedSessionReported: () => {
        throw new ReferenceError('optional observer is unavailable');
      },
    });

    expect(() => onWebhook('session-daemon-791', createMetadata(791, 'daemon'))).not.toThrow();
    expect(tracked.happySessionId).toBe('session-daemon-791');
  });

  it('stores vendorResumeId from session metadata when available', () => {
    const tracked: TrackedSession = {
      pid: 444,
      startedBy: 'daemon',
    };
    const pidToTrackedSession = new Map<number, TrackedSession>([[444, tracked]]);
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
    });

    onWebhook('session-daemon-444', {
      ...createMetadata(444, 'daemon'),
      flavor: 'codex',
      codexSessionId: 'vendor-session-444',
    });

    expect(pidToTrackedSession.get(444)?.vendorResumeId).toBe('vendor-session-444');
  });

  it('does not preserve durable connected-service restart intent by default when refreshing a daemon marker from webhook metadata', async () => {
    const tracked: TrackedSession = {
      pid: 447,
      startedBy: 'daemon',
    };
    const pidToTrackedSession = new Map<number, TrackedSession>([[447, tracked]]);
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    let markerOptions: unknown;
    let resolveMarker!: () => void;
    const markerWritten = new Promise<void>((resolve) => {
      resolveMarker = resolve;
    });

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async (_args: unknown, options: unknown) => {
        markerOptions = options;
        resolveMarker();
      },
    } as any);

    onWebhook('session-daemon-447', {
      ...createMetadata(447, 'daemon'),
      flavor: 'codex',
      codexSessionId: 'vendor-session-447',
    });
    await markerWritten;

    expect(markerOptions).toBeUndefined();
  });

  it('does not preserve durable connected-service restart intent through routine marker refreshes', async () => {
    const tracked: TrackedSession = {
      pid: 448,
      startedBy: 'daemon',
    };
    const pidToTrackedSession = new Map<number, TrackedSession>([[448, tracked]]);
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    let markerOptions: unknown;
    let resolveMarker!: () => void;
    const markerWritten = new Promise<void>((resolve) => {
      resolveMarker = resolve;
    });

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async (_args: unknown, options: unknown) => {
        markerOptions = options;
        resolveMarker();
      },
    } as any);

    onWebhook('session-daemon-448', {
      ...createMetadata(448, 'daemon'),
      flavor: 'codex',
      codexSessionId: 'vendor-session-448',
    });
    await markerWritten;

    expect(markerOptions).toBeUndefined();
  });

   it('preserves a previously discovered provider session id when a later webhook metadata payload is stale', async () => {
    const tracked: TrackedSession = {
      pid: 445,
      startedBy: 'daemon',
      happySessionId: 'session-daemon-445',
    };
    const pidToTrackedSession = new Map<number, TrackedSession>([[445, tracked]]);
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    let markerArgs: any = null;
    let resolveMarker!: () => void;
    const markerWritten = new Promise<void>((resolve) => {
      resolveMarker = resolve;
    });

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      listSessionMarkersFn: async () => [
        {
          pid: 445,
          happySessionId: 'session-daemon-445',
          happyHomeDir: configuration.happyHomeDir,
          createdAt: 1,
          updatedAt: 2,
          flavor: 'ohMyPi',
          metadata: {
            flavor: 'ohMyPi',
            hostPid: 445,
            path: '/tmp',
            ohMyPiSessionId: 'omp-session-existing',
          },
        },
      ],
      writeSessionMarkerFn: async (args: Record<string, unknown>) => {
        markerArgs = args;
        resolveMarker();
      },
    } as any);

    onWebhook('session-daemon-445', {
      ...createMetadata(445, 'daemon'),
      flavor: 'ohMyPi',
    });
    await markerWritten;

    expect(markerArgs.metadata).toEqual(expect.objectContaining({
      flavor: 'ohMyPi',
      hostPid: 445,
      ohMyPiSessionId: 'omp-session-existing',
    }));
  });

  it('does not resolve daemon awaiter on PID placeholder and resolves on canonical id', async () => {
    const tracked: TrackedSession = {
      pid: 9001,
      startedBy: 'daemon',
    };
    const pidToTrackedSession = new Map<number, TrackedSession>([[9001, tracked]]);
    const awaiter = vi.fn();
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>([[9001, awaiter]]);

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
    });

    await onWebhook('PID-9001', createMetadata(9001, 'daemon'));

    expect(awaiter).toHaveBeenCalledTimes(0);
    expect(pidToAwaiter.has(9001)).toBe(true);
    expect(pidToTrackedSession.get(9001)?.happySessionId).toBe('PID-9001');

    await onWebhook('session-real-9001', createMetadata(9001, 'daemon'));

    expect(awaiter).toHaveBeenCalledTimes(1);
    expect(pidToAwaiter.has(9001)).toBe(false);
    expect(pidToTrackedSession.get(9001)?.happySessionId).toBe('session-real-9001');
  });

  it('expands tilde paths before writing the session marker', async () => {
    const pidToTrackedSession = new Map<number, TrackedSession>();
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    let markerArgs: any = null;
    let resolveMarker!: () => void;
    const markerWritten = new Promise<void>((resolve) => {
      resolveMarker = resolve;
    });

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async (args) => {
        markerArgs = args;
        resolveMarker();
      },
    });

    onWebhook('PID-321', createMetadata(321, 'terminal', '~/Documents/Development/happier/dev'));
    await markerWritten;

    const expected = path.join(os.homedir(), 'Documents', 'Development', 'happier', 'dev');
    expect(markerArgs.cwd).toBe(expected);
    expect(markerArgs.metadata.path).toBe(expected);
  });

  it('normalizes Windows home paths through the canonical CLI path owner', () => {
    expect(resolveSessionWebhookPath(
      '~\\Documents/happier',
      { USERPROFILE: 'C:\\Users\\Alice' },
      'win32',
    )).toBe('C:\\Users\\Alice\\Documents\\happier');
  });

  it('includes safe and sealed respawn env continuity for daemon-spawned sessions with spawnOptions', async () => {
    const credentials = {
      token: 't',
      encryption: {
        type: 'dataKey' as const,
        publicKey: new Uint8Array(32).fill(3),
        machineKey: new Uint8Array(32).fill(9),
      },
    };

    const tracked: TrackedSession = {
      pid: 555,
      startedBy: 'daemon',
      spawnOptions: {
        directory: '/tmp/workspace',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        transcriptStorage: 'direct',
        token: 'secret-token-should-not-be-persisted',
        resume: 'vendor-resume-id',
        environmentVariables: {
          CLAUDE_CONFIG_DIR: '/tmp/claude-config',
          CODEX_HOME: '/tmp/codex-home',
          ANTHROPIC_AUTH_TOKEN: 'secret-provider-token',
          FOO: 'bar',
        },
        terminal: {
          mode: 'tmux',
          tmux: { sessionName: 'happy', isolated: true, tmpDir: '/tmp/tmux' },
        },
      } as any,
    };

    const pidToTrackedSession = new Map<number, TrackedSession>([[555, tracked]]);
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    let markerArgs: any = null;
    let resolveMarker!: () => void;
    const markerWritten = new Promise<void>((resolve) => {
      resolveMarker = resolve;
    });

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      readCredentialsFn: async () => credentials,
      writeSessionMarkerFn: async (args: Record<string, unknown>) => {
        markerArgs = args;
        resolveMarker();
      },
    } as any);

    onWebhook('session-daemon-555', createMetadata(555, 'daemon', '/tmp/workspace'));
    await markerWritten;

    expect(markerArgs.respawn).toEqual({
      version: 1,
      directory: '/tmp/workspace',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      resume: 'vendor-resume-id',
      terminal: {
        mode: 'tmux',
        tmux: { sessionName: 'happy', isolated: true, tmpDir: '/tmp/tmux' },
      },
      transcriptStorage: 'direct',
      environmentVariables: {
        CLAUDE_CONFIG_DIR: '/tmp/claude-config',
        CODEX_HOME: '/tmp/codex-home',
      },
      sealedEnvironmentVariables: {
        format: 'account_scoped_v1',
        ciphertext: expect.any(String),
      },
    });
    expect(markerArgs.respawn?.token).toBeUndefined();
    expect(markerArgs.respawn?.environmentVariables).not.toMatchObject({
      ANTHROPIC_AUTH_TOKEN: expect.any(String),
      FOO: expect.any(String),
    });
  });

  it('persists zellij topology in the daemon marker respawn fallback', async () => {
    const tracked: TrackedSession = {
      pid: 556,
      startedBy: 'daemon',
      spawnOptions: {
        directory: '/tmp/workspace',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        terminal: {
          mode: 'zellij',
        },
      },
    };
    let resolveMarker!: () => void;
    const markerWritten = new Promise<void>((resolve) => {
      resolveMarker = resolve;
    });
    type WriteSessionMarkerFn = NonNullable<
      Parameters<typeof createOnHappySessionWebhook>[0]['writeSessionMarkerFn']
    >;
    const captured = {
      marker: undefined as Parameters<WriteSessionMarkerFn>[0] | undefined,
    };
    const writeSessionMarkerFn = vi.fn<WriteSessionMarkerFn>(async (
      marker: Parameters<WriteSessionMarkerFn>[0],
    ) => {
      captured.marker = marker;
      resolveMarker();
    });
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession: new Map([[tracked.pid, tracked]]),
      pidToAwaiter: new Map(),
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn,
    });

    onWebhook('session-zellij-556', createMetadata(556, 'daemon', '/tmp/workspace'));
    await markerWritten;

    expect(captured.marker?.respawn).toMatchObject({
      version: 1,
      directory: '/tmp/workspace',
      terminal: {
        mode: 'zellij',
      },
    });
  });

  it('matches an unknown webhook PID to a daemon-tracked wrapper PID via PPID and resolves awaiter', async () => {
    const wrapperPid = 111;
    const runnerPid = 222;
    const tracked: TrackedSession = { pid: wrapperPid, startedBy: 'daemon' };
    const pidToTrackedSession = new Map<number, TrackedSession>([[wrapperPid, tracked]]);
    const awaiter = vi.fn();
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>([[wrapperPid, awaiter]]);

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => wrapperPid,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
    });

    await onWebhook('session-real-222', createMetadata(runnerPid, 'daemon'));

    expect(awaiter).toHaveBeenCalledTimes(1);
    expect(pidToAwaiter.has(wrapperPid)).toBe(false);
    expect(pidToTrackedSession.has(runnerPid)).toBe(false);
    expect(pidToTrackedSession.get(wrapperPid)?.happySessionId).toBe('session-real-222');
    expect(pidToTrackedSession.get(wrapperPid)?.sessionRunnerPid).toBe(runnerPid);
  });

  it('defers wrapper awaiter resolution on PID placeholder and resolves on canonical id', async () => {
    const wrapperPid = 111;
    const runnerPid = 222;
    const tracked: TrackedSession = { pid: wrapperPid, startedBy: 'daemon' };
    const pidToTrackedSession = new Map<number, TrackedSession>([[wrapperPid, tracked]]);
    const awaiter = vi.fn();
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>([[wrapperPid, awaiter]]);

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => wrapperPid,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
    });

    await onWebhook(`PID-${runnerPid}`, createMetadata(runnerPid, 'daemon'));

    expect(awaiter).toHaveBeenCalledTimes(0);
    expect(pidToAwaiter.has(wrapperPid)).toBe(true);

    await onWebhook('session-real-222', createMetadata(runnerPid, 'daemon'));

    expect(awaiter).toHaveBeenCalledTimes(1);
    expect(pidToAwaiter.has(wrapperPid)).toBe(false);
  });

  it('falls back to daemon child spawn arguments when process discovery cannot resolve command identity', async () => {
    const sessionPid = 777;
    const spawnArgs = [
      '/usr/bin/node',
      '/repo/.project/tmp/cli-dist-snapshot/src/index.ts',
      'claude',
      '--happy-starting-mode',
      'remote',
      '--started-by',
      'daemon',
    ];
    const tracked: TrackedSession = {
      pid: sessionPid,
      startedBy: 'daemon',
      childProcess: { pid: sessionPid, spawnargs: spawnArgs } as any,
    };
    const pidToTrackedSession = new Map<number, TrackedSession>([[sessionPid, tracked]]);
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    let markerArgs: any = null;
    let resolveMarker!: () => void;
    const markerWritten = new Promise<void>((resolve) => {
      resolveMarker = resolve;
    });

    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      readProcessIdentityByPidFn: async () => ({
        pid: sessionPid,
        processStartTimeMs: 1_717_171_717_000,
        command: '',
      }),
      writeSessionMarkerFn: async (args) => {
        markerArgs = args;
        resolveMarker();
      },
    });

    onWebhook('session-daemon-777', createMetadata(sessionPid, 'daemon', '/tmp/workspace'));
    await markerWritten;

    const expectedCommand = spawnArgs.join(' ');
    expect(markerArgs.processCommand).toBe(expectedCommand);
    expect(markerArgs.processCommandHash).toBeDefined();
    expect(markerArgs.processStartTimeMs).toBe(1_717_171_717_000);
    expect(pidToTrackedSession.get(sessionPid)?.processCommand).toBe(expectedCommand);
    expect(pidToTrackedSession.get(sessionPid)?.processCommandHash).toBe(markerArgs.processCommandHash);
    expect(pidToTrackedSession.get(sessionPid)?.processStartTimeMs).toBe(1_717_171_717_000);
  });
});
