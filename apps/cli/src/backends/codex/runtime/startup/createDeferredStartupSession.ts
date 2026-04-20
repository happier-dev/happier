import type { PermissionMode } from '@/api/types';
import { convertBackendTargetRefV2ToV1, readBackendTargetRefV2 } from '@happier-dev/protocol';
import { initialMachineMetadata } from '@/daemon/startDaemon';
import { createPreparedDeferredStartupBootstrap } from '@/agent/runtime/startup/createPreparedDeferredStartupBootstrap';
import type { DeferredStartupBootstrapResult } from '@/agent/runtime/startup/deferredStartupTypes';
import { readRequiredStartupMachineId } from '@/agent/runtime/startup/readRequiredStartupMachineId';
import { requireTerminalRuntimeLaunch } from '@/agent/terminalRuntime/providers/requireTerminalRuntimeLaunch';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { resolvePermissionModeSeedForAgentStart } from '@/settings/permissions/permissionModeSeed';
import { logger } from '@/ui/logger';
import type { CodexBackendMode } from '@happier-dev/agents';

import { resolveCodexStartupRuntimeMode } from '../../utils/resolveCodexStartupRuntimeMode';
import {
    resolveCodexTerminalRuntimeStartupState,
    type CodexTerminalRuntimeStartupState,
} from './resolveTerminalRuntimeStartupState';
import type { CodexTerminalRuntimeLaunchResult } from '../../terminalRuntime/launchTerminalRuntime';
import type {
    CodexRuntimeFactoryParams,
    CodexSessionRuntimeOptions,
} from '../session/types';
import { codexRuntimeModeFromHostStartingMode } from '../session/types';

export type CodexDeferredStartupState = {
    backgroundStartPromise: Promise<void> | null;
    terminalLaunchPromise: Promise<CodexTerminalRuntimeLaunchResult> | null;
    startupState: CodexTerminalRuntimeStartupState | null;
    markVendorSpawnInvoked: (() => void) | null;
};

function resolveStartedByForTerminalRuntime(opts: CodexSessionRuntimeOptions): 'cli' | 'daemon' {
    return opts.startedBy === 'daemon' ? 'daemon' : 'cli';
}

function hasTtyForCodexTerminalRuntime(): boolean {
    return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

export function shouldUseCodexDeferredStartup(
    opts: CodexSessionRuntimeOptions,
    backendMode: CodexBackendMode,
): boolean {
    const terminalRuntimeEnabled = backendMode === 'acp' || backendMode === 'appServer';
    const startedBy = resolveStartedByForTerminalRuntime(opts);
    const runtimeMode = resolveCodexStartupRuntimeMode({
        explicitRuntimeMode: codexRuntimeModeFromHostStartingMode(opts.startingMode) ?? undefined,
        startedBy,
        hasTtyForTerminal: hasTtyForCodexTerminalRuntime(),
        terminalRuntimeEnabled,
    });
    const existingSessionId =
        typeof opts.existingSessionId === 'string' && opts.existingSessionId.trim().length > 0
            ? opts.existingSessionId.trim()
            : null;
    const resumeId = typeof opts.resume === 'string' && opts.resume.trim().length > 0 ? opts.resume.trim() : null;
    const hasExplicitPermissionMode = typeof opts.permissionMode === 'string';

    return (
        runtimeMode === 'terminal' &&
        startedBy === 'cli' &&
        !existingSessionId &&
        (!resumeId || hasExplicitPermissionMode)
    );
}

export async function createCodexDeferredStartupSession(params: Readonly<{
    opts: CodexSessionRuntimeOptions;
    backendMode: CodexBackendMode;
    startupRef: CodexDeferredStartupState;
}>): Promise<DeferredStartupBootstrapResult> {
    const { opts, backendMode, startupRef } = params;
    const workingDirectory =
        typeof opts.directory === 'string' && opts.directory.trim().length > 0
            ? opts.directory
            : process.cwd();
    const startedBy = opts.startedBy ?? 'terminal';
    const initialMachineId = await readRequiredStartupMachineId(
        '[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/happier-dev/happier/issues',
    );
    const permissionModeSeed = resolvePermissionModeSeedForAgentStart({
        agentId: 'codex',
        backendTarget: opts.backendTarget ? convertBackendTargetRefV2ToV1(readBackendTargetRefV2(opts.backendTarget)) : undefined,
        explicitPermissionMode: opts.permissionMode,
        accountSettings: opts.accountSettingsContext?.settings ?? null,
    });
    const initialPermissionMode = permissionModeSeed.mode;
    opts.permissionMode = initialPermissionMode;

    const startupState = await resolveCodexTerminalRuntimeStartupState({
        startedByForTerminalRuntime: resolveStartedByForTerminalRuntime(opts),
        hasTtyForTerminalRuntime: hasTtyForCodexTerminalRuntime(),
        explicitStartingRuntimeMode: codexRuntimeModeFromHostStartingMode(opts.startingMode) ?? undefined,
        resumeIdFromArgs: typeof opts.resume === 'string' && opts.resume.trim().length > 0 ? opts.resume.trim() : null,
        codexBackendMode: backendMode,
    });
    startupRef.startupState = startupState;

    const bootstrap = await createPreparedDeferredStartupBootstrap({
        credentials: opts.credentials,
        flavor: 'codex',
        startedBy,
        workingDirectory,
        initialMachineId,
        machineMetadata: initialMachineMetadata,
        uiLogPrefix: '[Codex]',
        timingLogPrefix: '[codex-startup]',
        initialPermissionMode,
        explicitPermissionMode: opts.permissionMode,
        explicitPermissionModeUpdatedAt: opts.permissionModeUpdatedAt,
        sessionModeId: opts.sessionModeId,
        sessionModeUpdatedAt: opts.sessionModeUpdatedAt,
        modelId: opts.modelId,
        modelUpdatedAt: opts.modelUpdatedAt,
        terminalRuntime: opts.terminalRuntime ?? null,
        allowOfflineStub: true,
        startupSideEffectsOrder: 'persist-first',
        onBackgroundStartFailure: async (error) => {
            logger.debug('[codex-startup] Background attach failed (non-fatal)', error);
        },
    });
    startupRef.markVendorSpawnInvoked = bootstrap.markVendorSpawnInvoked;

    if (startupState.runtimeMode === 'terminal') {
        const fallbackMessage = startupState.initialCodexAcpFallbackToMcpMessage;
        if (fallbackMessage) {
            bootstrap.session.sendSessionEvent({ type: 'message', message: fallbackMessage });
        }
        const launchTerminalRuntime = await requireTerminalRuntimeLaunch<{
            path: string;
            api: unknown;
            session: CodexRuntimeFactoryParams['session'];
            messageQueue: CodexRuntimeFactoryParams['messageQueue'];
            permissionMode: PermissionMode;
            resumeId: string | null;
        }, CodexTerminalRuntimeLaunchResult>('codex');
        const startupMessageQueue = new MessageQueue2(() => 'codex-terminal-startup');
        bootstrap.markVendorSpawnInvoked();
        startupRef.terminalLaunchPromise = launchTerminalRuntime({
            path: workingDirectory,
            api: null,
            session: bootstrap.session,
            messageQueue: startupMessageQueue as unknown as NonNullable<CodexRuntimeFactoryParams['messageQueue']>,
            permissionMode: initialPermissionMode,
            resumeId: typeof opts.resume === 'string' && opts.resume.trim().length > 0 ? opts.resume.trim() : null,
        });
    }

    const start = async (): Promise<void> => {
        startupRef.backgroundStartPromise ??= bootstrap.start?.() ?? Promise.resolve();
        await startupRef.backgroundStartPromise;
    };

    return {
        ...bootstrap,
        start,
    };
}
