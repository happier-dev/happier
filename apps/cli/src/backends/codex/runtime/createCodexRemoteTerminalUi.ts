import type { render } from 'ink';

import { cleanupStdinAfterInk } from '@/ui/ink/cleanupStdinAfterInk';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createNonBlockingStdout } from '@/ui/ink/nonBlockingStdout';
import { logger } from '@/ui/logger';
import {
    startRemoteModeStaticControl,
    type RemoteModeControlSurface,
    type RemoteModeStaticControl,
} from '@/ui/remoteControl/remoteModeControl';

async function loadCodexInkUi() {
    const [{ render }, { default: React }, { CodexTerminalDisplay }] = await Promise.all([
        import('ink'),
        import('react'),
        import('@/backends/codex/ui/CodexTerminalDisplay'),
    ]);
    return { render, React, CodexTerminalDisplay };
}

type CodexInkUi = Awaited<ReturnType<typeof loadCodexInkUi>>;

export function createCodexRemoteTerminalUi(params: {
    messageBuffer: MessageBuffer;
    logPath?: string;
    hasTTY: boolean;
    surface?: RemoteModeControlSurface;
    stdin: NodeJS.ReadStream;
    stdout?: NodeJS.WriteStream;
    onExit: () => Promise<void>;
    onSwitchToLocal: () => Promise<void>;
}) {
    let inkInstance: ReturnType<typeof render> | null = null;
    let staticControl: RemoteModeStaticControl | null = null;
    let allowSwitchToLocal = false;
    const surface: RemoteModeControlSurface = params.surface ?? (params.hasTTY ? 'ink' : 'none');
    // Ink and React load on the first ink mount, so runners that never show the ink surface never load them.
    let inkUi: CodexInkUi | null = null;
    let inkUiLoad: Promise<CodexInkUi> | null = null;
    let inkRequested = false;
    // An unmount drains stdin, then restores cooked mode and pauses it; a remount must not render until that finishes.
    let unmountInFlight: Promise<void> | null = null;

    const renderRemoteUi = (ui: CodexInkUi) => ui.React.createElement(ui.CodexTerminalDisplay, {
        messageBuffer: params.messageBuffer,
        logPath: params.logPath,
        allowSwitchToLocal,
        onExit: params.onExit,
        onSwitchToLocal: params.onSwitchToLocal,
    });

    const mount = () => {
        if (surface === 'static') {
            if (!staticControl) {
                staticControl = startRemoteModeStaticControl({
                    providerName: 'Codex',
                    stdin: params.stdin,
                    stdout: params.stdout ?? process.stdout,
                    allowSwitchToLocal,
                    onExit: params.onExit,
                    onSwitchToLocal: params.onSwitchToLocal,
                });
            }
            return;
        }
        if (surface !== 'ink' || !params.hasTTY) return;
        inkRequested = true;
        if (inkUi && !unmountInFlight) {
            try {
                renderInk(inkUi);
            } catch (error) {
                reportInkFailure(error);
            }
            return;
        }
        inkUiLoad ??= loadCodexInkUi().catch((error: unknown) => {
            inkUiLoad = null;
            throw error;
        });
        void Promise.all([inkUiLoad, unmountInFlight])
            .then(([ui]) => {
                inkUi = ui;
                if (inkRequested && !unmountInFlight) renderInk(ui);
            })
            .catch(reportInkFailure);
    };

    // The terminal UI is a local convenience view: a failure to load or render it is
    // logged and leaves the session running for remote clients.
    const reportInkFailure = (error: unknown) => {
        logger.warnFile('[codex] Failed to show the terminal display', error);
    };

    const renderInk = (ui: CodexInkUi) => {
        if (!inkInstance) {
            console.clear();
            inkInstance = ui.render(renderRemoteUi(ui), {
                exitOnCtrlC: false,
                patchConsole: false,
                stdout: createNonBlockingStdout(process.stdout as any),
            });

            params.stdin.resume();
            if (params.stdin.isTTY) {
                params.stdin.setRawMode(true);
            }
            params.stdin.setEncoding('utf8');
            return;
        }
        inkInstance.rerender(renderRemoteUi(ui));
    };

    const unmount = (): Promise<void> => {
        inkRequested = false;
        const unmounting = unmountUi().finally(() => {
            if (unmountInFlight === unmounting) unmountInFlight = null;
        });
        unmountInFlight = unmounting;
        return unmounting;
    };

    const unmountUi = async () => {
        if (staticControl) {
            await staticControl.stop();
            staticControl = null;
        }
        if (surface !== 'ink' || !params.hasTTY) return;
        if (params.stdin.isTTY) {
            try {
                params.stdin.setRawMode(false);
            } catch {
                // ignore
            }
        }
        if (inkInstance) {
            try {
                inkInstance.unmount();
            } catch {
                // ignore
            }
            inkInstance = null;
        }
        await cleanupStdinAfterInk({ stdin: params.stdin as any, drainMs: 75 });
        try {
            params.stdin.pause();
        } catch {
            // ignore
        }
    };

    const setAllowSwitchToLocal = (allowed: boolean) => {
        allowSwitchToLocal = allowed;
        if (staticControl) {
            void staticControl.stop();
            staticControl = startRemoteModeStaticControl({
                providerName: 'Codex',
                stdin: params.stdin,
                stdout: params.stdout ?? process.stdout,
                allowSwitchToLocal,
                onExit: params.onExit,
                onSwitchToLocal: params.onSwitchToLocal,
            });
        }
        if (inkUi && inkInstance) {
            inkInstance.rerender(renderRemoteUi(inkUi));
        }
    };

    return {
        mount,
        unmount,
        setAllowSwitchToLocal,
    };
}
