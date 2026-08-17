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
 * The lock has two halves: a UI caller passing a `SessionSubagentStatus` straight into
 * `fromSubagentStatus` fails to compile when the mirror is missing a member, and
 * `sessionSubagentStatusProtocolParity.test.ts` in `apps/ui` asserts set equality so a member added
 * here without a UI counterpart (or vice versa) fails loudly instead of drifting. That test lives on
 * the UI side because only that side can see both vocabularies.
 */
export const SESSION_SUBAGENT_STATUS_SOURCES_V1 = [
  'running',
  'succeeded',
  'failed',
  'timedOut',
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
    case 'timedOut':
      // Kept distinct from `failed`: the recovery is to raise the budget, not to read an error.
      return 'timedOut';
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
