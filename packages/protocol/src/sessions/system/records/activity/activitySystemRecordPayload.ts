import { z } from 'zod';

import { SessionWorkflowRunSnapshotV1Schema } from '../../../work/workflow/sessionWorkflowRunSnapshotV1.js';
import { ActivitySessionSystemRecordKindSchema } from './activitySystemRecordKinds.js';

export const ActivityWorkflowRunSystemRecordPayloadSchema = z
  .object({
    kind: z.literal('workflow_run.v1'),
    payload: SessionWorkflowRunSnapshotV1Schema,
  })
  .passthrough();
export type ActivityWorkflowRunSystemRecordPayload = z.infer<typeof ActivityWorkflowRunSystemRecordPayloadSchema>;

export const ActivitySessionSystemRecordPayloadSchema = z.discriminatedUnion('kind', [
  ActivityWorkflowRunSystemRecordPayloadSchema,
]);
export type ActivitySessionSystemRecordPayload = z.infer<typeof ActivitySessionSystemRecordPayloadSchema>;

export const ActivitySessionSystemRecordRawPayloadSchema = z.union([
  SessionWorkflowRunSnapshotV1Schema,
]);
export type ActivitySessionSystemRecordRawPayload = z.infer<typeof ActivitySessionSystemRecordRawPayloadSchema>;

export function isActivitySessionSystemRecordKind(value: string): value is z.infer<typeof ActivitySessionSystemRecordKindSchema> {
  return ActivitySessionSystemRecordKindSchema.safeParse(value).success;
}
