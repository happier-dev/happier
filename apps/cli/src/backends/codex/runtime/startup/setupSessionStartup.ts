import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import type { DeferredApiSessionClient } from '@/agent/runtime/startup/DeferredApiSessionClient';
import type { StartupTiming } from '@/agent/runtime/startup/startupSpec';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { CodexBackendMode } from '@happier-dev/agents';

import type { CodexRuntimeMode } from '../session/types';
import {
    resolveCodexTerminalRuntimeStartupState,
    type CodexTerminalRuntimeStartupState,
} from './resolveTerminalRuntimeStartupState';
import { maybeStartCodexFastStartTerminal } from './maybeStartFastStartTerminal';
import type { CodexTerminalRuntimeLaunchResult } from '../../terminalRuntime/launchTerminalRuntime';

export type CodexSessionStartupArtifacts<TMessageQueue> = Readonly<{
    startupState: CodexTerminalRuntimeStartupState;
    deferredSession: DeferredApiSessionClient | null;
    terminalLauncherPromise: Promise<CodexTerminalRuntimeLaunchResult> | null;
    attachDeferredSessionIfNeeded: (target: ApiSessionClient) => Promise<void>;
    shouldFastStartTerminal: boolean;
}>;

export async function setupCodexSessionStartup<TMessageQueue>(params: Readonly<{
    requestedDirectory: string;
    startedByForTerminalRuntime: 'cli' | 'daemon';
    hasTtyForTerminalRuntime: boolean;
    explicitStartingRuntimeMode?: CodexRuntimeMode;
    resumeIdFromArgs: string | null;
    codexBackendMode?: CodexBackendMode;
    existingSessionId?: string | null;
    hasExplicitPermissionMode: boolean;
    messageQueue: TMessageQueue;
    messageBuffer: MessageBuffer;
    initialPermissionMode: PermissionMode;
    nowMs: () => number;
    timing: StartupTiming | null;
    requireCodexTerminalRuntimeLaunch: () => Promise<
        (launchArgs: Readonly<{
            path: string;
            api: unknown;
            session: ApiSessionClient;
            messageQueue: TMessageQueue;
            permissionMode: PermissionMode;
            resumeId: string | null;
        }>) => Promise<CodexTerminalRuntimeLaunchResult>
    >;
    logger: { debug: (message: string, ...args: unknown[]) => void };
}>): Promise<CodexSessionStartupArtifacts<TMessageQueue>> {
    const startupState = await resolveCodexTerminalRuntimeStartupState({
        startedByForTerminalRuntime: params.startedByForTerminalRuntime,
        hasTtyForTerminalRuntime: params.hasTtyForTerminalRuntime,
        explicitStartingRuntimeMode: params.explicitStartingRuntimeMode,
        resumeIdFromArgs: params.resumeIdFromArgs,
        codexBackendMode: params.codexBackendMode,
    });

    const hasExplicitPermissionMode = params.hasExplicitPermissionMode;
    const shouldFastStartTerminal =
        startupState.runtimeMode === 'terminal' &&
        params.startedByForTerminalRuntime === 'cli' &&
        (typeof params.existingSessionId !== 'string' || !params.existingSessionId.trim()) &&
        (!params.resumeIdFromArgs || hasExplicitPermissionMode);

    params.logger.debug('[codex] Runtime mode resolved', {
        explicitStartingRuntimeMode: params.explicitStartingRuntimeMode ?? null,
        startedBy: params.startedByForTerminalRuntime,
        hasTtyForTerminalRuntime: params.hasTtyForTerminalRuntime,
        codexBackendMode: startupState.codexBackendMode,
        experimentalCodexAcpEnabled: startupState.experimentalCodexAcpEnabled,
        terminalRuntimeEnabled: startupState.terminalRuntimeEnabled,
        runtimeMode: startupState.runtimeMode,
    });

    if (startupState.runtimeMode === 'terminal' && startupState.fallbackToRemoteMessage) {
        params.logger.debug('[codex] Terminal runtime is unavailable; falling back to remote.');
    }

    const {
        deferredSession,
        terminalLauncherPromise,
        attachDeferredSessionIfNeeded,
    } = await maybeStartCodexFastStartTerminal({
        enabled: shouldFastStartTerminal,
        resumeIdFromArgs: params.resumeIdFromArgs,
        requestedDirectory: params.requestedDirectory,
        startedBy: params.startedByForTerminalRuntime,
        hasTtyForTerminalRuntime: params.hasTtyForTerminalRuntime,
        nowMs: params.nowMs,
        timing: params.timing,
        messageQueue: params.messageQueue as never,
        initialPermissionMode: params.initialPermissionMode,
        requireCodexTerminalRuntimeLaunch: params.requireCodexTerminalRuntimeLaunch,
    });

    return {
        startupState,
        deferredSession,
        terminalLauncherPromise,
        attachDeferredSessionIfNeeded,
        shouldFastStartTerminal,
    };
}
