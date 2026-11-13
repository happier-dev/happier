import type { ApiMachineClient } from '@/api/apiMachine';
import type { SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { logger } from '@/ui/logger';
import type { TrackedSession } from '../types';
import type { DaemonAdmissionDrain } from './admissionDrain';
import type { SessionTrackingKey, TrackedSessionMap } from '@/daemon/sessions/sessionTrackingKey';

type SpawnResultResolver = (result: SpawnSessionResult) => void;
type PendingRpcDrainApiMachine = Pick<ApiMachineClient, 'awaitPendingRpcRequests'>;

export type CreateBeforeShutdownDrainParams = Readonly<{
    admissionDrain?: DaemonAdmissionDrain;
    hasPendingRunnerRestarts?: () => boolean;
    spawnAwaiterByKey: Map<SessionTrackingKey, unknown>;
    spawnResultResolverByKey: Map<SessionTrackingKey, SpawnResultResolver>;
    spawnWebhookTimeoutByKey: Map<SessionTrackingKey, NodeJS.Timeout>;
    trackedSessionsByKey?: TrackedSessionMap;
    shutdownSpawnDrainGraceMs: number;
    shutdownSpawnDrainPollMs: number;
    getApiMachineForSessions: () => PendingRpcDrainApiMachine | null;
    buildUnexpectedSpawnResult: (errorMessage: string) => SpawnSessionResult;
    buildIncompleteRetirementResult?: () => SpawnSessionResult;
    retireFiniteExecution?: () => Promise<void>;
    drainBackgroundServerWork?: () => Promise<void>;
    disposePluginRuntimeRegistry?: () => Promise<void>;
}>;

async function disposePluginRuntimeRegistryBestEffort(params: CreateBeforeShutdownDrainParams): Promise<void> {
    if (!params.disposePluginRuntimeRegistry) {
        return;
    }
    try {
        await params.disposePluginRuntimeRegistry();
    } catch (error) {
        logger.warn('[DAEMON RUN] Plugin runtime registry disposal failed during shutdown (best-effort)', error);
    }
}

async function drainBackgroundServerWorkBestEffort(params: CreateBeforeShutdownDrainParams): Promise<void> {
    if (!params.drainBackgroundServerWork) return;
    try {
        await params.drainBackgroundServerWork();
    } catch (error) {
        logger.debug('[DAEMON RUN] Background server-work drain failed during shutdown (best-effort)', error);
    }
}

async function drainFinalRuntimeWork(params: CreateBeforeShutdownDrainParams): Promise<void> {
    // Early accepted finite work is no longer a pending RPC. Keep its native
    // owner and observation/Stop transports alive until actual settlement.
    // A failed retirement still rejects to its caller, but must not skip the
    // final disposals: plugin managed services run detached and would outlive us.
    try {
        await params.retireFiniteExecution?.();
    } finally {
        await drainBackgroundServerWorkBestEffort(params);
        await disposePluginRuntimeRegistryBestEffort(params);
    }
}

export function createBeforeShutdownDrain(
    params: CreateBeforeShutdownDrainParams,
): () => Promise<void> {
    let beforeShutdownOnce: Promise<void> | null = null;

    return async (): Promise<void> => {
        params.admissionDrain?.beginShutdown();
        if (beforeShutdownOnce) return await beforeShutdownOnce;
        beforeShutdownOnce = (async () => {
            const initialInFlightSpawns = params.spawnAwaiterByKey.size;
            const hasPendingRunnerRestarts = () => params.hasPendingRunnerRestarts?.() === true;
            const hasPendingRpcRequests = params.getApiMachineForSessions() !== null;
            if (initialInFlightSpawns === 0 && !hasPendingRunnerRestarts() && !hasPendingRpcRequests) {
                await drainFinalRuntimeWork(params);
                return;
            }

            logger.debug('[DAEMON RUN] Shutdown requested with in-flight work; deferring shutdown', {
                inFlightSpawns: initialInFlightSpawns,
                pendingRunnerRestarts: hasPendingRunnerRestarts(),
                pendingRpcDrainEnabled: hasPendingRpcRequests,
                graceMs: params.shutdownSpawnDrainGraceMs,
                pollMs: params.shutdownSpawnDrainPollMs,
            });

            const start = Date.now();
            while ((params.spawnAwaiterByKey.size > 0 || hasPendingRunnerRestarts()) && Date.now() - start < params.shutdownSpawnDrainGraceMs) {
                // eslint-disable-next-line no-await-in-loop
                await new Promise((resolve) => setTimeout(resolve, params.shutdownSpawnDrainPollMs));
            }

            if (hasPendingRunnerRestarts()) {
                logger.warn('[DAEMON RUN] Planned runner restart(s) did not drain before shutdown', {
                    graceMs: params.shutdownSpawnDrainGraceMs,
                });
            }
            const remaining = params.spawnAwaiterByKey.size;
            if (remaining === 0) {
                logger.debug('[DAEMON RUN] In-flight spawn(s) drained; checking pending RPC requests');
            } else {
                const errorMessage = `Daemon shutting down while ${remaining} spawn(s) still awaiting session webhook.`;
                logger.warn('[DAEMON RUN] In-flight spawn(s) did not drain before shutdown; aborting spawn(s)', {
                    inFlight: remaining,
                    graceMs: params.shutdownSpawnDrainGraceMs,
                });

                for (const timeout of params.spawnWebhookTimeoutByKey.values()) {
                    clearTimeout(timeout);
                }

                for (
                    const [awaiterKey, resolveSpawnResult]
                    of params.spawnResultResolverByKey.entries()
                ) {
                    const tracked =
                        params.trackedSessionsByKey?.get(awaiterKey);
                    let retirementIncomplete = false;
                    const cancel =
                        tracked?.cancelStartupLaunchBeforeAck;
                    if (cancel) {
                        try {
                            retirementIncomplete =
                                (await cancel()).status
                                !== 'stopped';
                        } catch {
                            retirementIncomplete = true;
                        }
                    }
                    resolveSpawnResult(
                        retirementIncomplete
                        && params.buildIncompleteRetirementResult
                            ? params
                                .buildIncompleteRetirementResult()
                            : params
                                .buildUnexpectedSpawnResult(
                                    errorMessage,
                                ),
                    );
                }

                params.spawnAwaiterByKey.clear();
                params.spawnResultResolverByKey.clear();
                params.spawnWebhookTimeoutByKey.clear();
            }

            const apiMachineForSessions = params.getApiMachineForSessions();
            if (!apiMachineForSessions) {
                await drainFinalRuntimeWork(params);
                return;
            }

            const elapsedMs = Date.now() - start;
            const remainingRpcGraceMs = Math.max(0, params.shutdownSpawnDrainGraceMs - elapsedMs);
            if (remainingRpcGraceMs === 0) {
                logger.warn('[DAEMON RUN] No shutdown grace budget left to drain pending RPC requests');
                await drainFinalRuntimeWork(params);
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
            await drainFinalRuntimeWork(params);
        })();
        return await beforeShutdownOnce;
    };
}
