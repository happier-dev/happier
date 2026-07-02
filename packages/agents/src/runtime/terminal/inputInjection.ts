export type TerminalHostKind = 'tmux' | 'zellij';

export type TerminalInjectionFailurePhase =
    | 'liveness'
    | 'readiness'
    | 'before_write'
    | 'during_write'
    | 'after_write_before_enter'
    | 'after_enter_unknown';

export type TerminalInjectionDuplicateRisk = 'none' | 'possible' | 'likely';

export type TerminalPromptInput = Readonly<{
    text: string;
    multiline: boolean;
    origin: Readonly<{
        kind: 'ui_pending' | 'ui_immediate' | 'rpc';
        clientId?: string;
        nonce: string;
    }>;
    scheduling: Readonly<{
        deferredUntilQuietMs?: number;
        deferReason?: Extract<TerminalInputInjectionResult, { status: 'deferred' }>['reason'];
        retryAfterMs?: number;
        timeoutMs?: number;
    }>;
}>;

export type TerminalInputInjectionResult =
    | Readonly<{
        status: 'injected';
        injectedAt: number;
        bytesWritten: number;
        hostKind: TerminalHostKind;
        hostSessionName: string;
        paneId?: string;
    }>
    | Readonly<{
        status: 'deferred';
        reason:
            | 'permission'
            | 'user_typing'
            | 'finalizing'
            | 'host_not_ready'
            | 'liveness_uncertain'
            | 'provider_starting'
            | 'awaiting_provider_acceptance';
        recoverable: true;
        observedAt: number;
        hostKind?: TerminalHostKind;
        hostSessionName?: string;
        paneId?: string;
    }>
    | Readonly<{
        status: 'failed';
        reason:
            | 'pane_dead'
            | 'no_target'
            | 'host_unreachable'
            | 'timeout'
            | 'write_failed'
            | 'submit_failed'
            | 'ambiguous_provider_acceptance'
            | 'unsupported';
        phase: TerminalInjectionFailurePhase;
        recoverable: boolean;
        duplicateRisk: TerminalInjectionDuplicateRisk;
        observedAt: number;
        hostKind?: TerminalHostKind;
        hostSessionName?: string;
        paneId?: string;
        diagnostic?: string;
    }>;

export type TerminalInputInjectionV1 = Readonly<{
    hostKind: TerminalHostKind;
    injectUserPrompt(input: TerminalPromptInput): Promise<TerminalInputInjectionResult>;
}>;
