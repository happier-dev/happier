import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createStartServerDbMocks,
  installStartServerDbModuleMock,
  installStartServerCommonWiringMocks,
  startEnterpriseIdentitySyncWorkerMock,
} from '@/testkit/startServerMocks';
import { createStartServerHarness } from '@/testkit/startServerHarness';

vi.mock('@/storage/redis/redis', () => ({
  getRedisClient: () => ({ ping: vi.fn(async () => 'PONG') }),
}));

const startServerDbMocks = createStartServerDbMocks();
installStartServerDbModuleMock(startServerDbMocks);

installStartServerCommonWiringMocks();

const onShutdown = vi.fn();
vi.mock('@/utils/process/shutdown', () => ({
  shutdownSignal: new AbortController().signal,
  onShutdown,
  awaitShutdown: vi.fn(async () => {}),
}));

describe('startServer instance heartbeat wiring', () => {
  const startServerHarness = createStartServerHarness();

  beforeEach(() => {
    startServerDbMocks.reset();
    startEnterpriseIdentitySyncWorkerMock.mockReset().mockReturnValue(null);
  });

  afterEach(() => {
    startServerHarness.restore();
  });

  async function startWithRole(role: 'all' | 'api') {
    startServerHarness.prepareImport({ SERVER_ROLE: role });
    const heartbeatModule = await import('@/app/monitoring/instanceHeartbeat');
    const startInstanceHeartbeat = vi.mocked(
      heartbeatModule.startInstanceHeartbeat,
    );
    startInstanceHeartbeat.mockReturnValue({ stop: vi.fn() });
    const { startServer } = await import('./startServer');
    await startServer('full');
    return startInstanceHeartbeat;
  }

  it('starts the heartbeat with the resolved flavor and db provider in the background-jobs process', async () => {
    const startInstanceHeartbeat = await startWithRole('all');

    expect(startInstanceHeartbeat).toHaveBeenCalledTimes(1);
    expect(startInstanceHeartbeat).toHaveBeenCalledWith({
      flavor: 'full',
      dbProvider: 'postgres',
    });
    expect(onShutdown).toHaveBeenCalledWith(
      'instance-heartbeat',
      expect.any(Function),
    );
  });

  it('does not start the heartbeat in an api-only process', async () => {
    const startInstanceHeartbeat = await startWithRole('api');

    expect(startInstanceHeartbeat).not.toHaveBeenCalled();
  });
});
