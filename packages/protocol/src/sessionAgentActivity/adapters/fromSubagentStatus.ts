import { z } from 'zod';

import type { AgentActivityStatusV1 } from '../agentActivityStatusV1.js';

/**
 * Boundary vocabulary for the client-derived subagent status.
 *
 * The canonical owner is `SessionSubagentStatus` at
 * `apps/ui/sources/sync/domains/session/subagents/types.ts`. It is derived from transcript
 * observation rather than published on the wire, and `packages/protocol` cannot import from
 * `apps/ui`, so this schema is the boundary mirror the adapter is typed against — it does not take
 * ownership away from the UI type and must stay in step with it.
 *
 * The lock is the call site: a UI caller passes a `SessionSubagentStatus` straight into
 * `fromSubagentStatus`, so a member added upstream fails to compile against this parameter type
 * rather than degrading to `unknown`.
 */
export const SESSION_SUBAGENT_STATUS_SOURCES_V1 = [
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'terminated',
  'unknown',
] as const;

export const SessionSubagentStatusSourceV1Schema = z.enum(SESSION_SUBAGENT_STATUS_SOURCES_V1);
export type SessionSubagentStatusSourceV1 = z.infer<typeof SessionSubagentStatusSourceV1Schema>;

/**
 * Subagent status -> presentation status. No `default` arm: a value added upstream must fail to
 * compile here.
 */
export function fromSubagentStatus(status: SessionSubagentStatusSourceV1): AgentActivityStatusV1 {
  switch (status) {
    case 'running':
      return 'running';
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'cancelled':
    case 'terminated':
      // `terminated` is a stop, not an error; it collapses into `cancelled` by design.
      return 'cancelled';
    case 'unknown':
      return 'unknown';
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}
