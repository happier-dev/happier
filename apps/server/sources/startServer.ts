import { SERVER_CONFIG, readServerConfig } from '@happier-dev/protocol';
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
    shutdownDbClient,
    shutdownDbPglite,
} from '@/storage/db';
import {
    runHomeOwnerClaimCommand,
    runPrintHomeClaimCodeCommand,
    type HomeOwnerClaimRequestV1,
} from '@/app/home/governance/claimHomeOwnerCommand';
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
    resolveDefaultFilesBackend,
    resolveDefaultSocketAdapter,
} from '@/config/backends';
import { readSocketAdapterRuntimeConfigFromEnv } from '@/config/socketAdapter';
import { createRedisStreamsRoomEmitter } from '@/app/events/createRedisStreamsRoomEmitter';
import { registerSessionHumanPresenceAccessChangePublisher } from '@/app/session/humanPresence/sessionHumanPresenceService';
import { eventRouter } from '@/app/events/eventRouter';
import { getRedisClient } from '@/storage/redis/redis';
import { shouldConsumePresenceFromRedis, shouldEnableLocalPresenceDbFlush } from '@/app/presence/presenceMode';
import { startPresenceRedisWorker } from '@/app/presence/presenceRedisQueue';
import { initializeServerSentry } from '@/app/monitoring/sentry';
import { resolveInferredPublicServerAccess } from '@/app/integrations/publicUrl/publicServerUrlInference';
import { startRetentionWorker } from '@/app/retention/runtime/startRetentionWorker';
import { startPluginWebhookCredentialRetirementWorker } from '@/app/plugins/webhooks/credentialRetirementWorker';
import { startVoiceProviderIdentityBackfillWorker } from '@/app/voice/providerIdentityBackfill/worker';
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
import { applyStartupHomeEnvToProcess, loadStartupHomeEnv } from '@/app/home/settings/startupHomeEnv';
import {
    beginHomeIrohEndpointStartup,
    ensureHomeIrohEndpoint,
    markHomeIrohEndpointRetired,
    markHomeIrohEndpointStartupUnavailable,
    registerHomeIrohComposition,
    stopHomeIrohEndpoint,
} from '@/app/iroh/homeIrohEndpoint';
import { verifyPersonalHomeExposureProof } from '@/app/iroh/personalHomeExposureProof';
import { createPersonalHomeAuthenticatedReadiness } from '@/app/runtime/personalHomeReadiness';
import { createHomeConnectionDescriptorContinuityStoreForServer } from '@/app/features/homeConnectionDescriptorContinuity';
import { readHomeConnectionDescriptor } from '@/app/features/homeConnectionDescriptorPublication';

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
    const dbProvider = getDbProviderFromEnv(process.env, flavor === 'light' ? 'sqlite' : 'postgres');
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
    const shouldApplyLocalDefaults = getFilesBackendFromEnv(process.env, resolveDefaultFilesBackend(flavor)) === 'local'
        || dbProvider === 'pglite'
        || dbProvider === 'sqlite';
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

            if (shouldConsumePresenceFromRedis(process.env)) {
                const presenceWorker = startPresenceRedisWorker(readPresenceRedisWorkerConfigFromEnv(process.env));
                onShutdown('presence-redis-worker', async () => {
                    await presenceWorker.stop();
                });
            }
        }

        // Expose health + metrics in all roles (metrics server can be disabled via METRICS_ENABLED=false).
        const metricsServerStarted = await startMetricsServer();

        let apiListenerOwner: Awaited<ReturnType<typeof startApi>> | null = null;
        if (role === 'all' || role === 'api') {
            // Best-effort: warm the read-only public-address inference so the first requests' overlay
            // can publish an inferred address. Cached and single-flight; it never writes the env.
            void resolveInferredPublicServerAccess(process.env).catch(() => null);
            const shouldPreparePersonalHomeIroh = flavor === 'light'
                && isPersonalHomeRuntimePurpose(process.env.HAPPIER_MANAGED_RELAY_PURPOSE);
            // The owner's direct-connection choice (plan 2026-09-26-home-owner-console §3.2, AM-2) is
            // the source of truth at every start: off means nothing is composed and the retirement
            // is (re)published, which also completes a turn-off an earlier process did not finish.
            const personalHomeIrohRetired = shouldPreparePersonalHomeIroh
                && readServerConfig(await readHomeConfigEnv(), SERVER_CONFIG.HAPPIER_HOME_IROH_MODE) === 'disabled';
            if (shouldPreparePersonalHomeIroh && !personalHomeIrohRetired) {
                // Close the descriptor-publication retirement window before
                // HTTP can answer its first features request.
                beginHomeIrohEndpointStartup();
            }
            const homeConnectionDescriptorContinuityStore =
                createHomeConnectionDescriptorContinuityStoreForServer(process.env);
            const api = await startApi({
                homeConnectionDescriptorContinuityStore,
            });
            apiListenerOwner = api;
            const listener = resolveBoundServerListener(api);

            // Managed Personal Home / server-light composition: expose the
            // already-listening loopback API through one persistent Iroh Home
            // acceptor fixed to 127.0.0.1:<actual bound port>. Never composed
            // for the full server flavor, a worker-only role, a managed
            // runtime whose canonical purpose is not Personal Home, or until
            // the canonical auth-policy owner confirms anonymous signup was
            // explicitly disabled. Composition always follows a successful
            // API listen. Failures fail the Iroh composition closed and keep
            // the ordinary HTTPS Home running; Iroh ingress shutdown is
            // registered with a priority ahead of api:socket/api:http.
            if (
                shouldPreparePersonalHomeIroh
                && verifyPersonalHomeExposureProof({ env: process.env, listener })
                && homeConnectionDescriptorContinuityStore
            ) {
                onShutdown('iroh', () => stopHomeIrohEndpoint());
                registerHomeIrohComposition({
                    env: process.env,
                    apiPort: listener?.port ?? null,
                    continuityStore: homeConnectionDescriptorContinuityStore,
                });
                if (personalHomeIrohRetired) markHomeIrohEndpointRetired();
                const irohState = personalHomeIrohRetired
                    ? null
                    : await ensureHomeIrohEndpoint({
                        env: process.env,
                        apiPort: listener?.port ?? null,
                        continuityStore: homeConnectionDescriptorContinuityStore,
                    });
                if (personalHomeIrohRetired || irohState?.status === 'active') {
                    // The public features route only projects a committed
                    // generation. A restarted acceptor may have new direct
                    // addresses (or the owner retired Iroh), so commit through
                    // the canonical publisher, over the same configuration
                    // overlay requests read, before the startup receipt makes
                    // this Home discoverable.
                    await readHomeConnectionDescriptor({
                        env: await readHomeConfigEnv(),
                        continuityStore: homeConnectionDescriptorContinuityStore,
                        visibility: 'authenticated',
                    });
                }
            } else if (shouldPreparePersonalHomeIroh) {
                markHomeIrohEndpointStartupUnavailable();
            }
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
            const retentionWorker = startRetentionWorker({ readEnv: () => readHomeConfigEnv(process.env) });
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
