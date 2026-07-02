import type { Metadata } from '@/api/types';
import { buildHappyCliSubprocessLaunchSpec } from '@/utils/spawnHappyCLI';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionOptions, type SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import { writeTerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';

import { startHappySessionInVisibleWindowsConsole } from '../platform/windows/spawnHappyCliVisibleConsole';
import { startHappySessionInWindowsTerminal } from '../platform/windows/spawnHappyCliWindowsTerminal';
import {
    buildWindowsHostedTerminalArgs,
    buildWindowsHostedTerminalAttachment,
    buildWindowsTerminalWindowIdentity,
    resolveWindowsTerminalWindowName,
} from '../platform/windows/windowsHostedSessionRuntime';
import type { ChildExit } from '../sessions/onChildExited';
import { resolveSpawnWebhookResult } from '../sessions/resolveSpawnWebhookResult';
import { waitForVisibleConsoleSessionWebhook } from '../sessions/visibleConsoleSpawnWaiter';
import type { TrackedSession } from '../types';
import type { SpawnLifecycleCallbacks } from './createSpawnLifecycleCallbacks';

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
    processEnv: NodeJS.ProcessEnv;
    happyHomeDir: string;
    pidToTrackedSession: Map<number, TrackedSession>;
    pidToAwaiter: Map<number, (session: TrackedSession) => void>;
    pidToSpawnResultResolver: Map<number, (result: SpawnSessionResult) => void>;
    pidToSpawnWebhookTimeout: Map<number, NodeJS.Timeout>;
    resolveCanonicalTrackedSessionId: (pid: number) => string;
    onChildExited: (pid: number, exit: ChildExit) => void;
    spawnLifecycleCallbacks: SpawnLifecycleCallbacks;
    cleanupSpawnResources: () => void;
    logDebug: (message: string, payload?: unknown) => void;
    warn: (message: string) => void;
}>): Promise<SpawnSessionResult> {
    const buildWindowsHostedLaunchEnv = (launchSpec: ReturnType<typeof buildHappyCliSubprocessLaunchSpec>) => ({
        ...params.processEnv,
        ...params.extraEnvForChildWithMessage,
        ...(launchSpec.env ?? {}),
    });

    const waitForWindowsHostedSession = async (waitParams: {
        pid: number;
        logLabel: string;
        terminal: NonNullable<Metadata['terminal']>;
    }): Promise<SpawnSessionResult> => {
        params.spawnLifecycleCallbacks.consumeSessionAttachCleanupForPid(waitParams.pid);

        const trackedSession: TrackedSession = {
            startedBy: 'daemon',
            happySessionId: params.normalizedExistingSessionId || undefined,
            pid: waitParams.pid,
            spawnOptions: params.trackedSpawnOptions,
            vendorResumeId: params.effectiveResume || undefined,
            directoryCreated: params.directoryCreated,
            message: params.directoryCreated
                ? `The path '${params.directory}' did not exist. We created a new folder and spawned a new session there.`
                : undefined,
        };
        params.pidToTrackedSession.set(waitParams.pid, trackedSession);
        params.spawnLifecycleCallbacks.registerConnectedServiceSpawnTarget(waitParams.pid);
        params.spawnLifecycleCallbacks.registerSpawnResourceCleanupForPid(waitParams.pid);

        const pollMsRaw = typeof params.processEnv.HAPPIER_DAEMON_VISIBLE_CONSOLE_EXIT_POLL_MS === 'string'
            ? params.processEnv.HAPPIER_DAEMON_VISIBLE_CONSOLE_EXIT_POLL_MS.trim()
            : '';
        const pollMsParsed = pollMsRaw ? Number(pollMsRaw) : Number.NaN;
        const pollMs = Number.isFinite(pollMsParsed) && pollMsParsed > 0 ? pollMsParsed : 5000;

        params.logDebug(`[DAEMON RUN] Waiting for session webhook for PID ${waitParams.pid} (${waitParams.logLabel})`);

        return await waitForVisibleConsoleSessionWebhook({
            pid: waitParams.pid,
            pollMs,
            pidToAwaiter: params.pidToAwaiter,
            pidToSpawnResultResolver: params.pidToSpawnResultResolver,
            pidToSpawnWebhookTimeout: params.pidToSpawnWebhookTimeout,
            onChildExited: params.onChildExited,
            resolveExistingSessionId: () => params.resolveCanonicalTrackedSessionId(waitParams.pid),
        }).then(async (result) => {
            const resolved = resolveSpawnWebhookResult({
                pid: waitParams.pid,
                result,
                pidToTrackedSession: params.pidToTrackedSession,
                warn: params.warn,
            });
            if (resolved.type === 'success') {
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
                            terminal: waitParams.terminal,
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
        });
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
        const launchSpec = buildHappyCliSubprocessLaunchSpec(consoleArgs, {
            preferWindowsPackagedBinary: true,
        });
        const started = await startHappySessionInVisibleWindowsConsole({
            filePath: launchSpec.filePath,
            args: launchSpec.args,
            workingDirectory: params.directory,
            env: buildWindowsHostedLaunchEnv(launchSpec),
        });

        if (!started.ok) {
            params.logDebug('[DAEMON RUN] Failed to spawn visible Windows console session', { error: started.errorMessage });
            params.cleanupSpawnResources();
            await params.spawnLifecycleCallbacks.cleanupPendingSessionAttach();
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
                errorMessage: started.errorMessage,
            };
        }

        params.logDebug(`[DAEMON RUN] Spawned visible-console session with PID ${started.pid}`);
        return await waitForWindowsHostedSession({
            pid: started.pid,
            logLabel: launchParams.requested === 'windows_terminal' ? 'windows console fallback' : 'visible console',
            terminal: buildWindowsHostedTerminalAttachment({
                actualMode: 'windows_console',
                requestedMode: launchParams.requested,
                pid: started.pid,
                fallbackReason: launchParams.fallbackReason,
            }),
        });
    };

    if (params.windowsLaunchMode === 'windows_terminal') {
        const windowsTerminalArgs = buildWindowsHostedTerminalArgs({
            baseArgs: Array.from(params.args),
            actualMode: 'windows_terminal',
            requestedMode: 'windows_terminal',
            windowId: windowsTerminalIdentity.windowId,
        });
        const launchSpec = buildHappyCliSubprocessLaunchSpec(windowsTerminalArgs, {
            preferWindowsPackagedBinary: true,
        });
        const started = await startHappySessionInWindowsTerminal({
            filePath: launchSpec.filePath,
            args: launchSpec.args,
            workingDirectory: params.directory,
            env: buildWindowsHostedLaunchEnv(launchSpec),
            windowId: windowsTerminalIdentity.windowId,
            title: windowsTerminalIdentity.title,
        });

        if (started.ok) {
            params.logDebug(`[DAEMON RUN] Spawned Windows Terminal session with PID ${started.pid}`);
            return await waitForWindowsHostedSession({
                pid: started.pid,
                logLabel: 'windows terminal',
                terminal: buildWindowsHostedTerminalAttachment({
                    actualMode: 'windows_terminal',
                    requestedMode: 'windows_terminal',
                    pid: started.pid,
                    windowId: windowsTerminalIdentity.windowId,
                    title: windowsTerminalIdentity.title,
                }),
            });
        }

        params.logDebug('[DAEMON RUN] Failed to spawn Windows Terminal session; falling back to console', {
            error: started.errorMessage,
        });
        return await tryConsoleLaunch({
            requested: 'windows_terminal',
            fallbackReason: started.errorMessage,
        });
    }

    return await tryConsoleLaunch({ requested: 'console' });
}
