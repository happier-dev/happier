import { UsageSessionFactRecordV1Schema } from '../../../usage/usageWorkEvidence.js';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import type { UsageSessionFactRecordV1 } from '../../../usage/usageWorkEvidence.js';
import { z } from 'zod/mini';

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

export const SessionSystemRecordPayloadSchema = lazyZodSchema(() => z.union([
  UsageSessionFactRecordV1Schema,
  MemorySessionSystemRecordRawPayloadSchema,
  ActivitySessionSystemRecordRawPayloadSchema,
  SessionPermissionRemoteMediationRecordV1Schema,
]));
export type SessionSystemRecordPayload =
  | UsageSessionFactRecordV1
  | MemorySessionSystemRecordRawPayload
  | ActivitySessionSystemRecordRawPayload
  | SessionPermissionRemoteMediationRecordV1;
