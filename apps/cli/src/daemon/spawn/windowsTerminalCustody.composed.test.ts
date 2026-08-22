import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Metadata } from '@/api/types';
import type { TrackedSession } from '../types';
import type { SpawnLifecycleCallbacks } from './createSpawnLifecycleCallbacks';
import type { DeviceLocalSecretStorage } from '../deviceLocalSecretStorage';

const testDeviceLocalSecretStorage: DeviceLocalSecretStorage = {
  sealJson: ({ value }) => `test.${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}`,
  openJson: ({ ciphertext }) => JSON.parse(Buffer.from(ciphertext.slice('test.'.length), 'base64url').toString('utf8')) as unknown,
  deriveOpaqueIdentity: ({ value }) =>
    Buffer.from(value, 'utf8').toString('hex').padEnd(64, '0').slice(0, 64),
  deriveSecretKey: () => new Uint8Array(32).fill(7),
};

type LauncherInput = Readonly<{
  filePath: string;
  args: string[];
  onDispatcherSpawned?: (
    pid: number,
    stopDispatcher: () => void,
  ) => void;
}>;

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
      `happier-wt-custody-${Date.now()}-${Math.random()}`,
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
    process.env.HAPPIER_HOME_DIR = join(testRoot, 'home');
    process.env.HAPPIER_WINDOWS_SESSION_RUNNER_BINARY =
      binaryPath;
    Object.defineProperty(process, 'platform', {
      ...originalPlatform,
      value: 'win32',
    });

    let launcherInput: LauncherInput | null = null;
    const stopDispatcher = vi.fn();
    let settleDispatcher!: (
      result: Readonly<{
        ok: true;
        pid: number;
        custodyPid: number;
      }>,
    ) => void;
    const dispatcherSettlement = new Promise<Readonly<{
      ok: true;
      pid: number;
      custodyPid: number;
    }>>((resolve) => {
      settleDispatcher = resolve;
    });
    vi.doMock(
      '../platform/windows/spawnHappyCliWindowsTerminal',
      () => ({
        startHappySessionInWindowsTerminal:
          (input: LauncherInput) => {
            launcherInput = input;
            input.onDispatcherSpawned?.(
              8_888,
              stopDispatcher,
            );
            return dispatcherSettlement;
          },
      }),
    );
    vi.resetModules();

    const [
      { configuration },
      { spawnWindowsHostedSessionAndWaitForWebhook },
      { createOnHappySessionWebhook },
      { persistAcceptedSpawnMarker },
      {
        listSessionMarkers,
        removeSessionMarkerIfOwned,
        writeSessionMarker,
      },
      {
        parseWindowsCommandLine,
        serializeWindowsCommandLine,
      },
      { captureExactWindowsTerminalLaunchProcess },
    ] = await Promise.all([
      import('@/configuration'),
      import('./spawnWindowsHostedSessionAndWaitForWebhook'),
      import('../sessions/onHappySessionWebhook'),
      import('./persistAcceptedSpawnMarker'),
      import('../sessionRegistry'),
      import('../platform/windows/windowsCommandLine'),
      import('../platform/windows/windowsProcessCustody'),
    ]);

    const pidToTrackedSession =
      new Map<number, TrackedSession>();
    const pidToAwaiter =
      new Map<number, (tracked: TrackedSession) => void>();
    const pidToSpawnResultResolver = new Map();
    const pidToSpawnWebhookTimeout = new Map();
    const spawnResourceCleanupByPid =
      new Map<number, () => void | Promise<void>>();
    const sessionAttachCleanupByPid =
      new Map<number, () => Promise<void>>();
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
      registerSpawnResourceCleanupForPid: (pid) => {
        spawnResourceCleanupByPid.set(pid, vi.fn());
      },
      consumeSessionAttachCleanupForPid: (pid) => {
        sessionAttachCleanupByPid.set(
          pid,
          vi.fn(async () => undefined),
        );
      },
      cleanupPendingSessionAttach:
        vi.fn(async () => undefined),
    };
    const spawnPromise =
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
        pidToTrackedSession,
        pidToAwaiter,
        pidToSpawnResultResolver,
        pidToSpawnWebhookTimeout,
        resolveCanonicalTrackedSessionId: () =>
          'session-wt-composed',
        onChildExited: vi.fn(),
        spawnLifecycleCallbacks: lifecycle,
        cleanupSpawnResources: vi.fn(),
        logDebug: vi.fn(),
        warn: vi.fn(),
      });

    await vi.waitFor(() => {
      expect(pidToTrackedSession.has(8_888)).toBe(true);
      expect(launcherInput).not.toBeNull();
    });
    const launched = launcherInput!;
    agentExecutablePath = launched.filePath;
    agentCommand = serializeWindowsCommandLine([
      launched.filePath,
      ...launched.args,
    ]);
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
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
    const tracked = pidToTrackedSession.get(8_888)!;
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
      pid: 7_771,
      startedBy: 'daemon',
    };
    const unrelatedAwaiter = vi.fn();
    pidToTrackedSession.set(7_771, unrelatedTracked);
    pidToAwaiter.set(7_771, unrelatedAwaiter);
    const metadata: Metadata = {
      path: 'C:\\repo',
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
              ...pidToTrackedSession.keys(),
            ].join(',')}, awaiters=${[
              ...pidToAwaiter.keys(),
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
              ...pidToTrackedSession.keys(),
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
    pidToTrackedSession.delete(7_771);
    const spawnResult = await Promise.race([
      spawnPromise,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error(
            `Spawn result stalled: tracked=${[
              ...pidToTrackedSession.keys(),
            ].join(',')}, awaiters=${[
              ...pidToAwaiter.keys(),
            ].join(',')}, resolvers=${[
              ...pidToSpawnResultResolver.keys(),
            ].join(',')}, timeouts=${[
              ...pidToSpawnWebhookTimeout.keys(),
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
    expect(pidToTrackedSession.has(8_888)).toBe(false);
    expect(pidToTrackedSession.get(9_999)).toBe(tracked);
    const markers = await listSessionMarkers();
    expect(markers).toHaveLength(1);
    expect(markers[0]).toEqual(expect.objectContaining({
      pid: 9_999,
      happySessionId: 'session-wt-composed',
      processStartTimeMs: 2_000,
      respawn: expect.objectContaining({
        spawnNonce: 'nonce-wt-composed',
      }),
    }));
    settleDispatcher({
      ok: true,
      pid: 8_889,
      custodyPid: 8_888,
    });
    await dispatcherSettlement;
    await removeSessionMarkerIfOwned({
      pid: markers[0]!.pid,
      happySessionId:
        markers[0]!.happySessionId,
      processCommandHash:
        markers[0]!.processCommandHash,
      processStartTimeMs:
        markers[0]!.processStartTimeMs,
      isStillOwned: () => true,
    });
    pidToTrackedSession.delete(9_999);
    spawnResourceCleanupByPid.delete(9_999);
    sessionAttachCleanupByPid.delete(9_999);
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
        pidToTrackedSession.delete(pid);
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
        pidToTrackedSession,
        pidToAwaiter,
        pidToSpawnResultResolver,
        pidToSpawnWebhookTimeout,
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
      expect(pidToTrackedSession.has(8_888))
        .toBe(true);
      expect(pidToSpawnResultResolver.get(8_888))
        .toEqual(expect.any(Function));
    });
    const timeoutTracked =
      pidToTrackedSession.get(8_888)!;
    const timeoutLaunched = launcherInput!;
    agentExecutablePath = timeoutLaunched.filePath;
    agentCommand = serializeWindowsCommandLine([
      timeoutLaunched.filePath,
      ...timeoutLaunched.args,
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
    pidToSpawnResultResolver.get(8_888)?.({
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
    expect(pidToTrackedSession.has(8_888))
      .toBe(false);
    expect(await listSessionMarkers())
      .toHaveLength(0);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(await listSessionMarkers())
      .toHaveLength(0);
  }, 120_000);
});
