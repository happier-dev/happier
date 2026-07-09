import type {
    TerminalControlPort,
    TerminalHostHandle,
    TerminalHostKind,
    TerminalHostLivenessV1,
    TerminalHostPreference,
    TerminalInputInjectionResult,
    TerminalInputState,
    TerminalPromptInput,
} from '@happier-dev/agents';

import type { ExecAgentCliLaunchInputV1 } from './exec.js';

export type TerminalHostResolutionReasonV1 =
    | 'tmux_available'
    | 'tmux_forced'
    | 'tmux_unavailable'
    | 'tmux_unsupported_on_windows'
    | 'zellij_forced'
    | 'zellij_unavailable'
    | 'zellij_unavailable_tmux_fallback'
    | 'windows_console_available'
    | 'windows_console_forced'
    | 'windows_console_unavailable'
    | 'windows_zellij_unvalidated'
    | 'windows_arm64_unsupported'
    | 'no_host_available';

export type TerminalHostResolveRequestV1 = Readonly<{
    preference: TerminalHostPreference;
}>;

export type TerminalHostResolveResultV1 =
    | Readonly<{
        status: 'resolved';
        hostKind: TerminalHostKind;
        reason: TerminalHostResolutionReasonV1;
    }>
    | Readonly<{
        status: 'disabled';
        reason: TerminalHostResolutionReasonV1;
        message: string;
    }>;

export type TerminalHostCreateOrAttachRequestV1 = Readonly<{
    preference: TerminalHostPreference;
    sessionName: string;
    workingDirectory: string;
    launch: ExecAgentCliLaunchInputV1;
    isolatedEnv: boolean;
}>;

export interface TerminalHostRuntimeServiceV1 {
    resolve(request: TerminalHostResolveRequestV1): Promise<TerminalHostResolveResultV1>;
    createOrAttachHost(request: TerminalHostCreateOrAttachRequestV1): Promise<TerminalHostHandle>;
    injectUserPrompt(handle: TerminalHostHandle, input: TerminalPromptInput): Promise<TerminalInputInjectionResult>;
    interruptTurn(handle: TerminalHostHandle): Promise<void>;
    evaluateLiveness(handle: TerminalHostHandle): Promise<TerminalHostLivenessV1>;
    captureInputState(handle: TerminalHostHandle): Promise<TerminalInputState | null>;
    /**
     * Raw terminal-control port for provider-owned TUI runtime controls. Returns `null` when the
     * resolved host adapter does not expose verified control primitives; callers must treat that
     * as "runtime controls unavailable", never fall back to {@link injectUserPrompt}.
     */
    controlPort(handle: TerminalHostHandle): Promise<TerminalControlPort | null>;
    dispose(handle: TerminalHostHandle): Promise<void>;
}
