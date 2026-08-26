import type { AgentDeferredStartupEligibilityInputV1 } from '@happier-dev/plugin-sdk/agents/runtime';

/**
 * Claude's narrow eligibility policy for the host-owned deferred Session
 * bootstrap. Session creation, attachment, cancellation, and cleanup remain
 * host-owned.
 */
export function shouldUseClaudeDeferredBootstrap(
  params: AgentDeferredStartupEligibilityInputV1,
): boolean {
  const terminalLocal = params.startingMode === null
    || params.startingMode === 'terminal'
    || params.startingMode === 'local';
  const eligibleAttach = params.hasExistingSession
    && params.hasSessionAttachFile
    && params.hasExplicitPermissionMode;
  return params.startedBy === 'terminal'
    && terminalLocal
    && (!params.hasExistingSession || eligibleAttach);
}
