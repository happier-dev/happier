import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    applyEnvValues,
    installStartServerCommonWiringMocks,
    restoreEnvValues,
    snapshotStartServerEnv,
} from '@/testkit/startServerMocks';

const retentionStop = vi.fn();
const startRetentionWorker = vi.fn(() => ({ stop: retentionStop }));

vi.mock('@/app/retention/runtime/startRetentionWorker', () => ({
    startRetentionWorker,
}));

vi.mock('@/storage/redis/redis', () => ({
    getRedisClient: () => ({ ping: vi.fn(async () => 'PONG') }),
}));

vi.mock('@/storage/db', () => ({
    db: {
        $connect: vi.fn(async () => {}),
        $disconnect: vi.fn(async () => {}),
    },
    getDbProviderFromEnv: (
        _env: NodeJS.ProcessEnv,
        fallback: 'postgres' | 'pglite' | 'sqlite' | 'mysql',
    ) => fallback,
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

    it('starts the retention worker when SERVER_ROLE=all', async () => {
        const { startServer } = await import('./startServer');

        await startServer('full');

        expect(startRetentionWorker).toHaveBeenCalledTimes(1);
        const shutdownRegistration = onShutdown.mock.calls.find(([name]) => name === 'retention-worker');
        expect(shutdownRegistration).toBeDefined();
        await shutdownRegistration![1]();
        expect(retentionStop).toHaveBeenCalledTimes(1);
    });

    it('does not start the retention worker for api role', async () => {
        applyEnvValues({
            SERVER_ROLE: 'api',
        });

        const { startServer } = await import('./startServer');

        await startServer('full');

        expect(startRetentionWorker).not.toHaveBeenCalled();
    });
});
