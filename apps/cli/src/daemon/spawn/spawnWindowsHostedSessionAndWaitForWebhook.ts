import type { PersistedTakeoverAdmissionWaitRegistration } from './persistedTakeoverAdmission';
import { cleanupUnstartedLaunch } from './cleanupUnstartedLaunch';
import type { Metadata } from '@/api/types';
import type { SpawnFailureLimitsReader } from '@/processes/spawnFailure/classifySpawnFailure';
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
import { waitForVisibleConsoleSessionWebhook } from '../sessions/visibleConsoleSpawnWaiter';
import { armSessionWebhookStartupCustody, waitForSessionWebhook } from './waitForSessionWebhook';
import type {
    RunnerAgentInvocationContext,
    TrackedSession,
} from '../types';
import type {
    RunnerAgentSessionBootstrapAuthorization,
} from '../agentRuntime/sessionBridgeAuthorization';
import type { SpawnLifecycleCallbacks } from './createSpawnLifecycleCallbacks';
import { buildSpawnChildProcessEnv } from './buildSpawnChildProcessEnv';
import type { SpawnCommitRevalidation } from './spawnCommitRevalidation';
import {
    completeStartupCancellationCleanup,
    projectRetiredStartupLaunchResult,
    resolveSpawnErrorAfterStartupCancellation,
    type CancelStartupLaunch,
} from './startupLaunchCancellation';
import {
    resolveSessionReportRetryPolicy,
} from './sessionWebhookTimeoutPolicy';
import { mintSessionTrackingKey, trackSession, type SessionTrackingKey, type TrackedSessionMap } from '@/daemon/sessions/sessionTrackingKey';

export async function spawnWindowsHostedSessionAndWaitForWebhook(params: Readonly<{
    windowsLaunchMode: 'windows_terminal' | 'console';
    args: readonly string[];
    agentCommand: string;
    directory: string;
    options: SpawnSessionOptions;
    trackedSpawnOptions: SpawnSessionOptions;
    normalizedExistingSessionId: string;
    /** Creation outcome of a Session the daemon committed before launch; its attaching runner reports none. */
    sessionCreationOutcome?: TrackedSession['sessionCreationOutcome'];
    effectiveResume: string;
    reservedSessionId?: string;
    directoryCreated: boolean;
    extraEnvForChildWithMessage: Record<string, string>;
    unsetEnvKeys?: readonly string[];
    runnerAgentSessionBootstrapAuthorization?:
        RunnerAgentSessionBootstrapAuthorization | null;
    runnerAgentInvocationContext?: RunnerAgentInvocationContext | null;
    processEnv: NodeJS.ProcessEnv;
    happyHomeDir: string;
    trackedSessionsByKey: TrackedSessionMap;
    spawnAwaiterByKey: Map<SessionTrackingKey, (session: TrackedSession) => void>;
    spawnResultResolverByKey: Map<SessionTrackingKey, (result: SpawnSessionResult) => void>;
    spawnWebhookTimeoutByKey: Map<SessionTrackingKey, NodeJS.Timeout>;
    takeoverAdmission?: PersistedTakeoverAdmissionWaitRegistration;
    resolveCanonicalTrackedSessionId: (trackingKey: SessionTrackingKey) => string;
    onChildExited: (pid: number, exit: ChildExit) => void | Promise<void>;
    spawnLifecycleCallbacks: SpawnLifecycleCallbacks;
    cleanupSpawnResources: () => void | Promise<void>;
    logDebug: (message: string, payload?: unknown) => void;
    warn: (message: string) => void;
    sanitizeDiagnosticText?: (value: string) => string;
    revalidateBeforeCommit?: SpawnCommitRevalidation;
    runnerLaunchOptions?: HappyCliSubprocessLaunchOptions;
    readSpawnFailureLimits?: SpawnFailureLimitsReader;
    windowsProcessCustodyDependencies?: WindowsProcessCustodyDependencies;
}>): Promise<SpawnSessionResult> {
    const sanitizeDiagnosticText = params.sanitizeDiagnosticText ?? ((value: string) => value);
    const buildWindowsHostedLaunchEnv = (launchSpec: ReturnType<typeof buildHappyCliSubprocessLaunchSpec>) => buildSpawnChildProcessEnv({
        ...(params.normalizedExistingSessionId ? { processOwner: { kind: 'session' as const, sessionId: params.normalizedExistingSessionId } } : {}),
        happierHomeDir: params.happyHomeDir,
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
        const trackingKey = mintSessionTrackingKey();
        const trackedSession: TrackedSession = {
            trackingKey,
            startedBy: 'daemon',
            happySessionId:
                params.normalizedExistingSessionId
                || `PID-${waitParams.pid}`,
            pid: waitParams.pid,
            spawnOptions: params.trackedSpawnOptions,
            ...(params.sessionCreationOutcome
                ? { sessionCreationOutcome: params.sessionCreationOutcome }
                : {}),
            acceptedSpawnMarkerGate,
            hostedTerminal: waitParams.terminal,
            ...(waitParams.windowsTerminalLaunchCustody
                ? {
                    windowsTerminalLaunchCustody:
                        waitParams.windowsTerminalLaunchCustody,
                }
                : {}),
            ...(params.runnerAgentSessionBootstrapAuthorization ? {
                agentRuntimeDaemonServiceAuthorityFilePath:
                    params.runnerAgentSessionBootstrapAuthorization
                        .authorityFilePath,
                runnerAgentBootstrapIdentity: {
                    agentId:
                        params.runnerAgentSessionBootstrapAuthorization
                            .descriptor.agentId,
                    backendId:
                        params.runnerAgentSessionBootstrapAuthorization
                            .descriptor.backendId,
                },
            } : {}),
            ...(params.runnerAgentInvocationContext ? {
                runnerAgentInvocationContext:
                    params.runnerAgentInvocationContext,
            } : {}),
            vendorResumeId: params.effectiveResume || undefined,
            directoryCreated: params.directoryCreated,
            message: params.directoryCreated
                ? `The path '${params.trackedSpawnOptions.directory}' did not exist. We created a new folder and spawned a new session there.`
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
                                trackingKey: trackedSession.trackingKey,
                                happySessionId: acceptedTargetMarkerOwnership.happySessionId,
                                processStartTimeMs: acceptedTargetMarkerOwnership.processStartTimeMs,
                                processCommandHash: acceptedTargetMarkerOwnership.processCommandHash,
                                isStillOwned: () =>
                                    [
                                        ...params
                                            .trackedSessionsByKey
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
                    trackedSessionsByKey: params.trackedSessionsByKey,
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
        trackSession(params.trackedSessionsByKey, trackedSession);
        params.spawnLifecycleCallbacks.onTrackedSessionRegistered?.(trackedSession);
        params.spawnLifecycleCallbacks.registerSpawnResourceCleanupForSession(trackedSession.trackingKey);
        params.spawnLifecycleCallbacks.consumeSessionAttachCleanupForSession(trackedSession.trackingKey);
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
        const commitLocalAttachment = async (completedSession: TrackedSession): Promise<void> => {
            await acceptedSpawnMarkerPromise;
            if (trackedSession.spawnStartupReadinessFailure) {
                throw new Error(trackedSession.spawnStartupReadinessFailure.errorMessage);
            }
            const sessionId = completedSession.happySessionId?.trim();
            if (!sessionId) throw new Error('canonical_session_id_missing');
            try {
                await writeTerminalAttachmentInfo({ happyHomeDir: params.happyHomeDir, sessionId,
                    terminal: trackedSession.hostedTerminal ?? waitParams.terminal });
            } catch {
                trackedSession.spawnStartupReadinessFailure ??= {
                    type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
                    errorMessage: 'terminal_attachment_binding_failed',
                };
                throw new Error('terminal_attachment_binding_failed');
            }
        };

        const spawnResultPromise =
            waitParams.windowsTerminalLaunchCustody
                ? waitForSessionWebhook({
                    trackingKey,
                    pid: waitParams.pid,
                    spawnAwaiterByKey: params.spawnAwaiterByKey,
                    takeoverAdmission: params.takeoverAdmission,
                    spawnResultResolverByKey:
                        params.spawnResultResolverByKey,
                    spawnWebhookTimeoutByKey:
                        params.spawnWebhookTimeoutByKey,
                    trackedSessionsByKey:
                        params.trackedSessionsByKey,
                    timeoutErrorMessage:
                        `Session webhook timeout for PID ${waitParams.pid}`,
                    onSuccess: commitLocalAttachment,
                })
                : waitForVisibleConsoleSessionWebhook({
                    trackingKey,
                    pid: waitParams.pid,
                    pollMs,
                    spawnAwaiterByKey: params.spawnAwaiterByKey,
                    takeoverAdmission: params.takeoverAdmission,
                    spawnResultResolverByKey:
                        params.spawnResultResolverByKey,
                    spawnWebhookTimeoutByKey:
                        params.spawnWebhookTimeoutByKey,
                    trackedSessionsByKey:
                        params.trackedSessionsByKey,
                    onChildExited: params.onChildExited,
                    onSuccess: commitLocalAttachment,
                });
        armSessionWebhookStartupCustody(trackedSession, spawnResultPromise, acceptedSpawnMarkerPromise);
        const resolveHostedSpawnResult = async (
            result: SpawnSessionResult,
        ): Promise<SpawnSessionResult> => {
            let resolved = result;
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
                } else {
                    resolved = projectRetiredStartupLaunchResult({
                        result: resolved,
                        readinessFailure: trackedSession.spawnStartupReadinessFailure,
                        spawnNonce: params.trackedSpawnOptions.spawnNonce,
                        wrapperPid: waitParams.pid,
                    });
                }
            }
            if (resolved.type === 'success') {
                delete trackedSession.cancelStartupLaunchBeforeAck;
                delete trackedSession.windowsTerminalLaunchCustody;
                delete trackedSession.runnerProcessIdentity;
                delete trackedSession
                    .persistWindowsTerminalAcceptedAgentMarker;
                delete trackedSession
                    .windowsTerminalAcceptedTargetMarkerPersisted;
                params.logDebug(
                    `[DAEMON RUN] Session ${resolved.sessionId} fully spawned with webhook (${waitParams.logLabel})`,
                );
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
            const timeout = params.spawnWebhookTimeoutByKey.get(trackingKey);
            if (timeout) clearTimeout(timeout);
            params.spawnWebhookTimeoutByKey.delete(trackingKey);
            params.spawnAwaiterByKey.delete(trackingKey);
            params.spawnResultResolverByKey.delete(trackingKey);
            if (
                [...params.trackedSessionsByKey.values()].includes(
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
        params.spawnLifecycleCallbacks.registerConnectedServiceSpawnTarget(trackedSession.pid, trackedSession.trackingKey);
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
            readSpawnFailureLimits: params.readSpawnFailureLimits,
            filePath: launchSpec.filePath,
            args: launchSpec.args,
            workingDirectory: params.directory,
            env: launchEnv,
        });
        if (!started.ok) {
            const errorMessage = sanitizeDiagnosticText(started.errorMessage);
            params.logDebug('[DAEMON RUN] Failed to spawn visible Windows console session', { error: errorMessage });
            await cleanupUnstartedLaunch(params);
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
                errorMessage,
                ...(started.spawnFailure ? { errorDetail: { kind: 'spawn_failure' as const, ...started.spawnFailure } } : {}),
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
            + resolveSessionReportRetryPolicy(
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
                                .runnerProcessIdentity
                                ? {
                                    capturedIdentity:
                                        tracked
                                            .runnerProcessIdentity,
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
            readSpawnFailureLimits: params.readSpawnFailureLimits,
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
        await cleanupUnstartedLaunch(params);
        return {
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
            errorMessage: windowsTerminalError,
            ...(started.spawnFailure ? { errorDetail: { kind: 'spawn_failure' as const, ...started.spawnFailure } } : {}),
        };
    }

    return await tryConsoleLaunch({ requested: 'console' });
}
