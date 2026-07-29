import type { Metadata } from '@/api/types';
import { buildHappyCliSubprocessLaunchSpec, type HappyCliSubprocessLaunchOptions } from '@/utils/spawnHappyCLI';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionOptions, type SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { writeTerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';

import { startHappySessionInVisibleWindowsConsole } from '../platform/windows/spawnHappyCliVisibleConsole';
import { startHappySessionInWindowsTerminal } from '../platform/windows/spawnHappyCliWindowsTerminal';
import {
    cancelWindowsTerminalLaunch,
    type WindowsProcessCustodyDependencies,
    type WindowsTerminalLaunchCustody,
} from '../platform/windows/windowsProcessCustody';
import {
    buildWindowsHostedTerminalArgs,
    buildWindowsHostedTerminalAttachment,
    buildWindowsTerminalWindowIdentity,
    resolveWindowsTerminalWindowName,
} from '../platform/windows/windowsHostedSessionRuntime';
import type { ChildExit } from '../sessions/onChildExited';
import { resolveSpawnWebhookResult } from '../sessions/resolveSpawnWebhookResult';
import { waitForVisibleConsoleSessionWebhook } from '../sessions/visibleConsoleSpawnWaiter';
import { waitForSessionWebhook } from './waitForSessionWebhook';
import type { TrackedSession } from '../types';
import type { PluginLocalServicesBridgeAuthorization } from '../local/services/pluginBridgeAuthorization';
import type { AgentRuntimeSessionBridgeAuthorization } from '../agentRuntime/sessionBridgeAuthorization';
import type { SpawnLifecycleCallbacks } from './createSpawnLifecycleCallbacks';
import { buildSpawnChildProcessEnv } from './buildSpawnChildProcessEnv';
import type { SpawnCommitRevalidation } from './spawnCommitRevalidation';
import {
    completeStartupCancellationCleanup,
    resolveSpawnErrorAfterStartupCancellation,
    type CancelStartupLaunch,
} from './startupLaunchCancellation';
import {
    resolveDaemonStartedSessionReportRetryPolicy,
} from './sessionWebhookTimeoutPolicy';

export async function spawnWindowsHostedSessionAndWaitForWebhook(params: Readonly<{
    windowsLaunchMode: 'windows_terminal' | 'console';
    args: readonly string[];
    agentCommand: string;
    directory: string;
    options: SpawnSessionOptions;
    trackedSpawnOptions: SpawnSessionOptions;
    normalizedExistingSessionId: string;
    effectiveResume: string;
    reservedSessionId?: string;
    directoryCreated: boolean;
    extraEnvForChildWithMessage: Record<string, string>;
    unsetEnvKeys?: readonly string[];
    localServicesBridgeAuthorization: PluginLocalServicesBridgeAuthorization;
    agentRuntimeSessionBridgeAuthorization?: AgentRuntimeSessionBridgeAuthorization | null;
    processEnv: NodeJS.ProcessEnv;
    happyHomeDir: string;
    pidToTrackedSession: Map<number, TrackedSession>;
    pidToAwaiter: Map<number, (session: TrackedSession) => void>;
    pidToSpawnResultResolver: Map<number, (result: SpawnSessionResult) => void>;
    pidToSpawnWebhookTimeout: Map<number, NodeJS.Timeout>;
    resolveCanonicalTrackedSessionId: (pid: number) => string;
    onChildExited: (pid: number, exit: ChildExit) => void | Promise<void>;
    spawnLifecycleCallbacks: SpawnLifecycleCallbacks;
    cleanupSpawnResources: () => void | Promise<void>;
    logDebug: (message: string, payload?: unknown) => void;
    warn: (message: string) => void;
    sanitizeDiagnosticText?: (value: string) => string;
    revalidateBeforeCommit?: SpawnCommitRevalidation;
    runnerLaunchOptions?: HappyCliSubprocessLaunchOptions;
    windowsProcessCustodyDependencies?: WindowsProcessCustodyDependencies;
}>): Promise<SpawnSessionResult> {
    const sanitizeDiagnosticText = params.sanitizeDiagnosticText ?? ((value: string) => value);
    const buildWindowsHostedLaunchEnv = (launchSpec: ReturnType<typeof buildHappyCliSubprocessLaunchSpec>) => buildSpawnChildProcessEnv({
        processEnv: params.processEnv,
        extraEnv: {
            ...params.extraEnvForChildWithMessage,
            ...(launchSpec.env ?? {}),
        },
        unsetEnvKeys: params.unsetEnvKeys,
    });

    const waitForWindowsHostedSession = async (waitParams: {
        pid: number;
        logLabel: string;
        terminal: NonNullable<Metadata['terminal']>;
    cancelStartupLaunch: (
            trackedSession: TrackedSession,
        ) => ReturnType<CancelStartupLaunch>;
        windowsTerminalLaunchCustody?: WindowsTerminalLaunchCustody;
    }): Promise<SpawnSessionResult> => {
        let resolveAcceptedSpawnMarker!: (accepted: boolean) => void;
        const acceptedSpawnMarkerGate = new Promise<boolean>((resolve) => {
            resolveAcceptedSpawnMarker = resolve;
        });
        const trackedSession: TrackedSession = {
            startedBy: 'daemon',
            happySessionId:
                params.normalizedExistingSessionId
                || `PID-${waitParams.pid}`,
            pid: waitParams.pid,
            spawnOptions: params.trackedSpawnOptions,
            acceptedSpawnMarkerGate,
            hostedTerminal: waitParams.terminal,
            ...(waitParams.windowsTerminalLaunchCustody
                ? {
                    windowsTerminalLaunchCustody:
                        waitParams.windowsTerminalLaunchCustody,
                }
                : {}),
            localServicesBridgeTokenHash: params.localServicesBridgeAuthorization.tokenHash,
            localServicesBridgePluginId: params.localServicesBridgeAuthorization.pluginId,
            localServicesBridgeContributionId: params.localServicesBridgeAuthorization.contributionId,
            localServicesBridgeTokenFilePath: params.localServicesBridgeAuthorization.tokenFilePath,
            ...(params.agentRuntimeSessionBridgeAuthorization ? {
                agentRuntimeBridgeTokenHash: params.agentRuntimeSessionBridgeAuthorization.tokenHash,
                agentRuntimeBridgePluginId:
                    params.agentRuntimeSessionBridgeAuthorization.descriptor.pluginId,
                agentRuntimeBridgeAgentId:
                    params.agentRuntimeSessionBridgeAuthorization.descriptor.agentId,
                agentRuntimeBridgeBackendId:
                    params.agentRuntimeSessionBridgeAuthorization.descriptor.backendId,
                agentRuntimeBridgeGeneration:
                    params.agentRuntimeSessionBridgeAuthorization.descriptor.generation,
            } : {}),
            vendorResumeId: params.effectiveResume || undefined,
            directoryCreated: params.directoryCreated,
            message: params.directoryCreated
                ? `The path '${params.directory}' did not exist. We created a new folder and spawned a new session there.`
                : undefined,
        };
        let windowsTerminalMarkerWork:
            Promise<void> | null = null;
        let acceptedTargetMarkerOwnership:
            Readonly<{
                pid: number;
                happySessionId: string;
                processStartTimeMs: number;
                processCommandHash: string;
            }>
            | null = null;
        let startupLaunchCancellation:
            ReturnType<CancelStartupLaunch> | null = null;
        const cancelStartupLaunch: CancelStartupLaunch = () => {
            startupLaunchCancellation ??= (async () => {
                let resourceCleanupFailed = false;
                let markerCleanupFailed = false;
                if (windowsTerminalMarkerWork) {
                    try {
                        await windowsTerminalMarkerWork;
                    } catch {
                        // A marker writer can commit before reporting failure.
                        // Exact removal below remains required.
                    }
                }
                try {
                    await params.cleanupSpawnResources();
                } catch {
                    resourceCleanupFailed = true;
                }
                const launchCancellation =
                    await waitParams.cancelStartupLaunch(
                        trackedSession,
                    );
                if (launchCancellation.status !== 'stopped') {
                    return launchCancellation;
                }
                if (acceptedTargetMarkerOwnership) {
                    try {
                        await params.spawnLifecycleCallbacks
                            .removeAcceptedSpawnMarkerIfOwned({
                                ...acceptedTargetMarkerOwnership,
                                isStillOwned: () =>
                                    [
                                        ...params
                                            .pidToTrackedSession
                                            .values(),
                                    ].includes(
                                        trackedSession,
                                    ),
                            });
                    } catch {
                        markerCleanupFailed = true;
                    }
                }
                const trackedCleanup =
                    await completeStartupCancellationCleanup({
                    trackedSession,
                    pidToTrackedSession: params.pidToTrackedSession,
                    onChildExited: params.onChildExited,
                });
                if (trackedCleanup.status !== 'stopped') {
                    return trackedCleanup;
                }
                return (
                    resourceCleanupFailed
                    || markerCleanupFailed
                )
                    ? {
                        status: 'incomplete' as const,
                        reason:
                            'exit_cleanup_incomplete' as const,
                    }
                    : trackedCleanup;
            })();
            return startupLaunchCancellation;
        };
        trackedSession.cancelStartupLaunchBeforeAck =
            cancelStartupLaunch;
        params.pidToTrackedSession.set(waitParams.pid, trackedSession);
        let acceptedSpawnMarkerPromise: Promise<void>;
        let settleUnstartedWindowsTerminalMarker:
            (() => void) | null = null;
        if (waitParams.windowsTerminalLaunchCustody) {
            let resolveMarker!: () => void;
            let rejectMarker!: (error: unknown) => void;
            acceptedSpawnMarkerPromise =
                new Promise<void>((resolve, reject) => {
                    resolveMarker = resolve;
                    rejectMarker = reject;
                });
            settleUnstartedWindowsTerminalMarker =
                resolveMarker;
            trackedSession
                .persistWindowsTerminalAcceptedAgentMarker =
                    async (identity) => {
                        acceptedTargetMarkerOwnership ??= {
                            pid: identity.pid,
                            happySessionId:
                                trackedSession
                                    .happySessionId
                                    ?.trim()
                                || `PID-${identity.pid}`,
                            processStartTimeMs:
                                identity
                                    .processStartTimeMs,
                            processCommandHash:
                                identity
                                    .processCommandHash,
                        };
                        windowsTerminalMarkerWork ??=
                            params.spawnLifecycleCallbacks
                                .persistAcceptedSpawnMarker(
                                    trackedSession,
                                    {
                                        processPid: identity.pid,
                                        expectedProcessIdentity:
                                            identity,
                                    },
                                );
                        try {
                            await windowsTerminalMarkerWork;
                            trackedSession
                                .windowsTerminalAcceptedTargetMarkerPersisted =
                                  true;
                            resolveMarker();
                        } catch (error) {
                            rejectMarker(error);
                            throw error;
                        }
                    };
        } else {
            acceptedSpawnMarkerPromise =
                params.spawnLifecycleCallbacks
                    .persistAcceptedSpawnMarker(
                        trackedSession,
                    );
        }

        const pollMsRaw = typeof params.processEnv.HAPPIER_DAEMON_VISIBLE_CONSOLE_EXIT_POLL_MS === 'string'
            ? params.processEnv.HAPPIER_DAEMON_VISIBLE_CONSOLE_EXIT_POLL_MS.trim()
            : '';
        const pollMsParsed = pollMsRaw ? Number(pollMsRaw) : Number.NaN;
        const pollMs = Number.isFinite(pollMsParsed) && pollMsParsed > 0 ? pollMsParsed : 5000;

        params.logDebug(`[DAEMON RUN] Waiting for session webhook for PID ${waitParams.pid} (${waitParams.logLabel})`);

        const spawnResultPromise =
            waitParams.windowsTerminalLaunchCustody
                ? waitForSessionWebhook({
                    pid: waitParams.pid,
                    pidToAwaiter: params.pidToAwaiter,
                    pidToSpawnResultResolver:
                        params.pidToSpawnResultResolver,
                    pidToSpawnWebhookTimeout:
                        params.pidToSpawnWebhookTimeout,
                    pidToTrackedSession:
                        params.pidToTrackedSession,
                    timeoutErrorMessage:
                        `Session webhook timeout for PID ${waitParams.pid}`,
                })
                : waitForVisibleConsoleSessionWebhook({
                    pid: waitParams.pid,
                    pollMs,
                    pidToAwaiter: params.pidToAwaiter,
                    pidToSpawnResultResolver:
                        params.pidToSpawnResultResolver,
                    pidToSpawnWebhookTimeout:
                        params.pidToSpawnWebhookTimeout,
                    pidToTrackedSession:
                        params.pidToTrackedSession,
                    onChildExited: params.onChildExited,
                });
        const resolveHostedSpawnResult = async (
            result: SpawnSessionResult,
        ): Promise<SpawnSessionResult> => {
            let resolved = resolveSpawnWebhookResult({
                pid: waitParams.pid,
                result,
                pidToTrackedSession: params.pidToTrackedSession,
                warn: params.warn,
            });
            if (
                resolved.type === 'error'
                && (
                    trackedSession.spawnStartupReadinessFailure
                    || typeof trackedSession.sessionWebhookTimedOutAtMs
                        === 'number'
                )
            ) {
                const incompleteRetirement =
                    resolveSpawnErrorAfterStartupCancellation(
                        await cancelStartupLaunch(),
                    );
                if (incompleteRetirement) {
                    resolved = {
                        type: 'error',
                        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
                        errorMessage: incompleteRetirement,
                    };
                }
            }
            if (resolved.type === 'success') {
                delete trackedSession.cancelStartupLaunchBeforeAck;
                delete trackedSession.windowsTerminalLaunchCustody;
                delete trackedSession.windowsTerminalCancellationIdentity;
                delete trackedSession
                    .persistWindowsTerminalAcceptedAgentMarker;
                delete trackedSession
                    .windowsTerminalAcceptedTargetMarkerPersisted;
                params.logDebug(
                    `[DAEMON RUN] Session ${resolved.sessionId} fully spawned with webhook (${waitParams.logLabel})`,
                );
                const resolvedSessionId =
                    typeof resolved.sessionId === 'string' ? resolved.sessionId.trim() : '';
                if (resolvedSessionId) {
                    try {
                        await writeTerminalAttachmentInfo({
                            happyHomeDir: params.happyHomeDir,
                            sessionId: resolvedSessionId,
                            terminal:
                                trackedSession.hostedTerminal
                                ?? waitParams.terminal,
                        });
                    } catch (error) {
                        params.logDebug('[DAEMON RUN] Failed to persist Windows terminal attachment info', error);
                    }
                }
            } else if (
                resolved.type === 'error' &&
                resolved.errorCode === SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT
            ) {
                params.logDebug(`[DAEMON RUN] Session webhook timeout for PID ${waitParams.pid} (${waitParams.logLabel})`);
            }
            return resolved;
        };
        const acceptedMarkerOutcome =
            acceptedSpawnMarkerPromise.then(
                () => ({ type: 'accepted' as const }),
                (error: unknown) => ({
                    type: 'marker_error' as const,
                    error,
                }),
            );
        let firstOutcome =
            waitParams.windowsTerminalLaunchCustody
                ? await Promise.race([
                    acceptedMarkerOutcome,
                    spawnResultPromise.then((result) => ({
                        type: 'spawn_result' as const,
                        result,
                    })),
                ])
                : await acceptedMarkerOutcome;
        if (
            firstOutcome.type === 'spawn_result'
            && firstOutcome.result.type === 'success'
        ) {
            if (windowsTerminalMarkerWork) {
                await acceptedMarkerOutcome;
            } else {
                settleUnstartedWindowsTerminalMarker?.();
            }
            const readinessFailure: SpawnSessionResult = {
                type: 'error',
                errorCode:
                    SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
                errorMessage:
                    'Windows Terminal session resolved before exact Agent marker acceptance',
            };
            trackedSession.spawnStartupReadinessFailure =
                readinessFailure;
            firstOutcome = {
                type: 'spawn_result',
                result: readinessFailure,
            };
        }
        if (firstOutcome.type === 'spawn_result') {
            if (windowsTerminalMarkerWork) {
                const settledMarker =
                    await acceptedMarkerOutcome;
                if (
                    settledMarker.type
                    === 'marker_error'
                ) {
                    firstOutcome = settledMarker;
                }
            } else {
                settleUnstartedWindowsTerminalMarker?.();
            }
        }
        if (firstOutcome.type === 'spawn_result') {
            resolveAcceptedSpawnMarker(false);
            delete trackedSession
                .persistWindowsTerminalAcceptedAgentMarker;
            return await resolveHostedSpawnResult(
                firstOutcome.result,
            );
        }
        if (firstOutcome.type === 'marker_error') {
            const error = firstOutcome.error;
            resolveAcceptedSpawnMarker(false);
            const timeout = params.pidToSpawnWebhookTimeout.get(waitParams.pid);
            if (timeout) clearTimeout(timeout);
            params.pidToSpawnWebhookTimeout.delete(waitParams.pid);
            params.pidToAwaiter.delete(waitParams.pid);
            params.pidToSpawnResultResolver.delete(waitParams.pid);
            if (
                [...params.pidToTrackedSession.values()].includes(
                    trackedSession,
                )
            ) {
                const incompleteRetirement =
                    resolveSpawnErrorAfterStartupCancellation(
                        await cancelStartupLaunch(),
                    );
                if (incompleteRetirement) {
                    throw new Error(incompleteRetirement);
                }
            }
            throw error;
        }
        params.spawnLifecycleCallbacks.registerConnectedServiceSpawnTarget(waitParams.pid);
        params.spawnLifecycleCallbacks.registerSpawnResourceCleanupForPid(waitParams.pid);
        params.spawnLifecycleCallbacks.consumeSessionAttachCleanupForPid(waitParams.pid);
        trackedSession.acceptedSpawnMarkerGate = undefined;
        resolveAcceptedSpawnMarker(true);

        return await resolveHostedSpawnResult(
            await spawnResultPromise,
        );
    };

    const windowsTerminalIdentity = buildWindowsTerminalWindowIdentity({
        existingSessionId: params.normalizedExistingSessionId,
        reservedSessionId: params.reservedSessionId,
        agentCommand: params.agentCommand,
        windowName: resolveWindowsTerminalWindowName({
            requested: params.options.windowsTerminalWindowName,
            env: params.processEnv,
        }),
    });

    const tryConsoleLaunch = async (launchParams: {
        requested: 'windows_terminal' | 'console';
        fallbackReason?: string;
    }): Promise<SpawnSessionResult> => {
        const consoleArgs = buildWindowsHostedTerminalArgs({
            baseArgs: Array.from(params.args),
            actualMode: 'windows_console',
            requestedMode: launchParams.requested,
            fallbackReason: launchParams.fallbackReason,
        });
        const launchSpec = buildHappyCliSubprocessLaunchSpec(
            consoleArgs,
            params.runnerLaunchOptions ?? { preferWindowsPackagedBinary: true },
        );
        const commitRefusal = await params.revalidateBeforeCommit?.() ?? null;
        if (commitRefusal) return commitRefusal;
        const launchEnv =
            buildWindowsHostedLaunchEnv(launchSpec);
        const started =
            await startHappySessionInVisibleWindowsConsole({
            filePath: launchSpec.filePath,
            args: launchSpec.args,
            workingDirectory: params.directory,
            env: launchEnv,
        });
        if (!started.ok) {
            const errorMessage = sanitizeDiagnosticText(started.errorMessage);
            params.logDebug('[DAEMON RUN] Failed to spawn visible Windows console session', { error: errorMessage });
            await params.cleanupSpawnResources();
            await params.spawnLifecycleCallbacks.cleanupPendingSessionAttach();
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
                errorMessage,
            };
        }
        params.logDebug(`[DAEMON RUN] Spawned visible-console session with PID ${started.pid}`);
        return await waitForWindowsHostedSession({
            pid: started.pid,
            logLabel: 'visible console',
            terminal:
                buildWindowsHostedTerminalAttachment({
                    actualMode: 'windows_console',
                    requestedMode:
                        launchParams.requested,
                    pid: started.pid,
                    fallbackReason:
                        launchParams.fallbackReason,
                }),
            cancelStartupLaunch: async () =>
                await started.cancel(),
        });
    };

    if (params.windowsLaunchMode === 'windows_terminal') {
        const windowsTerminalArgs = buildWindowsHostedTerminalArgs({
            baseArgs: Array.from(params.args),
            actualMode: 'windows_terminal',
            requestedMode: 'windows_terminal',
            windowId: windowsTerminalIdentity.windowId,
            title: windowsTerminalIdentity.title,
            launchCorrelation:
                windowsTerminalIdentity.launchCorrelation,
        });
        const launchSpec = buildHappyCliSubprocessLaunchSpec(
            windowsTerminalArgs,
            params.runnerLaunchOptions ?? { preferWindowsPackagedBinary: true },
        );
        const commitRefusal = await params.revalidateBeforeCommit?.() ?? null;
        if (commitRefusal) return commitRefusal;
        const windowsTerminalLaunchCustody:
            WindowsTerminalLaunchCustody = {
                executablePath: launchSpec.filePath,
                argv: launchSpec.args,
                correlation:
                    windowsTerminalIdentity.launchCorrelation,
            };
        const launchEnv =
            buildWindowsHostedLaunchEnv(launchSpec);
        const dispatchStartedAtMs =
            (params.windowsProcessCustodyDependencies?.nowFn
                ?? Date.now)();
        const retirementNotBeforeMs =
            dispatchStartedAtMs
            + resolveDaemonStartedSessionReportRetryPolicy(
                launchEnv,
            ).retirementHorizonMs;
        let hostedWaitPromise:
            Promise<SpawnSessionResult> | null = null;
        const readHostedWaitPromise =
            (): Promise<SpawnSessionResult> | null =>
                hostedWaitPromise;
        let stopDispatcher: (() => void) | null = null;
        const readStopDispatcher =
            (): (() => void) | null =>
                stopDispatcher;
        const beginWindowsTerminalCustody = (
            custodyPid: number,
        ): void => {
            hostedWaitPromise ??=
                waitForWindowsHostedSession({
                    pid: custodyPid,
                    logLabel: 'windows terminal',
                    terminal:
                        buildWindowsHostedTerminalAttachment({
                            actualMode: 'windows_terminal',
                            requestedMode: 'windows_terminal',
                            pid: custodyPid,
                            windowId:
                                windowsTerminalIdentity.windowId,
                            title:
                                windowsTerminalIdentity.title,
                        }),
                    windowsTerminalLaunchCustody,
                    cancelStartupLaunch: async (tracked) =>
                        await cancelWindowsTerminalLaunch({
                            launch:
                                windowsTerminalLaunchCustody,
                            ...(tracked
                                .windowsTerminalCancellationIdentity
                                ? {
                                    capturedIdentity:
                                        tracked
                                            .windowsTerminalCancellationIdentity,
                                }
                                : {}),
                            retirementNotBeforeMs,
                            ...params
                                .windowsProcessCustodyDependencies,
                        }),
                });
        };
        const startPromise =
            startHappySessionInWindowsTerminal({
            filePath: launchSpec.filePath,
            args: launchSpec.args,
            workingDirectory: params.directory,
            env: launchEnv,
            windowId: windowsTerminalIdentity.windowId,
            title: windowsTerminalIdentity.title,
            onDispatcherSpawned: (
                custodyPid,
                stop,
            ) => {
                stopDispatcher = stop;
                beginWindowsTerminalCustody(custodyPid);
            },
        });
        const provisionalHostedWait =
            readHostedWaitPromise();
        let started:
            Awaited<ReturnType<
                typeof startHappySessionInWindowsTerminal
            >>;
        if (provisionalHostedWait) {
            const first = await Promise.race([
                startPromise.then((result) => ({
                    type: 'dispatcher' as const,
                    result,
                })),
                provisionalHostedWait.then((result) => ({
                    type: 'hosted' as const,
                    result,
                })),
            ]);
            if (first.type === 'hosted') {
                readStopDispatcher()?.();
                void startPromise.catch(() => undefined);
                return first.result;
            }
            started = first.result;
        } else {
            started = await startPromise;
        }

        if (started.ok) {
            beginWindowsTerminalCustody(started.custodyPid);
            params.logDebug(`[DAEMON RUN] Spawned Windows Terminal session with PID ${started.pid}`);
            return await readHostedWaitPromise()!;
        }

        const windowsTerminalError =
            sanitizeDiagnosticText(started.errorMessage);
        if (started.dispatch === 'uncertain') {
            beginWindowsTerminalCustody(started.custodyPid);
            params.logDebug(
                '[DAEMON RUN] Windows Terminal dispatch outcome uncertain; retaining webhook and cancellation custody',
                { pid: started.custodyPid },
            );
            return await readHostedWaitPromise()!;
        }
        params.logDebug(
            '[DAEMON RUN] Windows Terminal dispatch failed; Console fallback refused',
        );
        await params.cleanupSpawnResources();
        await params.spawnLifecycleCallbacks.cleanupPendingSessionAttach();
        return {
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
            errorMessage: windowsTerminalError,
        };
    }

    return await tryConsoleLaunch({ requested: 'console' });
}
