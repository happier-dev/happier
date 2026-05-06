import { randomBytes } from 'node:crypto';

import type { ApiMachineClient } from '@/api/apiMachine';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { resolveConcreteBackendTargetRefV2 } from '@/session/backendTargets/resolveConcreteBackendTargetRefs';
import { parseBooleanEnv } from '@happier-dev/protocol';

import { startDaemonControlServer } from '../controlServer';
import { createOnChildExited } from '../sessions/onChildExited';
import { isSessionRunnerActive as isSessionRunnerActiveInDaemon } from '../sessions/isSessionRunnerActive';
import { createStopSession } from '../sessions/stopSession';
import { waitForExistingSessionExitIfStopRequested } from '../sessions/waitForExistingSessionExitIfStopRequested';
import type { TrackedSession } from '../types';
import type {
    SpawnSessionOptions,
    SpawnSessionResult,
} from '@/rpc/handlers/registerSessionHandlers';
import { executeSpawnSessionRequest } from './executeSpawnSessionRequest';
import { createSpawnConcurrencyGate } from '../spawn/createSpawnConcurrencyGate';
import { computeDaemonSpawnRequestKey, createSpawnRequestCoalescer } from '../spawn/spawnRequestCoalescer';
import { resolveExistingSessionSpawnPreGate } from '../spawn/resolveExistingSessionSpawnPreGate';
import { createSessionRunnerRespawnManager } from '../processSupervision/sessionRunnerRespawn';
import type { ConnectedServiceRefreshCoordinator } from '../connectedServices/refresh/ConnectedServiceRefreshCoordinator';
import type { ConnectedServiceQuotasCoordinator } from '../connectedServices/quotas/ConnectedServiceQuotasCoordinator';
import type { SshTunnelSupervisor } from '../ssh/tunnels';

type ShutdownSource = 'happier-app' | 'happier-cli' | 'os-signal' | 'exception';

function resolvePositiveIntEnv(raw: string | undefined, fallback: number, bounds: { min: number; max: number }): number {
    const value = (raw ?? '').trim();
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(bounds.max, Math.max(bounds.min, parsed));
}

export async function startDaemonSessionControlRuntime(
    params: Readonly<{
        machineId: string;
        credentials: NonNullable<Parameters<typeof executeSpawnSessionRequest>[0]['credentials']>;
        api: Parameters<typeof executeSpawnSessionRequest>[0]['api'];
        loadLocalHandoffMetadataByVendorResumeId: Parameters<typeof executeSpawnSessionRequest>[0]['loadLocalHandoffMetadataByVendorResumeId'];
        connectedServicesMaterializationBaseDir: string;
        getConnectedServiceRefreshCoordinator: () => ConnectedServiceRefreshCoordinator | null;
        getConnectedServiceQuotasCoordinator: () => ConnectedServiceQuotasCoordinator | null;
        pidToTrackedSession: Map<number, TrackedSession>;
        pidToAwaiter: Map<number, (session: TrackedSession) => void>;
        pidToSpawnResultResolver: Map<number, (result: SpawnSessionResult) => void>;
        pidToSpawnWebhookTimeout: Map<number, NodeJS.Timeout>;
        getApiMachineForSessions: () => ApiMachineClient | null;
        spawnResourceCleanupByPid: Map<number, () => void>;
        sessionAttachCleanupByPid: Map<number, () => Promise<void>>;
        connectedServicesRestartRequestedPids: Set<number>;
        beforeShutdown: Parameters<typeof startDaemonControlServer>[0]['beforeShutdown'];
        onHappySessionWebhook: Parameters<typeof startDaemonControlServer>[0]['onHappySessionWebhook'];
        sshTunnelSupervisor?: Pick<SshTunnelSupervisor, 'ensureTunnel' | 'listTunnels' | 'probeTunnel' | 'releaseTunnel' | 'stopTunnel'>;
        requestShutdown: (source: ShutdownSource, errorMessage?: string) => void;
        processEnv: NodeJS.ProcessEnv;
    }>,
): Promise<Readonly<{
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    stopSession: (sessionId: string) => Promise<boolean>;
    isSessionAlreadyRunning: (sessionId: string) => Promise<boolean>;
    onChildExited: (pid: number, exit: { reason: string; code: number | null; signal: string | null }) => void;
    controlPort: number;
    controlToken: string;
    stopControlServer: () => Promise<void>;
}>> {
    const spawnConcurrencyGate = createSpawnConcurrencyGate(
        resolvePositiveIntEnv(params.processEnv.HAPPIER_DAEMON_MAX_CONCURRENT_SPAWNS, 0, { min: 0, max: 64 }),
    );
    const spawnRequestCoalescer = createSpawnRequestCoalescer({
        recentSuccessTtlMs: resolvePositiveIntEnv(
            params.processEnv.HAPPIER_DAEMON_SPAWN_RECENT_SUCCESS_TTL_MS,
            2_000,
            { min: 0, max: 60_000 },
        ),
    });
    const isSessionRunnerActive = async (sessionIdRaw: string): Promise<boolean> =>
        await isSessionRunnerActiveInDaemon({
            sessionId: sessionIdRaw,
            trackedSessions: params.pidToTrackedSession.values(),
        });
    const resolveCanonicalTrackedSessionId = (pid: number): string => {
        const session = params.pidToTrackedSession.get(pid);
        const sessionId = typeof session?.happySessionId === 'string' ? session.happySessionId.trim() : '';
        if (!sessionId || /^PID-\d+$/.test(sessionId)) {
            return '';
        }
        return sessionId;
    };

    let onChildExited: (pid: number, exit: { reason: string; code: number | null; signal: string | null }) => void = () => {};

    const spawnSession = async (options: SpawnSessionOptions): Promise<SpawnSessionResult> => {
        try {
            const key = computeDaemonSpawnRequestKey(options);
            return await spawnRequestCoalescer.run(key, async () => {
                const existingSessionPreGate = await resolveExistingSessionSpawnPreGate({
                    existingSessionId: options.existingSessionId,
                    pidToTrackedSession: params.pidToTrackedSession,
                    isSessionRunnerActive,
                    waitForExitTimeoutMs: configuration.daemonSpawnExistingSessionWaitForExitMs,
                    waitForExitPollIntervalMs: configuration.daemonSpawnExistingSessionWaitForExitPollIntervalMs,
                    logDebug: (message, payload) => logger.debug(message, payload),
                });
                if (existingSessionPreGate.shortCircuitResult) {
                    return existingSessionPreGate.shortCircuitResult;
                }

                return await spawnConcurrencyGate.run(async () =>
                    await executeSpawnSessionRequest({
                        options,
                        credentials: params.credentials,
                        api: params.api,
                        loadLocalHandoffMetadataByVendorResumeId: params.loadLocalHandoffMetadataByVendorResumeId,
                        connectedServicesMaterializationBaseDir: params.connectedServicesMaterializationBaseDir,
                        connectedServiceRefreshCoordinator: params.getConnectedServiceRefreshCoordinator(),
                        connectedServiceQuotasCoordinator: params.getConnectedServiceQuotasCoordinator(),
                        pidToTrackedSession: params.pidToTrackedSession,
                        pidToAwaiter: params.pidToAwaiter,
                        pidToSpawnResultResolver: params.pidToSpawnResultResolver,
                        pidToSpawnWebhookTimeout: params.pidToSpawnWebhookTimeout,
                        resolveCanonicalTrackedSessionId,
                        onChildExited,
                        spawnResourceCleanupByPid: params.spawnResourceCleanupByPid,
                        sessionAttachCleanupByPid: params.sessionAttachCleanupByPid,
                        processEnv: params.processEnv,
                    }),
                );
            });
        } catch (error) {
            logger.warn('[DAEMON RUN] Failed before spawn session work started', {
                error,
                hasExistingSessionId: typeof options.existingSessionId === 'string' && options.existingSessionId.trim().length > 0,
                hasResume: typeof options.resume === 'string' && options.resume.trim().length > 0,
                backendTargetKind: resolveConcreteBackendTargetRefV2(options.backendTarget)?.kind ?? null,
            });
            throw error;
        }
    };

    const stopSessionCore = createStopSession({ pidToTrackedSession: params.pidToTrackedSession });
    const sessionRunnerRespawnManager = createSessionRunnerRespawnManager({
        enabled: parseBooleanEnv(params.processEnv.HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED, false),
        maxRestarts: (() => {
            const maxAttempts = resolvePositiveIntEnv(
                params.processEnv.HAPPIER_DAEMON_SESSION_RESPAWN_MAX_ATTEMPTS,
                10,
                { min: 0, max: 100 },
            );
            return maxAttempts === 0 ? null : maxAttempts;
        })(),
        baseDelayMs: resolvePositiveIntEnv(
            params.processEnv.HAPPIER_DAEMON_SESSION_RESPAWN_BASE_DELAY_MS,
            1_000,
            { min: 50, max: 5 * 60_000 },
        ),
        maxDelayMs: resolvePositiveIntEnv(
            params.processEnv.HAPPIER_DAEMON_SESSION_RESPAWN_MAX_DELAY_MS,
            60_000,
            { min: 50, max: 30 * 60_000 },
        ),
        jitterMs: resolvePositiveIntEnv(
            params.processEnv.HAPPIER_DAEMON_SESSION_RESPAWN_JITTER_MS,
            250,
            { min: 0, max: 10_000 },
        ),
        isSessionAlreadyRunning: async (sessionId) => await isSessionRunnerActive(sessionId),
        spawnSession,
        random: () => Math.random(),
        logDebug: (message, payload) => logger.debug(message, payload),
        logWarn: (message) => logger.warn(message),
    });
    const onChildExitedBase = createOnChildExited({
        pidToTrackedSession: params.pidToTrackedSession,
        spawnResourceCleanupByPid: params.spawnResourceCleanupByPid,
        sessionAttachCleanupByPid: params.sessionAttachCleanupByPid,
        getApiMachineForSessions: params.getApiMachineForSessions,
        onUnexpectedExit: sessionRunnerRespawnManager.handleUnexpectedExit,
        isExitUnexpectedOverride: (tracked) => {
            if (!params.connectedServicesRestartRequestedPids.has(tracked.pid)) return null;
            params.connectedServicesRestartRequestedPids.delete(tracked.pid);
            return true;
        },
    });
    onChildExited = (pid, exit) => {
        params.getConnectedServiceRefreshCoordinator()?.unregisterPid(pid);
        params.getConnectedServiceQuotasCoordinator()?.unregisterPid(pid);
        onChildExitedBase(pid, exit);
    };
    const stopSession = async (sessionId: string): Promise<boolean> => {
        sessionRunnerRespawnManager.markStopRequested(sessionId, { reason: 'daemon_stop_session', requestedAtMs: Date.now() });
        const stopped = await stopSessionCore(sessionId);
        if (!stopped) return false;
        if (configuration.daemonStopSessionWaitForExitMs > 0) {
            await waitForExistingSessionExitIfStopRequested({
                sessionId,
                pidToTrackedSession: params.pidToTrackedSession,
                isSessionRunnerActive,
                timeoutMs: configuration.daemonStopSessionWaitForExitMs,
                pollIntervalMs: configuration.daemonStopSessionWaitForExitPollIntervalMs,
                onExitObserved: (pid, exit) => onChildExited(pid, exit),
            });
        }
        return true;
    };
    const isSessionAlreadyRunning = async (sessionId: string): Promise<boolean> =>
        await isSessionRunnerActive(sessionId);
    const controlToken = randomBytes(32).toString('base64url');
    const { port: controlPort, stop: stopControlServer } = await startDaemonControlServer({
        getChildren: () => Array.from(params.pidToTrackedSession.values()),
        machineId: params.machineId,
        stopSession,
        spawnSession,
        requestShutdown: () => params.requestShutdown('happier-cli'),
        beforeShutdown: params.beforeShutdown,
        onHappySessionWebhook: params.onHappySessionWebhook,
        ...(params.sshTunnelSupervisor ? { sshTunnels: params.sshTunnelSupervisor } : {}),
        controlToken,
    });

    return {
        spawnSession,
        stopSession,
        isSessionAlreadyRunning,
        onChildExited,
        controlPort,
        controlToken,
        stopControlServer,
    };
}
