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
        lan_http: {
          enabled: false,
          configured: false,
          active: false,
        },
        tailscale_serve_https: {
          enabled: false,
          configured: false,
          active: false,
          available: false,
        },
      },
      lifecycle: {
        mode: 'lazy_idle_shutdown',
        version: 1,
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
});
