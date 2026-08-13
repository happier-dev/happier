export type TerminalHostKind = 'tmux' | 'zellij' | 'windows_console';

export type TerminalInjectionFailurePhase =
  | 'before_write'
  | 'during_write'
  | 'after_write_before_enter'
  | 'after_enter_unknown'
  | 'liveness'
  | 'readiness';

export type TerminalInjectionDuplicateRisk = 'none' | 'possible' | 'likely';

export type TerminalInputInjectionDeferredBlocker =
  | Readonly<{
      kind: 'runtime_config_blocked';
      source: 'runtime_control';
      blockedReason?: string | null | undefined;
    }>
  | Readonly<{
      kind: 'terminal_user_draft' | 'own_leftover_clear_failed' | 'capture_ambiguous';
      source: 'draft_guard' | 'readiness';
      guardStatus?: 'foreign_draft' | 'capture_style_unavailable' | 'clear_failed' | undefined;
      draftLength?: number | undefined;
    }>
  | Readonly<{
      kind: 'provider_unavailable';
      source: 'draft_guard' | 'readiness';
      detail?: string | undefined;
    }>
  | Readonly<{
      kind: 'pane_initializing' | 'terminal_busy';
      source: 'terminal_injection' | 'readiness';
      detail?: string | undefined;
    }>;

export type TerminalPromptInput = Readonly<{
  text: string;
  multiline: boolean;
  origin: Readonly<{
    kind: 'ui_pending' | 'ui_immediate' | 'rpc';
    clientId?: string | undefined;
    nonce: string;
  }>;
  scheduling: Readonly<{
    deferredUntilQuietMs?: number | undefined;
    deferReason?: Extract<TerminalInputInjectionResult, { status: 'deferred' }>['reason'] | undefined;
    retryAfterMs?: number | undefined;
    timeoutMs?: number | undefined;
  }>;
}>;

export type TerminalInputInjectionResult =
  | Readonly<{ status: 'injected'; at: number; bytesWritten: number }>
  | Readonly<{
      status: 'deferred';
      reason: 'user_typing' | 'terminal_busy' | 'permission_blocked' | 'pane_initializing';
      retryAfterMs?: number | undefined;
      blocker?: TerminalInputInjectionDeferredBlocker | undefined;
    }>
  | Readonly<{
      status: 'failed';
      reason: 'pane_dead' | 'no_target' | 'host_unreachable' | 'verification_failed' | 'timeout' | 'invalid_prompt_text' | 'payload_too_large';
      phase: TerminalInjectionFailurePhase;
      duplicateRisk: TerminalInjectionDuplicateRisk;
      recoverable: boolean;
    }>;

/**
 * Optional local authorization gate invoked by a terminal host at its final
 * pre-byte-write boundary, after host-specific liveness/readiness checks.
 */
export type TerminalPromptWriteBoundaryV1 = Readonly<{
  authorizeBeforeWrite: () => boolean | Promise<boolean>;
}>;

export type TerminalInputInjectionV1 = Readonly<{
  hostKind: TerminalHostKind;
  injectUserPrompt(
    input: TerminalPromptInput,
    writeBoundary?: TerminalPromptWriteBoundaryV1,
  ): Promise<TerminalInputInjectionResult>;
}>;
