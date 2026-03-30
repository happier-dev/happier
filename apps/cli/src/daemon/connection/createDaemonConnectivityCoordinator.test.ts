import { describe, expect, it, vi } from 'vitest';

import type { ManagedConnectionState } from '@happier-dev/connection-supervisor';

import { createDaemonConnectivityCoordinator } from './createDaemonConnectivityCoordinator';

function buildState(
  phase: ManagedConnectionState['phase'],
  reason: ManagedConnectionState['reason'] = null,
): ManagedConnectionState {
  return {
    phase,
    reason,
    attempt: 0,
    nextRetryAt: null,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    lastErrorMessage: null,
  };
}

describe('createDaemonConnectivityCoordinator', () => {
  it('pauses managed resources until the machine socket is online', async () => {
    const pause = vi.fn(async () => {});
    const resume = vi.fn(async () => {});

    const coordinator = createDaemonConnectivityCoordinator({
      resources: [{ name: 'automation', pause, resume }],
    });

    await coordinator.applyState(buildState('idle'));
    expect(pause).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();

    await coordinator.applyState(buildState('online', 'initial_connect'));
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('does not spam duplicate pause and resume transitions', async () => {
    const pause = vi.fn(async () => {});
    const resume = vi.fn(async () => {});

    const coordinator = createDaemonConnectivityCoordinator({
      resources: [{ name: 'automation', pause, resume }],
    });

    await coordinator.applyState(buildState('offline', 'server_unreachable'));
    await coordinator.applyState(buildState('offline', 'server_unreachable'));
    await coordinator.applyState(buildState('online', 'initial_connect'));
    await coordinator.applyState(buildState('online', 'initial_connect'));

    expect(pause).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('syncs resources that are registered after connectivity state is already known', async () => {
    const initialPause = vi.fn(async () => {});
    const initialResume = vi.fn(async () => {});
    const latePause = vi.fn(async () => {});
    const lateResume = vi.fn(async () => {});

    const coordinator = createDaemonConnectivityCoordinator({
      resources: [{ name: 'initial', pause: initialPause, resume: initialResume }],
    });

    await coordinator.applyState(buildState('offline', 'server_unreachable'));
    await coordinator.registerResource({ name: 'late', pause: latePause, resume: lateResume });

    expect(initialPause).toHaveBeenCalledTimes(1);
    expect(latePause).toHaveBeenCalledTimes(1);
    expect(initialResume).not.toHaveBeenCalled();
    expect(lateResume).not.toHaveBeenCalled();

    await coordinator.applyState(buildState('online', 'initial_connect'));

    expect(initialResume).toHaveBeenCalledTimes(1);
    expect(lateResume).toHaveBeenCalledTimes(1);
  });
});
