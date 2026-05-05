import { createSessionScopedSocketCollector, createUserScopedSocketCollector } from '../../socketClient';
import { provisionMachineBoundSessionScopedSocketBinding } from '../../sessionSocketBinding';
import { createSession } from '../../sessions';
import { sleep, waitFor } from '../../timing';
import type { StressConfig } from '../config/stressScenarioSchema';
import { resolveStressSocketTransports } from './stressScenarioRuntime';
import {
    runStressTaskCountWithConcurrencyLimit,
    runStressTasksWithConcurrencyLimit,
} from './runStressTasksWithConcurrencyLimit';
import type { MixedRealisticWorkload } from './mixedRealisticWorkload';
import { resolveMixedSessionPlan } from './mixedRealisticWorkload';
import {
    captureMixedConnectivitySnapshot,
    recordProvisionedCollector,
    resolveMixedAuth,
    resolveMixedControlPlaneBaseUrlForIndex,
    resolveMixedConnectConvergenceTimeoutMs,
    resolveMixedUserDeviceBindings,
    runMixedSocketConnectTasks,
    type MixedCollector,
    type MixedConnectivitySnapshot,
    type MixedProvisionedCollectorIdentity,
    type MixedScenarioAuth,
    type MixedUserDeviceBinding,
    type MixedSessionTarget,
    type MixedUserDevices,
} from './mixedScenarioShared';

export type MixedProvisioningStageName =
    | 'session_create'
    | 'machine_create'
    | 'access_key_create';

export type MixedProvisioningStageSummary = Readonly<{
    completedCount: number;
    failedCount: number;
    totalMs: number;
}>;

export type MixedProvisioningStages = Readonly<Record<
    MixedProvisioningStageName,
    MixedProvisioningStageSummary
>>;

export type MixedScenarioBootstrapProgressStage =
    | 'user_devices'
    | 'machine_collectors'
    | 'provision'
    | 'session_create'
    | 'machine_binding'
    | 'connect_user_devices_materialize'
    | 'connect_user_devices_open'
    | 'connect_machine_collectors'
    | 'connect_wait';

export type MixedScenarioBootstrapProgressSnapshot = Readonly<{
    stage: MixedScenarioBootstrapProgressStage;
    status: 'started' | 'completed' | 'failed' | 'milestone';
    at: string;
    counts: {
        userDeviceGroups: number;
        userScopedSockets: number;
        openedUserScopedSockets: number;
        connectedUserScopedSockets: number;
        sessions: number;
        machineCollectors: number;
        openedMachineCollectors: number;
        connectedMachineCollectors: number;
        verificationSessions: number;
    };
    stageDurationsMs: {
        provisionMs: number;
        connectMs: number;
    };
    error?: string;
}>;

type MutableMixedProvisioningStages = Record<
    MixedProvisioningStageName,
    {
        completedCount: number;
        failedCount: number;
        totalMs: number;
    }
>;

type MixedScenarioBootstrapDeps = Readonly<{
    createSession: typeof createSession;
    provisionMachineBoundSessionScopedSocketBinding: typeof provisionMachineBoundSessionScopedSocketBinding;
    createSessionScopedSocketCollector: typeof createSessionScopedSocketCollector;
    createUserScopedSocketCollector: typeof createUserScopedSocketCollector;
    resolveStressSocketTransports: typeof resolveStressSocketTransports;
    runStressTasksWithConcurrencyLimit: typeof runStressTasksWithConcurrencyLimit;
    runStressTaskCountWithConcurrencyLimit: typeof runStressTaskCountWithConcurrencyLimit;
    resolveMixedConnectConvergenceTimeoutMs: typeof resolveMixedConnectConvergenceTimeoutMs;
    runMixedSocketConnectTasks: typeof runMixedSocketConnectTasks;
    sleep: typeof sleep;
    waitFor: typeof waitFor;
    captureMixedConnectivitySnapshot: typeof captureMixedConnectivitySnapshot;
}>;

const defaultDeps: MixedScenarioBootstrapDeps = {
    createSession,
    provisionMachineBoundSessionScopedSocketBinding,
    createSessionScopedSocketCollector,
    createUserScopedSocketCollector,
    resolveStressSocketTransports,
    runStressTasksWithConcurrencyLimit,
    runStressTaskCountWithConcurrencyLimit,
    resolveMixedConnectConvergenceTimeoutMs,
    runMixedSocketConnectTasks,
    sleep,
    waitFor,
    captureMixedConnectivitySnapshot,
};

export function createEmptyMixedProvisioningStages(): MixedProvisioningStages {
    return {
        session_create: { completedCount: 0, failedCount: 0, totalMs: 0 },
        machine_create: { completedCount: 0, failedCount: 0, totalMs: 0 },
        access_key_create: { completedCount: 0, failedCount: 0, totalMs: 0 },
    };
}

function recordProvisioningStageObservation(
    provisioningStages: MutableMixedProvisioningStages,
    params: Readonly<{
        stage: MixedProvisioningStageName;
        result: 'ok' | 'error';
        durationMs: number;
    }>,
): void {
    const current = provisioningStages[params.stage];
    provisioningStages[params.stage] = {
        completedCount: current.completedCount + (params.result === 'ok' ? 1 : 0),
        failedCount: current.failedCount + (params.result === 'error' ? 1 : 0),
        totalMs: current.totalMs + Math.max(0, params.durationMs),
    };
}

function cloneProvisioningStages(provisioningStages: MutableMixedProvisioningStages): MixedProvisioningStages {
    return {
        session_create: { ...provisioningStages.session_create },
        machine_create: { ...provisioningStages.machine_create },
        access_key_create: { ...provisioningStages.access_key_create },
    };
}

function countMixedUserScopedSockets(userDevices: readonly MixedUserDevices[]): number {
    return userDevices.reduce((sum, userDevice) => sum + userDevice.devices.length, 0);
}

function buildMixedScenarioBootstrapProgressSnapshot(params: {
    stage: MixedScenarioBootstrapProgressStage;
    status: MixedScenarioBootstrapProgressSnapshot['status'];
    userDevices?: readonly MixedUserDevices[];
    userDeviceBindings?: readonly MixedUserDeviceBinding[];
    sessions?: readonly MixedSessionTarget[];
    machineCollectors?: readonly (MixedProvisionedCollectorIdentity | MixedCollector)[];
    verificationSessionIds?: readonly string[];
    openedUserScopedSockets?: number;
    openedMachineCollectors?: number;
    stageDurationsMs?: {
        provisionMs: number;
        connectMs: number;
    };
    error?: string;
}): MixedScenarioBootstrapProgressSnapshot {
    const userDevices = params.userDevices ?? [];
    const userDeviceBindings = params.userDeviceBindings ?? [];
    const resolvedUserDeviceGroupCount = userDevices.length > 0
        ? userDevices.length
        : userDeviceBindings.length;
    const resolvedUserScopedSocketCount = userDevices.length > 0
        ? countMixedUserScopedSockets(userDevices)
        : userDeviceBindings.reduce((sum, binding) => sum + binding.deviceCount, 0);
    const sessions = params.sessions ?? [];
    const machineCollectors = params.machineCollectors ?? [];
    const verificationSessionIds = params.verificationSessionIds ?? [];
    const connectedUserScopedSockets = userDevices.reduce(
        (sum, userDevice) => sum + userDevice.devices.filter((device) => device.isConnected()).length,
        0,
    );
    const connectedMachineCollectors = machineCollectors.reduce(
        (sum, collector) => sum + (
            'socket' in collector
            && collector.socket
            && typeof collector.socket.isConnected === 'function'
            && collector.socket.isConnected()
                ? 1
                : 0
        ),
        0,
    );
    return {
        stage: params.stage,
        status: params.status,
        at: new Date().toISOString(),
        counts: {
            userDeviceGroups: resolvedUserDeviceGroupCount,
            userScopedSockets: resolvedUserScopedSocketCount,
            openedUserScopedSockets: params.openedUserScopedSockets ?? 0,
            connectedUserScopedSockets,
            sessions: sessions.length,
            machineCollectors: machineCollectors.length,
            openedMachineCollectors: params.openedMachineCollectors ?? 0,
            connectedMachineCollectors,
            verificationSessions: verificationSessionIds.length,
        },
        stageDurationsMs: {
            provisionMs: params.stageDurationsMs?.provisionMs ?? 0,
            connectMs: params.stageDurationsMs?.connectMs ?? 0,
        },
        ...(params.error ? { error: params.error } : {}),
    };
}

async function emitMixedScenarioBootstrapProgressSnapshot(params: {
    onProgressSnapshot?: (snapshot: MixedScenarioBootstrapProgressSnapshot) => Promise<void> | void;
    snapshot: MixedScenarioBootstrapProgressSnapshot;
}): Promise<void> {
    await params.onProgressSnapshot?.(params.snapshot);
}

function isMixedProgressMilestoneCount(value: number): boolean {
    return value > 0 && (value & (value - 1)) === 0;
}

function isMixedProgressMilestoneCountAtLeast(value: number, minimum: number): boolean {
    return value >= minimum && isMixedProgressMilestoneCount(value);
}

function isMixedConnectProgressMilestoneCount(value: number): boolean {
    return isMixedProgressMilestoneCountAtLeast(value, 8);
}

type MixedProvisionedCollectorBinding = MixedProvisionedCollectorIdentity & Readonly<{
    baseUrl: string;
}>;

function createMaterializedMixedCollector(params: Readonly<{
    binding: MixedProvisionedCollectorBinding;
    token: string;
    transports: readonly ('websocket' | 'polling')[];
    mixedSocketConnectTimeoutMs: number;
    mixedSocketAutoReconnect: boolean;
    mixedCaptureSocketEvents: boolean;
    createSessionScopedSocketCollector: typeof createSessionScopedSocketCollector;
}>): MixedCollector {
    return {
        sessionId: params.binding.sessionId,
        machineId: params.binding.machineId,
        authIndex: params.binding.authIndex,
        socket: params.createSessionScopedSocketCollector(
            params.binding.baseUrl,
            params.token,
            params.binding.sessionId,
            params.binding.machineId,
            {
                transports: params.transports,
                connectTimeoutMs: params.mixedSocketConnectTimeoutMs,
                autoReconnect: params.mixedSocketAutoReconnect,
                captureEvents: params.mixedCaptureSocketEvents,
            },
        ),
    };
}

function createMaterializedMixedUserDevices(params: Readonly<{
    binding: MixedUserDeviceBinding;
    auths: readonly MixedScenarioAuth[];
    authIndexOffset: number;
    baseUrl: string;
    transports: readonly ('websocket' | 'polling')[];
    mixedSocketConnectTimeoutMs: number;
    mixedSocketAutoReconnect: boolean;
    mixedCaptureSocketEvents: boolean;
    createUserScopedSocketCollector: typeof createUserScopedSocketCollector;
}>): MixedUserDevices {
    const auth = resolveMixedAuth({
        auths: params.auths,
        authIndex: params.binding.authIndex - params.authIndexOffset,
    });

    return {
        authIndex: params.binding.authIndex,
        devices: Array.from({ length: params.binding.deviceCount }, () =>
            params.createUserScopedSocketCollector(params.baseUrl, auth.token, {
                transports: params.transports,
                connectTimeoutMs: params.mixedSocketConnectTimeoutMs,
                autoReconnect: params.mixedSocketAutoReconnect,
                captureEvents: params.mixedCaptureSocketEvents,
            }),
        ),
    };
}

export type MixedScenarioBootstrapResult = Readonly<{
    userDevices: readonly MixedUserDevices[];
    sessions: MixedSessionTarget[];
    machineCollectors: MixedCollector[];
    verificationSessionIds: string[];
    verificationSessionTokensBySessionId: ReadonlyMap<string, string>;
    expectedLocalIdsBySession: Map<string, string[]>;
    provisioningStages: MixedProvisioningStages;
    stageDurationsMs: {
        provisionMs: number;
        connectMs: number;
    };
    connectivitySnapshot?: MixedConnectivitySnapshot;
}>;

export async function runMixedScenarioBootstrap(
    params: Readonly<{
        baseUrl: string;
        controlPlaneBaseUrl?: string;
        controlPlaneBaseUrls?: readonly string[];
        config: StressConfig;
        auths: readonly MixedScenarioAuth[];
        workload: MixedRealisticWorkload;
        authIndexOffset?: number;
        onProgressSnapshot?: (snapshot: MixedScenarioBootstrapProgressSnapshot) => Promise<void> | void;
    }>,
    deps: MixedScenarioBootstrapDeps = defaultDeps,
): Promise<MixedScenarioBootstrapResult> {
    const transports = deps.resolveStressSocketTransports(params.config, params.config.targetMode);
    const mixedSetupConcurrency = params.config.load.mixedSetupConcurrency ?? 8;
    const mixedConnectConcurrency = params.config.load.mixedConnectConcurrency ?? 128;
    const mixedConnectPattern = params.config.load.mixedConnectPattern ?? 'burst';
    const mixedConnectRampStepMs = params.config.load.mixedConnectRampStepMs ?? 0;
    const mixedSocketConnectTimeoutMs = params.config.load.mixedSocketConnectTimeoutMs ?? 60_000;
    const mixedConnectConvergenceTimeoutMs = deps.resolveMixedConnectConvergenceTimeoutMs(params.config);
    const mixedSocketAutoReconnect = params.config.load.mixedSocketAutoReconnect ?? true;
    const mixedCaptureSocketEvents = params.config.load.mixedCaptureSocketEvents ?? true;
    const mixedSetupRequestTimeoutMs = params.config.load.mixedSetupRequestTimeoutMs ?? 15_000;
    const mixedMessageEmitterCount = Math.max(1, params.config.load.mixedMessageEmitterCount ?? 1);
    const authIndexOffset = params.authIndexOffset ?? 0;
    let userDevices: readonly MixedUserDevices[] = [];
    const userDeviceBindings = resolveMixedUserDeviceBindings({
        auths: params.auths,
        mixedMessageEmitterCount,
        authIndexOffset,
    });
    const sessions: MixedSessionTarget[] = [];
    const provisionedMachineCollectors: MixedProvisionedCollectorBinding[] = [];
    const machineCollectors: MixedCollector[] = [];
    const verificationSessionIds: string[] = [];
    const verificationSessionTokensBySessionId = new Map<string, string>();
    const expectedLocalIdsBySession = new Map<string, string[]>();
    const provisioningStages = createEmptyMixedProvisioningStages() as MutableMixedProvisioningStages;
    let connectivitySnapshot: MixedConnectivitySnapshot | undefined;
    const stageDurationsMs = {
        provisionMs: 0,
        connectMs: 0,
    };
    let emittedSessionCreateStarted = false;
    let emittedSessionCreateCompleted = false;
    let emittedMachineBindingStarted = false;
    let emittedMachineBindingCompleted = false;
    const materializedUserDevicesByAuthIndex = new Map<number, MixedUserDevices>();

    const materializeUserDevicesForBinding = (binding: MixedUserDeviceBinding): MixedUserDevices => {
        const existing = materializedUserDevicesByAuthIndex.get(binding.authIndex);
        if (existing) {
            return existing;
        }
        const materialized = createMaterializedMixedUserDevices({
            binding,
            auths: params.auths,
            authIndexOffset,
            baseUrl: params.baseUrl,
            transports,
            mixedSocketConnectTimeoutMs,
            mixedSocketAutoReconnect,
            mixedCaptureSocketEvents,
            createUserScopedSocketCollector: deps.createUserScopedSocketCollector,
        });
        materializedUserDevicesByAuthIndex.set(binding.authIndex, materialized);
        return materialized;
    };

    try {
        await emitMixedScenarioBootstrapProgressSnapshot({
            onProgressSnapshot: params.onProgressSnapshot,
            snapshot: buildMixedScenarioBootstrapProgressSnapshot({
                stage: 'provision',
                status: 'started',
                userDevices,
                sessions,
                machineCollectors,
                verificationSessionIds,
                stageDurationsMs,
            }),
        });
        const provisionStartedAt = Date.now();
        await deps.runStressTasksWithConcurrencyLimit(
            Array.from({ length: params.workload.sessionPlanCount }, (_, index) => index),
            mixedSetupConcurrency,
            async (sessionPlanIndex) => {
                const sessionPlan = resolveMixedSessionPlan(params.workload, sessionPlanIndex);
                const auth = resolveMixedAuth({
                    auths: params.auths,
                    authIndex: sessionPlan.authIndex,
                });
                const controlPlaneBaseUrl = resolveMixedControlPlaneBaseUrlForIndex({
                    baseUrl: params.baseUrl,
                    controlPlaneBaseUrl: params.controlPlaneBaseUrl,
                    controlPlaneBaseUrls: params.controlPlaneBaseUrls,
                    index: authIndexOffset + sessionPlan.authIndex,
                });
                if (!emittedSessionCreateStarted) {
                    emittedSessionCreateStarted = true;
                    await emitMixedScenarioBootstrapProgressSnapshot({
                        onProgressSnapshot: params.onProgressSnapshot,
                        snapshot: buildMixedScenarioBootstrapProgressSnapshot({
                            stage: 'session_create',
                            status: 'started',
                            sessions,
                            machineCollectors,
                            verificationSessionIds,
                            stageDurationsMs,
                        }),
                    });
                }
                const sessionCreateStartedAt = Date.now();
                const { sessionId } = await deps.createSession(controlPlaneBaseUrl, auth.token, {
                    timeoutMs: mixedSetupRequestTimeoutMs,
                }).catch(async (error: unknown) => {
                    recordProvisioningStageObservation(provisioningStages, {
                        stage: 'session_create',
                        result: 'error',
                        durationMs: Date.now() - sessionCreateStartedAt,
                    });
                    if (!emittedSessionCreateCompleted) {
                        emittedSessionCreateCompleted = true;
                        await emitMixedScenarioBootstrapProgressSnapshot({
                            onProgressSnapshot: params.onProgressSnapshot,
                            snapshot: buildMixedScenarioBootstrapProgressSnapshot({
                                stage: 'session_create',
                                status: 'failed',
                                sessions,
                                machineCollectors,
                                verificationSessionIds,
                                stageDurationsMs,
                                error: error instanceof Error ? error.message : String(error),
                            }),
                        });
                    }
                    throw error;
                });
                recordProvisioningStageObservation(provisioningStages, {
                    stage: 'session_create',
                    result: 'ok',
                    durationMs: Date.now() - sessionCreateStartedAt,
                });
                if (!emittedSessionCreateCompleted) {
                    emittedSessionCreateCompleted = true;
                    await emitMixedScenarioBootstrapProgressSnapshot({
                        onProgressSnapshot: params.onProgressSnapshot,
                        snapshot: buildMixedScenarioBootstrapProgressSnapshot({
                            stage: 'session_create',
                            status: 'completed',
                            sessions,
                            machineCollectors,
                            verificationSessionIds,
                            stageDurationsMs,
                        }),
                    });
                }

                if (!emittedMachineBindingStarted) {
                    emittedMachineBindingStarted = true;
                    await emitMixedScenarioBootstrapProgressSnapshot({
                        onProgressSnapshot: params.onProgressSnapshot,
                        snapshot: buildMixedScenarioBootstrapProgressSnapshot({
                            stage: 'machine_binding',
                            status: 'started',
                            sessions,
                            machineCollectors: provisionedMachineCollectors,
                            verificationSessionIds,
                            stageDurationsMs,
                        }),
                    });
                }
                const binding = await deps.provisionMachineBoundSessionScopedSocketBinding({
                    baseUrl: controlPlaneBaseUrl,
                    token: auth.token,
                    sessionId,
                    requestTimeoutMs: mixedSetupRequestTimeoutMs,
                    onProvisioningStage: (observation) => {
                        recordProvisioningStageObservation(provisioningStages, {
                            stage: observation.stage,
                            result: observation.result,
                        durationMs: observation.durationMs,
                        });
                    },
                }).catch(async (error: unknown) => {
                    if (!emittedMachineBindingCompleted) {
                        emittedMachineBindingCompleted = true;
                        await emitMixedScenarioBootstrapProgressSnapshot({
                            onProgressSnapshot: params.onProgressSnapshot,
                            snapshot: buildMixedScenarioBootstrapProgressSnapshot({
                                stage: 'machine_binding',
                                status: 'failed',
                                sessions,
                                machineCollectors: provisionedMachineCollectors,
                                verificationSessionIds,
                                stageDurationsMs,
                                error: error instanceof Error ? error.message : String(error),
                            }),
                        });
                    }
                    throw error;
                });

                const verificationSessionCountBeforeRecord = verificationSessionIds.length;
                recordProvisionedCollector({
                    collector: {
                        sessionId,
                        machineId: binding.machineId,
                        authIndex: authIndexOffset + sessionPlan.authIndex,
                        baseUrl: controlPlaneBaseUrl,
                    },
                    sessions,
                    machineCollectors: provisionedMachineCollectors,
                    verificationSessionIds,
                    expectedLocalIdsBySession,
                    verificationSessionCount: params.workload.verificationSessionCount,
                });
                if (
                    verificationSessionIds.length > verificationSessionCountBeforeRecord
                    && verificationSessionIds[verificationSessionCountBeforeRecord] === sessionId
                ) {
                    verificationSessionTokensBySessionId.set(sessionId, auth.token);
                }
                if (!emittedMachineBindingCompleted) {
                    emittedMachineBindingCompleted = true;
                    await emitMixedScenarioBootstrapProgressSnapshot({
                        onProgressSnapshot: params.onProgressSnapshot,
                        snapshot: buildMixedScenarioBootstrapProgressSnapshot({
                            stage: 'machine_binding',
                            status: 'completed',
                            sessions,
                            machineCollectors: provisionedMachineCollectors,
                            verificationSessionIds,
                            stageDurationsMs,
                        }),
                    });
                }
                if (isMixedProgressMilestoneCount(provisionedMachineCollectors.length)) {
                    await emitMixedScenarioBootstrapProgressSnapshot({
                        onProgressSnapshot: params.onProgressSnapshot,
                        snapshot: buildMixedScenarioBootstrapProgressSnapshot({
                            stage: 'machine_binding',
                            status: 'milestone',
                            sessions,
                            machineCollectors: provisionedMachineCollectors,
                            verificationSessionIds,
                            stageDurationsMs,
                        }),
                    });
                }
            },
        );
        stageDurationsMs.provisionMs = Date.now() - provisionStartedAt;
        await emitMixedScenarioBootstrapProgressSnapshot({
            onProgressSnapshot: params.onProgressSnapshot,
            snapshot: buildMixedScenarioBootstrapProgressSnapshot({
                stage: 'provision',
                status: 'completed',
                sessions,
                machineCollectors: provisionedMachineCollectors,
                verificationSessionIds,
                stageDurationsMs,
            }),
        });

        await emitMixedScenarioBootstrapProgressSnapshot({
            onProgressSnapshot: params.onProgressSnapshot,
            snapshot: buildMixedScenarioBootstrapProgressSnapshot({
                stage: 'machine_collectors',
                status: 'started',
                sessions,
                machineCollectors: provisionedMachineCollectors,
                verificationSessionIds,
                stageDurationsMs,
            }),
        });
        await emitMixedScenarioBootstrapProgressSnapshot({
            onProgressSnapshot: params.onProgressSnapshot,
            snapshot: buildMixedScenarioBootstrapProgressSnapshot({
                stage: 'machine_collectors',
                status: 'completed',
                sessions,
                machineCollectors: provisionedMachineCollectors,
                verificationSessionIds,
                stageDurationsMs,
            }),
        });

        await emitMixedScenarioBootstrapProgressSnapshot({
            onProgressSnapshot: params.onProgressSnapshot,
            snapshot: buildMixedScenarioBootstrapProgressSnapshot({
                stage: 'user_devices',
                status: 'started',
                userDeviceBindings,
                sessions,
                machineCollectors,
                verificationSessionIds,
                stageDurationsMs,
            }),
        });
        try {
            await emitMixedScenarioBootstrapProgressSnapshot({
                onProgressSnapshot: params.onProgressSnapshot,
                snapshot: buildMixedScenarioBootstrapProgressSnapshot({
                    stage: 'user_devices',
                    status: 'completed',
                    userDeviceBindings,
                    sessions,
                    machineCollectors,
                    verificationSessionIds,
                    stageDurationsMs,
                }),
            });
        } catch (error) {
            await emitMixedScenarioBootstrapProgressSnapshot({
                onProgressSnapshot: params.onProgressSnapshot,
                snapshot: buildMixedScenarioBootstrapProgressSnapshot({
                    stage: 'user_devices',
                    status: 'failed',
                    userDeviceBindings,
                    sessions,
                    machineCollectors,
                    verificationSessionIds,
                    stageDurationsMs,
                    error: error instanceof Error ? error.message : String(error),
                }),
            });
            throw error;
        }

        const connectStartedAt = Date.now();
        let openedUserDeviceCount = 0;
        let openedMachineCollectorCount = 0;
        if (params.config.duration.warmupMs > 0) {
            await deps.sleep(params.config.duration.warmupMs);
        }
        await emitMixedScenarioBootstrapProgressSnapshot({
            onProgressSnapshot: params.onProgressSnapshot,
            snapshot: buildMixedScenarioBootstrapProgressSnapshot({
                stage: 'connect_user_devices_materialize',
                status: 'started',
                userDevices,
                machineCollectors,
                verificationSessionIds,
                stageDurationsMs,
            }),
        });
        try {
            const expectedUserDeviceCount = userDeviceBindings
                .reduce((sum, entry) => sum + entry.deviceCount, 0);
            let emittedConnectUserDevicesMaterializeCompleted = false;
            let emittedConnectUserDevicesOpenStarted = false;
            let emittedConnectUserDevicesOpenCompleted = false;
            let emittedConnectMachineCollectorsStarted = false;
            const connectUserDevice = async (plan: Readonly<{
                binding: MixedUserDeviceBinding;
                deviceIndex: number;
            }>): Promise<void> => {
                const didMaterializeBefore = materializedUserDevicesByAuthIndex.has(plan.binding.authIndex);
                const userDevice = materializeUserDevicesForBinding(plan.binding);
                if (
                    !didMaterializeBefore
                    && isMixedConnectProgressMilestoneCount(materializedUserDevicesByAuthIndex.size)
                ) {
                    await emitMixedScenarioBootstrapProgressSnapshot({
                        onProgressSnapshot: params.onProgressSnapshot,
                        snapshot: buildMixedScenarioBootstrapProgressSnapshot({
                            stage: 'connect_user_devices_materialize',
                            status: 'milestone',
                            userDevices: Array.from(materializedUserDevicesByAuthIndex.values()),
                            machineCollectors,
                            openedUserScopedSockets: openedUserDeviceCount,
                            openedMachineCollectors: openedMachineCollectorCount,
                            verificationSessionIds,
                            stageDurationsMs,
                        }),
                    });
                }
                const device = userDevice.devices[plan.deviceIndex];
                if (!device) {
                    throw new Error(
                        `Missing user-scoped socket collector ${plan.deviceIndex} for auth ${plan.binding.authIndex}`,
                    );
                }
                if (!emittedConnectUserDevicesMaterializeCompleted) {
                    const materializedDeviceCount = Array.from(materializedUserDevicesByAuthIndex.values())
                        .reduce((sum, entry) => sum + entry.devices.length, 0);
                    if (materializedDeviceCount >= expectedUserDeviceCount) {
                        emittedConnectUserDevicesMaterializeCompleted = true;
                        await emitMixedScenarioBootstrapProgressSnapshot({
                            onProgressSnapshot: params.onProgressSnapshot,
                            snapshot: buildMixedScenarioBootstrapProgressSnapshot({
                                stage: 'connect_user_devices_materialize',
                                status: 'completed',
                                userDevices: Array.from(materializedUserDevicesByAuthIndex.values()),
                                machineCollectors,
                                openedUserScopedSockets: openedUserDeviceCount,
                                openedMachineCollectors: openedMachineCollectorCount,
                                verificationSessionIds,
                                stageDurationsMs,
                            }),
                        });
                    }
                }
                if (!emittedConnectUserDevicesOpenStarted) {
                    emittedConnectUserDevicesOpenStarted = true;
                    await emitMixedScenarioBootstrapProgressSnapshot({
                        onProgressSnapshot: params.onProgressSnapshot,
                        snapshot: buildMixedScenarioBootstrapProgressSnapshot({
                            stage: 'connect_user_devices_open',
                            status: 'started',
                            userDevices: Array.from(materializedUserDevicesByAuthIndex.values()),
                            machineCollectors,
                            openedUserScopedSockets: openedUserDeviceCount,
                            openedMachineCollectors: openedMachineCollectorCount,
                            verificationSessionIds,
                            stageDurationsMs,
                        }),
                    });
                }
                device.connect();
                openedUserDeviceCount += 1;
                if (isMixedConnectProgressMilestoneCount(openedUserDeviceCount)) {
                    await emitMixedScenarioBootstrapProgressSnapshot({
                        onProgressSnapshot: params.onProgressSnapshot,
                        snapshot: buildMixedScenarioBootstrapProgressSnapshot({
                            stage: 'connect_user_devices_open',
                            status: 'milestone',
                            userDevices: Array.from(materializedUserDevicesByAuthIndex.values()),
                            machineCollectors,
                            openedUserScopedSockets: openedUserDeviceCount,
                            openedMachineCollectors: openedMachineCollectorCount,
                            verificationSessionIds,
                            stageDurationsMs,
                        }),
                    });
                }
                if (!emittedConnectUserDevicesOpenCompleted && openedUserDeviceCount >= expectedUserDeviceCount) {
                    emittedConnectUserDevicesOpenCompleted = true;
                    await emitMixedScenarioBootstrapProgressSnapshot({
                        onProgressSnapshot: params.onProgressSnapshot,
                        snapshot: buildMixedScenarioBootstrapProgressSnapshot({
                            stage: 'connect_user_devices_open',
                            status: 'completed',
                            userDevices: Array.from(materializedUserDevicesByAuthIndex.values()),
                            machineCollectors,
                            openedUserScopedSockets: openedUserDeviceCount,
                            openedMachineCollectors: openedMachineCollectorCount,
                            verificationSessionIds,
                            stageDurationsMs,
                        }),
                    });
                }
                await new Promise<void>((resolve) => setImmediate(resolve));
            };

            const connectMachineCollector = async (
                collectorBinding: MixedProvisionedCollectorBinding,
            ): Promise<void> => {
                if (!emittedConnectMachineCollectorsStarted) {
                    emittedConnectMachineCollectorsStarted = true;
                    await emitMixedScenarioBootstrapProgressSnapshot({
                        onProgressSnapshot: params.onProgressSnapshot,
                        snapshot: buildMixedScenarioBootstrapProgressSnapshot({
                            stage: 'connect_machine_collectors',
                            status: 'started',
                            userDevices: Array.from(materializedUserDevicesByAuthIndex.values()),
                            machineCollectors,
                            openedUserScopedSockets: openedUserDeviceCount,
                            openedMachineCollectors: openedMachineCollectorCount,
                            verificationSessionIds,
                            stageDurationsMs,
                        }),
                    });
                }
                const auth = resolveMixedAuth({
                    auths: params.auths,
                    authIndex: collectorBinding.authIndex - authIndexOffset,
                });
                const collector = createMaterializedMixedCollector({
                    binding: collectorBinding,
                    token: auth.token,
                    transports,
                    mixedSocketConnectTimeoutMs,
                    mixedSocketAutoReconnect,
                    mixedCaptureSocketEvents,
                    createSessionScopedSocketCollector: deps.createSessionScopedSocketCollector,
                });
                machineCollectors.push(collector);
                if (isMixedConnectProgressMilestoneCount(machineCollectors.length)) {
                    await emitMixedScenarioBootstrapProgressSnapshot({
                        onProgressSnapshot: params.onProgressSnapshot,
                        snapshot: buildMixedScenarioBootstrapProgressSnapshot({
                            stage: 'connect_machine_collectors',
                            status: 'milestone',
                            userDevices: Array.from(materializedUserDevicesByAuthIndex.values()),
                            machineCollectors,
                            openedUserScopedSockets: openedUserDeviceCount,
                            openedMachineCollectors: openedMachineCollectorCount,
                            verificationSessionIds,
                            stageDurationsMs,
                        }),
                    });
                }
                collector.socket.connect();
                openedMachineCollectorCount += 1;
                await new Promise<void>((resolve) => setImmediate(resolve));
            };

            const resolveUserDeviceConnectPlan = (connectIndex: number): Readonly<{
                binding: MixedUserDeviceBinding;
                deviceIndex: number;
            }> => {
                let remaining = connectIndex;
                for (const binding of userDeviceBindings) {
                    if (remaining < binding.deviceCount) {
                        return {
                            binding,
                            deviceIndex: remaining,
                        };
                    }
                    remaining -= binding.deviceCount;
                }
                throw new Error(`Missing user-device connect plan at index ${connectIndex}`);
            };

            if (mixedConnectPattern === 'ramped') {
                await deps.runMixedSocketConnectTasks({
                    concurrency: mixedConnectConcurrency,
                    connectPattern: mixedConnectPattern,
                    rampStepMs: mixedConnectRampStepMs,
                    tasks: Array.from({ length: expectedUserDeviceCount }, (_, connectIndex) => async () => {
                        await connectUserDevice(resolveUserDeviceConnectPlan(connectIndex));
                    }),
                });
                await deps.runMixedSocketConnectTasks({
                    concurrency: mixedConnectConcurrency,
                    connectPattern: mixedConnectPattern,
                    rampStepMs: mixedConnectRampStepMs,
                    tasks: provisionedMachineCollectors.map((collectorBinding) => async () => {
                        await connectMachineCollector(collectorBinding);
                    }),
                });
            } else {
                await deps.runStressTaskCountWithConcurrencyLimit(
                    expectedUserDeviceCount,
                    mixedConnectConcurrency,
                    async (connectIndex) => {
                        await connectUserDevice(resolveUserDeviceConnectPlan(connectIndex));
                    },
                );
                await deps.runStressTasksWithConcurrencyLimit(
                    provisionedMachineCollectors,
                    mixedConnectConcurrency,
                    async (collectorBinding) => {
                        await connectMachineCollector(collectorBinding);
                    },
                );
            }

            userDevices = userDeviceBindings.map((binding) => materializeUserDevicesForBinding(binding));
            await emitMixedScenarioBootstrapProgressSnapshot({
                onProgressSnapshot: params.onProgressSnapshot,
                snapshot: buildMixedScenarioBootstrapProgressSnapshot({
                    stage: 'connect_machine_collectors',
                    status: 'completed',
                    userDevices,
                    machineCollectors,
                    openedUserScopedSockets: openedUserDeviceCount,
                    openedMachineCollectors: openedMachineCollectorCount,
                    verificationSessionIds,
                    stageDurationsMs,
                }),
            });
            await emitMixedScenarioBootstrapProgressSnapshot({
                onProgressSnapshot: params.onProgressSnapshot,
                snapshot: buildMixedScenarioBootstrapProgressSnapshot({
                    stage: 'connect_wait',
                    status: 'started',
                    userDevices,
                    machineCollectors,
                    openedUserScopedSockets: openedUserDeviceCount,
                    openedMachineCollectors: openedMachineCollectorCount,
                    verificationSessionIds,
                    stageDurationsMs,
                }),
            });

            await deps.waitFor(
                () =>
                    userDevices.every((userDevice) => userDevice.devices.every((device) => device.isConnected()))
                    && machineCollectors.length === provisionedMachineCollectors.length
                    && machineCollectors.every((collector) => collector.socket.isConnected()),
                { timeoutMs: mixedConnectConvergenceTimeoutMs },
            );
            stageDurationsMs.connectMs = Date.now() - connectStartedAt;
            await emitMixedScenarioBootstrapProgressSnapshot({
                onProgressSnapshot: params.onProgressSnapshot,
                snapshot: buildMixedScenarioBootstrapProgressSnapshot({
                    stage: 'connect_wait',
                    status: 'completed',
                    userDevices,
                    machineCollectors,
                    openedUserScopedSockets: openedUserDeviceCount,
                    openedMachineCollectors: openedMachineCollectorCount,
                    verificationSessionIds,
                    stageDurationsMs,
                }),
            });
        } catch (error) {
            userDevices = Array.from(materializedUserDevicesByAuthIndex.values());
            stageDurationsMs.connectMs = Date.now() - connectStartedAt;
            await emitMixedScenarioBootstrapProgressSnapshot({
                onProgressSnapshot: params.onProgressSnapshot,
                snapshot: buildMixedScenarioBootstrapProgressSnapshot({
                    stage: 'connect_wait',
                    status: 'failed',
                    userDevices,
                    machineCollectors,
                    openedUserScopedSockets: openedUserDeviceCount,
                    openedMachineCollectors: openedMachineCollectorCount,
                    verificationSessionIds,
                    stageDurationsMs,
                    error: error instanceof Error ? error.message : String(error),
                }),
            });
            throw error;
        }
    } catch (error) {
        connectivitySnapshot = deps.captureMixedConnectivitySnapshot({
            userDevices,
            machineCollectors,
        });
        const failure = new Error(error instanceof Error ? error.message : String(error));
        Object.assign(failure, {
            partialResult: {
                userDevices,
                sessions,
                machineCollectors,
                verificationSessionIds,
                verificationSessionTokensBySessionId,
                expectedLocalIdsBySession,
                provisioningStages: cloneProvisioningStages(provisioningStages),
                stageDurationsMs,
                ...(connectivitySnapshot ? { connectivitySnapshot } : {}),
            } satisfies MixedScenarioBootstrapResult,
        });
        throw failure;
    }

    return {
        userDevices,
        sessions,
        machineCollectors,
        verificationSessionIds,
        verificationSessionTokensBySessionId,
        expectedLocalIdsBySession,
        provisioningStages: cloneProvisioningStages(provisioningStages),
        stageDurationsMs,
        ...(connectivitySnapshot ? { connectivitySnapshot } : {}),
    };
}
