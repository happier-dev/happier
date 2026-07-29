/**
 * Current-release decision fixture. Public Auggie list/hook shapes remain
 * research inputs only; no stable transcript page/read-after/follow contract
 * exists for a consumed External Sessions implementation.
 */
// Test support only; this is not a production capability declaration.
export const AUGGIE_EXTERNAL_SESSIONS_DECISION = Object.freeze({
  release: 'unsupported' as const,
  publicEvidenceInputs: Object.freeze([
    'session_list_json',
    'documented_lifecycle_hooks',
  ] as const),
  forbiddenEvidenceSources: Object.freeze([
    'private_database',
    'private_transcript_schema',
    'interactive_tui_reader',
  ] as const),
  recipe: 'none' as const,
  observationRegistration: false,
  externalSessionsRegistration: false,
  autoLinkEligible: false,
  exposedCapability: 'none' as const,
});
