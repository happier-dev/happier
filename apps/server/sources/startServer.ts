import { startApi } from '@/app/api/api';
import { startMetricsServer } from '@/app/monitoring/metrics';
import { startDatabaseMetricsUpdater, setSocketAdapterModeInfo } from '@/app/monitoring/metrics/index';
import { auth } from '@/app/auth/auth';
import { activityCache } from '@/app/presence/sessionCache';
import { startTimeout } from '@/app/presence/timeout';
import { initEncrypt } from '@/modules/encrypt';
import { initGithub } from '@/app/auth/providers/github/webhooks';
import { loadFiles, initFilesLocalFromEnv, initFilesS3FromEnv } from '@/storage/blob/files';
import { db, getDbProviderFromEnv, initDbMysql, initDbPostgres, initDbPglite, initDbSqlite, shutdownDbPglite } from '@/storage/db';
import { log } from '@/utils/logging/log';
import { awaitShutdown, onShutdown } from '@/utils/process/shutdown';
import {
    applyLightDefaultEnv,
    applyPackagedLightRuntimeSqliteDefaults,
    ensureHandyMasterSecret,
    resolveLightSqliteDatabaseUrl,
} from '@/flavors/light/env';
import { applySqliteMigrationsIfNeeded } from '@/flavors/light/sqliteMigrations';
import {
    getFilesBackendFromEnv,
    resolveDefaultFilesBackend,
    resolveDefaultSocketAdapter,
} from '@/config/backends';
import { readSocketAdapterRuntimeConfigFromEnv } from '@/config/socketAdapter';
import { createRedisStreamsRoomEmitter } from '@/app/events/createRedisStreamsRoomEmitter';
import { eventRouter } from '@/app/events/eventRouter';
import { getRedisClient } from '@/storage/redis/redis';
import { shouldConsumePresenceFromRedis, shouldEnableLocalPresenceDbFlush } from '@/app/presence/presenceMode';
import { startPresenceRedisWorker } from '@/app/presence/presenceRedisQueue';
import { initializeServerSentry } from '@/app/monitoring/sentry';
import { resolveCachedCanonicalPublicServerUrl } from '@/app/integrations/publicUrl/publicServerUrlInference';
import { startRetentionWorker } from '@/app/retention/runtime/startRetentionWorker';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { readPresenceRedisWorkerConfigFromEnv } from '@/config/presence';
import { initializeServerIdentityCache } from '@/app/serverIdentity/serverIdentity';

export type ServerFlavor = 'full' | 'light';
export type ServerRole = 'all' | 'api' | 'worker';

function resolveServerLightDataDir(env: NodeJS.ProcessEnv): string {
    return expandHomeDirPath(
        (env.HAPPIER_SERVER_LIGHT_DATA_DIR ?? env.HAPPY_SERVER_LIGHT_DATA_DIR ?? '').trim(),
        env,
    );
}

export function getServerRoleFromEnv(env: NodeJS.ProcessEnv): ServerRole {
    const raw = env.SERVER_ROLE?.trim();
    if (!raw) return 'all';
    if (raw === 'api' || raw === 'worker') return raw;
    return 'all';
}

function shouldEnableRedisAdapterFromEnv(env: NodeJS.ProcessEnv, flavor: ServerFlavor): boolean {
    return readSocketAdapterRuntimeConfigFromEnv(env, resolveDefaultSocketAdapter(flavor)).redisStreamsEnabled;
}

export async function startServer(flavor: ServerFlavor): Promise<void> {
    process.env.HAPPY_SERVER_FLAVOR = flavor;
    process.env.HAPPIER_SERVER_FLAVOR = flavor;
    initializeServerSentry(process.env);
    const role = getServerRoleFromEnv(process.env);
    const shouldEnableRedisAdapter = shouldEnableRedisAdapterFromEnv(process.env, flavor);
    const dbProvider = getDbProviderFromEnv(process.env, flavor === 'light' ? 'sqlite' : 'postgres');
    process.env.HAPPY_DB_PROVIDER = dbProvider;
    process.env.HAPPIER_DB_PROVIDER = dbProvider;

    const filesBackend = getFilesBackendFromEnv(process.env, resolveDefaultFilesBackend(flavor));
    process.env.HAPPY_FILES_BACKEND = filesBackend;
    process.env.HAPPIER_FILES_BACKEND = filesBackend;

    const socketAdapterConfig = readSocketAdapterRuntimeConfigFromEnv(process.env, resolveDefaultSocketAdapter(flavor));
    const socketAdapter = socketAdapterConfig.adapter;
    process.env.HAPPY_SOCKET_ADAPTER = socketAdapter;
    process.env.HAPPIER_SOCKET_ADAPTER = socketAdapter;

    const shouldApplyLocalDefaults = filesBackend === 'local' || dbProvider === 'pglite' || dbProvider === 'sqlite';
    if (shouldApplyLocalDefaults) {
        applyLightDefaultEnv(process.env);
        applyPackagedLightRuntimeSqliteDefaults(process.env);
        await ensureHandyMasterSecret(process.env);
    }

    if (dbProvider === 'postgres') {
        // initDbPostgres is synchronous (unlike other provider initializers).
        initDbPostgres();
    } else if (dbProvider === 'mysql') {
        await initDbMysql();
    } else if (dbProvider === 'pglite') {
        await initDbPglite();
    } else if (dbProvider === 'sqlite') {
        const dataDir = resolveServerLightDataDir(process.env);
        if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.trim()) {
            if (!dataDir) {
                throw new Error('HAPPIER_SERVER_LIGHT_DATA_DIR (or HAPPY_SERVER_LIGHT_DATA_DIR) must be set when using sqlite without DATABASE_URL');
            }
            process.env.DATABASE_URL = resolveLightSqliteDatabaseUrl(dataDir);
        }
        if (dataDir) {
            await applySqliteMigrationsIfNeeded({ env: process.env, dataDir });
        }
        await initDbSqlite();
    } else {
        throw new Error(`Unsupported HAPPY_DB_PROVIDER/HAPPIER_DB_PROVIDER: ${dbProvider}`);
    }

    if (filesBackend === 'local') {
        initFilesLocalFromEnv(process.env);
    } else if (filesBackend === 's3') {
        await initFilesS3FromEnv(process.env);
    } else {
        throw new Error(`Unsupported HAPPY_FILES_BACKEND/HAPPIER_FILES_BACKEND: ${String(filesBackend)}`);
    }

    // Storage
    await db.$connect();
    if (dbProvider === 'pglite') {
        // When using embedded pglite, ensure Prisma disconnect happens before stopping the socket server.
        onShutdown('db', async () => {
            await db.$disconnect();
            await shutdownDbPglite();
        });
    } else {
        onShutdown('db', async () => {
            await db.$disconnect();
        });
    }
    onShutdown('keepAlive:activity-cache', async () => {
        await activityCache.shutdown();
    });
    if (shouldEnableLocalPresenceDbFlush(process.env)) {
        activityCache.enableDbFlush();
    }
    await initializeServerIdentityCache(process.env);

    // Redis should not be a hard dependency unless explicitly enabled for scale features.
    if (shouldEnableRedisAdapter) {
        await getRedisClient().ping();
    }
    if (shouldEnableRedisAdapter && role === 'api') {
        log(
            { module: 'presence' },
            'Redis adapter is enabled: durable presence writes are consumed by a worker process. Ensure at least one replica runs with SERVER_ROLE=worker.',
        );
    }

    setSocketAdapterModeInfo({
        adapter: socketAdapter,
        redisEnabled: shouldEnableRedisAdapter,
        role,
    });

    // Initialize auth module
    await initEncrypt();
    await initGithub();
    await loadFiles();
    await auth.init();

    //
    // Start
    //

    if (role === 'worker') {
        if (!shouldEnableRedisAdapter) {
            throw new Error(
                "SERVER_ROLE=worker requires Redis socket adapter enabled (set REDIS_URL and HAPPIER_SOCKET_ADAPTER=redis-streams) so worker pushes can fan out to connected API sockets",
            );
        }
        // Background workers should publish into rooms without joining the Socket.IO cluster as a fetchSockets peer.
        eventRouter.setIo(createRedisStreamsRoomEmitter({
            maxLen: socketAdapterConfig.redisStreamsOptions.maxLen ?? 200_000,
        }));

        if (shouldConsumePresenceFromRedis(process.env)) {
            const presenceWorker = startPresenceRedisWorker(readPresenceRedisWorkerConfigFromEnv(process.env));
            onShutdown('presence-redis-worker', async () => {
                await presenceWorker.stop();
            });
        }
    }

    // Expose health + metrics in all roles (metrics server can be disabled via METRICS_ENABLED=false).
    await startMetricsServer();

    if (role === 'all' || role === 'api') {
        // Best-effort: infer a canonical public URL so capabilities.server can advertise it.
        // This is cached and single-flight so startup does not spawn redundant inference processes.
        void resolveCachedCanonicalPublicServerUrl(process.env).catch(() => null);
        await startApi();
    }

    if (role === 'all' || role === 'worker') {
        const retentionWorker = startRetentionWorker();
        if (retentionWorker) {
            onShutdown('retention-worker', async () => {
                retentionWorker.stop();
            });
        }
        startDatabaseMetricsUpdater();
        startTimeout();
    }

    //
    // Ready
    //

    log('Ready');
    await awaitShutdown();
    log('Shutting down...');
}
