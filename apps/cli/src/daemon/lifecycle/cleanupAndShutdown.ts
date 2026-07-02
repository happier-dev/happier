import type { ApiMachineClient } from '@/api/apiMachine';
import { clearDaemonState, acquireDaemonLock } from '@/persistence';
import { logger } from '@/ui/logger';
import type { AutomationWorkerHandle } from '../automation/automationWorker';
import type { ConnectedServiceQuotasLoopHandle } from '../connectedServices/quotas/startConnectedServiceQuotasLoop';
import type { MemoryWorkerHandle } from '../memory/memoryWorker';
import type { VoiceInferenceWorkerHandle } from '../voiceInference/voiceInferenceWorker';
import { getDaemonShutdownExitCode, getDaemonShutdownWatchdogTimeoutMs } from '../shutdownPolicy';
import { publishShutdownStateBestEffort } from './publishShutdownState';
import type { DaemonShutdownSource } from './shutdown';

type DaemonLockHandle = NonNullable<Awaited<ReturnType<typeof acquireDaemonLock>>>;
type ConnectedServiceRefreshLoopHandle = Readonly<{
    stop: () => void;
}>;

export type CleanupAndShutdownParams = Readonly<{
    source: DaemonShutdownSource;
    errorMessage?: string;
    processEnv: NodeJS.ProcessEnv;
    resolvePositiveIntEnv: (raw: string | undefined, fallback: number, bounds: { min: number; max: number }) => number;
    restartOnStaleVersionAndHeartbeat: NodeJS.Timeout | null;
    connectedServiceRefreshLoopHandle: ConnectedServiceRefreshLoopHandle | null;
    connectedServiceQuotasLoopHandle: ConnectedServiceQuotasLoopHandle | null;
    beforeShutdown?: () => Promise<void>;
    apiMachine: ApiMachineClient | null;
    machineConnectionStateCleanup: (() => void) | null;
    automationWorker: AutomationWorkerHandle | null;
    memoryWorker: MemoryWorkerHandle | null;
    voiceInferenceWorker: VoiceInferenceWorkerHandle | null;
    trackedSessionCount: number;
    stopDirectPeerServer: () => Promise<void>;
    stopTailscaleTransferServeLifecycle: () => Promise<void>;
    stopManagedServersOnShutdown: () => Promise<void>;
    stopSshTunnelsOnShutdown?: () => Promise<void>;
    stopControlServer: () => Promise<void>;
    stopCaffeinate: () => Promise<void>;
    daemonLockHandle: DaemonLockHandle | null;
    releaseDaemonLock: (handle: DaemonLockHandle) => Promise<void>;
}>;

export async function cleanupAndShutdown(params: CleanupAndShutdownParams): Promise<void> {
    const exitCode = getDaemonShutdownExitCode(params.source);
    const shutdownWatchdog = setTimeout(async () => {
        logger.debug(`[DAEMON RUN] Shutdown timed out, forcing exit with code ${exitCode}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
        process.exit(exitCode);
    }, getDaemonShutdownWatchdogTimeoutMs());
    shutdownWatchdog.unref?.();

    logger.debug(`[DAEMON RUN] Starting proper cleanup (source: ${params.source}, errorMessage: ${params.errorMessage})...`);

    if (params.restartOnStaleVersionAndHeartbeat) {
        clearInterval(params.restartOnStaleVersionAndHeartbeat);
        logger.debug('[DAEMON RUN] Health check interval cleared');
    }

    // Clear daemon.state.json early in shutdown so callers observing "stop" don't race a later
    // heartbeat tick or long tail cleanup work (and to satisfy daemon stop integration tests).
    try {
        await clearDaemonState({ includeLockFile: false });
        logger.debug('[DAEMON RUN] Daemon state file removed');
    } catch (error) {
        logger.debug('[DAEMON RUN] Error cleaning up daemon metadata', error);
    }

    if (params.connectedServiceRefreshLoopHandle) {
        params.connectedServiceRefreshLoopHandle.stop();
    }
    if (params.connectedServiceQuotasLoopHandle) {
        params.connectedServiceQuotasLoopHandle.stop();
    }
    if (params.beforeShutdown) {
        try {
            await params.beforeShutdown();
        } catch (error) {
            logger.debug('[DAEMON RUN] Error draining shutdown work during cleanup (best-effort)', error);
        }
    }

    if (params.apiMachine) {
        params.machineConnectionStateCleanup?.();
        const daemonStateUpdateTimeoutMs = params.resolvePositiveIntEnv(
            params.processEnv.HAPPIER_DAEMON_SHUTDOWN_STATE_UPDATE_TIMEOUT_MS,
            250,
            { min: 50, max: 30_000 },
        );

        await publishShutdownStateBestEffort({
            apiMachine: params.apiMachine,
            source: params.source,
            timeoutMs: daemonStateUpdateTimeoutMs,
            warn: (message, error) => {
                if (error !== undefined) {
                    logger.warn(message, error);
                    return;
                }
                logger.warn(message);
            },
        });
    }

    if (params.automationWorker) {
        params.automationWorker.stop();
    }
    if (params.memoryWorker) {
        params.memoryWorker.stop();
    }
    if (params.voiceInferenceWorker) {
        await params.voiceInferenceWorker.stop();
    }

    await params.stopDirectPeerServer();
    await params.stopTailscaleTransferServeLifecycle();
    await params.stopManagedServersOnShutdown();
    await params.stopSshTunnelsOnShutdown?.();
    await params.stopControlServer();
    await params.stopCaffeinate();
    if (params.daemonLockHandle) {
        await params.releaseDaemonLock(params.daemonLockHandle);
    }

    logger.debug('[DAEMON RUN] Cleanup completed, exiting process');
    clearTimeout(shutdownWatchdog);
    process.exit(exitCode);
}
