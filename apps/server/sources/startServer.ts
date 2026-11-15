import { SERVER_CONFIG } from '@happier-dev/protocol/serverConfig/registry';
import { readServerConfig } from '@happier-dev/protocol/serverConfig/serverConfigCodec';
import { startApi } from '@/app/api/api';
import { startMetricsServer } from '@/app/monitoring/metrics';
import { enableDatabaseRecordCountsOnScrape, setSocketAdapterModeInfo } from '@/app/monitoring/metrics/index';
import { auth } from '@/app/auth/auth';
import { activityCache } from '@/app/presence/sessionCache';
import { preparePresenceTimeouts } from '@/app/presence/timeout';
import { initEncrypt } from '@/modules/encrypt';
import { loadFiles, initFilesLocalFromEnv, initFilesS3FromEnv } from '@/storage/blob/files';
import {
    applySqliteRuntimePragmas,
    createDbSqliteMaintenanceClient,
    db,
    disconnectDbReadinessProbe,
    getDbProviderFromEnv,
    initDbMysql,
    initDbPostgres,
    initDbPglite,
    initDbSqlite,
    shutdownDbClient,
    shutdownDbPglite,
} from '@/storage/db';
import {
    runHomeOwnerClaimCommand,
    runPrintHomeClaimCodeCommand,
    type HomeOwnerClaimRequestV1,
} from '@/app/home/governance/claimHomeOwnerCommand';
import { initializeSessionSystemRecordsProtocolV1Activation } from '@/app/session/systemRecords/sessionSystemRecordProtocolContract';
import {
    isSqliteIncrementalVacuumEnabledFromEnv,
    reclaimSqliteFreePages,
    resolveSqliteIncrementalVacuumPagesFromEnv,
    resolveSqliteWalCheckpointBusyTimeoutMsFromEnv,
    resolveSqliteWalCheckpointIntervalMsFromEnv,
    startSqliteWalCheckpointWorker,
} from '@/storage/sqliteWalCheckpoint';
import { initializeServerLogging, log } from '@/utils/logging/log';
import { awaitShutdown, onShutdown } from '@/utils/process/shutdown';
import { isPersonalHomeRuntimePurpose } from '@/app/runtime/personalHomeRuntimePurpose';
import {
    applyLightDefaultEnv,
    applyPackagedLightRuntimeSqliteDefaults,
    ensureHandyMasterSecret,
    resolveLightSqliteDatabaseUrl,
} from '@/flavors/light/env';
import { applySqliteMigrationsIfNeeded, resolveSqliteDatabaseFilePath } from '@/flavors/light/sqliteMigrations';
import {
    getFilesBackendFromEnv,
    getServerRoleFromEnv,
    resolveDefaultFilesBackend,
    resolveDefaultSocketAdapter,
    shouldApplyLightDefaultEnv,
} from '@/config/backends';
import { readSocketAdapterRuntimeConfigFromEnv } from '@/config/socketAdapter';
import { resolveDefaultDbProvider } from '@/config/databaseProvider';
import { createRedisStreamsRoomEmitter } from '@/app/events/createRedisStreamsRoomEmitter';
import { registerSessionHumanPresenceAccessChangePublisher } from '@/app/session/humanPresence/sessionHumanPresenceService';
import { eventRouter } from '@/app/events/eventRouter';
import { getRedisClient } from '@/storage/redis/redis';
import { shouldConsumePresenceFromRedis } from '@/app/presence/presenceMode';
import { startPresenceRedisWorker } from '@/app/presence/presenceRedisQueue';
import { initializeServerSentry } from '@/app/monitoring/sentry';
import { resolveInferredPublicServerAccess } from '@/app/integrations/publicUrl/publicServerUrlInference';
import { startRetentionWorker } from '@/app/retention/runtime/startRetentionWorker';
import { startVoiceProviderIdentityBackfillWorker } from '@/app/voice/providerIdentityBackfill/worker';
import { startSessionMessageContentByteUpgrade } from '@/app/session/messages/sessionMessageContentByteUpgrade';
import { startEnterpriseIdentitySyncWorker } from '@/app/teams/directory/runtime/worker';
import {
    assertPersonalHomeBootAdmission,
    resolvePersonalHomeRuntimeLayout,
} from '@happier-dev/cli-common/firstPartyRuntime/server';
import { expandHomeDirPath } from '@happier-dev/cli-common/path';
import { readPresenceRedisWorkerConfigFromEnv } from '@/config/presence';
import { initializeServerIdentityCache } from '@/app/serverIdentity/serverIdentity';
import { stat } from 'node:fs/promises';
import { resolveBoundServerListener, writeStartupReceiptFromEnvironment } from '@/app/runtime/startupReceipt';
import { readPluginsFeatureEnv } from '@/app/features/catalog/readFeatureEnv';
import { readHomeConfigEnv, readStoredHomeSettingsForStartup } from '@/app/home/settings/homeSettings';
import { refreshAuthDiagnosticsLogsFlag } from '@/app/home/settings/authDiagnosticsFlag';
import { applyStartupHomeEnvToProcess, loadStartupHomeEnv } from '@/app/home/settings/startupHomeEnv';
import { prepareHomeIrohStartup } from '@/app/iroh/startup';
import { createPersonalHomeAuthenticatedReadiness } from '@/app/runtime/personalHomeReadiness';
import { createHomeConnectionDescriptorContinuityStoreForServer } from '@/app/features/homeConnectionDescriptorContinuity';

export type ServerFlavor = 'full' | 'light';
export { getServerRoleFromEnv } from '@/config/backends';
export type { ServerRole } from '@/config/backends';

function resolveServerLightDataDir(env: NodeJS.ProcessEnv): string {
    return expandHomeDirPath(
        (env.HAPPIER_SERVER_LIGHT_DATA_DIR ?? env.HAPPY_SERVER_LIGHT_DATA_DIR ?? '').trim(),
        env,
    );
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

/**
 * The one-shot operator work `startServer` may perform instead of serving.
 *
 * This is deliberately one named command rather than a command registry: the
 * Home owner claim needs the resolved database and nothing more, and a general
 * dispatcher would invite unrelated operator surface into the boot path.
 */
export type StartServerOptions = Readonly<{
    claimHomeOwner?: HomeOwnerClaimRequestV1;
    /** `--print-home-claim-code`: mint the one-time code the app redeems for the same claim. */
    printHomeClaimCode?: true;
}>;

export async function startServer(flavor: ServerFlavor, options?: StartServerOptions): Promise<void> {
    // The environment the deployment gave this process, before startup composition writes resolved
    // defaults or applied Home settings into `process.env`: explicit values here are the lock (D-1).
    const deploymentEnv: Readonly<NodeJS.ProcessEnv> = Object.freeze({ ...process.env });
    process.env.HAPPY_SERVER_FLAVOR = flavor;
    process.env.HAPPIER_SERVER_FLAVOR = flavor;
    const role = getServerRoleFromEnv(process.env);
    const dbProvider = getDbProviderFromEnv(process.env, resolveDefaultDbProvider(flavor));
    process.env.HAPPY_DB_PROVIDER = dbProvider;
    process.env.HAPPIER_DB_PROVIDER = dbProvider;


    if (flavor === 'light' && isPersonalHomeRuntimePurpose(process.env.HAPPIER_MANAGED_RELAY_PURPOSE)) {
        // Admission is independent of database/files backends. A retained operation marker must
        // block PostgreSQL/S3 configurations before any backend, listener, or Iroh owner opens.
        await assertPersonalHomeBootAdmission(
            resolvePersonalHomeRuntimeLayout({ env: process.env }),
            { kind: 'ordinary', startupNonce: process.env.HAPPIER_SERVER_STARTUP_RECEIPT_NONCE },
        );
    }

    // Light defaults locate the database and the local files directory before the database opens, so
    // this decision reads the deployment's files backend; the backend itself is resolved after the
    // Home settings startup overlay below.
    const shouldApplyLocalDefaults = shouldApplyLightDefaultEnv(process.env, flavor);
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

    // The deployment-local Home owner claim is a one-shot that needs exactly
    // this much of startup: the resolved database provider and nothing else.
    // Running it here reuses the one provider dispatch above instead of giving
    // the operator command a second, subtly different way to open the Home, and
    // returns before any listener, file backend, or worker opens.
    if (options?.claimHomeOwner) {
        const claim = await runHomeOwnerClaimCommand(options.claimHomeOwner);
        process.stdout.write(`${JSON.stringify(claim.output)}\n`);
        process.exitCode = claim.exitCode;
        await shutdownDbClient();
        return;
    }
    if (options?.printHomeClaimCode) {
        const printed = await runPrintHomeClaimCodeCommand();
        process.stdout.write(`${JSON.stringify(printed.output)}\n`);
        process.exitCode = printed.exitCode;
        await shutdownDbClient();
        return;
    }

    const sqliteWalCheckpointIntervalMs = dbProvider === 'sqlite'
        ? resolveSqliteWalCheckpointIntervalMsFromEnv(process.env)
        : null;
    // The SQLite maintenance connection serves write-armed WAL maintenance and the
    // retention sweep's free-page reclamation.
    const shouldStartSqliteMaintenanceClient = dbProvider === 'sqlite';
    const sqliteWalCheckpointBusyTimeoutMs = shouldStartSqliteMaintenanceClient
        ? resolveSqliteWalCheckpointBusyTimeoutMsFromEnv(process.env)
        : null;
    const sqliteIncrementalVacuumPages = shouldStartSqliteMaintenanceClient
        && isSqliteIncrementalVacuumEnabledFromEnv(process.env)
        ? resolveSqliteIncrementalVacuumPagesFromEnv(process.env)
        : null;

    let dbConnected = false;
    let sqliteWalCheckpointClient: typeof db | null = null;
    let sqliteWalCheckpointWorker: ReturnType<typeof startSqliteWalCheckpointWorker> = null;
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
            await sqliteWalCheckpointClient?.$disconnect();
        } catch (error) {
            firstError ??= error;
        } finally {
            sqliteWalCheckpointClient = null;
        }

        try {
            await disconnectDbReadinessProbe();
        } catch (error) {
            firstError ??= error;
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

        // Home settings startup overlay (plan 2026-09-26-home-owner-console §3.14): stored
        // `apply: 'restart'` values fill the keys the deployment left unset, once, before any reader
        // of those keys below. An invalid stored value is ignored with a logged reason.
        // Stored restart secrets are sealed with the at-rest key, so it is ready before they are read.
        await initEncrypt();
        applyStartupHomeEnvToProcess(await loadStartupHomeEnv({
            env: deploymentEnv,
            readStored: () => readStoredHomeSettingsForStartup(),
            log: (line) => log({ module: 'home-settings' }, line),
        }), process.env);
        initializeServerLogging(process.env);
        initializeServerSentry(process.env);
        // Authenticated requests read this flag in-process; the Home settings writer keeps it current.
        await refreshAuthDiagnosticsLogsFlag();

        const filesBackend = getFilesBackendFromEnv(process.env, resolveDefaultFilesBackend(flavor));
        process.env.HAPPY_FILES_BACKEND = filesBackend;
        process.env.HAPPIER_FILES_BACKEND = filesBackend;
        const socketAdapterConfig = readSocketAdapterRuntimeConfigFromEnv(process.env, resolveDefaultSocketAdapter(flavor));
        const socketAdapter = socketAdapterConfig.adapter;
        process.env.HAPPY_SOCKET_ADAPTER = socketAdapter;
        process.env.HAPPIER_SOCKET_ADAPTER = socketAdapter;
        const shouldEnableRedisAdapter = shouldEnableRedisAdapterFromEnv(process.env, flavor);
        if (filesBackend === 'local') {
            initFilesLocalFromEnv(process.env);
        } else if (filesBackend === 's3') {
            await initFilesS3FromEnv(process.env);
        } else {
            throw new Error(`Unsupported HAPPY_FILES_BACKEND/HAPPIER_FILES_BACKEND: ${String(filesBackend)}`);
        }
        await initializeSessionSystemRecordsProtocolV1Activation(db);
        if (shouldStartSqliteMaintenanceClient) {
            sqliteWalCheckpointClient = await createDbSqliteMaintenanceClient();
            await sqliteWalCheckpointClient.$connect();
            await applySqliteRuntimePragmas(sqliteWalCheckpointClient, {
                ...process.env,
                HAPPIER_SQLITE_BUSY_TIMEOUT_MS: String(sqliteWalCheckpointBusyTimeoutMs),
                HAPPY_SQLITE_BUSY_TIMEOUT_MS: String(sqliteWalCheckpointBusyTimeoutMs),
            });
        }

        // Actively checkpoint the SQLite WAL after committed writes so it cannot be
        // starved by long-lived readers and grow without bound, which slows queries
        // until they hit the Prisma timeout. An idle database schedules nothing.
        if (sqliteWalCheckpointClient && sqliteWalCheckpointIntervalMs !== null && sqliteWalCheckpointIntervalMs > 0) {
            sqliteWalCheckpointWorker = startSqliteWalCheckpointWorker({
                client: sqliteWalCheckpointClient,
                intervalMs: sqliteWalCheckpointIntervalMs,
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
        const presenceTimeouts = preparePresenceTimeouts();
        onShutdown('keepAlive:presence-timeouts', () => presenceTimeouts.stop());
        const startPresenceConsumer = async (): Promise<void> => {
            if (!shouldConsumePresenceFromRedis(process.env)) return;
            const presenceWorker = startPresenceRedisWorker(readPresenceRedisWorkerConfigFromEnv(process.env));
            onShutdown('presence-redis-worker', () => presenceWorker.stop());
            await presenceWorker.ready;
        };
        await initializeServerIdentityCache(process.env);

        // Redis should not be a hard dependency unless explicitly enabled for scale features.
        if (shouldEnableRedisAdapter) {
            await getRedisClient().ping();
        }
        if (shouldEnableRedisAdapter && role === 'api') {
            log(
                { module: 'presence' },
                'Redis adapter is enabled: API presence is committed synchronously; workers consume released API observations and deadline wakes.',
            );
        }

        setSocketAdapterModeInfo({
            adapter: socketAdapter,
            redisEnabled: shouldEnableRedisAdapter,
            role,
        });

        // Initialize auth module (the at-rest key was initialized before the Home settings overlay)
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
            const workerRoomEmitter = createRedisStreamsRoomEmitter({
                maxLen: socketAdapterConfig.redisStreamsOptions.maxLen,
                streamName: socketAdapterConfig.redisStreamsOptions.streamName,
            });
            eventRouter.setIo(workerRoomEmitter);
            // Access transitions this process commits (directory reconciliation)
            // must still reach the API nodes that own human presence rooms.
            registerSessionHumanPresenceAccessChangePublisher(workerRoomEmitter);

            await startPresenceConsumer();
            await presenceTimeouts.start();
        }

        // Expose health + metrics in all roles (metrics server can be disabled via METRICS_ENABLED=false).
        const metricsServerStarted = await startMetricsServer();

        let apiListenerOwner: Awaited<ReturnType<typeof startApi>> | null = null;
        if (role === 'all' || role === 'api') {
            // Best-effort: warm the read-only public-address inference so the first requests' overlay
            // can publish an inferred address. Cached and single-flight; it never writes the env.
            void resolveInferredPublicServerAccess(process.env).catch(() => null);
            const composeHomeIroh = prepareHomeIrohStartup(await readHomeConfigEnv());
            const homeConnectionDescriptorContinuityStore =
                createHomeConnectionDescriptorContinuityStoreForServer(process.env);
            const api = await startApi({
                homeConnectionDescriptorContinuityStore,
            });
            apiListenerOwner = api;
            await startPresenceConsumer();
            await presenceTimeouts.start();
            await composeHomeIroh({
                listener: resolveBoundServerListener(api),
                ingressPort: api.getDecorator<number | null>('homeIrohIngressPort'),
                continuityStore: homeConnectionDescriptorContinuityStore,
            });
        }

        if (role === 'all' || role === 'worker') {
            const enterpriseIdentitySyncWorker = startEnterpriseIdentitySyncWorker({ env: process.env });
            if (enterpriseIdentitySyncWorker) {
                onShutdown('enterprise-identity-sync-worker', async () => {
                    await enterpriseIdentitySyncWorker.stop();
                });
            }
            const voiceProviderIdentityBackfillWorker = startVoiceProviderIdentityBackfillWorker({
                provider: dbProvider,
                env: process.env,
            });
            if (voiceProviderIdentityBackfillWorker) {
                onShutdown('voice-provider-identity-backfill-worker', async () => {
                    await voiceProviderIdentityBackfillWorker.stop();
                });
            }
            const sqliteReclaimClient = sqliteWalCheckpointClient;
            const retentionWorker = startRetentionWorker({
                readEnv: () => readHomeConfigEnv(process.env),
                // Free pages appear only when rows are deleted, which the sweep does.
                ...(sqliteReclaimClient && sqliteIncrementalVacuumPages !== null
                    ? { reclaimStorage: () => reclaimSqliteFreePages(sqliteReclaimClient, sqliteIncrementalVacuumPages) }
                    : {}),
            });
            if (retentionWorker) {
                onShutdown('retention-worker', async () => {
                    retentionWorker.stop();
                });
            }
            // One-time 0.2 → 0.3 SessionMessage byte encoding; serves both forms while it runs, then ends.
            const sessionMessageContentByteUpgrade = startSessionMessageContentByteUpgrade();
            onShutdown('session-message-content-byte-upgrade', sessionMessageContentByteUpgrade.stop);
            // Exact record counts can monopolize the intentionally single-connection
            // SQLite runtime. They are operational metrics, so only collect them when
            // the metrics endpoint is enabled and the database can serve concurrent work.
            if (metricsServerStarted && dbProvider !== 'sqlite') {
                enableDatabaseRecordCountsOnScrape();
            }
        }

        //
        // Ready
        //

        const personalHomeReadiness = flavor === 'light'
            && isPersonalHomeRuntimePurpose(process.env.HAPPIER_MANAGED_RELAY_PURPOSE)
            ? await createPersonalHomeAuthenticatedReadiness(process.env)
            : null;
        await writeStartupReceiptFromEnvironment(process.env, apiListenerOwner, personalHomeReadiness);
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
