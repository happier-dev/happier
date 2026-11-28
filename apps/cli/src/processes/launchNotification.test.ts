import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The daemon's private loopback control transport is the network boundary here.
const daemonPost = vi.hoisted(() => vi.fn(async () => ({ accepted: true as const })));
vi.mock('@/daemon/controlHttp', () => ({ daemonPost }));

import { observeProcessLaunch, subscribeProcessLaunchDiscovery } from './launchNotification';

function spawnedChild(pid: number) {
  return Object.assign(new EventEmitter(), { pid });
}

describe('process launch notification', () => {
  afterEach(() => { daemonPost.mockClear(); });

  it('invalidates the daemon-hosted discovery view in process, without a loopback request to itself', async () => {
    let invalidations = 0;
    const unsubscribe = subscribeProcessLaunchDiscovery(() => { invalidations += 1; });
    try {
      observeProcessLaunch(spawnedChild(4101));
      observeProcessLaunch(spawnedChild(4102));
      await vi.waitFor(() => expect(invalidations).toBe(2));
      expect(daemonPost).toHaveBeenCalledTimes(0);
    } finally {
      unsubscribe();
    }
  });

  it('reaches the daemon over its control transport from a process that hosts no discovery view', async () => {
    observeProcessLaunch(spawnedChild(4201));
    await vi.waitFor(() => expect(daemonPost).toHaveBeenCalledTimes(1));
    expect(daemonPost).toHaveBeenCalledWith('/processes/launch-notify', {});
  });
});
