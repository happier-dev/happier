import type { TerminalInputInjectionResult } from '@happier-dev/agents';

export type ClaudeUnifiedInjectionFailureAction =
  | Readonly<{ kind: 'retry'; retryAfterMs: number }>
  | Readonly<{ kind: 'await_provider_confirmation'; timeoutMs: number }>
  | Readonly<{ kind: 'terminal_failure' }>;

export type ClaudeUnifiedInjectionFailurePolicyOptions = Readonly<{
  retryAttempt: number;
  retryLimit: number;
  retryBaseDelayMs: number;
  providerAcceptanceTimeoutMs: number;
}>;

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

export function classifyClaudeUnifiedInjectionFailure(
  failure: Extract<TerminalInputInjectionResult, { status: 'failed' }>,
  options: ClaudeUnifiedInjectionFailurePolicyOptions,
): ClaudeUnifiedInjectionFailureAction {
  if (!failure.recoverable) {
    return { kind: 'terminal_failure' };
  }

  if (failure.duplicateRisk !== 'none' || failure.reason === 'ambiguous_provider_acceptance') {
    return {
      kind: 'await_provider_confirmation',
      timeoutMs: nonNegativeInteger(options.providerAcceptanceTimeoutMs),
    };
  }

  const retryAttempt = nonNegativeInteger(options.retryAttempt);
  const retryLimit = nonNegativeInteger(options.retryLimit);
  if (retryAttempt >= retryLimit) {
    return { kind: 'terminal_failure' };
  }

  return {
    kind: 'retry',
    retryAfterMs: nonNegativeInteger(options.retryBaseDelayMs * (2 ** retryAttempt)),
  };
}
