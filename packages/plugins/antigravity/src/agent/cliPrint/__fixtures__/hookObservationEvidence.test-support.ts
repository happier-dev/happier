/**
 * Sanitized Antigravity 1.1.5 probe disposition. Candidate native events stay
 * inert until exact installed-version, cadence, interrupt, and config evidence
 * permits a recipe.
 */
// Test support only; it is excluded from the production package build.
export const ANTIGRAVITY_HOOK_OBSERVATION_EVIDENCE = Object.freeze({
  installedVersionProbe: '1.1.5' as const,
  recipe: 'none_until_pinned_contract' as const,
  preInvocation: Object.freeze({
    event: 'PreInvocation' as const,
    carriesConversationId: true,
    evidence: 'correlation_candidate' as const,
    proves: Object.freeze([]),
    perToolAllowedOnlyWhenNoLowerCadenceEvent: true,
  }),
  stop: Object.freeze({
    fullyIdleMeaning: 'unproven' as const,
    interruptCoverage: 'unproven' as const,
    admittedFacts: Object.freeze([]),
  }),
  autoLink: Object.freeze({
    onlineRequirements: Object.freeze([
      'pinned_conversation_source_correlation',
      'resolveSource',
      'resolveLinkIdentity',
    ] as const),
    offline:
      'ineligible_until_stable_identity_and_authoritative_created_at_are_proven' as const,
  }),
});
