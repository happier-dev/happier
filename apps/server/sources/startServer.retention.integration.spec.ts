import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    applyEnvValues,
    installStartServerCommonWiringMocks,
    restoreEnvValues,
    snapshotStartServerEnv,
} from '@/testkit/startServerMocks';

const retentionStop = vi.fn();

vi.mock('@/storage/redis/redis', () => ({
    getRedisClient: () => ({ ping: vi.fn(async () => 'PONG') }),
}));

vi.mock('@/storage/db', () => ({
    db: {
        $connect: vi.fn(async () => {}),
        $disconnect: vi.fn(async () => {}),
    },
    getDbProviderFromEnv: (_env: any, fallback: any) => fallback,
    initDbPostgres: vi.fn(() => {}),
    initDbPglite: vi.fn(async () => {}),
    initDbMysql: vi.fn(async () => {}),
    initDbSqlite: vi.fn(async () => {}),
    shutdownDbPglite: vi.fn(async () => {}),
}));

installStartServerCommonWiringMocks();

const onShutdown = vi.fn();
vi.mock('@/utils/process/shutdown', () => ({
    onShutdown,
    awaitShutdown: vi.fn(async () => {}),
}));

describe('startServer retention worker wiring', () => {
    const envBackup = snapshotStartServerEnv();

    beforeEach(() => {
        vi.clearAllMocks();
        restoreEnvValues(envBackup);
        applyEnvValues({
            SERVER_ROLE: 'all',
        });
    });

    afterEach(() => {
        restoreEnvValues(envBackup);
    });

    it('starts the unified retention worker when SERVER_ROLE=all', async () => {
        vi.resetModules();
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
});
