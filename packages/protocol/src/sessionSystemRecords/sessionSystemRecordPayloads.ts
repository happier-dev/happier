import {
  MemorySessionSystemRecordRawPayloadSchema,
  type MemorySessionSystemRecordRawPayload,
} from './memory/memorySystemRecordPayload.js';

export const SessionSystemRecordPayloadSchema = MemorySessionSystemRecordRawPayloadSchema;
export type SessionSystemRecordPayload = MemorySessionSystemRecordRawPayload;
