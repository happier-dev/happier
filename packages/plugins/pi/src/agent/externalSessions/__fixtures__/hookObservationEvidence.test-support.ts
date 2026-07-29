/**
 * Sanitized lifecycle/source fixture derived from the installed Pi 0.75.5
 * contract. It prepares evidence only; it does not register a hook recipe.
 */
// Test support only; it is excluded from the production package build.
export const PI_HOOK_OBSERVATION_EVIDENCE = Object.freeze({
  lifecycle: Object.freeze([
    Object.freeze({
      input: Object.freeze({ type: 'agent_end', willRetry: true }),
      expected: 'retrying' as const,
    }),
    Object.freeze({
      input: Object.freeze({ type: 'agent_end', willRetry: false }),
      expected: 'final' as const,
    }),
    Object.freeze({
      input: Object.freeze({ type: 'agent_end' }),
      expected: 'final' as const,
    }),
    Object.freeze({
      input: Object.freeze({ type: 'agent_settled' }),
      expected: null,
    }),
  ]),
  agentSettled: Object.freeze({
    installedVersion: '0.75.5' as const,
    exposedByPinnedInstalledVersion: false,
    disposition: 'ignored_unless_a_future_pinned_version_exposes_it' as const,
  }),
  fileOnly: Object.freeze({
    observation: 'reconcile_only' as const,
    mayProveWorking: false,
    mayProveCompletedBoundary: false,
  }),
  autoLink: Object.freeze({
    online: 'ineligible_until_persisted_identity_passes_both_resolvers' as const,
    offline: 'ineligible_until_identity_and_authoritative_created_at_are_pinned' as const,
  }),
});
