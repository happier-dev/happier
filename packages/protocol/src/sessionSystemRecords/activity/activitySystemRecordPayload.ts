import { z } from 'zod';

import { SessionBackgroundTaskRecordV1Schema } from '../../activity/backgroundTask/backgroundTaskRecordV1.js';
import { SessionWorkflowRunSnapshotV1Schema } from '../../sessionWorkflowActivity/sessionWorkflowRunSnapshotV1.js';
import { ActivitySessionSystemRecordKindSchema } from './activitySystemRecordKinds.js';

export const ActivityWorkflowRunSystemRecordPayloadSchema = z
  .object({
    kind: z.literal('workflow_run.v1'),
    payload: SessionWorkflowRunSnapshotV1Schema,
  })
  .passthrough();
export type ActivityWorkflowRunSystemRecordPayload = z.infer<typeof ActivityWorkflowRunSystemRecordPayloadSchema>;

export const ActivityBackgroundTaskSystemRecordPayloadSchema = z
  .object({
    kind: z.literal('background_task.v1'),
    payload: SessionBackgroundTaskRecordV1Schema,
  })
  .passthrough();
export type ActivityBackgroundTaskSystemRecordPayload = z.infer<typeof ActivityBackgroundTaskSystemRecordPayloadSchema>;

export const ActivitySessionSystemRecordPayloadSchema = z.discriminatedUnion('kind', [
  ActivityWorkflowRunSystemRecordPayloadSchema,
  ActivityBackgroundTaskSystemRecordPayloadSchema,
]);
export type ActivitySessionSystemRecordPayload = z.infer<typeof ActivitySessionSystemRecordPayloadSchema>;

export const ActivitySessionSystemRecordRawPayloadSchema = z.union([
  SessionWorkflowRunSnapshotV1Schema,
  SessionBackgroundTaskRecordV1Schema,
]);
export type ActivitySessionSystemRecordRawPayload = z.infer<typeof ActivitySessionSystemRecordRawPayloadSchema>;

export function isActivitySessionSystemRecordKind(value: string): value is z.infer<typeof ActivitySessionSystemRecordKindSchema> {
  return ActivitySessionSystemRecordKindSchema.safeParse(value).success;
}
