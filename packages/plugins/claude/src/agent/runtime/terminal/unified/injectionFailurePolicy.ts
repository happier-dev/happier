import type { TerminalInputInjectionResult } from '@happier-dev/plugin-sdk/agents/runtime';

export type ClaudeUnifiedInjectionFailureAction =
  | Readonly<{ kind: 'retry' }>
  | Readonly<{ kind: 'await_provider_confirmation' }>
  | Readonly<{ kind: 'handoff_ambiguous_failure' }>
  | Readonly<{ kind: 'terminal_failure' }>;

export function classifyClaudeUnifiedInjectionFailure(
  failure: Extract<TerminalInputInjectionResult, { status: 'failed' }>,
): ClaudeUnifiedInjectionFailureAction {
  if (!failure.recoverable) {
    return { kind: 'terminal_failure' };
  }

  if (
    failure.phase === 'after_enter_unknown'
    || failure.reason === 'ambiguous_provider_acceptance'
  ) {
    return { kind: 'await_provider_confirmation' };
  }

  if (failure.duplicateRisk !== 'none') {
    return { kind: 'handoff_ambiguous_failure' };
  }

  return { kind: 'retry' };
}
