import type {
    TerminalHostKind,
    TerminalInjectionDuplicateRisk,
} from './inputInjection.js';

export type TerminalHostLivenessV1 = Readonly<{
    paneAlive: boolean;
    paneDead?: boolean;
    panePid?: number;
    paneCurrentCommand?: string;
    paneExitStatus?: number;
    paneScreenDumpCaptured?: boolean;
    paneScreenDumpTruncated?: boolean;
    paneScreenDumpError?: string;
    observedAt: number;
}>;

export type TerminalInputReadinessStatusV1 =
    | 'writable'
    | 'defer_finalizing'
    | 'defer_permission'
    | 'defer_user_typing'
    | 'defer_host_not_ready'
    | 'defer_liveness_uncertain'
    | 'defer_provider_starting'
    | 'awaiting_provider_acceptance'
    | 'failed_retryable'
    | 'failed_ambiguous'
    | 'failed_terminal';

export type TerminalInputReadinessV1 = Readonly<{
    status: TerminalInputReadinessStatusV1;
    observedAt: number;
    reason?: string;
    activeTurnId?: string;
    pendingPromptId?: string;
    providerSessionId?: string;
    hostKind?: TerminalHostKind;
    hostSessionName?: string;
    paneId?: string;
    liveness?: TerminalHostLivenessV1;
    recoverable?: boolean;
    duplicateRisk?: TerminalInjectionDuplicateRisk;
}>;
