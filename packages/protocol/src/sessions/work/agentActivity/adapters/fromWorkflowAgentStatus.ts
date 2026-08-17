import type { SessionWorkflowAgentStatusV1 } from '../../workflow/sessionWorkflowRunSnapshotV1.js';
import type { AgentActivityStatusV1 } from '../agentActivityStatusV1.js';

/**
 * `SessionWorkflowAgentStatusV1` (one agent inside a durable workflow run) -> presentation status.
 *
 * The source enum is unchanged and still the wire contract. No `default` arm: a value added
 * upstream must fail to compile here.
 */
export function fromWorkflowAgentStatus(status: SessionWorkflowAgentStatusV1): AgentActivityStatusV1 {
  switch (status) {
    case 'pending':
      // Admitted to the run's phase plan but not dispatched.
      return 'queued';
    case 'active':
      return 'running';
    case 'complete':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'blocked':
      return 'blocked';
    case 'cancelled':
      return 'cancelled';
    case 'unknown':
      return 'unknown';
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}
