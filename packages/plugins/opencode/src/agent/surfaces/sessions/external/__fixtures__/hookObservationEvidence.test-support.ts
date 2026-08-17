import type {
  AgentExternalSessionsResolvedIdentity,
} from '@happier-dev/plugin-sdk/sessions/external';

const endpoint = 'http://127.0.0.1:49196';
const nativeSessionId = 'opencode-native-session-fixture';

const first = {
  source: {
    kind: 'opencodeServer',
    baseUrl: endpoint,
    directory: '/fixture/project-a',
  },
  remoteSessionId: nativeSessionId,
  linkData: {},
} as const satisfies AgentExternalSessionsResolvedIdentity;

const otherDirectory = {
  source: {
    kind: 'opencodeServer',
    baseUrl: endpoint,
    directory: '/fixture/project-b',
  },
  remoteSessionId: nativeSessionId,
  linkData: {},
} as const satisfies AgentExternalSessionsResolvedIdentity;

/**
 * Sanitized decision fixture derived from OpenCode's native SSE/status contract.
 * It is evidence for future hook/auto-link work, not a hook recipe or link policy.
 */
// Test support only; it is excluded from the production package build.
export const OPEN_CODE_HOOK_OBSERVATION_EVIDENCE = Object.freeze({
  identity: Object.freeze({
    endpoint,
    authGeneration: 'fixture-generation',
    first,
    otherDirectory,
    resourceIncludes: ['endpoint', 'auth_generation'] as const,
    linkIncludes: ['directory', 'native_session_id'] as const,
  }),
  nativeObservation: Object.freeze({
    preferred: true,
    configRecipe: 'none' as const,
    reconnectWithoutReplayId: 'reconcile' as const,
  }),
  statusCases: Object.freeze([
    Object.freeze({
      fetch: 'successful' as const,
      sessionPresent: false,
      admittedTurnPhase: 'idle' as const,
    }),
    Object.freeze({
      fetch: 'failed' as const,
      sessionPresent: false,
      admittedTurnPhase: 'unknown' as const,
    }),
  ]),
  autoLink: Object.freeze({
    online: Object.freeze({
      requiresResolveSource: true,
      requiresResolveLinkIdentity: true,
      eligibleAfterBothResolvers: true,
    }),
    offline: Object.freeze({
      requiresAuthoritativeCreatedAt: true,
      missingAuthoritativeCreatedAt: 'browse_only' as const,
    }),
  }),
});
