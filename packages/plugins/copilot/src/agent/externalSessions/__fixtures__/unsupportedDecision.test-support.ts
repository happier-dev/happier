/**
 * Current-release feasibility decision. Documented hook candidates are not
 * promoted without an installed-version fixture and a bounded history/follow
 * contract.
 */
// Test support only; this is not a production capability declaration.
export const COPILOT_EXTERNAL_SESSIONS_DECISION = Object.freeze({
  release: 'decision_only_unsupported' as const,
  installedVersion: 'unavailable' as const,
  documentedCandidates: Object.freeze([
    'agentStop',
    'sessionEnd.reason',
  ] as const),
  forbiddenEvidenceSources: Object.freeze([
    'session_store_database',
    'interactive_tui_reader',
    'experimental_event_log_as_release_contract',
  ] as const),
  recipe: 'none' as const,
  observationRegistration: false,
  externalSessionsRegistration: false,
  autoLinkEligible: false,
  exposedCapability: 'none' as const,
});
