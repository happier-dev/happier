import type { ApiSessionClient } from '@/api/session/sessionClient';
import { resolveHasTTY } from '@/ui/tty/resolveHasTTY';
import type { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { applyTerminalRemoteLaunchGating } from '@/agent/runtime/mode/switching/launchGating';
import { createTerminalRemoteModeController } from '@/agent/runtime/mode/switching/createModeController';
import { createCodexRemoteTerminalUi } from '../runtime/remote/createRemoteTerminalUi';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import { formatErrorForUi } from '@/ui/formatErrorForUi';
import { logger } from '@/ui/logger';
import { resolveRemoteModeControlSurface } from '@/ui/remoteControl/remoteModeControl';
import type { TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';

import { requestSwitchToTerminal } from './requestSwitchToTerminal';
import { formatCodexTerminalRuntimeSwitchDeniedMessage } from '../terminalRuntime/terminalRuntimeSupport';

export type CodexTerminalRuntimeUnsupportedReason =
    import('../terminalRuntime/terminalRuntimeSupport').CodexTerminalRuntimeUnsupportedReason;
export type CodexTerminalRuntimeSupportDecision =
    import('../terminalRuntime/terminalRuntimeSupport').CodexTerminalRuntimeSupportDecision;

export type CodexTerminalSwitchAvailability =
    | { ok: true }
    | { ok: false; reason: CodexTerminalRuntimeUnsupportedReason };

export type CodexSwitchToTerminalBarrier = Readonly<{ promise: Promise<void>; resolve: () => void }>;

const createSwitchToTerminalBarrier = (): { promise: Promise<void>; resolve: () => void } => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
        resolve = r;
    });
    return { promise, resolve };
};

export type CodexRuntimeSwitchController = Readonly<{
    remoteTerminalUi: ReturnType<typeof createCodexRemoteTerminalUi>;
    terminalRemoteSwitchController: ReturnType<typeof createTerminalRemoteModeController>;
    requestSwitchToTerminalIfSupported: () => Promise<boolean>;
    isTerminalSwitchRequested: () => boolean;
    getSwitchToTerminalBarrier: () => CodexSwitchToTerminalBarrier;
    resetTerminalSwitchState: () => void;
}>;

export async function createCodexRuntimeSwitchController<TMode extends { localId?: string | null }>(params: Readonly<{
    startedBy?: 'terminal' | 'daemon';
    messageBuffer: MessageBuffer;
    session: ApiSessionClient;
    messageQueue: MessageQueue2<TMode, string>;
    getKeepAliveActive: () => boolean;
    setShouldExit: (value: boolean) => void;
    handleAbort: () => Promise<void>;
    abortStartOrLoad: () => void;
    resolveTerminalRuntimeSupport: (args: { includeAcpProbe: boolean }) => Promise<CodexTerminalRuntimeSupportDecision>;
    stdin: NodeJS.ReadStream;
    terminalRuntime?: TerminalRuntimeFlags | null;
}>): Promise<CodexRuntimeSwitchController> {
    const hasTTY = resolveHasTTY({
        stdoutIsTTY: process.stdout.isTTY,
        stdinIsTTY: process.stdin.isTTY,
        startedBy: params.startedBy,
    });
    const remoteControlSurface = params.startedBy === 'daemon'
        ? resolveRemoteModeControlSurface({
            stdoutIsTTY: process.stdout.isTTY,
            stdinIsTTY: process.stdin.isTTY,
            startedBy: params.startedBy,
            terminalMode: params.terminalRuntime?.mode ?? null,
        })
        : hasTTY
            ? 'ink'
            : 'none';

    let requestedSwitchToTerminal = false;
    let switchToTerminalBarrier = createSwitchToTerminalBarrier();

    const resolveTerminalSwitchAvailability = async (): Promise<CodexTerminalSwitchAvailability> => {
        const support = await params.resolveTerminalRuntimeSupport({ includeAcpProbe: false });
        const gated = applyTerminalRemoteLaunchGating({ startingMode: 'local', support });
        if (gated.mode === 'local') return { ok: true };
        return {
            ok: false,
            reason: (gated.fallback?.reason ?? 'resume-disabled') as CodexTerminalRuntimeUnsupportedReason,
        };
    };

    const requestTerminalSwitch = async (): Promise<void> => {
        if (requestedSwitchToTerminal) return;
        requestedSwitchToTerminal = true;
        switchToTerminalBarrier.resolve();
        params.abortStartOrLoad();
        await params.handleAbort();
    };

    const requestSwitchToTerminalIfSupported = async (): Promise<boolean> => {
        return await requestSwitchToTerminal({
            queue: params.messageQueue,
            session: params.session,
            resolveLocalSwitchAvailability: resolveTerminalSwitchAvailability,
            requestSwitch: requestTerminalSwitch,
            formatSwitchDeniedMessage: (reason) => {
                const message = formatCodexTerminalRuntimeSwitchDeniedMessage(reason);
                params.messageBuffer.addMessage(message, 'status');
                return message;
            },
            formatError: formatErrorForUi,
        });
    };

    const remoteTerminalUi = createCodexRemoteTerminalUi({
        messageBuffer: params.messageBuffer,
        logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
        hasTTY,
        surface: remoteControlSurface,
        stdin: params.stdin,
        onExit: async () => {
            logger.debug('[codex]: Exiting agent via Ctrl-C');
            params.setShouldExit(true);
            await params.handleAbort();
        },
        onSwitchToTerminal: async () => {
            await requestSwitchToTerminalIfSupported();
        },
    });

    const terminalRemoteSwitchController = createTerminalRemoteModeController({
        session: params.session,
        getKeepAliveActive: params.getKeepAliveActive,
        resolveTerminalSwitchAvailability: resolveTerminalSwitchAvailability,
        requestSwitchToTerminalIfSupported: requestSwitchToTerminalIfSupported,
        mountRemoteUi: () => remoteTerminalUi.mount(),
        unmountRemoteUi: () => remoteTerminalUi.unmount(),
        setRemoteUiAllowsSwitchToTerminal: (allowed) => remoteTerminalUi.setAllowSwitchToTerminal(allowed),
    });

    terminalRemoteSwitchController.registerRemoteSwitchHandler();

    return {
        remoteTerminalUi,
        terminalRemoteSwitchController,
        requestSwitchToTerminalIfSupported,
        isTerminalSwitchRequested: () => requestedSwitchToTerminal,
        getSwitchToTerminalBarrier: () => switchToTerminalBarrier,
        resetTerminalSwitchState: () => {
            requestedSwitchToTerminal = false;
            switchToTerminalBarrier = createSwitchToTerminalBarrier();
        },
    };
}
