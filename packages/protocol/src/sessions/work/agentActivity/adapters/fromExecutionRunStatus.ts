import type { ExecutionRunStatus } from '../../../../execution/runs/listRequest.js';
import type { AgentActivityStatusV1 } from '../agentActivityStatusV1.js';

/**
 * `ExecutionRunStatus` (daemon execution-run registry) -> presentation status.
 *
 * Typed against the CANONICAL five-member enum in `execution/runs/listRequest.ts`, which is also the
 * source `ExecutionRunTerminalStatusSchema` is derived from — so the terminal-only result shapes on
 * `execution.run.wait` cannot drift away from what this adapter can translate.
 *
 * The source enum is unchanged and still the wire contract. No `default` arm: a value added upstream
 * must fail to compile here.
 *
 * `timeout` has its own presentation status. Collapsing it into `succeeded` is the defect this
 * boundary exists to prevent — a run the daemon timed out rendering as a green success is a lie the
 * user cannot see through, and timing out has a different recovery (raise the budget) than failing
 * (read the error).
 */
export function fromExecutionRunStatus(status: ExecutionRunStatus): AgentActivityStatusV1 {
  switch (status) {
    case 'running':
      return 'running';
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'timeout':
      return 'timedOut';
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}
