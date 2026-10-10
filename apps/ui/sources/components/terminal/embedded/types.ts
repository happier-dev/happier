import type { EmbeddedTerminalWriteCompleteEvent } from './embeddedTerminalRendererHandle';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';

export type EmbeddedTerminalPaneStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'exited';

export type EmbeddedTerminalDetectedUrl = Readonly<{
    url: string;
    kind: 'auth' | 'generic';
    suggestOpen?: boolean;
}> | null;

export type EmbeddedTerminalPaneController = Readonly<{
    status: EmbeddedTerminalPaneStatus;
    error: string | null;
    detectedUrl: EmbeddedTerminalDetectedUrl;
    onInput: (data: string) => void;
    onPaste: (data: string) => void | Promise<unknown>;
    onLink?: (url: string) => void;
    onTitle?: (title: string) => void;
    onBell?: (label: string) => void;
    terminalTitle?: string | null;
    terminalBell?: string | null;
    approvalPending?: boolean;
    approvalId?: string | null;
    approvalServerId?: string;
    onOpenApproval?: () => void;
    copySelection?: (request?: Readonly<{
        source: 'user-selection' | 'remote-osc52';
        text: string;
    }>) => void;
    onResize: (cols: number, rows: number) => void;
    onReady: (cols: number, rows: number) => void;
    onWriteComplete: (event: EmbeddedTerminalWriteCompleteEvent) => void;
    clearTerminal: () => void;
    requestRestart: (context?: ActionExecutorContext) => void;
    retryConnect: () => void;
    dismissDetectedUrl: () => void;
}>;
