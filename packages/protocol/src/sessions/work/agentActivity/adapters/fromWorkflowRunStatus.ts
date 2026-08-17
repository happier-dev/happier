import type { SessionWorkflowRunStatusV1 } from '../../workflow/sessionWorkflowRunSnapshotV1.js';
import type { AgentActivityStatusV1 } from '../agentActivityStatusV1.js';

/**
 * `SessionWorkflowRunStatusV1` (durable `activity/workflow_run.v1` record) -> presentation status.
 *
 * The source enum is unchanged and still the wire contract; this is the boundary where it becomes
 * presentable. No `default` arm: a value added upstream must fail to compile here.
 */
export function fromWorkflowRunStatus(status: SessionWorkflowRunStatusV1): AgentActivityStatusV1 {
  switch (status) {
    case 'active':
      return 'running';
    case 'complete':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'stopped':
      // A run left active when its process died is reconciled to `stopped`
      // (`statusReason: 'interrupted'`). A stop is not a failure and must not read as danger.
      return 'cancelled';
    case 'blocked':
      // Workflow `blocked` waits on a phase dependency, not on a person, so it is `blocked` and
      // not `waiting`. Human-blocking arrives as an attention signal on the entry, not here.
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
