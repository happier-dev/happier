import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createStartServerDbMocks,
    installStartServerDbModuleMock,
    installStartServerCommonWiringMocks,
    startEnterpriseIdentitySyncWorkerMock,
} from '@/testkit/startServerMocks';
import { createStartServerHarness } from '@/testkit/startServerHarness';

const retentionStop = vi.fn();
const enterpriseIdentitySyncStop = vi.fn(async () => {});

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

describe('startServer retention worker wiring', () => {
    const startServerHarness = createStartServerHarness({
        SERVER_ROLE: 'all',
    });

    beforeEach(() => {
        startServerDbMocks.reset();
        startServerHarness.reset();
        startEnterpriseIdentitySyncWorkerMock.mockReset().mockReturnValue(null);
    });

    afterEach(() => {
        startServerHarness.restore();
    });

    it('starts the unified retention worker when SERVER_ROLE=all', async () => {
        startServerHarness.prepareImport();
        const retentionWorkerModule = await import('@/app/retention/runtime/startRetentionWorker');
        const startRetentionWorker = vi.mocked(retentionWorkerModule.startRetentionWorker);
        startRetentionWorker.mockReturnValue({ stop: retentionStop });
        const { startServer } = await import('./startServer');

        await startServer('full');

        expect(startRetentionWorker).toHaveBeenCalledTimes(1);
        expect(onShutdown).toHaveBeenCalledWith(
            'retention-worker',
            expect.any(Function),
        );
    });

    it('starts and awaits enterprise identity sync under the worker lifecycle', async () => {
        startEnterpriseIdentitySyncWorkerMock.mockReturnValue({
            stop: enterpriseIdentitySyncStop,
            nudge: vi.fn(),
        });
        startServerHarness.prepareImport();
        const { startServer } = await import('./startServer');

        await startServer('full');

        expect(startEnterpriseIdentitySyncWorkerMock).toHaveBeenCalledWith({ env: process.env });
        const registration = onShutdown.mock.calls.find(([name]) => name === 'enterprise-identity-sync-worker');
        expect(registration).toBeDefined();
        await registration?.[1]();
        expect(enterpriseIdentitySyncStop).toHaveBeenCalledTimes(1);
    });
});
