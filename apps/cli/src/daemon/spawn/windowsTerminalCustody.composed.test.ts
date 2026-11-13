import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as processInstance from '@happier-dev/cli-common/processInstance';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnSyncReturns } from 'node:child_process';

import type { Metadata } from '@/api/types';
import type { TrackedSession } from '../types';
import type { SpawnLifecycleCallbacks } from './createSpawnLifecycleCallbacks';
import { readOrCreateDeviceLocalSecretStorage } from '../deviceLocalSecretStorage';
import {
  legacyPidSessionTrackingKey,
  trackedSessionForSingleSessionProcess,
  trackedSessionsForProcess,
  untrackSession,
  type SessionTrackingKey,
} from '@/daemon/sessions/sessionTrackingKey';

describe('Windows Terminal exact Agent custody composition', () => {
  const originalHome = process.env.HAPPIER_HOME_DIR;
  const originalRunner =
    process.env.HAPPIER_WINDOWS_SESSION_RUNNER_BINARY;
  const originalPlatform = Object.getOwnPropertyDescriptor(
    process,
    'platform',
  );
  let testRoot = '';

  afterEach(() => {
    vi.doUnmock(
      '../platform/windows/spawnHappyCliWindowsTerminal',
    );
    vi.doUnmock('node:fs');
    vi.doUnmock('@happier-dev/cli-common/process');
    vi.doUnmock('@happier-dev/cli-common/processInstance');
    vi.doUnmock('node:child_process');
    vi.resetModules();

    if (testRoot) {
      rmSync(testRoot, { recursive: true, force: true });
    }
    if (originalHome === undefined) {
      delete process.env.HAPPIER_HOME_DIR;
    } else {
      process.env.HAPPIER_HOME_DIR = originalHome;
    }
    if (originalRunner === undefined) {
      delete process.env
        .HAPPIER_WINDOWS_SESSION_RUNNER_BINARY;
    } else {
      process.env.HAPPIER_WINDOWS_SESSION_RUNNER_BINARY =
        originalRunner;
    }
    if (originalPlatform) {
      Object.defineProperty(
        process,
        'platform',
        originalPlatform,
      );
    }
  });

  it('pretracks before dispatcher settlement, persists the exact Agent marker, transfers custody, and completes readiness', async () => {
    if (!originalPlatform) {
      throw new Error('Expected process.platform descriptor');
    }
    testRoot = join(
      tmpdir(),
      `happier wt custody ${Date.now()}-${Math.random()}`,
    );
    const packageDist = join(testRoot, 'package-dist');
    const binaryPath = join(testRoot, 'happier.exe');
    mkdirSync(packageDist, { recursive: true });
    writeFileSync(
      join(packageDist, 'index.mjs'),
      'export {};\n',
      'utf8',
    );
    writeFileSync(binaryPath, '', 'utf8');
    // Device key persistence uses this runner's real filesystem; only launch/custody emulate Windows.
    const testDeviceLocalSecretStorage = await readOrCreateDeviceLocalSecretStorage({
      path: join(testRoot, 'private', 'device-local-secret.json'),
    });
    process.env.HAPPIER_HOME_DIR = join(testRoot, 'home');
    process.env.HAPPIER_WINDOWS_SESSION_RUNNER_BINARY =
      binaryPath;
    const stopDispatcher = vi.fn();
    const dispatchers: ChildProcess[] = [];
    // Native process/stdio and PowerShell inventory are OS ports; launch and custody stay real.
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return {
        ...actual,
        // The lock's reclaim witness uses the synchronous PowerShell process-birth OS port.
        spawnSync: (): SpawnSyncReturns<string> => ({
          pid: process.pid, status: 0, signal: null,
          stdout: '1970-01-01T00:00:01.0000000Z', stderr: '',
          output: [null, '1970-01-01T00:00:01.0000000Z', ''],
        }),
        spawn: () => {
          const child = new actual.ChildProcess();
          Object.defineProperties(child, {
            pid: { value: 8_888 },
            stdout: { value: new PassThrough() },
            stderr: { value: new PassThrough() },
            kill: { value: () => {
              stopDispatcher();
              Object.defineProperty(child, 'killed', { configurable: true, value: true });
              return true;
            } },
          });
          dispatchers.push(child);
          return child;
        },
        execFile: (_command: string, _args: readonly string[], _options: unknown,
          callback: (error: Error | null, stdout: string, stderr: string) => void) => {
          const child = new actual.ChildProcess();
          queueMicrotask(() => {
            callback(null, JSON.stringify([{ ProcessId: process.pid, ParentProcessId: process.ppid,
              ProcessStartTimeMs: 1_000, CommandLine: 'happier test owner', ExecutablePath: process.execPath }]), '');
            child.emit('close', 0, null);
          });
          return child;
        },
      };
    });
    // This suite emulates Windows on Linux workers. Keep marker/lock logic
    // real, but supply the OS inventory fact for this live test process.
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return { ...actual, existsSync: (path: string) => String(path).endsWith('happier-process-custody.exe') || actual.existsSync(path) };
    });
    vi.doMock('@happier-dev/cli-common/process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@happier-dev/cli-common/process')>();
      return { ...actual, execFileWithDeadline: async (command: string, args: readonly string[], options: Parameters<typeof actual.execFileWithDeadline>[2]) => {
        if (args[0] !== 'process-census') return await actual.execFileWithDeadline(command, args, options);
        return { stdout: JSON.stringify({ v: 1, capturedAtMs: Date.now(), logicalCpus: 4, rows: [{
          pid: process.pid, ppid: 1, start: { startTimeMs: 1 }, name: 'node.exe',
          principal: { kind: 'sid', value: 'S-1-5-21-1' }, memory: null, cpuTimeUs: null,
          commandLine: process.execPath, argv: [process.execPath], executablePath: process.execPath,
        }] }), stderr: '' };
      } };
    });
    // The reclaim guard reads the same OS birth witness synchronously.
    vi.doMock('@happier-dev/cli-common/processInstance', () => ({
      ...processInstance, readProcessStartTimeMsSync: (pid: number) =>
        pid === process.pid ? 1 : processInstance.readProcessStartTimeMsSync(pid),
    }));
    vi.resetModules();

    // The census captures its native platform when its reader is created.
    // Initialize the Windows source graph under the same emulated OS boundary.
    Object.defineProperty(process, 'platform', {
      ...originalPlatform,
      value: 'win32',
    });

    // These cold entry points share modules; initialize them sequentially after
    // resetModules so Vitest's mocked-module loader can finish each import.
    const { configuration } = await import('@/configuration');
    const { spawnWindowsHostedSessionAndWaitForWebhook } =
      await import('./spawnWindowsHostedSessionAndWaitForWebhook');
    const { createOnHappySessionWebhook } =
      await import('../sessions/onHappySessionWebhook');
    const { persistAcceptedSpawnMarker } =
      await import('./persistAcceptedSpawnMarker');
    const { listSessionMarkers, removeSessionMarkerIfOwned, writeSessionMarker } =
      await import('../sessionRegistry');
    const { parseWindowsCommandLine, serializeWindowsCommandLine } =
      await import('../platform/windows/windowsCommandLine');
    const { captureExactWindowsTerminalLaunchProcess } =
      await import('../platform/windows/windowsProcessCustody');

    const trackedSessionsByKey =
      new Map<SessionTrackingKey, TrackedSession>();
    const spawnAwaiterByKey =
      new Map<SessionTrackingKey, (tracked: TrackedSession) => void>();
    const spawnResultResolverByKey = new Map();
    const spawnWebhookTimeoutByKey = new Map();
    const spawnResourceCleanupByKey =
      new Map();
    const sessionAttachCleanupByKey =
      new Map();
    let persistedMarkerCustody: Readonly<{
      pid: number;
      ownership: Readonly<{
        happySessionId: string;
        processCommandHash: string;
        processStartTimeMs: number;
      }>;
    }> | null = null;
    let markerPersistenceAfterCommit:
      Promise<void> | null = null;
    let agentCommand = '';
    let agentExecutablePath = '';
    const readAgentIdentity = async (pid: number) =>
      pid === 9_999
        ? {
            pid,
            processStartTimeMs: 2_000,
            executablePath: agentExecutablePath,
            command: agentCommand,
          }
        : null;
    const lifecycle: SpawnLifecycleCallbacks = {
      persistAcceptedSpawnMarker: async (
        tracked,
        options,
      ) => {
        await persistAcceptedSpawnMarker({
          trackedSession: tracked,
          deviceLocalSecretStorage: testDeviceLocalSecretStorage,
          ...(options?.processPid !== undefined
            ? { processPid: options.processPid }
            : {}),
          ...(options?.expectedProcessIdentity
            ? {
                expectedProcessIdentity:
                  options.expectedProcessIdentity,
              }
            : {}),
          readProcessIdentityByPidFn: readAgentIdentity,
        });
        if (
          options?.processPid === undefined
          || !options.expectedProcessIdentity
        ) {
          throw new Error(
            'Expected exact target marker options',
          );
        }
        persistedMarkerCustody = {
          pid: options.processPid,
          ownership: {
            happySessionId:
              tracked.happySessionId
              ?? `PID-${options.processPid}`,
            ...options.expectedProcessIdentity,
          },
        };
        if (markerPersistenceAfterCommit) {
          await markerPersistenceAfterCommit;
        }
      },
      removeAcceptedSpawnMarkerIfOwned:
        removeSessionMarkerIfOwned,
      registerConnectedServiceSpawnTarget: vi.fn(),
      registerSpawnResourceCleanupForSession: (trackingKey) => {
        spawnResourceCleanupByKey.set(trackingKey, vi.fn());
      },
      consumeSessionAttachCleanupForSession: (trackingKey) => {
        sessionAttachCleanupByKey.set(
          trackingKey,
          vi.fn(async () => undefined),
        );
      },
      cleanupPendingSessionAttach:
        vi.fn(async () => undefined),
    };
    const nativeRoot = 'C:/native project root\\nested folder';
    const nativeResumeId = 'native/session with "quotes"\\';
    const spawnPromise =
      spawnWindowsHostedSessionAndWaitForWebhook({
        windowsLaunchMode: 'windows_terminal',
        args: [
          'codex',
          '--happy-starting-mode',
          'remote',
          '--started-by',
          'daemon',
          '--resume',
          nativeResumeId,
        ],
        agentCommand: 'codex',
        directory: nativeRoot,
        options: { directory: nativeRoot },
        trackedSpawnOptions: {
          directory: nativeRoot,
          backendTarget: {
            kind: 'backend',
            backendId: 'codex',
            sourceKind: 'built_in',
          },
          spawnNonce: 'nonce-wt-composed',
        },
        normalizedExistingSessionId: '',
        effectiveResume: '',
        reservedSessionId: 'reserved-wt',
        directoryCreated: false,
        extraEnvForChildWithMessage: {},
        processEnv: {
          ...process.env,
          HAPPIER_WINDOWS_SESSION_RUNNER_BINARY:
            binaryPath,
        },
        happyHomeDir: configuration.happyHomeDir,
        trackedSessionsByKey,
        spawnAwaiterByKey,
        spawnResultResolverByKey,
        spawnWebhookTimeoutByKey,
        resolveCanonicalTrackedSessionId: () =>
          'session-wt-composed',
        onChildExited: vi.fn(),
        spawnLifecycleCallbacks: lifecycle,
        cleanupSpawnResources: vi.fn(),
        logDebug: vi.fn(),
        warn: vi.fn(),
      });

    await vi.waitFor(() => {
      expect(trackedSessionForSingleSessionProcess(trackedSessionsByKey, 8_888)).toBeDefined();
      expect(dispatchers).toHaveLength(1);
    });
    const tracked = trackedSessionForSingleSessionProcess(trackedSessionsByKey, 8_888)!;
    const launched = tracked.windowsTerminalLaunchCustody!;
    expect(launched.argv).toEqual(expect.arrayContaining(['--resume', nativeResumeId]));
    agentExecutablePath = launched.executablePath;
    agentCommand = serializeWindowsCommandLine([
      launched.executablePath,
      ...launched.argv,
    ]);
    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey,
      spawnAwaiterByKey,
      getParentPidFn: (pid) =>
        pid === 7_772 ? 7_771 : null,
      readProcessIdentityByPidFn: readAgentIdentity,
      readAllWindowsProcessFactsFn: async () =>
        new Map([[9_999, {
          pid: 9_999,
          processStartTimeMs: 2_000,
          executablePath: agentExecutablePath,
          command: agentCommand,
        }]]),
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async (marker, options) => {
        if (marker.pid === 9_999) {
          await writeSessionMarker(marker, options);
        }
      },
      readCredentialsFn: async () => null,
    });
    expect(parseWindowsCommandLine(agentCommand)).toEqual([
      tracked.windowsTerminalLaunchCustody!.executablePath,
      ...tracked.windowsTerminalLaunchCustody!.argv,
    ]);
    expect(
      captureExactWindowsTerminalLaunchProcess({
        process: {
          pid: 9_999,
          processStartTimeMs: 2_000,
          executablePath: agentExecutablePath,
          command: agentCommand,
        },
        launch: tracked.windowsTerminalLaunchCustody!,
      }),
    ).toEqual({
      pid: 9_999,
      processStartTimeMs: 2_000,
      processCommandHash: expect.stringMatching(
        /^[a-f0-9]{64}$/u,
      ),
    });
    const activate = vi.fn(async () => null);
    tracked
      .activateConnectedAccountSessionBindingOnCanonicalSession =
        activate;
    const unrelatedTracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(7_771), pid: 7_771,
      startedBy: 'daemon',
    };
    const unrelatedAwaiter = vi.fn();
    trackedSessionsByKey.set(unrelatedTracked.trackingKey, unrelatedTracked);
    spawnAwaiterByKey.set(unrelatedTracked.trackingKey, unrelatedAwaiter);
    const metadata: Metadata = {
      path: nativeRoot,
      host: 'windows-host',
      homeDir: 'C:\\Users\\test',
      happyHomeDir: configuration.happyHomeDir,
      happyLibDir: 'C:\\happier\\lib',
      happyToolsDir: 'C:\\happier\\tools',
      hostPid: 9_999,
      startedBy: 'daemon',
      machineId: 'machine-windows',
      terminal: tracked.hostedTerminal,
    };

    await Promise.race([
      onWebhook(`PID-${metadata.hostPid}`, metadata),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error(
            `Placeholder webhook stalled: tracked=${[
              ...trackedSessionsByKey.keys(),
            ].join(',')}, awaiters=${[
              ...spawnAwaiterByKey.keys(),
            ].join(',')}`,
          ));
        }, 5_000);
      }),
    ]);
    expect(tracked.sessionRunnerPid).toBe(metadata.hostPid);

    await Promise.race([
      Promise.all([
        onWebhook('session-wt-composed', metadata),
        onWebhook('session-unrelated-concurrent', {
          path: 'C:\\other',
          host: 'windows-host',
          homeDir: 'C:\\Users\\test',
          happyHomeDir: configuration.happyHomeDir,
          happyLibDir: 'C:\\happier\\lib',
          happyToolsDir: 'C:\\happier\\tools',
          hostPid: 7_772,
          startedBy: 'daemon',
          machineId: 'machine-windows',
        }),
      ]),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error(
            `Webhook stalled: pidKeys=${[
              ...trackedSessionsByKey.keys(),
            ].join(',')}, persisted=${
              persistedMarkerCustody ? 'yes' : 'no'
            }`,
          ));
        }, 5_000);
      }),
    ]);
    expect(unrelatedAwaiter).toHaveBeenCalledWith(
      unrelatedTracked,
    );
    expect(unrelatedTracked.sessionRunnerPid).toBe(7_772);
    trackedSessionsByKey.delete(unrelatedTracked.trackingKey);
    const spawnResult = await Promise.race([
      spawnPromise,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error(
            `Spawn result stalled: tracked=${[
              ...trackedSessionsByKey.keys(),
            ].join(',')}, awaiters=${[
              ...spawnAwaiterByKey.keys(),
            ].join(',')}, resolvers=${[
              ...spawnResultResolverByKey.keys(),
            ].join(',')}, timeouts=${[
              ...spawnWebhookTimeoutByKey.keys(),
            ].join(',')}`,
          ));
        }, 5_000);
      }),
    ]);
    expect(spawnResult).toEqual({
      type: 'success',
      sessionId: 'session-wt-composed',
    });
    expect(stopDispatcher).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledWith(
      'session-wt-composed',
    );
    // The Session keeps its key; only its hosting pid moved to the agent.
    expect(trackedSessionsForProcess(trackedSessionsByKey, 8_888)).toHaveLength(0);
    expect(trackedSessionsByKey.get(tracked.trackingKey)).toBe(tracked);
    expect(tracked.pid).toBe(9_999);
    const markers = await listSessionMarkers();
    expect(markers).toHaveLength(1);
    expect(markers[0]).toEqual(expect.objectContaining({
      trackingKey: tracked.trackingKey,
      pid: 9_999,
      happySessionId: 'session-wt-composed',
      processStartTimeMs: 2_000,
      respawn: expect.objectContaining({
        spawnNonce: 'nonce-wt-composed',
      }),
    }));
    dispatchers[0]!.stdout?.emit('data', Buffer.from('8889\n'));
    dispatchers[0]!.emit('close', 0, null);
    // Readiness starts the ordinary report-marker write detached; exit
    // retirement awaits it before removing the marker, so this hand-rolled
    // retirement must too.
    await tracked.reportMarkerCustody?.pending;
    await removeSessionMarkerIfOwned({
      trackingKey: markers[0]!.trackingKey,
      happySessionId:
        markers[0]!.happySessionId,
      processCommandHash:
        markers[0]!.processCommandHash,
      processStartTimeMs:
        markers[0]!.processStartTimeMs,
      isStillOwned: () => true,
    });
    untrackSession(trackedSessionsByKey, tracked);
    spawnResourceCleanupByKey.delete(tracked.trackingKey);
    sessionAttachCleanupByKey.delete(tracked.trackingKey);
    persistedMarkerCustody = null;

    let releaseMarkerPersistence!: () => void;
    markerPersistenceAfterCommit =
      new Promise<void>((resolve) => {
        releaseMarkerPersistence = resolve;
      });
    let agentAlive = true;
    const terminateProcessTree = vi.fn(
      async ({ pid }: Readonly<{ pid: number }>) => {
        expect(pid).toBe(9_999);
        agentAlive = false;
      },
    );
    const timeoutOnChildExited = vi.fn(
      async (pid: number) => {
        for (const hosted of trackedSessionsForProcess(trackedSessionsByKey, pid)) {
          untrackSession(trackedSessionsByKey, hosted);
        }
      },
    );
    const timeoutSpawnPromise =
      spawnWindowsHostedSessionAndWaitForWebhook({
        windowsLaunchMode: 'windows_terminal',
        args: [
          'codex',
          '--happy-starting-mode',
          'remote',
          '--started-by',
          'daemon',
        ],
        agentCommand: 'codex',
        directory: 'C:\\repo',
        options: { directory: 'C:\\repo' },
        trackedSpawnOptions: {
          directory: 'C:\\repo',
          backendTarget: {
            kind: 'backend',
            backendId: 'codex',
            sourceKind: 'built_in',
          },
          spawnNonce:
            'nonce-wt-timeout-composed',
        },
        normalizedExistingSessionId: '',
        effectiveResume: '',
        reservedSessionId:
          'reserved-wt-timeout',
        directoryCreated: false,
        extraEnvForChildWithMessage: {},
        processEnv: {
          ...process.env,
          HAPPIER_WINDOWS_SESSION_RUNNER_BINARY:
            binaryPath,
        },
        happyHomeDir: configuration.happyHomeDir,
        trackedSessionsByKey,
        spawnAwaiterByKey,
        spawnResultResolverByKey,
        spawnWebhookTimeoutByKey,
        resolveCanonicalTrackedSessionId: () =>
          'session-wt-timeout-composed',
        onChildExited: timeoutOnChildExited,
        spawnLifecycleCallbacks: lifecycle,
        cleanupSpawnResources: vi.fn(),
        logDebug: vi.fn(),
        warn: vi.fn(),
        windowsProcessCustodyDependencies: {
          readAllWindowsProcessFactsFn:
            async () => new Map(),
          readProcessIdentityByPidFn:
            async (pid) =>
              pid === 9_999 && agentAlive
                ? {
                    pid,
                    processStartTimeMs: 2_000,
                    executablePath:
                      agentExecutablePath,
                    command: agentCommand,
                  }
                : null,
          terminateProcessTreeFn:
            terminateProcessTree,
          isPidAliveFn: (pid) =>
            pid === 9_999 && agentAlive,
          nowFn: () => 0,
          sleepFn: async () => undefined,
        },
      });
    await vi.waitFor(() => {
      const hosted = trackedSessionForSingleSessionProcess(trackedSessionsByKey, 8_888);
      expect(hosted).toBeDefined();
      expect(spawnResultResolverByKey.get(hosted!.trackingKey))
        .toEqual(expect.any(Function));
    });
    const timeoutTracked =
      trackedSessionForSingleSessionProcess(trackedSessionsByKey, 8_888)!;
    const timeoutLaunched = timeoutTracked.windowsTerminalLaunchCustody!;
    agentExecutablePath = timeoutLaunched.executablePath;
    agentCommand = serializeWindowsCommandLine([
      timeoutLaunched.executablePath,
      ...timeoutLaunched.argv,
    ]);
    const timeoutMetadata: Metadata = {
      path: 'C:\\repo',
      host: 'windows-host',
      homeDir: 'C:\\Users\\test',
      happyHomeDir: configuration.happyHomeDir,
      happyLibDir: 'C:\\happier\\lib',
      happyToolsDir: 'C:\\happier\\tools',
      hostPid: 9_999,
      startedBy: 'daemon',
      machineId: 'machine-windows',
      terminal: timeoutTracked.hostedTerminal,
    };
    const timeoutWebhook = onWebhook(
      'session-wt-timeout-composed',
      timeoutMetadata,
    );
    await vi.waitFor(async () => {
      expect(persistedMarkerCustody?.ownership)
        .toMatchObject({
          happySessionId:
            'session-wt-timeout-composed',
          processStartTimeMs: 2_000,
        });
      const committedMarkers =
        await listSessionMarkers();
      expect(committedMarkers).toHaveLength(1);
    });
    timeoutTracked.sessionWebhookTimedOutAtMs =
      Date.now();
    spawnResultResolverByKey.get(timeoutTracked.trackingKey)?.({
      type: 'error',
      errorCode: 'SESSION_WEBHOOK_TIMEOUT',
      errorMessage:
        'Session webhook timeout for PID 8888',
    });
    releaseMarkerPersistence();

    await expect(timeoutWebhook).rejects.toThrow(
      'spawn custody was not accepted',
    );
    await expect(timeoutSpawnPromise).resolves
      .toMatchObject({
        type: 'error',
        errorCode: 'SESSION_WEBHOOK_TIMEOUT',
      });
    expect(terminateProcessTree)
      .toHaveBeenCalledOnce();
    expect(timeoutOnChildExited)
      .toHaveBeenCalledOnce();
    expect(trackedSessionsByKey.has(timeoutTracked.trackingKey))
      .toBe(false);
    expect(await listSessionMarkers())
      .toHaveLength(0);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(await listSessionMarkers())
      .toHaveLength(0);
    dispatchers[1]!.stdout?.emit('data', Buffer.from('8889\n'));
    dispatchers[1]!.emit('close', 0, null);
  }, 120_000);
});
