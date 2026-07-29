import type { ClaudeProviderDisposeReason } from '../../providerOperations.js';

type ClaudeTerminalHostDisposeIntent =
  | Readonly<{
      kind: 'preserve_host';
      reason: 'plugin_deactivated' | 'host_shutdown' | 'runtime_recovery' | 'unspecified';
    }>
  | Readonly<{
      kind: 'destroy_owned_host';
      reason: 'session_closed';
    }>;

export function resolveClaudeTerminalHostDisposeIntent(
  input:
    | ClaudeProviderDisposeReason
    | Readonly<{ reason?: ClaudeProviderDisposeReason }>
    | undefined,
): ClaudeTerminalHostDisposeIntent {
  const reason = typeof input === 'string' ? input : input?.reason;
  if (reason === 'session_closed') {
    return { kind: 'destroy_owned_host', reason: 'session_closed' };
  }
  return {
    kind: 'preserve_host',
    reason: reason === 'plugin_deactivated'
      ? 'plugin_deactivated'
      : reason === 'host_shutdown'
        ? 'host_shutdown'
        : reason === 'runtime_recovery'
          ? 'runtime_recovery'
          : 'unspecified',
  };
}
