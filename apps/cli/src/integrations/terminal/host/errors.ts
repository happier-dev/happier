import type { TerminalHostKind } from './_types';
import { TerminalHostUnavailableSpawnErrorDetailSchema } from '@happier-dev/protocol/spawnSession';
import type { TerminalHostUnavailableSpawnErrorDetail } from '@happier-dev/protocol';

export const TERMINAL_HOST_STARTUP_ERROR_CODE = 'terminal_host_startup_failed';

export type TerminalHostCreationDisposition = 'not_created' | 'created_and_absent' | 'created_or_uncertain';
export type TerminalHostCreationFailure = Readonly<{
  creationDisposition: TerminalHostCreationDisposition;
  cleanupIncomplete: boolean;
}>;

/** Internal ownership evidence, not a replay policy or a public terminal-host wire shape. */
export class TerminalHostCreationError extends AggregateError implements TerminalHostCreationFailure {
  readonly creationDisposition: TerminalHostCreationDisposition;
  readonly cleanupIncomplete: boolean;

  constructor(errors: readonly unknown[], message: string, failure: TerminalHostCreationFailure) {
    super(errors, message, { cause: errors[0] });
    this.name = 'TerminalHostCreationError';
    this.creationDisposition = failure.creationDisposition;
    this.cleanupIncomplete = failure.cleanupIncomplete;
  }
}

export function resolveTerminalHostCreationFailure(error: unknown): TerminalHostCreationFailure {
  if (error instanceof TerminalHostCreationError) return error;
  if (error instanceof TerminalHostStartupError && error.creationFailure) return error.creationFailure;
  return { creationDisposition: 'created_or_uncertain', cleanupIncomplete: true };
}

export type TerminalHostStartupFailureReason =
  | 'installation_unavailable'
  | 'server_version_unsupported'
  | 'startup_action_timeout'
  | 'pane_disappeared_after_bootstrap_cleanup';

export type TerminalHostStartupErrorParams = Readonly<{
  hostKind: TerminalHostKind;
  reason: TerminalHostStartupFailureReason;
  message: string;
  diagnostics?: Readonly<Record<string, unknown>> | undefined;
  cause?: unknown;
  creationFailure?: TerminalHostCreationFailure;
}>;

export class TerminalHostStartupError extends Error {
  readonly code = TERMINAL_HOST_STARTUP_ERROR_CODE;
  readonly hostKind: TerminalHostKind;
  readonly reason: TerminalHostStartupFailureReason;
  readonly diagnostics?: Readonly<Record<string, unknown>> | undefined;
  readonly creationFailure?: TerminalHostCreationFailure;

  constructor(params: TerminalHostStartupErrorParams) {
    super(params.message, { cause: params.cause });
    this.name = 'TerminalHostStartupError';
    this.hostKind = params.hostKind;
    this.reason = params.reason;
    this.diagnostics = params.diagnostics;
    this.creationFailure = params.creationFailure;
  }
}

function isTerminalHostKind(value: unknown): value is TerminalHostKind {
  return value === 'tmux' || value === 'zellij' || value === 'herdr';
}

function isTerminalHostStartupFailureReason(value: unknown): value is TerminalHostStartupFailureReason {
  return value === 'installation_unavailable'
    || value === 'startup_action_timeout'
    || value === 'server_version_unsupported'
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

/** Publish only protocol-owned setup failures, never local diagnostics or causes. */
export function resolveTerminalHostUnavailableSpawnErrorDetail(error: unknown): TerminalHostUnavailableSpawnErrorDetail | undefined {
  if (!isTerminalHostStartupError(error)) return undefined;
  const detail = TerminalHostUnavailableSpawnErrorDetailSchema.safeParse({
    kind: 'terminal_host_unavailable', host: error.hostKind, reason: error.reason,
  });
  return detail.success ? detail.data : undefined;
}
