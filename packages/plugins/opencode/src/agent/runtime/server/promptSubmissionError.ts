import { projectSessionRuntimeFailureCause } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

/** Native dispatch may have committed input without a usable identity receipt. */
export class OpenCodePromptIdentityUnresolvedError extends Error {
  readonly code = 'opencode_prompt_identity_unresolved';
  readonly failureCause?: ReturnType<typeof projectSessionRuntimeFailureCause>;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OpenCodePromptIdentityUnresolvedError';
    if (options?.cause !== undefined) {
      const failureCause = projectSessionRuntimeFailureCause(options.cause, 'turn_start', 'agent.turn');
      if (failureCause) {
        const { providerErrorMessage: _privateMessage, ...safeCause } = failureCause;
        this.failureCause = safeCause;
      }
    }
  }
}
