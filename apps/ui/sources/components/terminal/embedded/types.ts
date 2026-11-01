import type { EmbeddedTerminalWriteCompleteEvent } from './embeddedTerminalRendererHandle';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { TerminalOutputRetention } from '@/sync/domains/terminal/stream/model';

export type EmbeddedTerminalPaneStatus = 'idle' | 'connecting' | 'connected' | 'not-open' | 'error' | 'exited';

export type EmbeddedTerminalDetectedUrl = Readonly<{
    url: string;
    kind: 'auth' | 'generic';
    suggestOpen?: boolean;
}> | null;

export type EmbeddedTerminalPaneController = Readonly<{
    status: EmbeddedTerminalPaneStatus;
    /** A borrowed view of a process another lifecycle owns: it reads output, it never types, resets or restarts. */
    readOnly?: boolean;
    error: string | null;
    /** Native exit observed from the terminal's retained stream. */
    exitCode?: number | null;
    /** Native termination signal; zero means the process was not signalled. */
    exitSignal?: number | null;
    /** Canonical operation outcome, when this borrowed PTY belongs to an operation. */
    operationState?: ActionOperationSnapshotV1['state'] | null;
    /** The existing Stop control is pending or has an accepted request, not settlement. */
    operationStopPending?: boolean;
    /** What the daemon still retains of this terminal's output; null while unknown (legacy transport, not yet read). */
    outputRetention?: TerminalOutputRetention | null;
    /** `error` that followed a connected stream: the terminal started, then its connection dropped. */
    connectionLost?: boolean;
    inputRecoveryAvailable?: boolean;
    copyInputRecovery?: () => Promise<void>;
    discardInputRecovery?: () => void;
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
