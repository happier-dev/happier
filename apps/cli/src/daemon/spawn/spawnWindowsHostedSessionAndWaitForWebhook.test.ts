import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { withTempDir } from '@/testkit/fs/tempDir';
import { createSpawnHappyCliEnvScope } from '@/testkit/process/spawnHappyCliHarness';
import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import { hashProcessCommand } from '../sessionRegistry';
import { spawnWindowsHostedSessionAndWaitForWebhook } from './spawnWindowsHostedSessionAndWaitForWebhook';

const mocks = vi.hoisted(() => {
  const visibleConsoleCancel = vi.fn(async () => ({
    status: 'stopped' as const,
  }));
  return {
  visibleConsoleCancel,
  startHappySessionInVisibleWindowsConsole: vi.fn(async (): Promise<
    | {
        ok: true;
        pid: number;
        processStartTimeMs: number;
        cancel: () => Promise<{ status: 'stopped' }>;
      }
    | { ok: false; errorMessage: string }
  > => ({
    ok: true,
    pid: 7777,
    processStartTimeMs: 1_717_171_717_777,
    cancel: visibleConsoleCancel,
  })),
  startHappySessionInWindowsTerminal: vi.fn(async (params: {
    onDispatcherSpawned?: (
      pid: number,
      stop: () => void,
    ) => void;
  }): Promise<
    | { ok: true; pid: number; custodyPid: number }
    | {
        ok: false;
        dispatch: 'not_started';
        errorMessage: string;
      }
    | {
        ok: false;
        dispatch: 'uncertain';
        custodyPid: number;
        errorMessage: string;
      }
  > => {
    params.onDispatcherSpawned?.(8888, vi.fn());
    return {
      ok: true,
      pid: 8888,
      custodyPid: 8888,
    };
  }),
  waitForVisibleConsoleSessionWebhook: vi.fn(async (params: { pid: number }): Promise<SpawnSessionResult> => ({
    type: 'success',
    sessionId: `session-${params.pid}`,
  })),
  writeTerminalAttachmentInfo: vi.fn(async () => {}),
  };
});

vi.mock('../platform/windows/spawnHappyCliVisibleConsole', () => ({
  startHappySessionInVisibleWindowsConsole: mocks.startHappySessionInVisibleWindowsConsole,
}));

vi.mock('@/daemon/platform/windows/spawnHappyCliVisibleConsole', () => ({
  startHappySessionInVisibleWindowsConsole: mocks.startHappySessionInVisibleWindowsConsole,
}));

vi.mock('../platform/windows/spawnHappyCliWindowsTerminal', () => ({
  startHappySessionInWindowsTerminal: mocks.startHappySessionInWindowsTerminal,
}));

vi.mock('@/daemon/platform/windows/spawnHappyCliWindowsTerminal', () => ({
  startHappySessionInWindowsTerminal: mocks.startHappySessionInWindowsTerminal,
}));

vi.mock('../sessions/visibleConsoleSpawnWaiter', () => ({
  waitForVisibleConsoleSessionWebhook: mocks.waitForVisibleConsoleSessionWebhook,
}));

vi.mock('@/daemon/sessions/visibleConsoleSpawnWaiter', () => ({
  waitForVisibleConsoleSessionWebhook: mocks.waitForVisibleConsoleSessionWebhook,
}));

vi.mock('@/terminal/attachment/terminalAttachmentInfo', () => ({
  writeTerminalAttachmentInfo: mocks.writeTerminalAttachmentInfo,
}));

function createParams(overrides: Partial<Parameters<typeof import('./spawnWindowsHostedSessionAndWaitForWebhook').spawnWindowsHostedSessionAndWaitForWebhook>[0]> = {}) {
  const pidToTrackedSession =
    overrides.pidToTrackedSession ?? new Map();
  const onChildExited =
    overrides.onChildExited
    ?? vi.fn(async (pid: number) => {
      pidToTrackedSession.delete(pid);
    });
  return {
    windowsLaunchMode: 'console' as const,
    args: ['codex', '--happy-starting-mode', 'remote', '--started-by', 'daemon'],
    agentCommand: 'codex',
    directory: 'C:\\repo',
    options: { directory: 'C:\\repo' },
    trackedSpawnOptions: { directory: 'C:\\repo' },
    normalizedExistingSessionId: '',
    effectiveResume: '',
    reservedSessionId: 'reserved-session',
    localServicesBridgeAuthorization: {
      tokenHash: `sha256:${'a'.repeat(64)}`,
      pluginId: 'happier.agent.codex',
      contributionId: 'codex',
      tokenFilePath: 'C:\\Users\\test\\.happier\\tmp\\bridge-token',
    },
    directoryCreated: false,
    extraEnvForChildWithMessage: {},
    processEnv: {
      ...process.env,
      HAPPIER_DAEMON_REPORT_SESSION_RETRY_TIMEOUT_MS: '0',
      HAPPIER_DAEMON_REPORT_SESSION_RETRY_INTERVAL_MS: '50',
      HAPPIER_DAEMON_REPORT_SESSION_HTTP_TIMEOUT_MS: '100',
    },
    happyHomeDir: 'C:\\Users\\test\\.happier',
    pidToTrackedSession,
    pidToAwaiter: new Map(),
    pidToSpawnResultResolver: new Map(),
    pidToSpawnWebhookTimeout: new Map(),
    resolveCanonicalTrackedSessionId: vi.fn(() => 'session-1'),
    onChildExited,
    spawnLifecycleCallbacks: {
      registerConnectedServiceSpawnTarget: vi.fn(),
      registerSpawnResourceCleanupForPid: vi.fn(),
      cleanupSpawnResourcesForPid: vi.fn(async () => true),
      consumeSessionAttachCleanupForPid: vi.fn(),
      cleanupPendingSessionAttach: vi.fn(async () => {}),
      persistAcceptedSpawnMarker: vi.fn(async () => {}),
      removeAcceptedSpawnMarkerIfOwned: vi.fn(async () => true),
    },
    cleanupSpawnResources: vi.fn(),
    logDebug: vi.fn(),
    warn: vi.fn(),
    windowsProcessCustodyDependencies: {
      nowFn: () => 0,
      sleepFn: async () => undefined,
      readAllWindowsProcessFactsFn: async () => new Map(),
      readProcessIdentityByPidFn: async () => null,
      terminateProcessTreeFn: vi.fn(async () => undefined),
      isPidAliveFn: () => false,
    },
    ...overrides,
  };
}

async function resolveWindowsTerminalWebhook(
  input: ReturnType<typeof createParams>,
  updateTrackedSession: (
    trackedSession: NonNullable<
      ReturnType<typeof input.pidToTrackedSession.get>
    >,
  ) => void,
): Promise<SpawnSessionResult> {
  const pending =
    spawnWindowsHostedSessionAndWaitForWebhook(input);
  await vi.waitFor(() => {
    expect(input.pidToAwaiter.get(8888)).toEqual(
      expect.any(Function),
    );
  });
  const trackedSession = input.pidToTrackedSession.get(8888);
  if (!trackedSession) {
    throw new Error('Expected Windows Terminal tracked session');
  }
  updateTrackedSession(trackedSession);
  await trackedSession
    .persistWindowsTerminalAcceptedAgentMarker?.({
      pid: 9_999,
      processStartTimeMs: 2_000,
      processCommandHash: 'a'.repeat(64),
    });
  input.pidToAwaiter.get(8888)?.(trackedSession);
  return await pending;
}

describe('spawnWindowsHostedSessionAndWaitForWebhook', () => {
  const envScope = createSpawnHappyCliEnvScope();
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalSessionWebhookTimeoutMs =
    process.env.HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS;

  afterEach(() => {
    vi.clearAllMocks();
    envScope.restore();
    if (originalSessionWebhookTimeoutMs === undefined) {
      delete process.env.HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS;
    } else {
      process.env.HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS =
        originalSessionWebhookTimeoutMs;
    }
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  });

  async function withPackagedWindowsCli<T>(fn: (binaryPath: string) => Promise<T> | T): Promise<T> {
    if (!originalPlatformDescriptor) {
      throw new Error('Expected process.platform descriptor to be available');
    }

    return await withTempDir('happier-windows-hosted-', async (dir) => {
      const packageDistDir = join(dir, 'package-dist');
      const entrypoint = join(packageDistDir, 'index.mjs');
      const binaryPath = join(dir, 'happier.exe');
      mkdirSync(packageDistDir, { recursive: true });
      writeFileSync(entrypoint, 'export {};\n', 'utf8');
      writeFileSync(binaryPath, '', 'utf8');

      Object.defineProperty(process, 'platform', {
        ...originalPlatformDescriptor,
        value: 'win32',
      });

      envScope.patch({
        HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
        HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: entrypoint,
        HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '0',
        HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: '0',
        HAPPIER_VARIANT: undefined,
        HAPPIER_STACK_REPO_DIR: undefined,
        HAPPIER_STACK_CLI_ROOT_DIR: undefined,
        HAPPIER_STACK_STACK: undefined,
        HAPPIER_WINDOWS_SESSION_RUNNER_BINARY: undefined,
      });

      return await fn(binaryPath);
    });
  }

  it('runs the final provider authorization guard immediately before Windows child creation', async () => {
    await withPackagedWindowsCli(async () => {
      const refusal = {
        type: 'error' as const,
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: 'provider_authorization_changed',
      };
      const revalidateBeforeCommit = vi.fn(async () => refusal);

      await expect(spawnWindowsHostedSessionAndWaitForWebhook(createParams({ revalidateBeforeCommit })))
        .resolves.toEqual(refusal);
      expect(revalidateBeforeCommit).toHaveBeenCalledTimes(1);
      expect(mocks.startHappySessionInVisibleWindowsConsole).not.toHaveBeenCalled();
      expect(mocks.startHappySessionInWindowsTerminal).not.toHaveBeenCalled();
    });
  });

  it('starts visible console sessions through the packaged Windows binary', async () => {
    await withPackagedWindowsCli(async (binaryPath) => {
      await expect(spawnWindowsHostedSessionAndWaitForWebhook(createParams())).resolves.toEqual({
        type: 'success',
        sessionId: 'session-7777',
      });

      expect(mocks.startHappySessionInVisibleWindowsConsole).toHaveBeenCalledWith(expect.objectContaining({
        filePath: binaryPath,
        args: expect.arrayContaining([
          'codex',
          '--happy-terminal-mode',
          'windows_console',
        ]),
      }));
      const consoleCalls =
        mocks.startHappySessionInVisibleWindowsConsole
          .mock.calls as unknown as Array<[
            { args: string[] },
          ]>;
      const consoleLaunch = consoleCalls[0]?.[0];
      expect(consoleLaunch?.args).not.toContain(
        '--happy-terminal-launch-correlation',
      );
      expect(mocks.writeTerminalAttachmentInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-7777',
          terminal: expect.objectContaining({
            mode: 'windows_console',
            requested: 'console',
            windows: {
              host: 'console',
              pid: 7777,
            },
          }),
        }),
      );
    });
  });

  it('installs visible-console webhook custody before accepted marker persistence completes', async () => {
    await withPackagedWindowsCli(async () => {
      const order: string[] = [];
      let resolveMarker!: () => void;
      const markerPersistence = new Promise<void>((resolve) => {
        resolveMarker = resolve;
      });
      const persistAcceptedSpawnMarker = vi.fn(
        async () => {
          order.push('marker-start');
          await markerPersistence;
          order.push('marker-end');
        },
      );
      const input = createParams({
        spawnLifecycleCallbacks: {
          ...createParams().spawnLifecycleCallbacks,
          persistAcceptedSpawnMarker,
        },
      });
      mocks.waitForVisibleConsoleSessionWebhook.mockImplementationOnce(
        async ({ pid }: { pid: number }) => {
          order.push('waiter-installed');
          return { type: 'success', sessionId: `session-${pid}` };
        },
      );

      const pending = spawnWindowsHostedSessionAndWaitForWebhook(input);
      await vi.waitFor(() => {
        expect(order).toEqual(['marker-start', 'waiter-installed']);
      });
      expect(
        input.pidToTrackedSession.get(7777)?.acceptedSpawnMarkerGate,
      ).toEqual(expect.any(Promise));

      resolveMarker();
      await expect(pending).resolves.toEqual({
        type: 'success',
        sessionId: 'session-7777',
      });
      expect(order).toEqual([
        'marker-start',
        'waiter-installed',
        'marker-end',
      ]);
    });
  });

  it('retains denied custody when marker publication fails so a late hosted webhook cannot be adopted externally', async () => {
    await withPackagedWindowsCli(async () => {
      const persistAcceptedSpawnMarker = vi.fn(async () => {});
      persistAcceptedSpawnMarker.mockRejectedValueOnce(new Error('marker refused'));
      const input = createParams({
        windowsLaunchMode: 'windows_terminal',
        spawnLifecycleCallbacks: {
          ...createParams().spawnLifecycleCallbacks,
          persistAcceptedSpawnMarker,
        },
      });

      const pending =
        spawnWindowsHostedSessionAndWaitForWebhook(input);
      await vi.waitFor(() => {
        expect(
          input.pidToTrackedSession.get(8888)
            ?.persistWindowsTerminalAcceptedAgentMarker,
        ).toEqual(expect.any(Function));
      });
      await expect(
        input.pidToTrackedSession.get(8888)!
          .persistWindowsTerminalAcceptedAgentMarker?.({
            pid: 9_999,
            processStartTimeMs: 2_000,
            processCommandHash: 'a'.repeat(64),
          }),
      ).rejects.toThrow('marker refused');
      await expect(pending).rejects.toThrow('marker refused');
      expect(mocks.visibleConsoleCancel).not.toHaveBeenCalled();
      expect(input.onChildExited).toHaveBeenCalledWith(
        8888,
        expect.objectContaining({
          reason: 'startup-cancelled-before-ack',
        }),
      );
      expect(input.pidToTrackedSession.has(8888)).toBe(false);
    });
  });

  it('retires the exact Windows-hosted startup owner when canonical readiness is refused', async () => {
    await withPackagedWindowsCli(async () => {
      const input = createParams();
      mocks.waitForVisibleConsoleSessionWebhook.mockImplementationOnce(
        async ({ pid }: { pid: number }) => {
          const tracked = input.pidToTrackedSession.get(pid);
          Object.assign(tracked!, {
            happySessionId: 'session-windows-readiness-refused',
            spawnStartupReadinessFailure: {
              type: 'error',
              errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
              errorMessage: 'managed_provider_request_auth_activation_failed',
            },
          });
          return tracked!.spawnStartupReadinessFailure!;
        },
      );

      await expect(
        spawnWindowsHostedSessionAndWaitForWebhook(input),
      ).resolves.toMatchObject({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      });
      expect(mocks.visibleConsoleCancel).toHaveBeenCalledOnce();
      expect(input.cleanupSpawnResources).toHaveBeenCalledOnce();
      expect(
        vi.mocked(
          input.cleanupSpawnResources,
        ).mock.invocationCallOrder[0],
      ).toBeLessThan(
        mocks.visibleConsoleCancel.mock.invocationCallOrder[0]!,
      );
      expect(input.onChildExited).toHaveBeenCalledOnce();
      expect(input.pidToTrackedSession.has(7777)).toBe(false);
    });
  });

  it('sanitizes provider credentials from Windows launcher errors and diagnostics', async () => {
    await withPackagedWindowsCli(async () => {
      const rawSecret = 'provider-secret-windows';
      mocks.startHappySessionInVisibleWindowsConsole.mockResolvedValueOnce({
        ok: false as const,
        errorMessage: `launcher echoed ${rawSecret}`,
      });
      const logDebug = vi.fn();
      const params = createParams({
        sanitizeDiagnosticText: (value: string) => value.replaceAll(rawSecret, '[REDACTED]'),
        logDebug,
      });

      const result = await spawnWindowsHostedSessionAndWaitForWebhook(params);
      expect(JSON.stringify(result)).not.toContain(rawSecret);
      expect(JSON.stringify(logDebug.mock.calls)).not.toContain(rawSecret);
      expect(JSON.stringify(result)).toContain('[REDACTED]');
    });
  });

  it('builds visible console launch env from the daemon-owned process env', async () => {
    await withPackagedWindowsCli(async () => {
      envScope.patch({
        HAPPIER_WINDOWS_HOSTED_AMBIENT_ONLY_TEST: 'ambient-only',
        HAPPIER_WINDOWS_HOSTED_SHARED_TEST: 'ambient',
      });
      await expect(spawnWindowsHostedSessionAndWaitForWebhook(createParams({
        processEnv: {
          ...process.env,
          HAPPIER_WINDOWS_HOSTED_AMBIENT_ONLY_TEST: undefined,
          HAPPIER_WINDOWS_HOSTED_DAEMON_ONLY_TEST: 'daemon-only',
          HAPPIER_WINDOWS_HOSTED_SHARED_TEST: 'daemon',
        },
        extraEnvForChildWithMessage: {
          HAPPIER_WINDOWS_HOSTED_SHARED_TEST: 'message',
          HAPPIER_WINDOWS_HOSTED_MESSAGE_ONLY_TEST: 'message-only',
        },
      }))).resolves.toEqual({
        type: 'success',
        sessionId: 'session-7777',
      });

      expect(mocks.startHappySessionInVisibleWindowsConsole).toHaveBeenCalledTimes(1);
      const visibleConsoleCalls = mocks.startHappySessionInVisibleWindowsConsole.mock.calls as unknown as
        Array<[{ env?: NodeJS.ProcessEnv }]>;
      const launchArgs = visibleConsoleCalls[0]?.[0];
      const launchedEnv = launchArgs?.env;
      expect(launchedEnv).toMatchObject({
        HAPPIER_WINDOWS_HOSTED_DAEMON_ONLY_TEST: 'daemon-only',
        HAPPIER_WINDOWS_HOSTED_SHARED_TEST: 'message',
        HAPPIER_WINDOWS_HOSTED_MESSAGE_ONLY_TEST: 'message-only',
      });
      expect(launchedEnv?.HAPPIER_WINDOWS_HOSTED_AMBIENT_ONLY_TEST).toBeUndefined();
    });
  });

  it('builds Windows hosted launch env through the canonical session child env builder', async () => {
    await withPackagedWindowsCli(async () => {
      await expect(spawnWindowsHostedSessionAndWaitForWebhook(createParams({
        processEnv: {
          ...process.env,
          HAPPIER_STACK_STACK: 'repo-dev',
          HAPPIER_STACK_ENV_FILE: 'C:\\happier\\repo-dev\\env',
          HAPPIER_STACK_PROCESS_KIND: 'infra',
          HAPPIER_DAEMON_RUNTIME_ID: 'runtime-parent',
          HAPPIER_DAEMON_STARTUP_SOURCE: 'self-restart',
          HAPPIER_DAEMON_TAKEOVER: '1',
        },
        extraEnvForChildWithMessage: {},
      }))).resolves.toEqual({
        type: 'success',
        sessionId: 'session-7777',
      });

      const visibleConsoleCalls = mocks.startHappySessionInVisibleWindowsConsole.mock.calls as unknown as
        Array<[{ env?: NodeJS.ProcessEnv }]>;
      const launchedEnv = visibleConsoleCalls[0]?.[0]?.env;
      expect(launchedEnv?.HAPPIER_STACK_PROCESS_KIND).toBe('session');
      expect(launchedEnv?.HAPPIER_DAEMON_RUNTIME_ID).toBeUndefined();
      expect(launchedEnv?.HAPPIER_DAEMON_STARTUP_SOURCE).toBeUndefined();
      expect(launchedEnv?.HAPPIER_DAEMON_TAKEOVER).toBeUndefined();
    });
  });

  it('starts Windows Terminal sessions through the packaged Windows binary', async () => {
    await withPackagedWindowsCli(async (binaryPath) => {
      const input = createParams({
        windowsLaunchMode: 'windows_terminal',
      });
      await expect(resolveWindowsTerminalWebhook(
        input,
        (trackedSession) => {
          trackedSession.happySessionId = 'session-8888';
        },
      )).resolves.toEqual({
        type: 'success',
        sessionId: 'session-8888',
      });

      expect(mocks.startHappySessionInWindowsTerminal).toHaveBeenCalledWith(expect.objectContaining({
        filePath: binaryPath,
        args: expect.arrayContaining([
          'codex',
          '--happy-terminal-mode',
          'windows_terminal',
          '--happy-terminal-launch-correlation',
        ]),
      }));
      const terminalCalls = (
        mocks.startHappySessionInWindowsTerminal.mock.calls
      ) as unknown as Array<[
            {
              args: string[];
            },
          ]>;
      const terminalLaunch = terminalCalls[0]?.[0];
      const correlationIndex = terminalLaunch?.args.indexOf(
        '--happy-terminal-launch-correlation',
      ) ?? -1;
      expect(terminalLaunch?.args[correlationIndex + 1]).toMatch(
        /^[a-f0-9]{32}$/u,
      );
      expect(input.pidToTrackedSession.size).toBe(1);
      expect(mocks.writeTerminalAttachmentInfo).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'session-8888',
        terminal: expect.objectContaining({
          mode: 'windows_terminal',
          requested: 'windows_terminal',
          windows: expect.objectContaining({
            host: 'windows_terminal',
          }),
        }),
      }));
    });
  });

  it.each([
    ['readiness refusal', false],
    ['webhook timeout', true],
  ] as const)(
    'proves Windows Terminal retirement from two quiescent zero scans on %s',
    async (_label, timedOut) => {
      await withPackagedWindowsCli(async () => {
        const input = createParams({
          windowsLaunchMode: 'windows_terminal',
        });
        if (timedOut) {
          process.env.HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS =
            '10';
        }

        const pending = timedOut
          ? spawnWindowsHostedSessionAndWaitForWebhook(input)
          : resolveWindowsTerminalWebhook(input, (tracked) => {
            tracked.spawnStartupReadinessFailure = {
              type: 'error',
              errorCode:
                SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
              errorMessage:
                'managed_provider_request_auth_activation_failed',
            };
          });

        await expect(pending).resolves.toMatchObject({
          type: 'error',
          errorCode: timedOut
            ? SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT
            : SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        });
        expect(mocks.visibleConsoleCancel).not.toHaveBeenCalled();
        expect(input.cleanupSpawnResources).toHaveBeenCalledOnce();
        expect(input.onChildExited).toHaveBeenCalledOnce();
        expect(input.pidToTrackedSession.has(8888)).toBe(false);
        expect(mocks.writeTerminalAttachmentInfo).not.toHaveBeenCalled();
      });
    },
  );

  it('waits for an overlapping exact Agent marker write and removes it after timeout retirement', async () => {
    await withPackagedWindowsCli(async () => {
      let resolveMarkerWrite!: () => void;
      const markerWriteBlocked =
        new Promise<void>((resolve) => {
          resolveMarkerWrite = resolve;
        });
      const persistAcceptedSpawnMarker = vi.fn(
        async () => {
          await markerWriteBlocked;
        },
      );
      const removeAcceptedSpawnMarkerIfOwned =
        vi.fn(async () => true);
      const input = createParams({
        windowsLaunchMode: 'windows_terminal',
        spawnLifecycleCallbacks: {
          ...createParams().spawnLifecycleCallbacks,
          persistAcceptedSpawnMarker,
          removeAcceptedSpawnMarkerIfOwned,
        },
      });

      const pending =
        spawnWindowsHostedSessionAndWaitForWebhook(input);
      await vi.waitFor(() => {
        expect(
          input.pidToTrackedSession.get(8888)
            ?.persistWindowsTerminalAcceptedAgentMarker,
        ).toEqual(expect.any(Function));
      });
      const tracked = input.pidToTrackedSession.get(8888)!;
      tracked.happySessionId =
        'session-timeout-overlap';
      const exactAgentIdentity = {
        pid: 9_999,
        processStartTimeMs: 2_000,
        processCommandHash: 'a'.repeat(64),
      };
      const markerWrite = tracked
        .persistWindowsTerminalAcceptedAgentMarker!(
          exactAgentIdentity,
        );
      await vi.waitFor(() => {
        expect(persistAcceptedSpawnMarker)
          .toHaveBeenCalledOnce();
      });
      tracked.sessionWebhookTimedOutAtMs = Date.now();
      input.pidToSpawnResultResolver.get(8888)?.({
        type: 'error',
        errorCode:
          SPAWN_SESSION_ERROR_CODES
            .SESSION_WEBHOOK_TIMEOUT,
        errorMessage:
          'Session webhook timeout for PID 8888',
      });

      expect(removeAcceptedSpawnMarkerIfOwned)
        .not.toHaveBeenCalled();
      resolveMarkerWrite();
      await markerWrite;

      await expect(pending).resolves.toMatchObject({
        type: 'error',
        errorCode:
          SPAWN_SESSION_ERROR_CODES
            .SESSION_WEBHOOK_TIMEOUT,
      });
      expect(
        removeAcceptedSpawnMarkerIfOwned,
      ).toHaveBeenCalledOnce();
      expect(
        removeAcceptedSpawnMarkerIfOwned,
      ).toHaveBeenCalledWith({
        pid: exactAgentIdentity.pid,
        happySessionId:
          'session-timeout-overlap',
        processStartTimeMs:
          exactAgentIdentity.processStartTimeMs,
        processCommandHash:
          exactAgentIdentity.processCommandHash,
        isStillOwned: expect.any(Function),
      });
      expect(input.onChildExited).toHaveBeenCalledOnce();
      expect(input.pidToTrackedSession.has(8888))
        .toBe(false);
    });
  });

  it('bounds a never-settling Windows Terminal dispatcher through provisional hosted custody', async () => {
    await withPackagedWindowsCli(async () => {
      const stopDispatcher = vi.fn();
      mocks.startHappySessionInWindowsTerminal
        .mockImplementationOnce((params) => {
          params.onDispatcherSpawned?.(
            8_888,
            stopDispatcher,
          );
          return new Promise<never>(() => {});
        });
      const input = createParams({
        windowsLaunchMode: 'windows_terminal',
      });

      const pending =
        spawnWindowsHostedSessionAndWaitForWebhook(input);
      await vi.waitFor(() => {
        expect(
          input.pidToSpawnResultResolver.get(8888),
        ).toEqual(expect.any(Function));
      });
      const tracked = input.pidToTrackedSession.get(8888)!;
      tracked.sessionWebhookTimedOutAtMs = Date.now();
      input.pidToSpawnResultResolver.get(8888)?.({
        type: 'error',
        errorCode:
          SPAWN_SESSION_ERROR_CODES
            .SESSION_WEBHOOK_TIMEOUT,
        errorMessage:
          'Session webhook timeout for PID 8888',
      });

      await expect(pending).resolves.toMatchObject({
        type: 'error',
        errorCode:
          SPAWN_SESSION_ERROR_CODES
            .SESSION_WEBHOOK_TIMEOUT,
      });
      expect(stopDispatcher).toHaveBeenCalledOnce();
      expect(
        mocks.startHappySessionInVisibleWindowsConsole,
      ).not.toHaveBeenCalled();
      expect(input.cleanupSpawnResources)
        .toHaveBeenCalledOnce();
      expect(input.onChildExited).toHaveBeenCalledOnce();
      expect(input.pidToTrackedSession.has(8888))
        .toBe(false);
    });
  });

  it('reports typed incomplete cleanup after exact Agent retirement when target marker removal fails', async () => {
    await withPackagedWindowsCli(async () => {
      const processCommand =
        '"C:\\Program Files\\Happier\\happier.exe" codex';
      let agentAlive = true;
      const terminateProcessTreeFn = vi.fn(
        async () => {
          agentAlive = false;
        },
      );
      const removeAcceptedSpawnMarkerIfOwned =
        vi.fn(async () => {
          throw new Error('marker removal failed');
        });
      const input = createParams({
        windowsLaunchMode: 'windows_terminal',
        spawnLifecycleCallbacks: {
          ...createParams().spawnLifecycleCallbacks,
          removeAcceptedSpawnMarkerIfOwned,
        },
        windowsProcessCustodyDependencies: {
          readAllWindowsProcessFactsFn:
            async () => new Map(),
          readProcessIdentityByPidFn:
            async (pid) =>
              pid === 9_999 && agentAlive
                ? {
                    pid,
                    processStartTimeMs: 2_000,
                    command: processCommand,
                  }
                : null,
          terminateProcessTreeFn,
          isPidAliveFn: (pid) =>
            pid === 9_999 && agentAlive,
          nowFn: () => 0,
          sleepFn: async () => undefined,
        },
      });

      const pending =
        spawnWindowsHostedSessionAndWaitForWebhook(input);
      await vi.waitFor(() => {
        expect(
          input.pidToTrackedSession.get(8888)
            ?.persistWindowsTerminalAcceptedAgentMarker,
        ).toEqual(expect.any(Function));
      });
      const tracked = input.pidToTrackedSession.get(8888)!;
      const exactAgentIdentity = {
        pid: 9_999,
        processStartTimeMs: 2_000,
        processCommandHash:
          hashProcessCommand(processCommand),
      };
      tracked.happySessionId =
        'session-marker-cleanup-failure';
      tracked.windowsTerminalCancellationIdentity =
        exactAgentIdentity;
      await tracked
        .persistWindowsTerminalAcceptedAgentMarker!(
          exactAgentIdentity,
        );
      tracked.sessionWebhookTimedOutAtMs = Date.now();
      input.pidToSpawnResultResolver.get(8888)?.({
        type: 'error',
        errorCode:
          SPAWN_SESSION_ERROR_CODES
            .SESSION_WEBHOOK_TIMEOUT,
        errorMessage:
          'Session webhook timeout for PID 8888',
      });

      await expect(pending).resolves.toEqual({
        type: 'error',
        errorCode:
          SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
        errorMessage:
          'startup_retirement_incomplete:exit_cleanup_incomplete',
      });
      expect(terminateProcessTreeFn)
        .toHaveBeenCalledOnce();
      expect(removeAcceptedSpawnMarkerIfOwned)
        .toHaveBeenCalledOnce();
      expect(input.onChildExited).toHaveBeenCalledOnce();
      expect(input.pidToTrackedSession.has(8888))
        .toBe(false);
      expect(
        mocks.startHappySessionInVisibleWindowsConsole,
      ).not.toHaveBeenCalled();
    });
  });

  it('proves Windows Terminal retirement when marker publication fails before ACK', async () => {
    await withPackagedWindowsCli(async () => {
      const persistAcceptedSpawnMarker = vi.fn(
        async () => {
          throw new Error('marker refused');
        },
      );
      const input = createParams({
        windowsLaunchMode: 'windows_terminal',
        spawnLifecycleCallbacks: {
          ...createParams().spawnLifecycleCallbacks,
          persistAcceptedSpawnMarker,
        },
      });

      const pending =
        spawnWindowsHostedSessionAndWaitForWebhook(input);
      await vi.waitFor(() => {
        expect(
          input.pidToTrackedSession.get(8888)
            ?.persistWindowsTerminalAcceptedAgentMarker,
        ).toEqual(expect.any(Function));
      });
      await expect(
        input.pidToTrackedSession.get(8888)!
          .persistWindowsTerminalAcceptedAgentMarker?.({
            pid: 9_999,
            processStartTimeMs: 2_000,
            processCommandHash: 'a'.repeat(64),
          }),
      ).rejects.toThrow('marker refused');
      await expect(pending).rejects.toThrow(
        'marker refused',
      );
      expect(mocks.visibleConsoleCancel).not.toHaveBeenCalled();
      expect(input.cleanupSpawnResources).toHaveBeenCalledOnce();
      expect(input.onChildExited).toHaveBeenCalledOnce();
      expect(input.pidToTrackedSession.has(8888)).toBe(false);
      expect(mocks.writeTerminalAttachmentInfo).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['console', 'windows_console'],
    ['windows_terminal', 'windows_terminal'],
  ] as const)('uses the admitted immutable runner decision for %s launches', async (windowsLaunchMode, terminalMode) => {
    await withPackagedWindowsCli(async () => {
      const immutableEntrypoint = 'C:\\runtime\\.runner-snapshots\\0123456789abcdef\\index.mjs';
      const params = createParams({
        windowsLaunchMode,
        runnerLaunchOptions: {
          runtimeDecision: {
            runtime: 'node',
            argvPrefix: ['--no-warnings', '--no-deprecation', immutableEntrypoint],
            env: { HAPPIER_TEST_ADMITTED_CLOSURE: '0123456789abcdef' },
          },
        },
      });

      const result = windowsLaunchMode === 'windows_terminal'
        ? resolveWindowsTerminalWebhook(
            params,
            (trackedSession) => {
              trackedSession.happySessionId = 'session-8888';
            },
          )
        : spawnWindowsHostedSessionAndWaitForWebhook(params);
      await expect(result).resolves.toEqual({
        type: 'success',
        sessionId: windowsLaunchMode === 'windows_terminal' ? 'session-8888' : 'session-7777',
      });

      const spawner = windowsLaunchMode === 'windows_terminal'
        ? mocks.startHappySessionInWindowsTerminal
        : mocks.startHappySessionInVisibleWindowsConsole;
      expect(spawner).toHaveBeenCalledWith(expect.objectContaining({
        args: expect.arrayContaining([
          immutableEntrypoint,
          'codex',
          '--happy-terminal-mode',
          terminalMode,
        ]),
        env: expect.objectContaining({
          HAPPIER_TEST_ADMITTED_CLOSURE: '0123456789abcdef',
        }),
      }));
    });
  });

  it('never starts Console after a Windows Terminal dispatch failure may have committed', async () => {
    await withPackagedWindowsCli(async () => {
      mocks.startHappySessionInWindowsTerminal.mockResolvedValueOnce({
        ok: false,
        dispatch: 'not_started',
        errorMessage: 'wt.exe unavailable',
      });

      await expect(spawnWindowsHostedSessionAndWaitForWebhook(createParams({
        windowsLaunchMode: 'windows_terminal',
      }))).resolves.toMatchObject({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      });

      expect(mocks.startHappySessionInVisibleWindowsConsole).not.toHaveBeenCalled();
      expect(mocks.writeTerminalAttachmentInfo).not.toHaveBeenCalled();
    });
  });
});
