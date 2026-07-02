import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';

const mocks = vi.hoisted(() => ({
  spawnTmuxHostedSessionAndWaitForWebhook: vi.fn(),
  spawnRegularProcessAndWaitForWebhook: vi.fn(),
  spawnWindowsHostedSessionAndWaitForWebhook: vi.fn(),
  resolveWindowsRemoteSessionConsoleMode: vi.fn(() => 'hidden'),
}));

vi.mock('./spawnTmuxHostedSessionAndWaitForWebhook', () => ({
  spawnTmuxHostedSessionAndWaitForWebhook: mocks.spawnTmuxHostedSessionAndWaitForWebhook,
}));

vi.mock('./spawnRegularProcessAndWaitForWebhook', () => ({
  spawnRegularProcessAndWaitForWebhook: mocks.spawnRegularProcessAndWaitForWebhook,
}));

vi.mock('./spawnWindowsHostedSessionAndWaitForWebhook', () => ({
  spawnWindowsHostedSessionAndWaitForWebhook: mocks.spawnWindowsHostedSessionAndWaitForWebhook,
}));

vi.mock('../platform/windows/windowsSessionConsoleMode', () => ({
  resolveWindowsRemoteSessionConsoleMode: mocks.resolveWindowsRemoteSessionConsoleMode,
}));

const successResult: SpawnSessionResult = {
  type: 'success',
  sessionId: 'session-1',
};

function createParams() {
  return {
    terminalRequest: { requested: null },
    directory: '/tmp/happier-project',
    options: { directory: '/tmp/happier-project' },
    trackedSpawnOptions: { directory: '/tmp/happier-project' },
    normalizedExistingSessionId: '',
    effectiveResume: '',
    effectiveBackendTargetV2: {
      kind: 'backend',
      sourceKind: 'built_in',
      backendId: 'opencode',
    },
    directoryCreated: false,
    extraEnvForChildWithMessage: {},
    processEnv: process.env,
    happyHomeDir: '/tmp/happier-home',
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
  } as const;
}

describe('routeSpawnModeAndWaitForWebhook', () => {
  beforeEach(() => {
    mocks.spawnTmuxHostedSessionAndWaitForWebhook.mockReset().mockResolvedValue({
      spawnResult: null,
      tmuxRequested: false,
      tmuxFallbackReason: null,
    });
    mocks.spawnRegularProcessAndWaitForWebhook.mockReset().mockResolvedValue(successResult);
    mocks.spawnWindowsHostedSessionAndWaitForWebhook.mockReset().mockResolvedValue(successResult);
    mocks.resolveWindowsRemoteSessionConsoleMode.mockReset().mockReturnValue('hidden');
  });

  it('routes non-hosted remote starts to a regular background process with daemon metadata args', async () => {
    const { routeSpawnModeAndWaitForWebhook } = await import('./routeSpawnModeAndWaitForWebhook');

    await expect(routeSpawnModeAndWaitForWebhook({
      ...createParams(),
      accountSettingsVersionHint: 14,
    } as Parameters<typeof routeSpawnModeAndWaitForWebhook>[0] & { accountSettingsVersionHint: number })).resolves.toEqual(successResult);

    expect(mocks.spawnRegularProcessAndWaitForWebhook).toHaveBeenCalledTimes(1);
    expect(mocks.spawnRegularProcessAndWaitForWebhook).toHaveBeenCalledWith(expect.objectContaining({
      args: [
        'opencode',
        '--happy-starting-mode',
        'remote',
        '--started-by',
        'daemon',
      ],
      directory: '/tmp/happier-project',
    }));
    expect(mocks.spawnWindowsHostedSessionAndWaitForWebhook).not.toHaveBeenCalled();
  });

  it('marks tmux fallback regular starts as plain instead of implying a hosted terminal', async () => {
    mocks.spawnTmuxHostedSessionAndWaitForWebhook.mockResolvedValueOnce({
      spawnResult: null,
      tmuxRequested: true,
      tmuxFallbackReason: 'tmux unavailable',
    });
    const { routeSpawnModeAndWaitForWebhook } = await import('./routeSpawnModeAndWaitForWebhook');

    await expect(routeSpawnModeAndWaitForWebhook({
      ...createParams(),
      terminalRequest: {
        requested: 'tmux',
        tmux: {
          sessionName: 'happy',
          isolated: true,
          tmpDir: '/tmp/happier-home/tmux',
          source: 'typed',
        },
      },
      options: {
        directory: '/tmp/happier-project',
        terminal: { mode: 'tmux', tmux: { sessionName: 'happy', isolated: true } },
      },
    })).resolves.toEqual(successResult);

    expect(mocks.spawnRegularProcessAndWaitForWebhook).toHaveBeenCalledWith(expect.objectContaining({
      args: expect.arrayContaining([
        '--happy-terminal-mode',
        'plain',
        '--happy-terminal-requested',
        'tmux',
        '--happy-terminal-fallback-reason',
        'tmux unavailable',
      ]),
    }));
    expect(mocks.spawnWindowsHostedSessionAndWaitForWebhook).not.toHaveBeenCalled();
  });
});
