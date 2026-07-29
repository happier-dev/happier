import { describe, expect, it, vi } from 'vitest';

import type { DaemonState } from '@/api/types';
import { createDaemonTransferRuntimeState, createDaemonTransferRuntimeStatePublisher } from './transferRuntimeState';

describe('createDaemonTransferRuntimeState', () => {
  it('derives the initial transfer capability snapshot from direct-peer runtime config', () => {
    const state = createDaemonTransferRuntimeState({
      directPeer: {
        featureEnabled: true,
        serverEnabled: true,
        bindHost: '127.0.0.1',
        bindPort: 46001,
        advertisedHosts: ['127.0.0.1'],
      },
      tailscaleServe: {
        enabled: true,
        configured: true,
        active: false,
        available: true,
      },
    });

    expect(state).toEqual({
      supported: {
        import: true,
        export: true,
      },
      listenerClasses: {
        loopback_http: {
          enabled: true,
          configured: true,
          active: false,
        },
        tailscale_serve_https: {
          enabled: true,
          configured: true,
          active: false,
          available: true,
        },
      },
      lifecycle: {
        mode: 'lazy_idle_shutdown',
        version: 1,
      },
    });
  });

  it('projects a legacy nonloopback bind configuration through the loopback-only runtime posture', () => {
    const state = createDaemonTransferRuntimeState({
      directPeer: {
        featureEnabled: true,
        serverEnabled: true,
        bindHost: '0.0.0.0',
        bindPort: 46001,
        advertisedHosts: ['192.168.1.20'],
      },
    });

    expect(state.listenerClasses).toEqual({
      loopback_http: {
        enabled: true,
        configured: true,
        active: false,
      },
      tailscale_serve_https: {
        enabled: false,
        configured: false,
        active: false,
        available: false,
      },
    });
  });

  it('publishes lifecycle state changes through apiMachine.updateDaemonState after attachment', async () => {
    const initialState = createDaemonTransferRuntimeState({
      directPeer: {
        featureEnabled: true,
        serverEnabled: true,
        bindHost: '127.0.0.1',
        bindPort: 46001,
        advertisedHosts: ['127.0.0.1'],
      },
    });
    const publishedStates: DaemonState[] = [];
    const updateDaemonState = vi.fn(async (updater: (state: DaemonState | null) => DaemonState) => {
      const next = updater({
      status: 'running',
      pid: 123,
      httpPort: 46000,
      startedAt: 1,
      transfer: initialState,
      });
      publishedStates.push(next);
      return next;
    });
    const publisher = createDaemonTransferRuntimeStatePublisher({
      initialTransferState: initialState,
    });

    await publisher.publishDirectTransferServerLifecycleState({
      status: 'starting',
      listenerClasses: ['loopback_http'],
      publishedTransferCount: 0,
    });

    await publisher.attachApiMachine({
      updateDaemonState,
    });

    await publisher.publishDirectTransferServerLifecycleState({
      status: 'running',
      listenerClasses: ['loopback_http'],
      port: 46001,
      publishedTransferCount: 1,
    });

    await publisher.publishDirectTransferServerLifecycleState({
      status: 'stopped',
      listenerClasses: ['loopback_http'],
      publishedTransferCount: 0,
    });

    expect(updateDaemonState).toHaveBeenCalledTimes(3);
    expect(publishedStates).toHaveLength(3);
    const [startingState, runningState, stoppedState] = publishedStates;
    expect(startingState.transfer?.supported).toEqual({
      import: true,
      export: true,
    });
    expect(startingState.transfer?.listenerClasses.loopback_http.active).toBe(false);
    expect(runningState.transfer?.listenerClasses.loopback_http.active).toBe(true);
    expect(runningState.transfer?.listenerClasses.loopback_http.configured).toBe(true);
    expect(stoppedState.transfer?.listenerClasses.loopback_http.active).toBe(false);
  });

  it('publishes explicit tailscale transfer listener state independently of direct server lifecycle updates', async () => {
    const initialState = createDaemonTransferRuntimeState({
      directPeer: {
        featureEnabled: true,
        serverEnabled: true,
        bindHost: '127.0.0.1',
        bindPort: 46001,
        advertisedHosts: ['127.0.0.1'],
      },
      tailscaleServe: {
        enabled: true,
        configured: false,
        active: false,
        available: true,
      },
    });
    const publishedStates: DaemonState[] = [];
    const updateDaemonState = vi.fn(async (updater: (state: DaemonState | null) => DaemonState) => {
      const next = updater({
        status: 'running',
        pid: 123,
        httpPort: 46000,
        startedAt: 1,
        transfer: initialState,
      });
      publishedStates.push(next);
      return next;
    });
    const publisher = createDaemonTransferRuntimeStatePublisher({
      initialTransferState: initialState,
    });

    await publisher.attachApiMachine({
      updateDaemonState,
    });

    await publisher.publishTailscaleTransferListenerState({
      enabled: true,
      configured: true,
      active: true,
      available: true,
    });

    expect(updateDaemonState).toHaveBeenCalledTimes(1);
    expect(publishedStates[0]?.transfer?.listenerClasses.tailscale_serve_https).toEqual({
      enabled: true,
      configured: true,
      active: true,
      available: true,
    });
  });

  it('does not mark tailscale serve active until the tailscale listener publishes its own state', async () => {
    const initialState = createDaemonTransferRuntimeState({
      directPeer: {
        featureEnabled: true,
        serverEnabled: true,
        bindHost: '127.0.0.1',
        bindPort: 46001,
        advertisedHosts: ['127.0.0.1'],
      },
      tailscaleServe: {
        enabled: true,
        configured: false,
        active: false,
        available: true,
      },
    });
    const publishedStates: DaemonState[] = [];
    const updateDaemonState = vi.fn(async (updater: (state: DaemonState | null) => DaemonState) => {
      const next = updater({
        status: 'running',
        pid: 123,
        httpPort: 46000,
        startedAt: 1,
        transfer: initialState,
      });
      publishedStates.push(next);
      return next;
    });
    const publisher = createDaemonTransferRuntimeStatePublisher({
      initialTransferState: initialState,
    });

    await publisher.attachApiMachine({
      updateDaemonState,
    });

    await publisher.publishDirectTransferServerLifecycleState({
      status: 'running',
      listenerClasses: ['loopback_http', 'tailscale_serve_https'],
      port: 46001,
      publishedTransferCount: 1,
    });

    expect(updateDaemonState).toHaveBeenCalledTimes(1);
    expect(publishedStates[0]?.transfer?.listenerClasses.loopback_http.active).toBe(true);
    expect(publishedStates[0]?.transfer?.listenerClasses.tailscale_serve_https).toEqual({
      enabled: true,
      configured: false,
      active: false,
      available: true,
    });
  });

  it('preserves both direct lifecycle and tailscale listener state in the same daemon transfer snapshot', async () => {
    const initialState = createDaemonTransferRuntimeState({
      directPeer: {
        featureEnabled: true,
        serverEnabled: true,
        bindHost: '127.0.0.1',
        bindPort: 46001,
        advertisedHosts: ['127.0.0.1'],
      },
      tailscaleServe: {
        enabled: true,
        configured: false,
        active: false,
        available: true,
      },
    });
    const publishedStates: DaemonState[] = [];
    const updateDaemonState = vi.fn(async (updater: (state: DaemonState | null) => DaemonState) => {
      const next = updater({
        status: 'running',
        pid: 123,
        httpPort: 46000,
        startedAt: 1,
        transfer: initialState,
      });
      publishedStates.push(next);
      return next;
    });
    const publisher = createDaemonTransferRuntimeStatePublisher({
      initialTransferState: initialState,
    });

    await publisher.attachApiMachine({
      updateDaemonState,
    });

    await publisher.publishDirectTransferServerLifecycleState({
      status: 'running',
      listenerClasses: ['loopback_http'],
      port: 46001,
      publishedTransferCount: 1,
    });

    await publisher.publishTailscaleTransferListenerState({
      enabled: true,
      configured: true,
      active: true,
      available: true,
    });

    expect(updateDaemonState).toHaveBeenCalledTimes(2);
    expect(publishedStates.at(-1)?.transfer?.listenerClasses.loopback_http).toEqual({
      enabled: true,
      configured: true,
      active: true,
    });
    expect(publishedStates.at(-1)?.transfer?.listenerClasses.tailscale_serve_https).toEqual({
      enabled: true,
      configured: true,
      active: true,
      available: true,
    });
  });

  it('retains the latest pending state while quiescing and flushes it once after resume', async () => {
    const initialState = createDaemonTransferRuntimeState({
      directPeer: {
        featureEnabled: true,
        serverEnabled: true,
        bindHost: '127.0.0.1',
        bindPort: 46001,
        advertisedHosts: ['127.0.0.1'],
      },
    });
    let quiescing = true;
    const publishedStates: DaemonState[] = [];
    const updateDaemonState = vi.fn(async (updater: (state: DaemonState | null) => DaemonState) => {
      const next = updater({
        status: 'running',
        pid: 123,
        httpPort: 46000,
        startedAt: 1,
        transfer: initialState,
      });
      publishedStates.push(next);
      return next;
    });
    const publisher = createDaemonTransferRuntimeStatePublisher({
      initialTransferState: initialState,
      isDaemonQuiescing: () => quiescing,
    });

    await publisher.attachApiMachine({ updateDaemonState });
    await publisher.publishDirectTransferServerLifecycleState({
      status: 'starting',
      listenerClasses: ['loopback_http'],
      publishedTransferCount: 0,
    });
    await publisher.publishDirectTransferServerLifecycleState({
      status: 'running',
      listenerClasses: ['loopback_http'],
      port: 46001,
      publishedTransferCount: 1,
    });

    expect(updateDaemonState).not.toHaveBeenCalled();

    quiescing = false;
    await publisher.resume();
    await publisher.resume();

    expect(updateDaemonState).toHaveBeenCalledTimes(1);
    expect(publishedStates).toHaveLength(1);
    expect(publishedStates[0]?.transfer?.listenerClasses.loopback_http.active).toBe(true);
  });

  it('replays the latest pending state once after an admitted publication is suppressed', async () => {
    const initialState = createDaemonTransferRuntimeState({
      directPeer: {
        featureEnabled: true,
        serverEnabled: true,
        bindHost: '127.0.0.1',
        bindPort: 46001,
        advertisedHosts: ['127.0.0.1'],
      },
    });
    let quiescing = false;
    const publishedStates: DaemonState[] = [];
    const updateDaemonState = vi.fn(async (updater: (state: DaemonState | null) => DaemonState) => {
      const next = updater({
        status: 'running',
        pid: 123,
        httpPort: 46000,
        startedAt: 1,
        transfer: initialState,
      });
      if (updateDaemonState.mock.calls.length === 1) {
        quiescing = true;
        return 'suppressed' as const;
      }
      publishedStates.push(next);
      return 'published' as const;
    });
    const publisher = createDaemonTransferRuntimeStatePublisher({
      initialTransferState: initialState,
      isDaemonQuiescing: () => quiescing,
    });

    await publisher.attachApiMachine({ updateDaemonState });
    await publisher.publishDirectTransferServerLifecycleState({
      status: 'running',
      listenerClasses: ['loopback_http'],
      port: 46001,
      publishedTransferCount: 1,
    });

    expect(updateDaemonState).toHaveBeenCalledTimes(1);
    expect(publishedStates).toHaveLength(0);

    quiescing = false;
    await publisher.resume();
    await publisher.resume();

    expect(updateDaemonState).toHaveBeenCalledTimes(2);
    expect(publishedStates).toHaveLength(1);
    expect(publishedStates[0]?.transfer?.listenerClasses.loopback_http.active).toBe(true);
  });

  it('replays a suppressed publication when resume joins the still-settling flush', async () => {
    const initialState = createDaemonTransferRuntimeState({
      directPeer: {
        featureEnabled: true,
        serverEnabled: true,
        bindHost: '127.0.0.1',
        bindPort: 46001,
        advertisedHosts: ['127.0.0.1'],
      },
    });
    let quiescing = false;
    let resolveFirstPublication!: (outcome: 'suppressed') => void;
    const firstPublication = new Promise<'suppressed'>((resolve) => {
      resolveFirstPublication = resolve;
    });
    const updateDaemonState = vi.fn(async () => {
      if (updateDaemonState.mock.calls.length === 1) {
        return await firstPublication;
      }
      return 'published' as const;
    });
    const publisher = createDaemonTransferRuntimeStatePublisher({
      initialTransferState: initialState,
      isDaemonQuiescing: () => quiescing,
    });
    await publisher.attachApiMachine({ updateDaemonState });

    const publish = publisher.publishDirectTransferServerLifecycleState({
      status: 'running',
      listenerClasses: ['loopback_http'],
      port: 46001,
      publishedTransferCount: 1,
    });
    await vi.waitFor(() => expect(updateDaemonState).toHaveBeenCalledTimes(1));

    quiescing = true;
    quiescing = false;
    const resume = publisher.resume();
    resolveFirstPublication('suppressed');
    await Promise.all([publish, resume]);

    expect(updateDaemonState).toHaveBeenCalledTimes(2);
  });

  it('does not spin forever when publishing daemon state keeps failing', async () => {
    const initialState = createDaemonTransferRuntimeState({
      directPeer: {
        featureEnabled: true,
        serverEnabled: true,
        bindHost: '127.0.0.1',
        bindPort: 46001,
        advertisedHosts: ['127.0.0.1'],
      },
    });
    const updateDaemonState = vi.fn(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      throw new Error('persist failed');
    });
    const publisher = createDaemonTransferRuntimeStatePublisher({
      initialTransferState: initialState,
    });

    await publisher.attachApiMachine({
      updateDaemonState,
    });

    const outcome = await Promise.race([
      publisher.publishDirectTransferServerLifecycleState({
        status: 'running',
        listenerClasses: ['loopback_http'],
        port: 46001,
        publishedTransferCount: 1,
      }).then(() => 'resolved' as const),
      new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), 50);
      }),
    ]);

    expect(outcome).toBe('resolved');
    expect(updateDaemonState).toHaveBeenCalledTimes(1);
  });
});
