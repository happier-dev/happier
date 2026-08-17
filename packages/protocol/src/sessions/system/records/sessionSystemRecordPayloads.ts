import { z } from 'zod';

import {
  ActivitySessionSystemRecordRawPayloadSchema,
  type ActivitySessionSystemRecordRawPayload,
} from './activity/activitySystemRecordPayload.js';
import {
  MemorySessionSystemRecordRawPayloadSchema,
  type MemorySessionSystemRecordRawPayload,
} from './memory/memorySystemRecordPayload.js';
import {
  SessionPermissionRemoteMediationRecordV1Schema,
  type SessionPermissionRemoteMediationRecordV1,
} from '../../permissions/mediationRecordsV1.js';

export const SessionSystemRecordPayloadSchema = z.union([
  MemorySessionSystemRecordRawPayloadSchema,
  ActivitySessionSystemRecordRawPayloadSchema,
  SessionPermissionRemoteMediationRecordV1Schema,
]);
export type SessionSystemRecordPayload =
  | MemorySessionSystemRecordRawPayload
  | ActivitySessionSystemRecordRawPayload
  | SessionPermissionRemoteMediationRecordV1;
