import type { AgentDeferredStartupEligibilityInputV1 } from '@happier-dev/plugin-sdk/agents/runtime';

/**
 * Codex's narrow eligibility policy for the host-owned deferred Session
 * bootstrap. The persisted permission seed is a host-provided lifecycle fact;
 * this policy neither reads nor writes the released compatibility cache.
 */
export function shouldUseCodexDeferredBootstrap(
  params: AgentDeferredStartupEligibilityInputV1,
): boolean {
  const terminalLocal = params.startingMode === null
    || params.startingMode === 'terminal'
    || params.startingMode === 'local';
  return params.startedBy === 'terminal'
    && params.hasTerminalTty
    && terminalLocal
    && !params.hasExistingSession
    && (
      !params.hasProviderResumeId
      || params.hasExplicitPermissionMode
      || params.hasPersistedPermissionModeSeed
    );
}
