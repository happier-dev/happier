import {
    spawn as nodeSpawn,
    type ChildProcess,
    type SpawnOptions,
} from 'node:child_process';
import { basename } from 'node:path';

import type {
    IosSimulatorAdapterHealthV1,
} from '@happier-dev/protocol';

import { defaultSimulatorToolRunner, type SimulatorToolRunner } from '../process';
import { createIosSimulatorUnavailableHealth } from './diagnostics';
import { PINNED_IOS_SIMULATOR_HELPER_ARTIFACT } from './discovery';
import {
    resolveIosSimulatorHelperArtifact,
    type IosSimulatorHelperArtifactResolution,
} from './helperArtifact';
import {
    probeIosSimulatorHelperHealth,
    type IosSimulatorHelperProbeRunner,
} from './helperProbe';

const DEFAULT_HELPER_PROCESS_ARGS = ['--daemon-json'] as const;
const FORBIDDEN_HELPER_PROCESS_NAMES = new Set(['node', 'npm', 'npx', 'pnpm', 'yarn', 'bunx']);

type MaybePromise<T> = T | Promise<T>;

export type IosSimulatorHelperArtifact = Readonly<{
    path: string;
    version: string;
    digest: string;
}>;

export type IosSimulatorHelperProcessExit = Readonly<{
    exitCode: number | null;
    signal: string | null;
}>;

export type IosSimulatorHelperProcess = Readonly<{
    pid?: number;
    exited?: Promise<IosSimulatorHelperProcessExit>;
    stop: () => MaybePromise<void>;
}>;

export type IosSimulatorHelperProcessStartInput = Readonly<{
    helperPath: string;
    args: readonly string[];
}>;

export type IosSimulatorHelperProcessStarter = (
    input: IosSimulatorHelperProcessStartInput,
) => Promise<IosSimulatorHelperProcess> | IosSimulatorHelperProcess;

export type IosSimulatorHelperSpawnedChild = Pick<
    ChildProcess,
    'killed' | 'kill' | 'once' | 'pid'
>;

export type IosSimulatorHelperSpawn = (
    command: string,
    args: readonly string[],
    options: SpawnOptions & Readonly<{ shell: false; windowsHide: true }>,
) => IosSimulatorHelperSpawnedChild;

export type IosSimulatorHelperReadyStatus = Readonly<{
    ready: true;
    helper: IosSimulatorHelperArtifact;
    health: Extract<IosSimulatorAdapterHealthV1, { status: 'available' }>;
    process: IosSimulatorHelperProcess;
}>;

export type IosSimulatorHelperUnavailableStatus = Readonly<{
    ready: false;
    helper?: IosSimulatorHelperArtifact;
    health: Extract<IosSimulatorAdapterHealthV1, { status: 'unavailable' }>;
}>;

export type IosSimulatorHelperLifecycleStatus =
    | IosSimulatorHelperReadyStatus
    | IosSimulatorHelperUnavailableStatus;

export type CreateIosSimulatorHelperProcessStarterInput = Readonly<{
    spawn?: IosSimulatorHelperSpawn;
}>;

export type CreateIosSimulatorHelperLifecycleInput = Readonly<{
    expectedHelperVersion?: string;
    expectedHelperDigest?: string;
    resolveHelperArtifact?: () => MaybePromise<IosSimulatorHelperArtifactResolution>;
    probeHelperHealth?: (input: Readonly<{
        helperPath: string;
        runHelper?: IosSimulatorHelperProbeRunner;
    }>) => MaybePromise<IosSimulatorAdapterHealthV1>;
    runHelper?: IosSimulatorHelperProbeRunner;
    startHelper?: IosSimulatorHelperProcessStarter;
    helperArgs?: readonly string[];
    timeoutMs?: number;
}>;

export type IosSimulatorHelperLifecycle = Readonly<{
    start: () => Promise<IosSimulatorHelperLifecycleStatus>;
    health: () => Promise<IosSimulatorAdapterHealthV1>;
    stop: () => Promise<void>;
}>;

function unavailableHealth(
    code: string,
    details: Record<string, unknown> = {},
): Extract<IosSimulatorAdapterHealthV1, { status: 'unavailable' }> {
    return createIosSimulatorUnavailableHealth({
        reasonCode: 'ios_private_helper_unavailable',
        diagnostics: [{
            code,
            ...details,
        }],
    }) as Extract<IosSimulatorAdapterHealthV1, { status: 'unavailable' }>;
}

function artifactUnavailableHealth(
    artifact: Extract<IosSimulatorHelperArtifactResolution, { ok: false }>,
): Extract<IosSimulatorAdapterHealthV1, { status: 'unavailable' }> {
    return createIosSimulatorUnavailableHealth({
        reasonCode: artifact.reasonCode,
        diagnostics: artifact.diagnostics,
    }) as Extract<IosSimulatorAdapterHealthV1, { status: 'unavailable' }>;
}

function errorName(error: unknown): string {
    return error instanceof Error ? error.name : 'UnknownError';
}

function helperFromArtifact(
    artifact: Extract<IosSimulatorHelperArtifactResolution, { ok: true }>,
): IosSimulatorHelperArtifact {
    return {
        path: artifact.path,
        version: artifact.version,
        digest: artifact.digest,
    };
}

function createDefaultHelperRunner(runner: SimulatorToolRunner): IosSimulatorHelperProbeRunner {
    return async (input) => await runner({
        command: input.helperPath,
        args: input.args,
        timeoutMs: input.timeoutMs,
    });
}

function isForbiddenHelperProcessPath(path: string): boolean {
    return FORBIDDEN_HELPER_PROCESS_NAMES.has(basename(path));
}

export function createIosSimulatorHelperProcessStarter(
    input: CreateIosSimulatorHelperProcessStarterInput = {},
): IosSimulatorHelperProcessStarter {
    const spawn = input.spawn ?? nodeSpawn;
    return (startInput) => {
        if (isForbiddenHelperProcessPath(startInput.helperPath)) {
            throw Object.assign(new Error('Refusing to start helper through a Node/package-manager runtime'), {
                code: 'FORBIDDEN_HELPER_RUNTIME',
            });
        }

        const child = spawn(startInput.helperPath, [...startInput.args], {
            stdio: 'ignore',
            windowsHide: true,
            shell: false,
        });
        const exited = new Promise<IosSimulatorHelperProcessExit>((resolve) => {
            child.once('exit', (exitCode: number | null, signal: string | null) => {
                resolve({ exitCode, signal });
            });
        });

        return Object.freeze({
            ...(typeof child.pid === 'number' ? { pid: child.pid } : {}),
            exited,
            stop: async () => {
                if (!child.killed) child.kill('SIGTERM');
            },
        });
    };
}

export function createIosSimulatorHelperLifecycle(
    input: CreateIosSimulatorHelperLifecycleInput = {},
): IosSimulatorHelperLifecycle {
    const runHelper = input.runHelper ?? createDefaultHelperRunner(defaultSimulatorToolRunner);
    const resolveHelperArtifact = input.resolveHelperArtifact ?? (async () => await resolveIosSimulatorHelperArtifact({
        expectedVersion: input.expectedHelperVersion ?? PINNED_IOS_SIMULATOR_HELPER_ARTIFACT.version,
        expectedDigest: input.expectedHelperDigest ?? PINNED_IOS_SIMULATOR_HELPER_ARTIFACT.digest,
    }));
    const probeHelperHealth = input.probeHelperHealth ?? (async ({ helperPath }) => await probeIosSimulatorHelperHealth({
        helperPath,
        runHelper,
        timeoutMs: input.timeoutMs,
    }));
    const startHelper = input.startHelper ?? createIosSimulatorHelperProcessStarter();
    const helperArgs = input.helperArgs ?? DEFAULT_HELPER_PROCESS_ARGS;

    let currentStatus: IosSimulatorHelperLifecycleStatus | null = null;
    let startPromise: Promise<IosSimulatorHelperLifecycleStatus> | null = null;
    let stopPromise: Promise<void> | null = null;

    const setUnavailable = (
        health: Extract<IosSimulatorAdapterHealthV1, { status: 'unavailable' }>,
        helper?: IosSimulatorHelperArtifact,
    ): IosSimulatorHelperUnavailableStatus => {
        const status: IosSimulatorHelperUnavailableStatus = helper
            ? { ready: false, helper, health }
            : { ready: false, health };
        currentStatus = status;
        return status;
    };

    const attachExitSupervisor = (
        helper: IosSimulatorHelperArtifact,
        processHandle: IosSimulatorHelperProcess,
    ): void => {
        if (!processHandle.exited) return;
        void processHandle.exited.then((exit) => {
            if (currentStatus?.ready !== true || currentStatus.process !== processHandle) return;
            setUnavailable(unavailableHealth('helper_process_exited', {
                exitCode: exit.exitCode,
                signal: exit.signal,
            }), helper);
        }).catch((error: unknown) => {
            if (currentStatus?.ready !== true || currentStatus.process !== processHandle) return;
            setUnavailable(unavailableHealth('helper_process_exit_watch_failed', {
                errorName: errorName(error),
            }), helper);
        });
    };

    const startOnce = async (): Promise<IosSimulatorHelperLifecycleStatus> => {
        const artifact = await resolveHelperArtifact();
        if (!artifact.ok) return setUnavailable(artifactUnavailableHealth(artifact));

        const helper = helperFromArtifact(artifact);
        const health = await probeHelperHealth({ helperPath: helper.path, runHelper });
        if (health.status !== 'available') return setUnavailable(health, helper);

        let processHandle: IosSimulatorHelperProcess;
        try {
            processHandle = await startHelper({
                helperPath: helper.path,
                args: helperArgs,
            });
        } catch (error) {
            return setUnavailable(unavailableHealth('helper_process_start_failed', {
                errorName: errorName(error),
            }), helper);
        }

        const status: IosSimulatorHelperReadyStatus = {
            ready: true,
            helper,
            health,
            process: processHandle,
        };
        currentStatus = status;
        stopPromise = null;
        attachExitSupervisor(helper, processHandle);
        return status;
    };

    return Object.freeze({
        start: async () => {
            if (currentStatus?.ready === true) return currentStatus;
            if (startPromise) return await startPromise;
            startPromise = startOnce().finally(() => {
                startPromise = null;
            });
            return await startPromise;
        },
        health: async () => currentStatus?.health ?? unavailableHealth('helper_lifecycle_not_started'),
        stop: async () => {
            if (currentStatus?.ready !== true) return;
            const readyStatus = currentStatus;
            stopPromise ??= Promise.resolve(readyStatus.process.stop())
                .catch((error: unknown) => {
                    setUnavailable(unavailableHealth('helper_process_stop_failed', {
                        errorName: errorName(error),
                    }), readyStatus.helper);
                })
                .then(() => {
                    if (currentStatus?.ready === true && currentStatus.process === readyStatus.process) {
                        setUnavailable(unavailableHealth('helper_process_stopped'), readyStatus.helper);
                    }
                });
            await stopPromise;
        },
    });
}
