import { z } from '../../../../zodRuntimePolicy.js';

import { SessionBackgroundTaskRecordV1Schema } from '../../../work/backgroundTask/backgroundTaskRecordV1.js';
import { SessionWorkflowRunSnapshotV1Schema } from '../../../work/workflow/sessionWorkflowRunSnapshotV1.js';
import { ActivitySessionSystemRecordKindSchema } from './activitySystemRecordKinds.js';
import { SessionStopRecordV1Schema } from '../../../../machines/guard/sessionGuardStateV1.js';

export const ActivityWorkflowRunSystemRecordPayloadSchema = z.looseObject({
    kind: z.literal('workflow_run.v1'),
    payload: SessionWorkflowRunSnapshotV1Schema,
  });
export type ActivityWorkflowRunSystemRecordPayload = z.infer<typeof ActivityWorkflowRunSystemRecordPayloadSchema>;

export const ActivityBackgroundTaskSystemRecordPayloadSchema = z.looseObject({
    kind: z.literal('background_task.v1'),
    payload: SessionBackgroundTaskRecordV1Schema,
  });
export type ActivityBackgroundTaskSystemRecordPayload = z.infer<typeof ActivityBackgroundTaskSystemRecordPayloadSchema>;

export const ActivitySessionSystemRecordPayloadSchema = z.discriminatedUnion('kind', [
  ActivityWorkflowRunSystemRecordPayloadSchema,
  ActivityBackgroundTaskSystemRecordPayloadSchema,
  z.strictObject({ kind: z.literal('session_stop.v1'), payload: SessionStopRecordV1Schema }),
]);
export type ActivitySessionSystemRecordPayload = z.infer<typeof ActivitySessionSystemRecordPayloadSchema>;

export const ActivitySessionSystemRecordRawPayloadSchema = z.union([
  SessionWorkflowRunSnapshotV1Schema,
  SessionBackgroundTaskRecordV1Schema,
  SessionStopRecordV1Schema,
]);
export type ActivitySessionSystemRecordRawPayload = z.infer<typeof ActivitySessionSystemRecordRawPayloadSchema>;

export function isActivitySessionSystemRecordKind(value: string): value is z.infer<typeof ActivitySessionSystemRecordKindSchema> {
  return ActivitySessionSystemRecordKindSchema.safeParse(value).success;
}
