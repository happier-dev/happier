import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';
import type { ApiClient } from '@/api/api';
import type { MachineMetadata } from '@/api/types';
import type { ConnectedServiceQuotasLoopHandle } from '../connectedServices/quotas/startConnectedServiceQuotasLoop';
import { startDaemonMachineRegistration } from '../machine/startDaemonMachineRegistration';

type ResolvePositiveIntEnv = (
    raw: string | undefined,
    fallback: number,
    bounds: { min: number; max: number },
) => number;

export function startDaemonMachineRegistrationRuntime(
    params: Readonly<{
        api: ApiClient;
        metadataForRegistration: MachineMetadata;
        initialDaemonState: Parameters<typeof startDaemonMachineRegistration>[0]['initialDaemonState'];
        processEnv: NodeJS.ProcessEnv;
        resolvePositiveIntEnv: ResolvePositiveIntEnv;
        resolvesWhenShutdownRequested: Promise<unknown>;
        initialPreflightMachineRegistration: Parameters<typeof startDaemonMachineRegistration>[0]['initialPreflightMachineRegistration'];
        resolveMachineId: () => string;
        setMachineId: (resolvedMachineId: string) => void;
        isShuttingDown: () => boolean;
        bootstrapRuntime: Omit<
            Parameters<typeof startDaemonMachineRegistration>[0]['bootstrapRuntime'],
            | 'preferredHost'
            | 'happyHomeDir'
            | 'happyLibDir'
            | 'filesystemAccessPolicy'
            | 'takeoverRequested'
            | 'connectedServiceRefreshLoopHandle'
            | 'connectedServiceQuotasLoopHandle'
        >;
        onMachineSyncRuntime: Parameters<typeof startDaemonMachineRegistration>[0]['onMachineSyncRuntime'];
        filesystemAccessPolicy: Parameters<typeof startDaemonMachineRegistration>[0]['bootstrapRuntime']['filesystemAccessPolicy'];
        takeoverRequested: boolean;
        preferredHost: string;
        connectedServiceRefreshLoopHandle: Readonly<{
            stop: () => void;
            pause: () => void;
            resume: () => void;
        }> | null;
        connectedServiceQuotasLoopHandle: ConnectedServiceQuotasLoopHandle | null;
    }>,
): void {
    const machineRegistrationTimeoutMs = params.resolvePositiveIntEnv(
        params.processEnv.HAPPIER_DAEMON_MACHINE_REGISTRATION_TIMEOUT_MS,
        10_000,
        { min: 250, max: 120_000 },
    );
    const machineRegistrationRetryBaseDelayMs = params.resolvePositiveIntEnv(
        params.processEnv.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_BASE_DELAY_MS
            ?? params.processEnv.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_DELAY_MS,
        10_000,
        { min: 0, max: 5 * 60_000 },
    );
    const machineRegistrationRetryMaxDelayMs = params.resolvePositiveIntEnv(
        params.processEnv.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_MAX_DELAY_MS,
        5 * 60_000,
        { min: 0, max: 30 * 60_000 },
    );
    const machineRegistrationRetryJitterMs = params.resolvePositiveIntEnv(
        params.processEnv.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_JITTER_MS,
        1_000,
        { min: 0, max: 60_000 },
    );
    const machineRegistrationRetryEffectiveMaxDelayMs = Math.max(
        machineRegistrationRetryBaseDelayMs,
        machineRegistrationRetryMaxDelayMs,
    );
    const machineRegistrationMaxAttempts = params.resolvePositiveIntEnv(
        params.processEnv.HAPPIER_DAEMON_MACHINE_REGISTRATION_MAX_ATTEMPTS,
        0,
        { min: 0, max: 10_000 },
    );

    startDaemonMachineRegistration({
        api: params.api,
        metadataForRegistration: params.metadataForRegistration,
        initialDaemonState: params.initialDaemonState,
        machineRegistrationTimeoutMs,
        machineRegistrationRetryBaseDelayMs,
        machineRegistrationRetryMaxDelayMs: machineRegistrationRetryEffectiveMaxDelayMs,
        machineRegistrationRetryJitterMs,
        machineRegistrationMaxAttempts,
        resolvesWhenShutdownRequested: params.resolvesWhenShutdownRequested,
        initialPreflightMachineRegistration: params.initialPreflightMachineRegistration,
        resolveMachineId: params.resolveMachineId,
        setMachineId: params.setMachineId,
        isShuttingDown: params.isShuttingDown,
        bootstrapRuntime: {
            ...params.bootstrapRuntime,
            preferredHost: params.preferredHost,
            happyHomeDir: configuration.happyHomeDir,
            happyLibDir: projectPath(),
            filesystemAccessPolicy: params.filesystemAccessPolicy,
            takeoverRequested: params.takeoverRequested,
            connectedServiceRefreshLoopHandle: params.connectedServiceRefreshLoopHandle,
            connectedServiceQuotasLoopHandle: params.connectedServiceQuotasLoopHandle,
        },
        onMachineSyncRuntime: params.onMachineSyncRuntime,
    });
}
