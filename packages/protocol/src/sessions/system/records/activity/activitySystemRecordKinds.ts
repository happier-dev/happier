import { z } from 'zod';

export const SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE = 'activity' as const;

/**
 * Durable record kinds in the `activity` namespace.
 *
 * Append only: consumers name their kinds positionally in places, so reordering this list silently
 * retargets a publisher.
 */
export const ACTIVITY_SESSION_SYSTEM_RECORD_KINDS = [
  'workflow_run.v1',
  'background_task.v1',
] as const;

export const ActivitySessionSystemRecordKindSchema = z.enum(ACTIVITY_SESSION_SYSTEM_RECORD_KINDS);
export type ActivitySessionSystemRecordKind = z.infer<typeof ActivitySessionSystemRecordKindSchema>;

/**
 * Stable, idempotent local id for one workflow run's durable `activity/workflow_run.v1` detail
 * record. This is the canonical join key shared by the CLI publisher and the UI reader so both write
 * and read paths agree on the record address; the same `runId` always maps to the same record.
 */
export function buildWorkflowRunSystemRecordLocalId(params: Readonly<{ runId: string }>): string {
  const runId = String(params.runId ?? '').trim();
  return `activity:workflow_run:v1:${runId}`;
}

/**
 * Stable, idempotent local id for one background task's durable `activity/background_task.v1`
 * record, shared by the producer and every reader exactly as the workflow builder is.
 *
 * It throws where the workflow builder tolerates an empty component, and that difference is
 * deliberate: `runId` reaches its builder from a schema that already requires a non-empty string,
 * whereas a task id is read off a provider event. An empty one would address every unidentifiable
 * task to the single record `activity:background_task:v1:` — each task overwriting the last, with
 * nothing failing loudly.
 */
export function buildBackgroundTaskSystemRecordLocalId(params: Readonly<{ taskId: string }>): string {
  const taskId = String(params.taskId ?? '').trim();
  if (taskId.length === 0) {
    throw new Error('activity background_task.v1 local id: taskId must be a non-empty string');
  }
  return `activity:background_task:v1:${taskId}`;
}
