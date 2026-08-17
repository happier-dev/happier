import { startApi } from '@/app/api/api';
import { startMetricsServer } from '@/app/monitoring/metrics';
import { startDatabaseMetricsUpdater, setSocketAdapterModeInfo } from '@/app/monitoring/metrics/index';
import { auth } from '@/app/auth/auth';
import { activityCache } from '@/app/presence/sessionCache';
import { startTimeout } from '@/app/presence/timeout';
import { initEncrypt } from '@/modules/encrypt';
import { loadFiles, initFilesLocalFromEnv, initFilesS3FromEnv } from '@/storage/blob/files';
import {
    applySqliteRuntimePragmas,
    createDbSqliteMaintenanceClient,
    db,
    getDbProviderFromEnv,
    initDbMysql,
    initDbPostgres,
    initDbPglite,
    initDbSqlite,
    shutdownDbPglite,
} from '@/storage/db';
import { initializeSessionSystemRecordsProtocolV1Activation } from '@/app/session/systemRecords/sessionSystemRecordProtocolContract';
import { initializeSessionTurnTranscriptAnchorProjectionProtocolActivation } from '@/app/session/turns/sessionTurnTranscriptAnchorProjectionProtocolContract';
import {
    resolveSqliteIncrementalVacuumIntervalMsFromEnv,
    resolveSqliteIncrementalVacuumPagesFromEnv,
    resolveSqliteWalCheckpointBusyTimeoutMsFromEnv,
    resolveSqliteWalCheckpointIntervalMsFromEnv,
    startSqliteIncrementalVacuumWorker,
    startSqliteWalCheckpointWorker,
} from '@/storage/sqliteWalCheckpoint';
import { log } from '@/utils/logging/log';
import { awaitShutdown, onShutdown } from '@/utils/process/shutdown';
import {
    applyLightDefaultEnv,
    applyPackagedLightRuntimeSqliteDefaults,
    ensureHandyMasterSecret,
    resolveLightSqliteDatabaseUrl,
} from '@/flavors/light/env';
import { applySqliteMigrationsIfNeeded, resolveSqliteDatabaseFilePath } from '@/flavors/light/sqliteMigrations';
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
import { startPluginWebhookCredentialRetirementWorker } from '@/app/plugins/webhooks/credentialRetirementWorker';
import { startVoiceProviderIdentityBackfillWorker } from '@/app/voice/providerIdentityBackfill/worker';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { readPresenceRedisWorkerConfigFromEnv } from '@/config/presence';
import { initializeServerIdentityCache } from '@/app/serverIdentity/serverIdentity';
import { stat } from 'node:fs/promises';
import { writeStartupReceiptFromEnvironment } from '@/app/runtime/startupReceipt';
import { readPluginsFeatureEnv } from '@/app/features/catalog/readFeatureEnv';

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

function resolveSqliteSizeWarnBytes(env: NodeJS.ProcessEnv): number | null {
    const raw = String(env.HAPPIER_SERVER_DB_SIZE_WARN_BYTES ?? '').trim();
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function warnIfSqliteFileExceedsThreshold(params: Readonly<{
    path: string;
    label: string;
    thresholdBytes: number;
}>): Promise<void> {
    const fileStat = await stat(params.path).catch((error: any) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
    });
    if (!fileStat || !fileStat.isFile() || fileStat.size <= params.thresholdBytes) return;

    log(
        {
            module: 'sqlite',
            level: 'warn',
            path: params.path,
            sizeBytes: fileStat.size,
            thresholdBytes: params.thresholdBytes,
        },
        `SQLite ${params.label} file is larger than the configured warning threshold`,
    );
}

async function warnIfSqliteDatabaseFilesExceedThreshold(env: NodeJS.ProcessEnv): Promise<void> {
    const thresholdBytes = resolveSqliteSizeWarnBytes(env);
    if (thresholdBytes === null) return;

    const dbPath = resolveSqliteDatabaseFilePath(String(env.DATABASE_URL ?? '').trim());
    if (!dbPath) return;

    await warnIfSqliteFileExceedsThreshold({
        path: dbPath,
        label: 'database',
        thresholdBytes,
    });
    await warnIfSqliteFileExceedsThreshold({
        path: `${dbPath}-wal`,
        label: 'WAL',
        thresholdBytes,
    });
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

    // Parse the one Collection deployment policy before opening external
    // resources. Feature projection, activation, and mutation all consume
    // this same reader; startup must not defer a malformed policy until a
    // later write path.
    readPluginsFeatureEnv(process.env);

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
        await warnIfSqliteDatabaseFilesExceedThreshold(process.env);
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

    const sqliteWalCheckpointIntervalMs = dbProvider === 'sqlite'
        ? resolveSqliteWalCheckpointIntervalMsFromEnv(process.env)
        : null;
    const sqliteIncrementalVacuumIntervalMs = dbProvider === 'sqlite'
        ? resolveSqliteIncrementalVacuumIntervalMsFromEnv(process.env)
        : null;
    const shouldStartSqliteWalCheckpointWorker =
        sqliteWalCheckpointIntervalMs !== null && sqliteWalCheckpointIntervalMs > 0;
    const shouldStartSqliteIncrementalVacuumWorker =
        sqliteIncrementalVacuumIntervalMs !== null && sqliteIncrementalVacuumIntervalMs > 0;
    const shouldStartSqliteMaintenanceClient =
        shouldStartSqliteWalCheckpointWorker || shouldStartSqliteIncrementalVacuumWorker;
    const sqliteWalCheckpointBusyTimeoutMs = shouldStartSqliteMaintenanceClient
        ? resolveSqliteWalCheckpointBusyTimeoutMsFromEnv(process.env)
        : null;
    const sqliteIncrementalVacuumPages = shouldStartSqliteIncrementalVacuumWorker
        ? resolveSqliteIncrementalVacuumPagesFromEnv(process.env)
        : null;

    let dbConnected = false;
    let sqliteWalCheckpointClient: typeof db | null = null;
    let sqliteWalCheckpointWorker: ReturnType<typeof startSqliteWalCheckpointWorker> = null;
    let sqliteIncrementalVacuumWorker: ReturnType<typeof startSqliteIncrementalVacuumWorker> = null;
    let sqliteLifecycleCleanedUp = false;
    const cleanupSqliteLifecycle = async (): Promise<void> => {
        if (sqliteLifecycleCleanedUp) return;
        sqliteLifecycleCleanedUp = true;

        let firstError: unknown = null;
        try {
            await sqliteWalCheckpointWorker?.stop();
        } catch (error) {
            firstError ??= error;
        } finally {
            sqliteWalCheckpointWorker = null;
        }

        try {
            await sqliteIncrementalVacuumWorker?.stop();
        } catch (error) {
            firstError ??= error;
        } finally {
            sqliteIncrementalVacuumWorker = null;
        }

        try {
            await sqliteWalCheckpointClient?.$disconnect();
        } catch (error) {
            firstError ??= error;
        } finally {
            sqliteWalCheckpointClient = null;
        }

        if (dbConnected) {
            try {
                await db.$disconnect();
            } catch (error) {
                firstError ??= error;
            } finally {
                dbConnected = false;
            }
        }

        if (firstError) {
            throw firstError;
        }
    };

    let unregisterDbShutdown = () => {};
    let startupCompleted = false;

    try {
        // Storage
        await db.$connect();
        dbConnected = true;
        await initializeSessionSystemRecordsProtocolV1Activation(db);
        await initializeSessionTurnTranscriptAnchorProjectionProtocolActivation(db);
        if (shouldStartSqliteMaintenanceClient) {
            sqliteWalCheckpointClient = await createDbSqliteMaintenanceClient();
            await sqliteWalCheckpointClient.$connect();
            await applySqliteRuntimePragmas(sqliteWalCheckpointClient, {
                ...process.env,
                HAPPIER_SQLITE_BUSY_TIMEOUT_MS: String(sqliteWalCheckpointBusyTimeoutMs),
                HAPPY_SQLITE_BUSY_TIMEOUT_MS: String(sqliteWalCheckpointBusyTimeoutMs),
            });
        }

        // Actively checkpoint the SQLite WAL so it cannot be starved by long-lived
        // readers and grow without bound, which slows queries until they hit the
        // Prisma timeout.
        if (sqliteWalCheckpointClient && sqliteWalCheckpointIntervalMs !== null) {
            sqliteWalCheckpointWorker = startSqliteWalCheckpointWorker({
                client: sqliteWalCheckpointClient,
                intervalMs: sqliteWalCheckpointIntervalMs,
            });
        }
        if (
            sqliteWalCheckpointClient
            && sqliteIncrementalVacuumIntervalMs !== null
            && sqliteIncrementalVacuumPages !== null
        ) {
            sqliteIncrementalVacuumWorker = startSqliteIncrementalVacuumWorker({
                client: sqliteWalCheckpointClient,
                intervalMs: sqliteIncrementalVacuumIntervalMs,
                pages: sqliteIncrementalVacuumPages,
            });
        }

        if (dbProvider === 'pglite') {
            // When using embedded pglite, ensure Prisma disconnect happens before stopping the socket server.
            unregisterDbShutdown = onShutdown('db', async () => {
                await db.$disconnect();
                dbConnected = false;
                await shutdownDbPglite();
            });
        } else if (dbProvider === 'sqlite') {
            unregisterDbShutdown = onShutdown('db', async () => {
                await cleanupSqliteLifecycle();
            });
        } else {
            unregisterDbShutdown = onShutdown('db', async () => {
                await db.$disconnect();
                dbConnected = false;
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
        const metricsServerStarted = await startMetricsServer();

        if (role === 'all' || role === 'api') {
            // Best-effort: infer a canonical public URL so capabilities.server can advertise it.
            // This is cached and single-flight so startup does not spawn redundant inference processes.
            void resolveCachedCanonicalPublicServerUrl(process.env).catch(() => null);
            await startApi();
        }

        if (role === 'all' || role === 'worker') {
            const voiceProviderIdentityBackfillWorker = startVoiceProviderIdentityBackfillWorker({
                provider: dbProvider,
                env: process.env,
            });
            if (voiceProviderIdentityBackfillWorker) {
                onShutdown('voice-provider-identity-backfill-worker', async () => {
                    await voiceProviderIdentityBackfillWorker.stop();
                });
            }
            const retentionWorker = startRetentionWorker();
            if (retentionWorker) {
                onShutdown('retention-worker', async () => {
                    retentionWorker.stop();
                });
            }
            const webhookCredentialRetirementWorker = startPluginWebhookCredentialRetirementWorker();
            if (webhookCredentialRetirementWorker) {
                onShutdown('plugin-webhook-credential-retirement-worker', async () => {
                    webhookCredentialRetirementWorker.stop();
                });
            }
            // Exact record counts can monopolize the intentionally single-connection
            // SQLite runtime. They are operational metrics, so only collect them when
            // the metrics endpoint is enabled and the database can serve concurrent work.
            if (metricsServerStarted && dbProvider !== 'sqlite') {
                startDatabaseMetricsUpdater();
            }
            startTimeout();
        }

        //
        // Ready
        //

        await writeStartupReceiptFromEnvironment(process.env);
        log('Ready');
        startupCompleted = true;
        await awaitShutdown();
        log('Shutting down...');
    } catch (error) {
        if (dbProvider === 'sqlite' && !startupCompleted) {
            unregisterDbShutdown();
            try {
                await cleanupSqliteLifecycle();
            } catch {
                // Preserve the startup failure as the primary error.
            }
        }
        throw error;
    }
}
