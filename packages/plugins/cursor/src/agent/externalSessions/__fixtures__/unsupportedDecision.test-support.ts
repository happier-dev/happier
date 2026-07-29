/**
 * Current-release feasibility decision. Official/local evidence does not expose
 * a stable arbitrary-history page/read-after/follow contract.
 */
// Test support only; this is not a production capability declaration.
export const CURSOR_EXTERNAL_SESSIONS_DECISION = Object.freeze({
  release: 'decision_only_unsupported' as const,
  evidenceBasis: 'official_docs_and_local_help_only' as const,
  forbiddenEvidenceSources: Object.freeze([
    'private_opaque_database',
    'interactive_tui_reader',
    'happier_owned_acp_files_as_arbitrary_cursor_history',
  ] as const),
  recipe: 'none' as const,
  observationRegistration: false,
  externalSessionsRegistration: false,
  autoLinkEligible: false,
  exposedCapability: 'none' as const,
});
