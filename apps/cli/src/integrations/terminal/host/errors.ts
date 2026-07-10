import type { TerminalHostKind } from './_types';

export const TERMINAL_HOST_STARTUP_ERROR_CODE = 'terminal_host_startup_failed';

export type TerminalHostStartupFailureReason =
  | 'startup_action_timeout'
  | 'pane_disappeared_after_bootstrap_cleanup';

export type TerminalHostStartupErrorParams = Readonly<{
  hostKind: TerminalHostKind;
  reason: TerminalHostStartupFailureReason;
  message: string;
  diagnostics?: Readonly<Record<string, unknown>> | undefined;
}>;

export class TerminalHostStartupError extends Error {
  readonly code = TERMINAL_HOST_STARTUP_ERROR_CODE;
  readonly hostKind: TerminalHostKind;
  readonly reason: TerminalHostStartupFailureReason;
  readonly diagnostics?: Readonly<Record<string, unknown>> | undefined;

  constructor(params: TerminalHostStartupErrorParams) {
    super(params.message);
    this.name = 'TerminalHostStartupError';
    this.hostKind = params.hostKind;
    this.reason = params.reason;
    this.diagnostics = params.diagnostics;
  }
}

function isTerminalHostKind(value: unknown): value is TerminalHostKind {
  return value === 'tmux' || value === 'zellij';
}

function isTerminalHostStartupFailureReason(value: unknown): value is TerminalHostStartupFailureReason {
  return value === 'startup_action_timeout'
    || value === 'pane_disappeared_after_bootstrap_cleanup';
}

export function isTerminalHostStartupError(error: unknown): error is TerminalHostStartupError {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & Readonly<{
    code?: unknown;
    hostKind?: unknown;
    reason?: unknown;
  }>;
  return candidate.code === TERMINAL_HOST_STARTUP_ERROR_CODE
    && isTerminalHostKind(candidate.hostKind)
    && isTerminalHostStartupFailureReason(candidate.reason);
}
