import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceSyncSidecarLifecycle,
  WORKSPACE_SYNC_SIDECAR_STARTUP_DEADLINE_MS,
  type SpawnWorkspaceSyncSidecar,
  type WorkspaceSyncSidecarLifecycleDependencies,
  type WorkspaceSyncSidecarProcess,
} from './workspaceSyncSidecarLifecycle';

describe('WorkspaceSyncSidecarLifecycle', () => {
  it('settles pending artifact acquisition at the startup deadline and ignores its late result', async () => {
    vi.useFakeTimers();
    let releaseArtifact!: () => void;
    let markAcquiring!: () => void;
    const acquiring = new Promise<void>(resolve => { markAcquiring = resolve; });
    const artifact = new Promise<void>(resolve => { releaseArtifact = resolve; });
    const broker = vi.fn<WorkspaceSyncSidecarLifecycleDependencies['createBroker']>();
    const spawn = vi.fn<SpawnWorkspaceSyncSidecar>();
    const states: string[] = [];
    const lifecycle = new WorkspaceSyncSidecarLifecycle({
      resolveRuntime: async () => {
        markAcquiring();
        await artifact;
        return { managerPath: '/verified/manager', agentPath: '/verified/agent',
          dataDir: '/private/data', brokerDir: '/private/broker',
          manifest: { engineVersion: '1', protocolEpoch: 'external-stream-v1' } };
      },
      createBroker: broker, spawn, ensurePrivateDirectory: async () => {},
      openExternalStream: vi.fn(), randomBytes: () => new Uint8Array(32), randomId: () => 'id',
      onRestartReady: async () => {}, onReadinessChanged: state => states.push(state.state),
    });
    let outcome: unknown = 'pending';
    const starting = lifecycle.start().then(
      () => { outcome = 'ready'; }, error => { outcome = error; },
    );
    try {
      await acquiring;
      await vi.advanceTimersByTimeAsync(WORKSPACE_SYNC_SIDECAR_STARTUP_DEADLINE_MS);
      expect(outcome).toMatchObject({ code: 'engine_unavailable' });
      expect(states).toEqual(['starting', 'unavailable']);
      await lifecycle.stop();
      releaseArtifact();
      await starting;
      await Promise.resolve();
      expect(broker).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(lifecycle.readProcessRoots()).toEqual([]);
    } finally {
      releaseArtifact();
      await starting;
      await lifecycle.stop();
      vi.useRealTimers();
    }
  });

  it('stops the exact pending-authentication root without publishing readiness or restarting it', async () => {
    let finishReadiness!: () => void;
    const readiness = new Promise<void>((resolve) => { finishReadiness = resolve; });
    let exit!: (event: { type: 'exited'; code: number }) => void;
    const termination = new Promise<{ type: 'exited'; code: number }>((resolve) => { exit = resolve; });
    const states: string[] = [];
    const waitForReady = vi.fn(async () => await readiness);
    const spawn = vi.fn<SpawnWorkspaceSyncSidecar>(async () => ({ pid: 42,
      waitForTermination: async () => await termination, stop: async () => exit({ type: 'exited', code: 0 }) }));
    const lifecycle = new WorkspaceSyncSidecarLifecycle({
      resolveRuntime: async () => ({ managerPath: '/verified/manager', agentPath: '/verified/agent',
        dataDir: '/private/data', brokerDir: '/private/broker', manifest: { engineVersion: '1', protocolEpoch: 'external-stream-v1' } }),
      createBroker: async () => ({ bootstrapDescriptor: new Uint8Array([1]), waitForReady,
        command: async () => [], close: async () => undefined }),
      openExternalStream: vi.fn(), spawn, ensurePrivateDirectory: async () => undefined,
      randomBytes: () => new Uint8Array(32), randomId: () => 'opaque-id', onRestartReady: async () => undefined,
      onReadinessChanged: (state) => states.push(state.state), shutdownGraceMs: 0,
    });
    const starting = lifecycle.start().catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(waitForReady).toHaveBeenCalled());
      const root = lifecycle.readProcessRoots()[0];
      expect(root).toMatchObject({ owner: { kind: 'workspace_sync' }, pid: 42 });
      const stopping = root?.stop?.();
      finishReadiness();
      await stopping;
      expect(await starting).toMatchObject({ code: 'engine_unavailable' });
      expect(states).not.toContain('ready');
      expect(lifecycle.readProcessRoots()).toEqual([]);
      await expect(lifecycle.start()).rejects.toMatchObject({ code: 'engine_unavailable' });
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      finishReadiness();
      await lifecycle.stop();
      await starting;
    }
  });

  it.each(['resolve', 'broker', 'spawn'] as const)(
    'waits for an in-flight %s acquisition and retires every late sidecar resource',
    async (blockedStage) => {
      let releaseStage!: () => void;
      let stageReached!: () => void;
      const stageGate = new Promise<void>((resolve) => { releaseStage = resolve; });
      const reached = new Promise<void>((resolve) => { stageReached = resolve; });
      const waitAtStage = async (stage: typeof blockedStage): Promise<void> => {
        if (blockedStage !== stage) return;
        stageReached();
        await stageGate;
      };
      const processStop = vi.fn(async () => undefined);
      const brokerClose = vi.fn(async () => undefined);
      const createBroker = vi.fn(async () => {
        await waitAtStage('broker');
        return {
          bootstrapDescriptor: new Uint8Array([1]),
          waitForReady: async () => undefined,
          command: async () => [],
          close: brokerClose,
        };
      });
      const spawn = vi.fn(async () => {
        await waitAtStage('spawn');
        return {
          pid: 42,
          waitForTermination: async () => await new Promise<never>(() => {}),
          stop: processStop,
        };
      });
      const lifecycle = new WorkspaceSyncSidecarLifecycle({
        resolveRuntime: vi.fn(async () => {
          await waitAtStage('resolve');
          return {
            managerPath: '/verified/manager', agentPath: '/verified/agent',
            dataDir: '/private/data', brokerDir: '/private/broker',
            manifest: { engineVersion: '1', protocolEpoch: 'external-stream-v1' },
          };
        }),
        createBroker,
        openExternalStream: vi.fn(),
        spawn,
        ensurePrivateDirectory: vi.fn(async () => undefined),
        randomBytes: () => new Uint8Array(32), randomId: () => 'opaque-id',
        onRestartReady: async () => undefined,
        shutdownGraceMs: 0,
      });

      const starting = lifecycle.start();
      await reached;
      let stopSettled = false;
      const stopping = lifecycle.stop().finally(() => { stopSettled = true; });
      await Promise.resolve();
      expect(stopSettled).toBe(false);
      releaseStage();

      await expect(starting).rejects.toMatchObject({ code: 'engine_unavailable' });
      await expect(stopping).resolves.toBeUndefined();
      expect(createBroker).toHaveBeenCalledTimes(blockedStage === 'resolve' ? 0 : 1);
      expect(spawn).toHaveBeenCalledTimes(blockedStage === 'spawn' ? 1 : 0);
      expect(brokerClose).toHaveBeenCalledTimes(blockedStage === 'resolve' ? 0 : 1);
      expect(processStop).toHaveBeenCalledTimes(blockedStage === 'spawn' ? 1 : 0);
    },
  );

  it('starts one verified sidecar and delivers the complete broker bootstrap only on descriptor 3', async () => {
    let terminate!: () => void;
    const waitForTermination = new Promise<void>((resolve) => { terminate = resolve; });
    const command = vi.fn(async (input: { t: string }) => {
      if (input.t === 'shutdown') terminate();
      return [];
    });
    const closeBroker = vi.fn(async () => undefined);
    const stop = vi.fn(async () => { terminate(); });
    const spawn = vi.fn<SpawnWorkspaceSyncSidecar>(async () => ({ pid: 42, waitForTermination: async () => { await waitForTermination; return { type: 'exited' as const, code: 0 }; }, stop }));
    const openExternalStream = vi.fn();
    const brokerBootstrapDescriptor = new TextEncoder().encode('{"protocol":1,"secret":"descriptor-only"}');
    const setExpectedSidecarPid = vi.fn();
    const createBroker = vi.fn<WorkspaceSyncSidecarLifecycleDependencies['createBroker']>(async () => ({ bootstrapDescriptor: brokerBootstrapDescriptor, setExpectedSidecarPid, waitForReady: vi.fn(async () => undefined), command, close: closeBroker }));
    const lifecycle = new WorkspaceSyncSidecarLifecycle({
      resolveRuntime: vi.fn(async () => ({
        managerPath: '/verified/bin/happier-mutagen',
        agentPath: '/verified/bin/happier-mutagen-agent',
        dataDir: '/daemon/workspace-sync/mutagen/data',
        brokerDir: '/daemon/workspace-sync/mutagen/broker',
        manifest: { engineVersion: '0.18.1', protocolEpoch: 'external-stream-v1' },
      })),
      createBroker,
      openExternalStream,
      spawn: async (input) => {
        input.onSpawned?.(42);
        return await spawn(input);
      },
      ensurePrivateDirectory: vi.fn(async () => undefined),
      randomBytes: () => new Uint8Array(32).fill(7),
      randomId: () => 'opaque-id',
      onRestartReady: async () => undefined,
      shutdownGraceMs: 1_000,
    });

    await lifecycle.start();
    await lifecycle.start();
    expect(spawn).toHaveBeenCalledTimes(1);
    const launch = spawn.mock.calls[0]?.[0];
    expect(launch?.args).toEqual([
      '--daemon', '--data-directory', '/daemon/workspace-sync/mutagen/data',
      '--broker-descriptor', '3',
    ]);
    expect(JSON.stringify(launch?.args)).not.toContain('070707');
    expect(launch?.environment).toBeUndefined();
    expect(launch?.inheritedBrokerDescriptor).toEqual(brokerBootstrapDescriptor);
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ t: 'list' }));
    expect(createBroker).toHaveBeenCalledWith(expect.objectContaining({ openExternalStream }));
    expect(setExpectedSidecarPid).toHaveBeenCalledWith(42);

    const root = lifecycle.readProcessRoots()[0];
    expect(root).toMatchObject({ owner: { kind: 'workspace_sync' }, pid: 42 });
    await root?.stop?.();
    expect(lifecycle.readProcessRoots()).toEqual([]);
    await expect(lifecycle.start()).rejects.toMatchObject({ code: 'engine_unavailable' });
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ t: 'shutdown' }));
    expect(closeBroker).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
  });

  it('surfaces broker endpoint cleanup failure after still completing sidecar shutdown', async () => {
    let terminate!: () => void;
    const termination = new Promise<void>((resolve) => { terminate = resolve; });
    const cleanupFailure = new AggregateError([new Error('pipe cleanup failed')], 'broker cleanup failed');
    const close = vi.fn(async () => { throw cleanupFailure; });
    const command = vi.fn(async (input: { t: string }) => {
      if (input.t === 'shutdown') terminate();
      return [];
    });
    const lifecycle = new WorkspaceSyncSidecarLifecycle({
      resolveRuntime: vi.fn(async () => ({
        managerPath: '/verified/manager', agentPath: '/verified/agent',
        dataDir: '/private/data', brokerDir: '/private/broker',
        manifest: { engineVersion: '1', protocolEpoch: 'external-stream-v1' },
      })),
      createBroker: vi.fn(async () => ({
        bootstrapDescriptor: new Uint8Array([1]), waitForReady: async () => undefined,
        command, close,
      })),
      openExternalStream: vi.fn(),
      spawn: vi.fn(async () => ({
        pid: 42,
        waitForTermination: async () => { await termination; return { type: 'exited' as const, code: 0 }; },
        stop: async () => terminate(),
      })),
      ensurePrivateDirectory: vi.fn(async () => undefined),
      randomBytes: () => new Uint8Array(32), randomId: () => 'opaque-id',
      onRestartReady: async () => undefined,
      shutdownGraceMs: 1_000,
    });

    await lifecycle.start();
    await expect(lifecycle.stop()).rejects.toBe(cleanupFailure);
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ t: 'shutdown' }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('bounds a shutdown command that never settles from the moment it is dispatched', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const lifecycle = new WorkspaceSyncSidecarLifecycle({
      resolveRuntime: vi.fn(async () => ({
        managerPath: '/verified/manager', agentPath: '/verified/agent',
        dataDir: '/private/data', brokerDir: '/private/broker',
        manifest: { engineVersion: '1', protocolEpoch: 'external-stream-v1' },
      })),
      createBroker: vi.fn(async () => ({
        bootstrapDescriptor: new Uint8Array([1]),
        waitForReady: async () => undefined,
        command: async (input: { t: string }) => {
          if (input.t === 'shutdown') {
            events.push('shutdown');
            return await new Promise<never>(() => {});
          }
          return [];
        },
        close: async () => { events.push('broker-close'); },
      })),
      openExternalStream: vi.fn(),
      spawn: vi.fn(async () => ({
        pid: 42,
        waitForTermination: async () => await new Promise<never>(() => {}),
        stop: async () => { events.push('child-stop'); },
      })),
      ensurePrivateDirectory: vi.fn(async () => undefined),
      randomBytes: () => new Uint8Array(32), randomId: () => 'opaque-id',
      onRestartReady: async () => undefined,
      shutdownGraceMs: 25,
    });

    try {
      await lifecycle.start();
      let outcome = 'pending';
      void lifecycle.stop().then(
        () => { outcome = 'stopped'; },
        () => { outcome = 'failed'; },
      );

      await vi.advanceTimersByTimeAsync(25);

      expect(outcome).toBe('stopped');
      expect(events).toEqual(['shutdown', 'broker-close', 'child-stop']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the broker alive while the sidecar exits naturally during shutdown grace', async () => {
    let terminate!: () => void;
    const termination = new Promise<void>((resolve) => { terminate = resolve; });
    const command = vi.fn(async () => []);
    const close = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const lifecycle = new WorkspaceSyncSidecarLifecycle({
      resolveRuntime: vi.fn(async () => ({
        managerPath: '/verified/manager', agentPath: '/verified/agent',
        dataDir: '/private/data', brokerDir: '/private/broker',
        manifest: { engineVersion: '1', protocolEpoch: 'external-stream-v1' },
      })),
      createBroker: vi.fn(async () => ({
        bootstrapDescriptor: new Uint8Array([1]),
        waitForReady: async () => undefined,
        command,
        close,
      })),
      openExternalStream: vi.fn(),
      spawn: vi.fn(async () => ({
        pid: 42,
        waitForTermination: async () => { await termination; return { type: 'exited' as const, code: 0 }; },
        stop,
      })),
      ensurePrivateDirectory: vi.fn(async () => undefined),
      randomBytes: () => new Uint8Array(32), randomId: () => 'opaque-id',
      onRestartReady: async () => undefined,
      shutdownGraceMs: 1_000,
    });

    await lifecycle.start();
    const stopping = lifecycle.stop();
    await vi.waitFor(() => expect(command).toHaveBeenCalledWith(expect.objectContaining({ t: 'shutdown' })));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(close).not.toHaveBeenCalled();
    terminate();
    await expect(stopping).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
  });

  it('closes broker streams before force-stopping the child when shutdown grace expires', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const lifecycle = new WorkspaceSyncSidecarLifecycle({
      resolveRuntime: vi.fn(async () => ({
        managerPath: '/verified/manager', agentPath: '/verified/agent',
        dataDir: '/private/data', brokerDir: '/private/broker',
        manifest: { engineVersion: '1', protocolEpoch: 'external-stream-v1' },
      })),
      createBroker: vi.fn(async () => ({
        bootstrapDescriptor: new Uint8Array([1]),
        waitForReady: async () => undefined,
        command: async (input: { t: string }) => {
          if (input.t === 'shutdown') events.push('shutdown');
          return [];
        },
        close: async () => { events.push('broker-close'); },
      })),
      openExternalStream: vi.fn(),
      spawn: vi.fn(async () => ({
        pid: 42,
        waitForTermination: async () => await new Promise<never>(() => {}),
        stop: async () => { events.push('child-stop'); },
      })),
      ensurePrivateDirectory: vi.fn(async () => undefined),
      randomBytes: () => new Uint8Array(32), randomId: () => 'opaque-id',
      onRestartReady: async () => undefined,
      shutdownGraceMs: 25,
    });

    try {
      await lifecycle.start();
      const stopping = lifecycle.stop();
      await Promise.resolve();
      await Promise.resolve();
      expect(events).toEqual(['shutdown']);

      await vi.advanceTimersByTimeAsync(25);
      await stopping;
      expect(events).toEqual(['shutdown', 'broker-close', 'child-stop']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports every shutdown cleanup failure and retains broker and process custody for retry', async () => {
    const shutdownFailure = new Error('shutdown command failed');
    const brokerFailure = new Error('broker close failed');
    const processFailure = new Error('process stop failed');
    let shutdownAttempts = 0;
    const command = vi.fn(async (input: { t: string }) => {
      if (input.t !== 'shutdown') return [];
      shutdownAttempts += 1;
      if (shutdownAttempts === 1) throw shutdownFailure;
      return [];
    });
    const close = vi.fn()
      .mockRejectedValueOnce(brokerFailure)
      .mockResolvedValueOnce(undefined);
    const stop = vi.fn()
      .mockRejectedValueOnce(processFailure)
      .mockResolvedValueOnce(undefined);
    const lifecycle = new WorkspaceSyncSidecarLifecycle({
      resolveRuntime: vi.fn(async () => ({
        managerPath: '/verified/manager', agentPath: '/verified/agent',
        dataDir: '/private/data', brokerDir: '/private/broker',
        manifest: { engineVersion: '1', protocolEpoch: 'external-stream-v1' },
      })),
      createBroker: vi.fn(async () => ({
        bootstrapDescriptor: new Uint8Array([1]),
        waitForReady: async () => undefined,
        command,
        close,
      })),
      openExternalStream: vi.fn(),
      spawn: vi.fn(async () => ({
        pid: 42,
        waitForTermination: async () => await new Promise<never>(() => {}),
        stop,
      })),
      ensurePrivateDirectory: vi.fn(async () => undefined),
      randomBytes: () => new Uint8Array(32), randomId: () => 'opaque-id',
      onRestartReady: async () => undefined,
      shutdownGraceMs: 0,
    });

    await lifecycle.start();
    const failure = await lifecycle.stop().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      shutdownFailure,
      brokerFailure,
      processFailure,
    ]);

    await expect(lifecycle.stop()).resolves.toBeUndefined();
    expect(command.mock.calls.filter(([input]) => input.t === 'shutdown')).toHaveLength(2);
    expect(close).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('returns a typed engine_unavailable error when artifact resolution fails', async () => {
    const onReadinessChanged = vi.fn();
    const lifecycle = new WorkspaceSyncSidecarLifecycle({
      resolveRuntime: vi.fn(async () => { throw new Error('missing artifact'); }),
      createBroker: vi.fn(), spawn: vi.fn(), ensurePrivateDirectory: vi.fn(),
      openExternalStream: vi.fn(),
      randomBytes: () => new Uint8Array(32), randomId: () => 'opaque-id',
      onRestartReady: async () => undefined,
      onReadinessChanged,
      shutdownGraceMs: 0,
    });
    await expect(lifecycle.start()).rejects.toMatchObject({ code: 'engine_unavailable' });
    expect(onReadinessChanged.mock.calls.map(([state]) => state)).toEqual([
      { state: 'starting' },
      { state: 'unavailable', errorCode: 'engine_unavailable' },
    ]);
  });

  it('fails startup when the spawned sidecar exits before authenticating', async () => {
    const stop = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const lifecycle = new WorkspaceSyncSidecarLifecycle({
      resolveRuntime: vi.fn(async () => ({
        managerPath: '/verified/manager', agentPath: '/verified/agent',
        dataDir: '/private/data', brokerDir: '/private/broker',
        manifest: { engineVersion: '1', protocolEpoch: 'external-stream-v1' },
      })),
      createBroker: vi.fn(async () => ({
        bootstrapDescriptor: new Uint8Array([1]),
        waitForReady: async () => await new Promise<void>(() => {}),
        command: async () => [],
        close,
      })),
      openExternalStream: vi.fn(),
      spawn: vi.fn(async () => ({
        pid: 42,
        waitForTermination: async () => ({ type: 'exited' as const, code: 23 }),
        stop,
      })),
      ensurePrivateDirectory: vi.fn(async () => undefined),
      randomBytes: () => new Uint8Array(32), randomId: () => 'opaque-id',
      onRestartReady: async () => undefined,
      shutdownGraceMs: 0,
    });

    const outcome = await Promise.race([
      lifecycle.start().then(() => 'ready', (error: unknown) => error),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 100)),
    ]);
    expect(outcome).toMatchObject({ code: 'engine_unavailable' });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    await lifecycle.stop();
  });

  it('fails and retires a sidecar that stalls before authenticated readiness', async () => {
    let terminate!: (event: { type: 'exited'; code: number }) => void;
    const termination = new Promise<{ type: 'exited'; code: number }>((resolve) => { terminate = resolve; });
    const stop = vi.fn(async () => terminate({ type: 'exited', code: 0 }));
    const close = vi.fn(async () => undefined);
    const lifecycle = new WorkspaceSyncSidecarLifecycle({
      resolveRuntime: vi.fn(async () => ({
        managerPath: '/verified/manager', agentPath: '/verified/agent',
        dataDir: '/private/data', brokerDir: '/private/broker',
        manifest: { engineVersion: '1', protocolEpoch: 'external-stream-v1' },
      })),
      createBroker: vi.fn(async () => ({
        bootstrapDescriptor: new Uint8Array([1]),
        waitForReady: async () => await new Promise<void>(() => {}),
        command: async () => [],
        close,
      })),
      openExternalStream: vi.fn(),
      spawn: vi.fn(async () => ({
        pid: 42,
        waitForTermination: async () => await termination,
        stop,
      })),
      ensurePrivateDirectory: vi.fn(async () => undefined),
      randomBytes: () => new Uint8Array(32), randomId: () => 'opaque-id',
      onRestartReady: async () => undefined,
      startupDeadlineMs: 25,
      shutdownGraceMs: 0,
    });

    await expect(lifecycle.start()).rejects.toMatchObject({ code: 'engine_unavailable' });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    await lifecycle.stop();
  });

  it('bounds a sidecar launcher that never resolves with the same startup deadline', async () => {
    const close = vi.fn(async () => undefined);
    const spawn = vi.fn<SpawnWorkspaceSyncSidecar>(async () => await new Promise<WorkspaceSyncSidecarProcess>(() => {}));
    const lifecycle = new WorkspaceSyncSidecarLifecycle({
      resolveRuntime: vi.fn(async () => ({
        managerPath: '/verified/manager', agentPath: '/verified/agent',
        dataDir: '/private/data', brokerDir: '/private/broker',
        manifest: { engineVersion: '1', protocolEpoch: 'external-stream-v1' },
      })),
      createBroker: vi.fn(async () => ({
        bootstrapDescriptor: new Uint8Array([1]),
        waitForReady: async () => undefined,
        command: async () => [],
        close,
      })),
      openExternalStream: vi.fn(),
      spawn,
      ensurePrivateDirectory: vi.fn(async () => undefined),
      randomBytes: () => new Uint8Array(32), randomId: () => 'opaque-id',
      onRestartReady: async () => undefined,
      startupDeadlineMs: 25,
      shutdownGraceMs: 0,
    });

    const outcome = await Promise.race([
      lifecycle.start().then(() => 'ready', (error: unknown) => error),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 100)),
    ]);
    expect(outcome).toMatchObject({ code: 'engine_unavailable' });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    const stopOutcome = await Promise.race([
      lifecycle.stop().then(() => 'stopped', (error: unknown) => error),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 100)),
    ]);
    expect(stopOutcome).toMatchObject({
      code: 'engine_unavailable',
      message: expect.stringContaining('cleanup is pending'),
    });
  });

  it('stops a sidecar process that arrives after its startup deadline', async () => {
    let resolveSpawn!: (process: WorkspaceSyncSidecarProcess) => void;
    const deferredSpawn = new Promise<WorkspaceSyncSidecarProcess>((resolve) => { resolveSpawn = resolve; });
    const stop = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const lifecycle = new WorkspaceSyncSidecarLifecycle({
      resolveRuntime: vi.fn(async () => ({
        managerPath: '/verified/manager', agentPath: '/verified/agent',
        dataDir: '/private/data', brokerDir: '/private/broker',
        manifest: { engineVersion: '1', protocolEpoch: 'external-stream-v1' },
      })),
      createBroker: vi.fn(async () => ({
        bootstrapDescriptor: new Uint8Array([1]),
        waitForReady: async () => undefined,
        command: async () => [],
        close,
      })),
      openExternalStream: vi.fn(),
      spawn: vi.fn(async () => await deferredSpawn),
      ensurePrivateDirectory: vi.fn(async () => undefined),
      randomBytes: () => new Uint8Array(32), randomId: () => 'opaque-id',
      onRestartReady: async () => undefined,
      startupDeadlineMs: 25,
      shutdownGraceMs: 0,
    });

    await expect(lifecycle.start()).rejects.toMatchObject({ code: 'engine_unavailable' });
    resolveSpawn({
      pid: 42,
      waitForTermination: async () => await new Promise<never>(() => {}),
      stop,
    });
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    expect(close).toHaveBeenCalledTimes(1);
    await lifecycle.stop();
  });

  it('retains a late sidecar whose first stop fails and retries it on the next lifecycle stop', async () => {
    let resolveSpawn!: (process: WorkspaceSyncSidecarProcess) => void;
    const deferredSpawn = new Promise<WorkspaceSyncSidecarProcess>((resolve) => { resolveSpawn = resolve; });
    const cleanupFailure = new Error('late sidecar stop failed');
    let finishFirstStop!: () => void;
    const firstStopGate = new Promise<void>((resolve) => { finishFirstStop = resolve; });
    const stop = vi.fn()
      .mockImplementationOnce(async () => {
        await firstStopGate;
        throw cleanupFailure;
      })
      .mockResolvedValueOnce(undefined);
    const lifecycle = new WorkspaceSyncSidecarLifecycle({
      resolveRuntime: vi.fn(async () => ({
        managerPath: '/verified/manager', agentPath: '/verified/agent',
        dataDir: '/private/data', brokerDir: '/private/broker',
        manifest: { engineVersion: '1', protocolEpoch: 'external-stream-v1' },
      })),
      createBroker: vi.fn(async () => ({
        bootstrapDescriptor: new Uint8Array([1]),
        waitForReady: async () => undefined,
        command: async () => [],
        close: async () => undefined,
      })),
      openExternalStream: vi.fn(),
      spawn: vi.fn(async () => await deferredSpawn),
      ensurePrivateDirectory: vi.fn(async () => undefined),
      randomBytes: () => new Uint8Array(32), randomId: () => 'opaque-id',
      onRestartReady: async () => undefined,
      startupDeadlineMs: 25,
      shutdownGraceMs: 0,
    });

    await expect(lifecycle.start()).rejects.toMatchObject({ code: 'engine_unavailable' });
    resolveSpawn({
      pid: 42,
      waitForTermination: async () => await new Promise<never>(() => {}),
      stop,
    });
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    const firstStop = lifecycle.stop();
    finishFirstStop();
    await expect(firstStop).rejects.toBe(cleanupFailure);
    await expect(lifecycle.stop()).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('supervises a crash restart without ever spawning a concurrent second sidecar', async () => {
    vi.useFakeTimers();
    const onRestartReady = vi.fn(async () => undefined);
    const exits: Array<(event: { type: 'exited'; code: number }) => void> = [];
    let active = 0;
    let maximumActive = 0;
    const spawn = vi.fn<SpawnWorkspaceSyncSidecar>(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const waitForTermination = new Promise<{ type: 'exited'; code: number }>((resolve) => exits.push(resolve));
      return {
        pid: 42,
        waitForTermination: async () => { const event = await waitForTermination; active -= 1; return event; },
        stop: async () => { active = Math.max(0, active - 1); },
      };
    });
    const lifecycle = new WorkspaceSyncSidecarLifecycle({
      resolveRuntime: vi.fn(async () => ({ managerPath: '/verified/manager', agentPath: '/verified/agent', dataDir: '/private/data', brokerDir: '/private/broker', manifest: { engineVersion: '1', protocolEpoch: 'external-stream-v1' } })),
      createBroker: vi.fn(async () => ({ bootstrapDescriptor: new Uint8Array([1]), waitForReady: async () => undefined, command: async () => [], close: async () => undefined })),
      openExternalStream: vi.fn(), spawn, ensurePrivateDirectory: vi.fn(async () => undefined),
      randomBytes: () => new Uint8Array(32), randomId: () => 'opaque-id',
      onRestartReady,
      shutdownGraceMs: 0,
    });
    await lifecycle.start();
    expect(onRestartReady).not.toHaveBeenCalled();
    const departedRoot = lifecycle.readProcessRoots()[0];
    exits[0]?.({ type: 'exited', code: 1 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(1);
    expect(onRestartReady).toHaveBeenCalledTimes(1);
    await expect(departedRoot?.stop?.()).rejects.toMatchObject({ code: 'process_root_changed' });
    expect(active).toBe(1);
    await lifecycle.stop();
    vi.useRealTimers();
  });

  it('retries crashed broker cleanup before publishing a replacement broker', async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const exits: Array<(event: { type: 'exited'; code: number }) => void> = [];
    const events: string[] = [];
    let oldCloseAttempts = 0;
    const createBroker = vi.fn(async () => {
      const brokerNumber = createBroker.mock.calls.length;
      events.push(`broker-create:${brokerNumber}`);
      return {
        bootstrapDescriptor: new Uint8Array([1]),
        waitForReady: async () => undefined,
        command: async () => [],
        close: async () => {
          if (brokerNumber !== 1) return;
          oldCloseAttempts += 1;
          events.push(`old-close:${oldCloseAttempts}`);
          if (oldCloseAttempts === 1) throw new Error('close failed');
        },
      };
    });
    const lifecycle = new WorkspaceSyncSidecarLifecycle({
      resolveRuntime: vi.fn(async () => ({ managerPath: '/verified/manager', agentPath: '/verified/agent', dataDir: '/private/data', brokerDir: '/private/broker', manifest: { engineVersion: '1', protocolEpoch: 'external-stream-v1' } })),
      createBroker,
      openExternalStream: vi.fn(),
      spawn: vi.fn(async () => ({
        pid: 40 + exits.length,
        waitForTermination: async () => await new Promise<{ type: 'exited'; code: number }>((resolve) => exits.push(resolve)),
        stop: async () => undefined,
      })),
      ensurePrivateDirectory: vi.fn(async () => undefined),
      randomBytes: () => new Uint8Array(32), randomId: () => 'opaque-id',
      onRestartReady: vi.fn(async () => undefined), shutdownGraceMs: 0,
    });
    try {
      await lifecycle.start();
      exits[0]?.({ type: 'exited', code: 1 });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(events).toEqual([
        'broker-create:1',
        'old-close:1',
        'old-close:2',
        'broker-create:2',
      ]);
      await lifecycle.stop();
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not reset the crash-loop budget merely because each replacement reaches readiness', async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const exits: Array<(event: { type: 'exited'; code: number }) => void> = [];
    const spawn = vi.fn<SpawnWorkspaceSyncSidecar>(async () => {
      let terminate!: (event: { type: 'exited'; code: number }) => void;
      const termination = new Promise<{ type: 'exited'; code: number }>((resolve) => { terminate = resolve; });
      exits.push(terminate);
      return {
        pid: 40 + exits.length,
        waitForTermination: async () => await termination,
        stop: async () => terminate({ type: 'exited', code: 0 }),
      };
    });
    const lifecycle = new WorkspaceSyncSidecarLifecycle({
      resolveRuntime: vi.fn(async () => ({ managerPath: '/verified/manager', agentPath: '/verified/agent', dataDir: '/private/data', brokerDir: '/private/broker', manifest: { engineVersion: '1', protocolEpoch: 'external-stream-v1' } })),
      createBroker: vi.fn(async () => ({ bootstrapDescriptor: new Uint8Array([1]), waitForReady: async () => undefined, command: async () => [], close: async () => undefined })),
      openExternalStream: vi.fn(), spawn, ensurePrivateDirectory: vi.fn(async () => undefined),
      randomBytes: () => new Uint8Array(32), randomId: () => 'opaque-id',
      onRestartReady: async () => undefined,
      shutdownGraceMs: 0,
    });

    try {
      await lifecycle.start();
      for (const delayMs of [250, 500, 1_000, 2_000, 4_000]) {
        exits.at(-1)?.({ type: 'exited', code: 1 });
        await vi.advanceTimersByTimeAsync(delayMs);
      }
      expect(spawn).toHaveBeenCalledTimes(6);

      exits.at(-1)?.({ type: 'exited', code: 1 });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(spawn).toHaveBeenCalledTimes(6);
    } finally {
      await lifecycle.stop();
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(['reconciliation_failure', 'root_stop'] as const)(
    'stops and closes a replacement sidecar without publishing readiness after %s', async (reason) => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const exits: Array<(event: { type: 'exited'; code: number }) => void> = [];
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    const brokerCloses: Array<ReturnType<typeof vi.fn>> = [];
    let rejectRestartReconciliation!: (error: Error) => void;
    let finishRestartReconciliation!: () => void;
    const states: string[] = [];
    const restartReconciliation = new Promise<void>((resolve, reject) => {
      finishRestartReconciliation = resolve;
      rejectRestartReconciliation = reject;
    });
    const spawn = vi.fn<SpawnWorkspaceSyncSidecar>(async () => {
      let terminate!: (event: { type: 'exited'; code: number }) => void;
      const termination = new Promise<{ type: 'exited'; code: number }>((resolve) => { terminate = resolve; });
      exits.push(terminate);
      const stop = vi.fn(async () => terminate({ type: 'exited', code: 0 }));
      stops.push(stop);
      return { pid: 40 + exits.length, waitForTermination: async () => await termination, stop };
    });
    const lifecycle = new WorkspaceSyncSidecarLifecycle({
      resolveRuntime: vi.fn(async () => ({ managerPath: '/verified/manager', agentPath: '/verified/agent', dataDir: '/private/data', brokerDir: '/private/broker', manifest: { engineVersion: '1', protocolEpoch: 'external-stream-v1' } })),
      createBroker: vi.fn(async () => {
        const close = vi.fn(async () => undefined);
        brokerCloses.push(close);
        return { bootstrapDescriptor: new Uint8Array([1]), waitForReady: async () => undefined, command: async () => [], close };
      }),
      openExternalStream: vi.fn(), spawn, ensurePrivateDirectory: vi.fn(async () => undefined),
      randomBytes: () => new Uint8Array(32), randomId: () => 'opaque-id',
      onRestartReady: async () => await restartReconciliation,
      onReadinessChanged: (state) => states.push(state.state),
      shutdownGraceMs: 0,
    });

    try {
      await lifecycle.start();
      exits[0]?.({ type: 'exited', code: 1 });
      await vi.advanceTimersByTimeAsync(250);

      expect(spawn).toHaveBeenCalledTimes(2);
      let waitingStartSettled = false;
      const waitingStart = lifecycle.start();
      void waitingStart.then(
        () => { waitingStartSettled = true; },
        () => { waitingStartSettled = true; },
      );
      await Promise.resolve();
      expect(waitingStartSettled).toBe(false);

      const stopping = reason === 'root_stop' ? lifecycle.readProcessRoots()[0]?.stop?.() : undefined;
      if (reason === 'root_stop') finishRestartReconciliation();
      else rejectRestartReconciliation(new Error('settings reconciliation failed'));
      await expect(waitingStart).rejects.toMatchObject({ code: 'engine_unavailable' });
      await stopping;
      expect(states.filter((state) => state === 'ready')).toHaveLength(1);
      if (reason === 'reconciliation_failure') {
        expect(stops[1]).toHaveBeenCalledTimes(1);
        expect(brokerCloses[1]).toHaveBeenCalledTimes(1);
      } else {
        expect(lifecycle.readProcessRoots()).toEqual([]);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(spawn).toHaveBeenCalledTimes(2);
      }
    } finally {
      finishRestartReconciliation();
      await lifecycle.stop();
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it('retains failed replacement cleanup custody and retries it before spawning again', async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const exits: Array<(event: { type: 'exited'; code: number }) => void> = [];
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    const cleanupFailure = new Error('replacement cleanup failed');
    let releaseRetainedCleanup!: () => void;
    const retainedCleanup = new Promise<void>((resolve) => { releaseRetainedCleanup = resolve; });
    let markThirdSpawned!: () => void;
    const thirdSpawned = new Promise<void>((resolve) => { markThirdSpawned = resolve; });
    let replacementStopAttempts = 0;
    const spawn = vi.fn<SpawnWorkspaceSyncSidecar>(async () => {
      let terminate!: (event: { type: 'exited'; code: number }) => void;
      const termination = new Promise<{ type: 'exited'; code: number }>((resolve) => { terminate = resolve; });
      exits.push(terminate);
      const processNumber = exits.length;
      if (processNumber === 3) markThirdSpawned();
      const stop = vi.fn(async () => {
        if (processNumber === 2) {
          replacementStopAttempts += 1;
          if (replacementStopAttempts === 1) throw cleanupFailure;
          await retainedCleanup;
        }
        terminate({ type: 'exited', code: 0 });
      });
      stops.push(stop);
      return { pid: 40 + processNumber, waitForTermination: async () => await termination, stop };
    });
    const onRestartReady = vi.fn(async () => undefined);
    onRestartReady.mockRejectedValueOnce(new Error('settings reconciliation failed'));
    const lifecycle = new WorkspaceSyncSidecarLifecycle({
      resolveRuntime: vi.fn(async () => ({ managerPath: '/verified/manager', agentPath: '/verified/agent', dataDir: '/private/data', brokerDir: '/private/broker', manifest: { engineVersion: '1', protocolEpoch: 'external-stream-v1' } })),
      createBroker: vi.fn(async () => ({ bootstrapDescriptor: new Uint8Array([1]), waitForReady: async () => undefined, command: async () => [], close: async () => undefined })),
      openExternalStream: vi.fn(), spawn, ensurePrivateDirectory: vi.fn(async () => undefined),
      randomBytes: () => new Uint8Array(32), randomId: () => 'opaque-id',
      onRestartReady,
      shutdownGraceMs: 0,
    });

    try {
      await lifecycle.start();
      exits[0]?.({ type: 'exited', code: 1 });
      await vi.advanceTimersByTimeAsync(250);

      expect(spawn).toHaveBeenCalledTimes(2);
      expect(stops[1]).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(500);
      expect(stops[1]).toHaveBeenCalledTimes(2);
      expect(spawn).toHaveBeenCalledTimes(2);

      releaseRetainedCleanup();
      await thirdSpawned;
      expect(spawn).toHaveBeenCalledTimes(3);
    } finally {
      releaseRetainedCleanup();
      await lifecycle.stop();
      random.mockRestore();
      vi.useRealTimers();
    }
  });
});
