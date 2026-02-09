import { startApi } from '@/app/api/api';
import { startMetricsServer } from '@/app/monitoring/metrics';
import { startDatabaseMetricsUpdater } from '@/app/monitoring/metrics2';
import { auth } from '@/app/auth/auth';
import { activityCache } from '@/app/presence/sessionCache';
import { startTimeout } from '@/app/presence/timeout';
import { initEncrypt } from '@/modules/encrypt';
import { initGithub } from '@/app/auth/providers/github/webhooks';
import { loadFiles, initFilesLocalFromEnv, initFilesS3FromEnv } from '@/storage/blob/files';
import { db, getDbProviderFromEnv, initDbMysql, initDbPostgres, initDbPglite, initDbSqlite, shutdownDbPglite } from '@/storage/db';
import { log } from '@/utils/logging/log';
import { awaitShutdown, onShutdown } from '@/utils/process/shutdown';
import { applyLightDefaultEnv, ensureHandyMasterSecret } from '@/flavors/light/env';
import {
    getFilesBackendFromEnv,
    getSocketAdapterFromEnv,
    isRedisStreamsEnabled,
    resolveDefaultFilesBackend,
    resolveDefaultSocketAdapter,
} from '@/config/backends';
import http from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-streams-adapter';
import { getRedisClient } from '@/storage/redis/redis';
import { eventRouter } from '@/app/events/eventRouter';
import { startAccountChangeCleanupFromEnv } from '@/app/changes/accountChangeCleanup';
import { shouldConsumePresenceFromRedis, shouldEnableLocalPresenceDbFlush } from '@/app/presence/presenceMode';
import { startPresenceRedisWorker } from '@/app/presence/presenceRedisQueue';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startVoiceSessionLeaseCleanupFromEnv } from '@/app/voice/voiceSessionLeaseCleanup';

export type ServerFlavor = 'full' | 'light';
export type ServerRole = 'all' | 'api' | 'worker';

export function getServerRoleFromEnv(env: NodeJS.ProcessEnv): ServerRole {
    const raw = env.SERVER_ROLE?.trim();
    if (!raw) return 'all';
    if (raw === 'api' || raw === 'worker') return raw;
    return 'all';
}

function shouldEnableRedisAdapterFromEnv(env: NodeJS.ProcessEnv, flavor: ServerFlavor): boolean {
    const socketAdapter = getSocketAdapterFromEnv(env, resolveDefaultSocketAdapter(flavor));
    return isRedisStreamsEnabled(env, socketAdapter);
}

export async function startServer(flavor: ServerFlavor): Promise<void> {
    process.env.HAPPY_SERVER_FLAVOR = flavor;
    process.env.HAPPIER_SERVER_FLAVOR = flavor;
    const role = getServerRoleFromEnv(process.env);
    const shouldEnableRedisAdapter = shouldEnableRedisAdapterFromEnv(process.env, flavor);
    const dbProvider = getDbProviderFromEnv(process.env, flavor === 'light' ? 'sqlite' : 'postgres');
    process.env.HAPPY_DB_PROVIDER = dbProvider;
    process.env.HAPPIER_DB_PROVIDER = dbProvider;

    const filesBackend = getFilesBackendFromEnv(process.env, resolveDefaultFilesBackend(flavor));
    process.env.HAPPY_FILES_BACKEND = filesBackend;
    process.env.HAPPIER_FILES_BACKEND = filesBackend;

    const socketAdapter = getSocketAdapterFromEnv(process.env, resolveDefaultSocketAdapter(flavor));
    process.env.HAPPY_SOCKET_ADAPTER = socketAdapter;
    process.env.HAPPIER_SOCKET_ADAPTER = socketAdapter;

    const shouldApplyLocalDefaults = filesBackend === 'local' || dbProvider === 'pglite' || dbProvider === 'sqlite';
    if (shouldApplyLocalDefaults) {
        applyLightDefaultEnv(process.env);
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
        if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.trim()) {
            const dataDir = (process.env.HAPPIER_SERVER_LIGHT_DATA_DIR ?? process.env.HAPPY_SERVER_LIGHT_DATA_DIR ?? '').trim();
            if (!dataDir) {
                throw new Error('HAPPIER_SERVER_LIGHT_DATA_DIR (or HAPPY_SERVER_LIGHT_DATA_DIR) must be set when using sqlite without DATABASE_URL');
            }
            process.env.DATABASE_URL = pathToFileURL(join(dataDir, 'happier-server-light.sqlite')).href;
        }
        await initDbSqlite();
    } else {
        throw new Error(`Unsupported HAPPY_DB_PROVIDER/HAPPIER_DB_PROVIDER: ${dbProvider}`);
    }

    if (filesBackend === 'local') {
        initFilesLocalFromEnv(process.env);
    } else if (filesBackend === 's3') {
        initFilesS3FromEnv(process.env);
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
    onShutdown('activity-cache', async () => {
        activityCache.shutdown();
    });
    if (shouldEnableLocalPresenceDbFlush(process.env)) {
        activityCache.enableDbFlush();
    }

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
        // Create an emitter-only Socket.IO server wired to the Redis adapter, so background jobs can publish
        // ephemeral/update events to rooms even though this process does not accept client connections.
        const dummyHttpServer = http.createServer();
        const io = new SocketIOServer(dummyHttpServer, {
            adapter: createAdapter(getRedisClient()),
            serveClient: false,
            transports: ['websocket', 'polling'],
            path: '/v1/updates',
        });
        eventRouter.setIo(io);
        onShutdown('worker-socketio', async () => {
            await io.close();
            dummyHttpServer.close();
        });

        if (shouldConsumePresenceFromRedis(process.env)) {
            const presenceWorker = startPresenceRedisWorker();
            onShutdown('presence-redis-worker', async () => {
                await presenceWorker.stop();
            });
        }
    }

    // Expose health + metrics in all roles (metrics server can be disabled via METRICS_ENABLED=false).
    await startMetricsServer();

    if (role === 'all' || role === 'api') {
        await startApi();
    }

    if (role === 'all' || role === 'worker') {
        const cleanup = startAccountChangeCleanupFromEnv();
        if (cleanup) {
            onShutdown('account-change-cleanup', async () => {
                cleanup.stop();
            });
        }
        const voiceCleanup = startVoiceSessionLeaseCleanupFromEnv();
        if (voiceCleanup) {
            onShutdown('voice-lease-cleanup', async () => {
                voiceCleanup.stop();
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
