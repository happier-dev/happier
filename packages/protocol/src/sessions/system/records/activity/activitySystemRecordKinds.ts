import { z } from 'zod';

export const SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE = 'activity' as const;

export const ACTIVITY_SESSION_SYSTEM_RECORD_KINDS = [
  'workflow_run.v1',
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
