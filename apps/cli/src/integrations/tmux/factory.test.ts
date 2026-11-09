import { ChildProcess, spawn } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isTmuxAvailable } from './factory';

// The tmux executable is the OS boundary; availability and command lifecycle stay real.
vi.mock('child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('child_process')>(),
  spawn: vi.fn(),
}));

describe('isTmuxAvailable', () => {
  beforeEach(() => vi.mocked(spawn).mockReset());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('fails closed when the ambient tmux server probe hangs', async () => {
    vi.useFakeTimers();
    vi.stubEnv('HAPPIER_CLI_TMUX_COMMAND_TIMEOUT_MS', '120000');
    const child = new ChildProcess();
    vi.spyOn(child, 'kill').mockReturnValue(true);
    vi.mocked(spawn).mockReturnValue(child);

    const availability = isTmuxAvailable();
    await vi.advanceTimersByTimeAsync(60_000);
    const available = await availability;

    expect(available).toBe(false);
    child.emit('close', 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['close', 'error'] as const)('releases the availability deadline after the command settles with %s', async (event) => {
    vi.useFakeTimers();
    const child = new ChildProcess();
    vi.mocked(spawn).mockReturnValue(child);

    const availability = isTmuxAvailable();
    if (event === 'close') child.emit('close', 0);
    else child.emit('error', new Error('spawn tmux ENOENT'));

    await expect(availability).resolves.toBe(event === 'close');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start a tmux process for a plain session and still probes an explicitly requested host', async () => {
    const { spawnTmuxHostedSessionAndWaitForWebhook } = await import('@/daemon/spawn/spawnTmuxHostedSessionAndWaitForWebhook');
    const input: Parameters<typeof spawnTmuxHostedSessionAndWaitForWebhook>[0] = {
      terminalRequest: { requested: 'plain' },
      directory: '/tmp/project',
      options: { directory: '/tmp/project' },
      trackedSpawnOptions: { directory: '/tmp/project' },
      normalizedExistingSessionId: '',
      effectiveResume: '',
      effectiveBackendTargetV2: { kind: 'backend', sourceKind: 'built_in', backendId: 'codex' },
      sessionControlArgs: [],
      directoryCreated: false,
      extraEnvForChildWithMessage: {},
      pidToTrackedSession: new Map(),
      pidToAwaiter: new Map(),
      pidToSpawnResultResolver: new Map(),
      pidToSpawnWebhookTimeout: new Map(),
      resolveCanonicalTrackedSessionId: () => 'session-a',
      onChildExited: async () => {},
      spawnLifecycleCallbacks: {
        registerConnectedServiceSpawnTarget: () => {},
        registerSpawnResourceCleanupForPid: () => {},
        cleanupSpawnResourcesForPid: async () => true,
        consumeSessionAttachCleanupForPid: () => {},
        cleanupPendingSessionAttach: async () => {},
        persistAcceptedSpawnMarker: async () => {},
        removeAcceptedSpawnMarkerIfOwned: async () => true,
      },
      cleanupSpawnResources: () => {},
      logDebug: () => {},
      warn: () => {},
    };
    vi.mocked(spawn).mockImplementation(() => {
      const child = new ChildProcess();
      queueMicrotask(() => child.emit('error', new Error('spawn tmux ENOENT')));
      return child;
    });

    await expect(spawnTmuxHostedSessionAndWaitForWebhook(input)).resolves.toMatchObject({
      spawnResult: null,
      tmuxRequested: false,
      tmuxFallbackReason: null,
    });
    expect(vi.mocked(spawn).mock.calls.length).toBe(0);

    await expect(spawnTmuxHostedSessionAndWaitForWebhook({
      ...input,
      terminalRequest: { requested: 'tmux', tmux: { sessionName: 'happy', isolated: true, tmpDir: null, source: 'typed' } },
    })).resolves.toMatchObject({
      spawnResult: null,
      tmuxRequested: true,
      tmuxFallbackReason: 'tmux is not available on this machine',
    });
    expect(vi.mocked(spawn).mock.calls.length).toBe(1);
  });
});
