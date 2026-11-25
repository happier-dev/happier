import type { ApiMachineClient } from '@/api/apiMachine';
import {
    acquireDaemonLock,
    clearDaemonStateForLockOwner,
    releaseDaemonLock,
    type DaemonStateOwner,
} from '@/persistence';
import { logger } from '@/ui/logger';
import type { AutomationWorkerHandle } from '../automation/automationWorker';
import type { ConnectedServiceQuotasLoopHandle } from '../connectedServices/quotas/startConnectedServiceQuotasLoop';
import type { MemoryWorkerHandle } from '../memory/memoryWorker';
import type { VoiceInferenceWorkerHandle } from '../voiceInference/voiceInferenceWorker';
import { getDaemonShutdownExitCode, getDaemonShutdownWatchdogTimeoutMs } from '../shutdownPolicy';
import { publishShutdownStateBestEffort } from './publishShutdownState';
import type { DaemonShutdownSource } from './shutdown';
import type { SingleFlightIntervalLoopHandle } from './singleFlightIntervalLoop';

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
    publicProfileRefreshHandle?: Pick<SingleFlightIntervalLoopHandle, 'stop'> | null;
    beforeShutdown?: () => Promise<void>;
    apiMachine: ApiMachineClient | null;
    closeDaemonMutationCustody?: () => Promise<void>;
    machineConnectionStateCleanup: (() => void) | null;
    automationWorker: AutomationWorkerHandle | null;
    memoryWorker: MemoryWorkerHandle | null;
    voiceInferenceWorker: VoiceInferenceWorkerHandle | null;
    trackedSessionCount: number;
    stopDirectPeerServer: () => Promise<void>;
    stopTailscaleTransferServeLifecycle: () => Promise<void>;
    stopSshTunnelsOnShutdown?: () => Promise<void>;
    stopControlServer: () => Promise<void>;
    stopKeepAwake: () => Promise<void>;
    daemonStateOwner?: DaemonStateOwner;
    daemonLockHandle: DaemonLockHandle | null;
    releaseDaemonLock: (handle: DaemonLockHandle) => Promise<void>;
}>;

export async function releaseDaemonOwnershipAfterFatal(params: Readonly<{
    daemonLockHandle: DaemonLockHandle | null;
    daemonStateOwner: DaemonStateOwner | null;
}>): Promise<void> {
    if (!params.daemonLockHandle) return;
    try {
        if (params.daemonStateOwner) {
            clearDaemonStateForLockOwner(
                params.daemonLockHandle,
                params.daemonStateOwner,
            );
        }
    } finally {
        await releaseDaemonLock(params.daemonLockHandle);
    }
}

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

    // Publication preparation holds captured Account authority. Abort and join
    // it before any shutdown drain can retire its settings or HTTP transport.
    await params.publicProfileRefreshHandle?.stop();

    // Admission has already been stopped synchronously by the outer lifecycle
    // owner. Retire native language-server work before joining admitted requests
    // that may be waiting for a native response.
    try {
        const { disposeLanguageServerHost } = await import('@/lsp/languageServerHost');
        await disposeLanguageServerHost();
    } catch (error) {
        logger.infoFile('[DAEMON RUN] Language-server shutdown did not complete', error);
    }

    // Drain admitted Action/RPC work while control and data transports and their
    // supporting loops are still live.
    if (params.beforeShutdown) {
        try {
            await params.beforeShutdown();
        } catch (error) {
            logger.debug('[DAEMON RUN] Error draining shutdown work during cleanup (best-effort)', error);
        }
    }

    if (params.connectedServiceRefreshLoopHandle) {
        params.connectedServiceRefreshLoopHandle.stop();
    }
    if (params.connectedServiceQuotasLoopHandle) {
        await params.connectedServiceQuotasLoopHandle.stop();
    }
    // Stop transfer listeners while the machine socket is still available. Their lifecycle
    // owners publish the terminal inactive state through apiMachine; disconnecting first leaves
    // the previous daemon's direct routes falsely active until a replacement daemon publishes.
    await params.stopDirectPeerServer();
    await params.stopTailscaleTransferServeLifecycle();

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

    // API shutdown waits for in-flight machine RPC handlers. Close the usage-capable
    // daemon handle afterwards so no staging call can race handle retirement.
    if (params.closeDaemonMutationCustody) {
        try {
            await params.closeDaemonMutationCustody();
        } catch (error) {
            logger.debug('[DAEMON RUN] Error closing daemon mutation custody during cleanup (best-effort)', error);
        }
    }

    if (params.automationWorker) {
        await params.automationWorker.stop();
    }
    if (params.memoryWorker) {
        await params.memoryWorker.stop();
    }
    if (params.voiceInferenceWorker) {
        await params.voiceInferenceWorker.stop();
    }

    await params.stopSshTunnelsOnShutdown?.();
    await params.stopControlServer();
    await params.stopKeepAwake();
    // Keep the exact owner publication through cleanup so a stop caller can
    // still verify this process if graceful shutdown outlasts its wait.
    // A self-restart predecessor must preserve its successor's publication.
    if (params.daemonLockHandle && params.daemonStateOwner) {
        const removed = clearDaemonStateForLockOwner(
            params.daemonLockHandle,
            params.daemonStateOwner,
        );
        logger.debug(
            removed
                ? '[DAEMON RUN] Daemon state file removed'
                : '[DAEMON RUN] Daemon state cleanup skipped because lifecycle ownership changed',
        );
    }
    if (params.daemonLockHandle) {
        await params.releaseDaemonLock(params.daemonLockHandle);
    }

    logger.debug('[DAEMON RUN] Cleanup completed, exiting process');
    clearTimeout(shutdownWatchdog);
    process.exit(exitCode);
}
