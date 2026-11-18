import type { AttachSurfaceStaticMetadataV1 } from '@happier-dev/protocol';

import type { TerminalControlPort } from './control.js';
import type {
    TerminalHostKind,
    TerminalInputInjectionResult,
    TerminalPromptInput,
} from './inputInjection.js';
import type { TerminalHostLivenessV1 } from './inputReadiness.js';

/** The host a person asks for. `windows_console` (the Windows hidden console) is served by the `pty` host. */
export type TerminalHostPreference = 'auto' | 'tmux' | 'zellij' | 'herdr' | 'windows_console';

declare const terminalAttachmentIdBrand: unique symbol;

export type TerminalAttachmentId = string & Readonly<{
    [terminalAttachmentIdBrand]: 'TerminalAttachmentId';
}>;

export type TerminalHostAttachMetadata = AttachSurfaceStaticMetadataV1 & Readonly<{
    attachStrategy: 'terminal_host';
}>;

export type TerminalHostHandle = Readonly<{
    attachmentId?: TerminalAttachmentId;
    kind: TerminalHostKind;
    sessionName: string;
    paneId?: string;
    socketDir?: string;
    socketPath?: string;
    terminalId?: string;
    expectedCommandFragments?: readonly string[];
    attachMetadata: TerminalHostAttachMetadata;
}>;

export type TerminalInputState = Readonly<{
    stable: boolean;
    currentInput: string;
    /** Zero-based terminal cursor position when the host can report it. */
    cursor?: Readonly<{ x: number; y: number }>;
    observedAt: number;
}>;

export type TerminalHostAdapter = Readonly<{
    kind: TerminalHostKind;
    /** Validate admission to a recovered host before launching into it; never create or replace it. */
    validateExistingHostAdmission?(handle: TerminalHostHandle): Promise<void>;
    createOrAttachHost(opts: Readonly<{
        sessionName: string;
        label?: string;
        workingDirectory: string;
        spawnArgv: readonly string[];
        spawnEnv: Readonly<Record<string, string>>;
        unsetEnvKeys?: readonly string[];
        isolatedEnv: boolean;
    }>): Promise<TerminalHostHandle>;
    injectUserPrompt(handle: TerminalHostHandle, input: TerminalPromptInput): Promise<TerminalInputInjectionResult>;
    interruptTurn(handle: TerminalHostHandle): Promise<void>;
    evaluateLiveness(handle: TerminalHostHandle): Promise<TerminalHostLivenessV1>;
    captureInputState?(handle: TerminalHostHandle): Promise<TerminalInputState>;
    /**
     * Raw control port for provider-owned TUI runtime controls (model/effort/permission-mode).
     * Optional: hosts without verified raw send/capture primitives simply omit it, and the
     * runtime-control feature stays unavailable rather than degrading to best-effort writes.
     * Never route user prompts through this port; that stays on {@link injectUserPrompt}.
     */
    createControlPort?(handle: TerminalHostHandle): TerminalControlPort;
    dispose(handle: TerminalHostHandle): Promise<void>;
}>;
