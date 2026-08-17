import type {
  AgentExternalSessionsResolvedIdentity,
} from '@happier-dev/plugin-sdk/sessions/external';

const sessionFilePath = '/fixture/omp/session.jsonl';

/**
 * Sanitized negative-knowledge fixture. Oh My Pi event names and supported
 * versions remain deliberately absent until a pinned installed contract exists.
 */
// Test support only; it is excluded from the production package build.
export const OH_MY_PI_HOOK_OBSERVATION_EVIDENCE = Object.freeze({
  linkedSource: Object.freeze({
    source: {
      kind: 'ohMyPiAgentDir',
      agentDir: '/fixture/omp',
      sessionFilePath,
    },
    remoteSessionId: 'omp-native-session-fixture',
    // The resolved session file travels on the source only; a top-level
    // `sessionFilePath` on link data is rejected by host owner metadata.
    linkData: {},
  } as const satisfies AgentExternalSessionsResolvedIdentity),
  recipe: Object.freeze({
    disposition: 'none' as const,
    installedVersion: 'unproven' as const,
    exactEventContract: 'unproven' as const,
    borrowedPiEventNames: false,
  }),
  fileEvidence: Object.freeze({
    mayProve: ['recent_activity_after_successful_qualified_read'] as const,
    mayNotProve: [
      'liveness',
      'working',
      'idle',
      'retrying',
      'completed_boundary',
      'interrupt',
      'process_exit',
      'identity',
      'authoritative_created_at',
    ] as const,
  }),
  autoLink: Object.freeze({
    online: 'ineligible_until_both_resolvers_have_authoritative_identity' as const,
    offline: 'ineligible_without_authoritative_identity_and_created_at' as const,
  }),
});
