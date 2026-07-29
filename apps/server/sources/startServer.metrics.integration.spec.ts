import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createStartServerDbMocks,
    installStartServerCommonWiringMocks,
    installStartServerDbModuleMock,
} from '@/testkit/startServerMocks';
import { createStartServerHarness } from '@/testkit/startServerHarness';

vi.mock('@happier-dev/cli-common/firstPartyRuntime', () => ({
    DEFAULT_SERVER_LIGHT_SQLITE_CONNECTION_LIMIT: 1,
    renderPrismaCompatibleSqliteDatabaseUrl: vi.fn((path: string) => `file:${path}?connection_limit=1`),
    resolveServerLightSqliteDatabaseUrlOptionsFromEnv: vi.fn(() => ({
        connectionLimit: 1,
        busyTimeoutMs: 5_000,
    })),
}));
vi.mock('@/storage/redis/redis', () => ({
    getRedisClient: () => ({ ping: vi.fn(async () => 'PONG') }),
}));
vi.mock('@/app/events/createRedisStreamsRoomEmitter', () => ({
    createRedisStreamsRoomEmitter: vi.fn(() => ({})),
}));
vi.mock('@/app/events/eventRouter', () => ({
    eventRouter: { setIo: vi.fn() },
}));
vi.mock('@/app/serverIdentity/serverIdentity', () => ({
    initializeServerIdentityCache: vi.fn(async () => 'srv_metricsTest'),
}));
vi.mock('@/flavors/light/sqliteMigrations', () => ({
    applySqliteMigrationsIfNeeded: vi.fn(async () => {}),
    resolveSqliteDatabaseFilePath: vi.fn(() => null),
}));

const startServerDbMocks = createStartServerDbMocks();
installStartServerDbModuleMock(startServerDbMocks);
installStartServerCommonWiringMocks();

vi.mock('@/utils/process/shutdown', () => ({
    onShutdown: vi.fn(),
    awaitShutdown: vi.fn(async () => {}),
}));

describe('startServer database metrics wiring', () => {
    const harness = createStartServerHarness({
        SERVER_ROLE: 'all',
        METRICS_ENABLED: 'false',
        DATABASE_URL: 'file:/tmp/happier-metrics-test.sqlite?connection_limit=1',
    });

    beforeEach(() => {
        startServerDbMocks.reset();
        harness.reset();
    });

    afterEach(() => {
        harness.restore();
    });

    it('does not run exact table-count metrics when the metrics server is disabled', async () => {
        harness.prepareImport();
        const metricsModule = await import('@/app/monitoring/metrics');
        const metricsIndexModule = await import('@/app/monitoring/metrics/index');
        vi.mocked(metricsModule.startMetricsServer).mockResolvedValue(false);
        const { startServer } = await import('./startServer');

        await startServer('light');

        expect(metricsIndexModule.startDatabaseMetricsUpdater).not.toHaveBeenCalled();
    });

    it('does not run exact table-count metrics on the single-connection SQLite runtime', async () => {
        harness.prepareImport({ METRICS_ENABLED: 'true' });
        const metricsModule = await import('@/app/monitoring/metrics');
        const metricsIndexModule = await import('@/app/monitoring/metrics/index');
        vi.mocked(metricsModule.startMetricsServer).mockResolvedValue(true);
        const { startServer } = await import('./startServer');

        await startServer('light');

        expect(metricsIndexModule.startDatabaseMetricsUpdater).not.toHaveBeenCalled();
    });

    it('retains database record metrics for an enabled non-SQLite runtime', async () => {
        harness.prepareImport({ METRICS_ENABLED: 'true' });
        const metricsModule = await import('@/app/monitoring/metrics');
        const metricsIndexModule = await import('@/app/monitoring/metrics/index');
        vi.mocked(metricsModule.startMetricsServer).mockResolvedValue(true);
        const { startServer } = await import('./startServer');

        await startServer('full');

        expect(metricsIndexModule.startDatabaseMetricsUpdater).toHaveBeenCalledOnce();
    });
});
