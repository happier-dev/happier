import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawnHappyCLI: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('@/utils/spawnHappyCLI', () => ({
  spawnHappyCLI: mocks.spawnHappyCLI,
}));

vi.mock('node:fs/promises', () => ({
  writeFile: mocks.writeFile,
}));

function createFakeChildProcess(pid: number) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function createParams() {
  return {
    args: ['opencode'],
    directory: '/tmp/happier-project',
    options: { directory: '/tmp/happier-project' },
    trackedSpawnOptions: { directory: '/tmp/happier-project' },
    normalizedExistingSessionId: '',
    effectiveResume: '',
    directoryCreated: false,
    extraEnvForChildWithMessage: {},
    processEnv: {
      PATH: process.env.PATH,
      HAPPIER_DAEMON_STARTUP_SOURCE: 'manual',
      HAPPIER_DAEMON_SPAWNED_CHILD_OOM_SCORE_ADJ: '321',
    },
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

describe('spawnRegularProcessAndWaitForWebhook', () => {
  const originalOomScoreAdjustment = process.env.HAPPIER_DAEMON_SPAWNED_CHILD_OOM_SCORE_ADJ;
  const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;
  const originalServerUrl = process.env.HAPPIER_SERVER_URL;
  const originalPlatform = process.platform;

  beforeEach(() => {
    mocks.spawnHappyCLI.mockReset().mockReturnValue(createFakeChildProcess(4242));
    mocks.writeFile.mockReset().mockResolvedValue(undefined);
    process.env.HAPPIER_DAEMON_SPAWNED_CHILD_OOM_SCORE_ADJ = '321';
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'linux',
    });
  });

  afterEach(() => {
    if (originalOomScoreAdjustment === undefined) {
      delete process.env.HAPPIER_DAEMON_SPAWNED_CHILD_OOM_SCORE_ADJ;
    } else {
      process.env.HAPPIER_DAEMON_SPAWNED_CHILD_OOM_SCORE_ADJ = originalOomScoreAdjustment;
    }
    if (originalHappyHomeDir === undefined) {
      delete process.env.HAPPIER_HOME_DIR;
    } else {
      process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;
    }
    if (originalServerUrl === undefined) {
      delete process.env.HAPPIER_SERVER_URL;
    } else {
      process.env.HAPPIER_SERVER_URL = originalServerUrl;
    }
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform,
    });
  });

  it('applies the spawned child OOM score adjustment after a PID is available', async () => {
    const { spawnRegularProcessAndWaitForWebhook } = await import('./spawnRegularProcessAndWaitForWebhook');
    const params = createParams();

    const resultPromise = spawnRegularProcessAndWaitForWebhook(params);

    await vi.waitFor(() => {
      expect(mocks.writeFile).toHaveBeenCalledWith('/proc/4242/oom_score_adj', '321\n', 'utf8');
    });
    const awaiter = params.pidToAwaiter.get(4242);
    expect(awaiter).toBeDefined();
    awaiter?.({
      startedBy: 'daemon',
      pid: 4242,
      happySessionId: 'session-1',
      spawnOptions: params.trackedSpawnOptions,
      directoryCreated: false,
    });

    await expect(resultPromise).resolves.toEqual({
      type: 'success',
      sessionId: 'session-1',
    });
  });

  it('uses the daemon process env supplied by spawn orchestration for regular child launch', async () => {
    process.env.HAPPIER_HOME_DIR = '/tmp/ambient-happier-home';
    process.env.HAPPIER_SERVER_URL = 'https://ambient.example.test';

    const { spawnRegularProcessAndWaitForWebhook } = await import('./spawnRegularProcessAndWaitForWebhook');
    const params = {
      ...createParams(),
      processEnv: {
        PATH: process.env.PATH,
        HAPPIER_DAEMON_STARTUP_SOURCE: 'manual',
        HAPPIER_DAEMON_SPAWNED_CHILD_OOM_SCORE_ADJ: '321',
        HAPPIER_HOME_DIR: '/tmp/daemon-happier-home',
        HAPPIER_SERVER_URL: 'https://daemon.example.test',
      },
    } as Parameters<typeof spawnRegularProcessAndWaitForWebhook>[0] & { processEnv: NodeJS.ProcessEnv };

    const resultPromise = spawnRegularProcessAndWaitForWebhook(params);

    await vi.waitFor(() => {
      expect(mocks.spawnHappyCLI).toHaveBeenCalled();
    });
    const launchOptions = mocks.spawnHappyCLI.mock.calls[0]?.[1] as { env?: NodeJS.ProcessEnv } | undefined;
    expect(launchOptions?.env?.HAPPIER_HOME_DIR).toBe('/tmp/daemon-happier-home');
    expect(launchOptions?.env?.HAPPIER_SERVER_URL).toBe('https://daemon.example.test');

    const awaiter = params.pidToAwaiter.get(4242);
    expect(awaiter).toBeDefined();
    awaiter?.({
      startedBy: 'daemon',
      pid: 4242,
      happySessionId: 'session-1',
      spawnOptions: params.trackedSpawnOptions,
      directoryCreated: false,
    });

    await expect(resultPromise).resolves.toEqual({
      type: 'success',
      sessionId: 'session-1',
    });
  });
});
