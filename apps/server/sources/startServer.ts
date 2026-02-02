import { startApi } from '@/app/api/api';
import { startMetricsServer } from '@/app/monitoring/metrics';
import { startDatabaseMetricsUpdater } from '@/app/monitoring/metrics2';
import { auth } from '@/app/auth/auth';
import { activityCache } from '@/app/presence/sessionCache';
import { startTimeout } from '@/app/presence/timeout';
import { initEncrypt } from '@/modules/encrypt';
import { initGithub } from '@/modules/github';
import { loadFiles, initFilesLocalFromEnv, initFilesS3FromEnv } from '@/storage/files';
import { db, initDbPostgres, initDbPglite, shutdownDbPglite } from '@/storage/db';
import { log } from '@/utils/log';
import { awaitShutdown, onShutdown } from '@/utils/shutdown';
import { applyLightDefaultEnv, ensureHandyMasterSecret } from '@/flavors/light/env';
import http from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-streams-adapter';
import { getRedisClient } from '@/storage/redis';
import { eventRouter } from '@/app/events/eventRouter';
import { startAccountChangeCleanupFromEnv } from '@/app/changes/accountChangeCleanup';
import { shouldConsumePresenceFromRedis, shouldEnableLocalPresenceDbFlush } from '@/app/presence/presenceMode';
import { startPresenceRedisWorker } from '@/app/presence/presenceRedisQueue';

export type ServerFlavor = 'full' | 'light';
export type ServerRole = 'all' | 'api' | 'worker';

export function getServerRoleFromEnv(env: NodeJS.ProcessEnv): ServerRole {
    const raw = env.SERVER_ROLE?.trim();
    if (!raw) return 'all';
    if (raw === 'api' || raw === 'worker') return raw;
    return 'all';
}

function shouldEnableRedisAdapterFromEnv(env: NodeJS.ProcessEnv, flavor: ServerFlavor): boolean {
    return (
        flavor !== 'light' &&
        (env.HAPPY_SOCKET_REDIS_ADAPTER === 'true' || env.HAPPY_SOCKET_REDIS_ADAPTER === '1') &&
        typeof env.REDIS_URL === 'string' &&
        env.REDIS_URL.trim().length > 0
    );
}

export async function startServer(flavor: ServerFlavor): Promise<void> {
    process.env.HAPPY_SERVER_FLAVOR = flavor;
    const role = getServerRoleFromEnv(process.env);
    const shouldEnableRedisAdapter = shouldEnableRedisAdapterFromEnv(process.env, flavor);

    if (flavor === 'light') {
        applyLightDefaultEnv(process.env);
        await ensureHandyMasterSecret(process.env);
        await initDbPglite();
        initFilesLocalFromEnv(process.env);
    } else {
        initDbPostgres();
        initFilesS3FromEnv(process.env);
    }

    // Storage
    await db.$connect();
    if (flavor === 'light') {
        // In light mode, ensure Prisma disconnect happens before stopping the embedded pglite server.
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
                "SERVER_ROLE=worker requires Redis adapter enabled (set REDIS_URL and HAPPY_SOCKET_REDIS_ADAPTER=1) so worker pushes can fan out to connected API sockets",
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
