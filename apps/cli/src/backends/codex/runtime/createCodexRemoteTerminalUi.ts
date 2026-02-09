import { render } from 'ink';
import React from 'react';

import { cleanupStdinAfterInk } from '@/ui/ink/cleanupStdinAfterInk';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { CodexTerminalDisplay } from '@/backends/codex/ui/CodexTerminalDisplay';

export function createCodexRemoteTerminalUi(params: {
    messageBuffer: MessageBuffer;
    logPath?: string;
    hasTTY: boolean;
    stdin: NodeJS.ReadStream;
    onExit: () => Promise<void>;
    onSwitchToLocal: () => Promise<void>;
}) {
    let inkInstance: ReturnType<typeof render> | null = null;
    let allowSwitchToLocal = false;

    const renderRemoteUi = () => React.createElement(CodexTerminalDisplay, {
        messageBuffer: params.messageBuffer,
        logPath: params.logPath,
        allowSwitchToLocal,
        onExit: params.onExit,
        onSwitchToLocal: params.onSwitchToLocal,
    });

    const mount = () => {
        if (!params.hasTTY) return;
        if (!inkInstance) {
            console.clear();
            inkInstance = render(renderRemoteUi(), {
                exitOnCtrlC: false,
                patchConsole: false,
            });

            params.stdin.resume();
            if (params.stdin.isTTY) {
                params.stdin.setRawMode(true);
            }
            params.stdin.setEncoding('utf8');
            return;
        }
        inkInstance.rerender(renderRemoteUi());
    };

    const unmount = async () => {
        if (!params.hasTTY) return;
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
        if (inkInstance) {
            inkInstance.rerender(renderRemoteUi());
        }
    };

    return {
        mount,
        unmount,
        setAllowSwitchToLocal,
    };
}
