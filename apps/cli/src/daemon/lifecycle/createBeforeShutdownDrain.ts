import type { ApiMachineClient } from '@/api/apiMachine';
import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import { logger } from '@/ui/logger';

type SpawnResultResolver = (result: SpawnSessionResult) => void;

export type CreateBeforeShutdownDrainParams = Readonly<{
    pidToAwaiter: Map<number, unknown>;
    pidToSpawnResultResolver: Map<number, SpawnResultResolver>;
    pidToSpawnWebhookTimeout: Map<number, NodeJS.Timeout>;
    shutdownSpawnDrainGraceMs: number;
    shutdownSpawnDrainPollMs: number;
    getApiMachineForSessions: () => ApiMachineClient | null;
    buildUnexpectedSpawnResult: (errorMessage: string) => SpawnSessionResult;
    drainBackgroundServerWork?: () => Promise<void>;
}>;

export function createBeforeShutdownDrain(
    params: CreateBeforeShutdownDrainParams,
): () => Promise<void> {
    let beforeShutdownOnce: Promise<void> | null = null;

    return async (): Promise<void> => {
        if (beforeShutdownOnce) return await beforeShutdownOnce;
        beforeShutdownOnce = (async () => {
            if (params.drainBackgroundServerWork) {
                try {
                    await params.drainBackgroundServerWork();
                } catch (error) {
                    logger.debug('[DAEMON RUN] Background server-work drain failed during shutdown (best-effort)', error);
                }
            }

            const initialInFlightSpawns = params.pidToAwaiter.size;
            const hasPendingRpcRequests = params.getApiMachineForSessions() !== null;
            if (initialInFlightSpawns === 0 && !hasPendingRpcRequests) return;

            logger.debug('[DAEMON RUN] Shutdown requested with in-flight work; deferring shutdown', {
                inFlightSpawns: initialInFlightSpawns,
                pendingRpcDrainEnabled: hasPendingRpcRequests,
                graceMs: params.shutdownSpawnDrainGraceMs,
                pollMs: params.shutdownSpawnDrainPollMs,
            });

            const start = Date.now();
            while (params.pidToAwaiter.size > 0 && Date.now() - start < params.shutdownSpawnDrainGraceMs) {
                // eslint-disable-next-line no-await-in-loop
                await new Promise((resolve) => setTimeout(resolve, params.shutdownSpawnDrainPollMs));
            }

            const remaining = params.pidToAwaiter.size;
            if (remaining === 0) {
                logger.debug('[DAEMON RUN] In-flight spawn(s) drained; checking pending RPC requests');
            } else {
                const errorMessage = `Daemon shutting down while ${remaining} spawn(s) still awaiting session webhook.`;
                logger.warn('[DAEMON RUN] In-flight spawn(s) did not drain before shutdown; aborting spawn(s)', {
                    inFlight: remaining,
                    graceMs: params.shutdownSpawnDrainGraceMs,
                });

                for (const timeout of params.pidToSpawnWebhookTimeout.values()) {
                    clearTimeout(timeout);
                }

                for (const resolveSpawnResult of params.pidToSpawnResultResolver.values()) {
                    resolveSpawnResult(params.buildUnexpectedSpawnResult(errorMessage));
                }

                params.pidToAwaiter.clear();
                params.pidToSpawnResultResolver.clear();
                params.pidToSpawnWebhookTimeout.clear();
            }

            const apiMachineForSessions = params.getApiMachineForSessions();
            if (!apiMachineForSessions) return;

            const elapsedMs = Date.now() - start;
            const remainingRpcGraceMs = Math.max(0, params.shutdownSpawnDrainGraceMs - elapsedMs);
            if (remainingRpcGraceMs === 0) {
                logger.warn('[DAEMON RUN] No shutdown grace budget left to drain pending RPC requests');
                return;
            }

            let rpcRequestsDrained = false;
            const timeoutHandle = setTimeout(() => {
                if (!rpcRequestsDrained) {
                    logger.warn('[DAEMON RUN] Pending RPC requests did not drain before shutdown', {
                        graceMs: remainingRpcGraceMs,
                    });
                }
            }, remainingRpcGraceMs);

            try {
                await Promise.race([
                    apiMachineForSessions.awaitPendingRpcRequests().then(() => {
                        rpcRequestsDrained = true;
                    }),
                    new Promise<void>((resolve) => setTimeout(resolve, remainingRpcGraceMs)),
                ]);
            } finally {
                clearTimeout(timeoutHandle);
            }

            if (rpcRequestsDrained) {
                logger.debug('[DAEMON RUN] Pending RPC requests drained; proceeding with shutdown');
            }
        })();
        return await beforeShutdownOnce;
    };
}
