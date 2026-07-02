import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { withTempDir } from '@/testkit/fs/tempDir';
import { createSpawnHappyCliEnvScope } from '@/testkit/process/spawnHappyCliHarness';
import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';

const mocks = vi.hoisted(() => ({
  startHappySessionInVisibleWindowsConsole: vi.fn(async () => ({ ok: true as const, pid: 7777 })),
  startHappySessionInWindowsTerminal: vi.fn(async () => ({ ok: true as const, pid: 8888 })),
  waitForVisibleConsoleSessionWebhook: vi.fn(async (params: { pid: number }): Promise<SpawnSessionResult> => ({
    type: 'success',
    sessionId: `session-${params.pid}`,
  })),
  writeTerminalAttachmentInfo: vi.fn(async () => {}),
}));

vi.mock('../platform/windows/spawnHappyCliVisibleConsole', () => ({
  startHappySessionInVisibleWindowsConsole: mocks.startHappySessionInVisibleWindowsConsole,
}));

vi.mock('../platform/windows/spawnHappyCliWindowsTerminal', () => ({
  startHappySessionInWindowsTerminal: mocks.startHappySessionInWindowsTerminal,
}));

vi.mock('../sessions/visibleConsoleSpawnWaiter', () => ({
  waitForVisibleConsoleSessionWebhook: mocks.waitForVisibleConsoleSessionWebhook,
}));

vi.mock('@/terminal/attachment/terminalAttachmentInfo', () => ({
  writeTerminalAttachmentInfo: mocks.writeTerminalAttachmentInfo,
}));

function createParams(overrides: Partial<Parameters<typeof import('./spawnWindowsHostedSessionAndWaitForWebhook').spawnWindowsHostedSessionAndWaitForWebhook>[0]> = {}) {
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
    directoryCreated: false,
    extraEnvForChildWithMessage: {},
    processEnv: process.env,
    happyHomeDir: 'C:\\Users\\test\\.happier',
    pidToTrackedSession: new Map(),
    pidToAwaiter: new Map(),
    pidToSpawnResultResolver: new Map(),
    pidToSpawnWebhookTimeout: new Map(),
    resolveCanonicalTrackedSessionId: vi.fn(() => 'session-1'),
    onChildExited: vi.fn(),
    spawnLifecycleCallbacks: {
      registerConnectedServiceSpawnTarget: vi.fn(),
      registerSpawnResourceCleanupForPid: vi.fn(),
      consumeSessionAttachCleanupForPid: vi.fn(),
      cleanupPendingSessionAttach: vi.fn(async () => {}),
    },
    cleanupSpawnResources: vi.fn(),
    logDebug: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  };
}

describe('spawnWindowsHostedSessionAndWaitForWebhook', () => {
  const envScope = createSpawnHappyCliEnvScope();
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    envScope.restore();
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

  it('starts visible console sessions through the packaged Windows binary', async () => {
    await withPackagedWindowsCli(async (binaryPath) => {
      const { spawnWindowsHostedSessionAndWaitForWebhook } = await import('./spawnWindowsHostedSessionAndWaitForWebhook');

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
    });
  });

  it('builds visible console launch env from the daemon-owned process env', async () => {
    await withPackagedWindowsCli(async () => {
      envScope.patch({
        HAPPIER_WINDOWS_HOSTED_AMBIENT_ONLY_TEST: 'ambient-only',
        HAPPIER_WINDOWS_HOSTED_SHARED_TEST: 'ambient',
      });
      const { spawnWindowsHostedSessionAndWaitForWebhook } = await import('./spawnWindowsHostedSessionAndWaitForWebhook');

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

  it('starts Windows Terminal sessions through the packaged Windows binary', async () => {
    await withPackagedWindowsCli(async (binaryPath) => {
      const { spawnWindowsHostedSessionAndWaitForWebhook } = await import('./spawnWindowsHostedSessionAndWaitForWebhook');

      await expect(spawnWindowsHostedSessionAndWaitForWebhook(createParams({
        windowsLaunchMode: 'windows_terminal',
      }))).resolves.toEqual({
        type: 'success',
        sessionId: 'session-8888',
      });

      expect(mocks.startHappySessionInWindowsTerminal).toHaveBeenCalledWith(expect.objectContaining({
        filePath: binaryPath,
        args: expect.arrayContaining([
          'codex',
          '--happy-terminal-mode',
          'windows_terminal',
        ]),
      }));
    });
  });
});
