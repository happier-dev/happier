import { z } from 'zod';

/**
 * What kind of work an agent-activity entry describes.
 *
 * MEMBERSHIP IS DECIDED BY PRODUCERS, NOT BY DESIGN INTENT. A kind is added here only in the same
 * change that lands its live writer, with evidence that the writer actually publishes in a real
 * session. A kind with no writer is a dormant horizontal spine: consumers branch on a value that
 * can never arrive, and the branch rots.
 *
 * v1 ships the two kinds carried by the one activity record that is published today —
 * `activity/workflow_run.v1`, written by `apps/cli/src/session/systemRecords/activity/**`, whose
 * snapshot holds both the run and its agents.
 *
 * Waiting on their producers:
 * - `subagent`, `execution_run` — added once their observation source is evidenced.
 * - `agent_team_member` — added only if a writer is proven to exist.
 * - `background_task` — added together with its CLI producer.
 * - `scheduled_run` — never: automations are account-scoped and terminal at dispatch, so they are
 *   excluded from agent activity outright.
 * - `monitor` / `monitor_mcp` — classification buckets only; no member without a verified producer.
 *
 * Adding a member is a one-line change to the tuple below. Consumers must therefore treat this as
 * an open vocabulary: switch on it only where a total mapping is genuinely required, and use a
 * `never` check there so the compiler points at every site the new kind reaches.
 */
export const AGENT_ACTIVITY_KINDS_V1 = [
  'workflow_run',
  'workflow_agent',
] as const;

export const AgentActivityKindV1Schema = z.enum(AGENT_ACTIVITY_KINDS_V1);
export type AgentActivityKindV1 = z.infer<typeof AgentActivityKindV1Schema>;
