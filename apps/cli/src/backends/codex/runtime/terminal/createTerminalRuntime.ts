import type { PermissionMode } from '@/api/types';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { requireTerminalRuntimeLaunch } from '@/agent/terminalRuntime/providers/requireTerminalRuntimeLaunch';
import type {
    RuntimeTurnConfigUpdate,
    RuntimeTurnStartOrLoadOptions,
} from '@/agent/runtime/turns/runtimeTurnOperations';

import type { CodexTerminalRuntimeLaunchResult } from '../../terminalRuntime/launchTerminalRuntime';
import type { CodexDeferredStartupState } from '../startup/createDeferredStartupSession';
import type {
    CodexNativeRuntime,
    CodexRuntimeFactoryParams,
} from '../session/types';
import type { CodexTerminalRuntimeStartupState } from '../startup/resolveTerminalRuntimeStartupState';

export function createCodexTerminalRuntime(params: Readonly<{
    runtimeParams: CodexRuntimeFactoryParams;
    codexArgs?: readonly string[];
    startupRef: CodexDeferredStartupState;
    startupState: CodexTerminalRuntimeStartupState;
    createRemoteRuntime: () => Promise<CodexNativeRuntime>;
}>): CodexNativeRuntime {
    let remoteRuntime: CodexNativeRuntime | null = null;
    let terminalLaunchPromise: Promise<CodexTerminalRuntimeLaunchResult> | null = null;
    let fallbackMessageSent = false;

    const ensureRemoteRuntime = async (): Promise<CodexNativeRuntime> => {
        if (!remoteRuntime) {
            remoteRuntime = await params.createRemoteRuntime();
        }
        return remoteRuntime;
    };

    const startTerminal = async (
        options?: RuntimeTurnStartOrLoadOptions,
    ): Promise<CodexTerminalRuntimeLaunchResult> => {
        if (params.startupRef.terminalLaunchPromise) {
            return await params.startupRef.terminalLaunchPromise;
        }
        if (!terminalLaunchPromise) {
            if (!fallbackMessageSent && params.startupState.initialCodexAcpFallbackToMcpMessage) {
                fallbackMessageSent = true;
                params.runtimeParams.session.sendSessionEvent({
                    type: 'message',
                    message: params.startupState.initialCodexAcpFallbackToMcpMessage,
                });
            }
            const launchTerminalRuntime = await requireTerminalRuntimeLaunch<{
                path: string;
                api: unknown;
                session: CodexRuntimeFactoryParams['session'];
                messageQueue: NonNullable<CodexRuntimeFactoryParams['messageQueue']>;
                permissionMode: PermissionMode;
                resumeId: string | null;
                codexArgs?: readonly string[];
            }, CodexTerminalRuntimeLaunchResult>('codex');
            params.startupRef.markVendorSpawnInvoked?.();
            terminalLaunchPromise = launchTerminalRuntime({
                path: params.runtimeParams.directory,
                api: null,
                session: params.runtimeParams.session,
                messageQueue: params.runtimeParams.messageQueue ?? new MessageQueue2(() => 'codex-terminal-runtime'),
                permissionMode: params.runtimeParams.getPermissionMode?.() ?? 'default',
                resumeId:
                    typeof options?.resumeId === 'string' && options.resumeId.trim().length > 0
                        ? options.resumeId.trim()
                        : null,
                ...(params.codexArgs && params.codexArgs.length > 0
                    ? { codexArgs: params.codexArgs }
                    : {}),
            });
        }

        return await terminalLaunchPromise;
    };

    const startOrLoadSession = async (
        options?: RuntimeTurnStartOrLoadOptions,
    ): Promise<CodexTerminalRuntimeLaunchResult | undefined> => {
        const terminalResult = await startTerminal(options);
        await params.startupRef.backgroundStartPromise?.catch(() => undefined);
        if (terminalResult.type === 'switch') {
            const remote = await ensureRemoteRuntime();
            await remote.startOrLoadSession({
                ...(terminalResult.resumeId ? { resumeId: terminalResult.resumeId } : {}),
                importHistory: false,
            });
            return undefined;
        }
        return terminalResult;
    };

    return {
        beginTurnLifecycle() {
            remoteRuntime?.beginTurnLifecycle();
        },
        async startOrLoadSession(options?: RuntimeTurnStartOrLoadOptions) {
            return await startOrLoadSession(options);
        },
        async sendTurnPrompt(prompt: string) {
            const remote = await ensureRemoteRuntime();
            await remote.sendTurnPrompt(prompt);
        },
        async steerInFlightTurn(prompt: string) {
            const remote = await ensureRemoteRuntime();
            await remote.steerInFlightTurn(prompt);
        },
        async waitForTurnCompletion() {
            await remoteRuntime?.waitForTurnCompletion();
        },
        subscribeRuntimeMessages(listener) {
            return remoteRuntime?.subscribeRuntimeMessages(listener) ?? (() => undefined);
        },
        async respondToPermission(requestId: string, approved: boolean) {
            await remoteRuntime?.respondToPermission(requestId, approved);
        },
        async cancelTurn() {
            await remoteRuntime?.cancelTurn();
        },
        readSessionIdentity() {
            return remoteRuntime?.readSessionIdentity() ?? { sessionId: null };
        },
        async updateSessionRuntimeConfig(update: RuntimeTurnConfigUpdate) {
            await remoteRuntime?.updateSessionRuntimeConfig(update);
        },
        async resetOrDisposeRuntime() {
            await remoteRuntime?.resetOrDisposeRuntime();
        },
        shouldResumeAfterPermissionModeChange: () =>
            remoteRuntime?.shouldResumeAfterPermissionModeChange?.() ?? false,
        supportsInFlightSteer: () => remoteRuntime?.supportsInFlightSteer?.() === true,
        isTurnInFlight: () => remoteRuntime?.isTurnInFlight?.() === true,
        canSteerPrompt: () => (
            remoteRuntime?.canSteerPrompt?.()
            ?? remoteRuntime?.isTurnInFlight?.()
            ?? false
        ) === true,
        steerPrompt: async (prompt: string) => {
            const remote = await ensureRemoteRuntime();
            await remote.steerInFlightTurn(prompt);
        },
    };
}
