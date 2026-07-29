import { AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1 } from '@happier-dev/protocol/runtime';

/**
 * Sole CORE-A owner for Agent-session runtime bounds.
 *
 * The members under `p0MeasuredCandidates` deliberately remain package-internal
 * until RA21-M measures the production provider, persistence, socket, and UI
 * paths. Do not re-export this object from a public SDK entrypoint before
 * CORE.T2B promotes those values.
 */
export { AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1 };

export type AgentSessionRuntimeLimitsCandidateV1 =
  typeof AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1;
