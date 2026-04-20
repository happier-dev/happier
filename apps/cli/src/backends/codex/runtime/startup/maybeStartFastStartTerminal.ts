import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import { configuration } from '@/configuration';
import { DeferredApiSessionClient } from '@/agent/runtime/startup/DeferredApiSessionClient';
import { runStartupCoordinator } from '@/agent/runtime/startup/startupCoordinator';
import type { BackendStartupSpec, StartupContext, StartupTiming } from '@/agent/runtime/startup/startupSpec';

import type { CodexTerminalRuntimeLaunchResult } from '../../terminalRuntime/launchTerminalRuntime';

type CodexFastStartArtifacts = {
    deferredSession: DeferredApiSessionClient;
    terminalResult: CodexTerminalRuntimeLaunchResult | null;
};

type TerminalRuntimeLaunch<TMessageQueue> = (params: Readonly<{
    path: string;
    api: unknown;
    session: ApiSessionClient;
    messageQueue: TMessageQueue;
    permissionMode: PermissionMode;
    resumeId: string | null;
}>) => Promise<CodexTerminalRuntimeLaunchResult>;

export async function maybeStartCodexFastStartTerminal<TMessageQueue>(params: Readonly<{
    enabled: boolean;
    resumeIdFromArgs: string | null;
    requestedDirectory: string;
    startedBy: 'cli' | 'daemon';
    hasTtyForTerminalRuntime: boolean;
    nowMs: () => number;
    timing: StartupTiming | null;
    messageQueue: TMessageQueue;
    initialPermissionMode: PermissionMode;
    requireCodexTerminalRuntimeLaunch: () => Promise<TerminalRuntimeLaunch<TMessageQueue>>;
}>): Promise<Readonly<{
    deferredSession: DeferredApiSessionClient | null;
    terminalLauncherPromise: Promise<CodexTerminalRuntimeLaunchResult> | null;
    attachDeferredSessionIfNeeded: (target: ApiSessionClient) => Promise<void>;
}>> {
    let deferredSession: DeferredApiSessionClient | null = null;
    let terminalLauncherPromise: Promise<CodexTerminalRuntimeLaunchResult> | null = null;

    let deferredSessionAttached = false;
    const attachDeferredSessionIfNeeded = async (target: ApiSessionClient): Promise<void> => {
        if (!deferredSession) return;
        if (deferredSessionAttached) return;
        deferredSessionAttached = true;
        await deferredSession.attach(target as any);
    };

    if (!params.enabled) {
        return { deferredSession, terminalLauncherPromise, attachDeferredSessionIfNeeded };
    }

    const ctx: StartupContext = {
        backendId: 'codex',
        sessionKind: params.resumeIdFromArgs ? 'resume' : 'fresh',
        startingModeIntent: 'local',
        startedBy: params.startedBy,
        hasTty: params.hasTtyForTerminalRuntime,
        workspaceDir: params.requestedDirectory,
        nowMs: params.nowMs,
        timing: params.timing,
    };

    const spec: BackendStartupSpec<CodexFastStartArtifacts> = {
        backendId: 'codex',
        createArtifacts: () => ({
            deferredSession: new DeferredApiSessionClient({
                placeholderSessionId: `PID-${process.pid}`,
                limits: {
                    maxEntries: configuration.startupDeferredSessionBufferMaxEntries,
                    maxBytes: configuration.startupDeferredSessionBufferMaxBytes,
                },
            }),
            terminalResult: null,
        }),
        tasks: [],
        spawnVendor: async ({ artifacts }) => {
            const launchTerminalRuntime = await params.requireCodexTerminalRuntimeLaunch();
            artifacts.terminalResult = await launchTerminalRuntime({
                path: params.requestedDirectory,
                api: null,
                session: artifacts.deferredSession as unknown as ApiSessionClient,
                messageQueue: params.messageQueue,
                permissionMode: params.initialPermissionMode,
                resumeId: params.resumeIdFromArgs,
            });
        },
    };

    const coordinator = runStartupCoordinator({ ctx, spec });
    deferredSession = coordinator.artifacts.deferredSession;
    terminalLauncherPromise = coordinator.spawnPromise.then(() => {
        const res = coordinator.artifacts.terminalResult;
        return res ?? { type: 'exit', code: 0 };
    });

    return { deferredSession, terminalLauncherPromise, attachDeferredSessionIfNeeded };
}
