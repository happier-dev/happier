import { z } from 'zod';

import {
  ActivitySessionSystemRecordRawPayloadSchema,
  type ActivitySessionSystemRecordRawPayload,
} from './activity/activitySystemRecordPayload.js';
import {
  MemorySessionSystemRecordRawPayloadSchema,
  type MemorySessionSystemRecordRawPayload,
} from './memory/memorySystemRecordPayload.js';

export const SessionSystemRecordPayloadSchema = z.union([
  MemorySessionSystemRecordRawPayloadSchema,
  ActivitySessionSystemRecordRawPayloadSchema,
]);
export type SessionSystemRecordPayload =
  | MemorySessionSystemRecordRawPayload
  | ActivitySessionSystemRecordRawPayload;
