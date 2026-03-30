import * as z from 'zod';

import {
    createTranscriptRawRecordV1Schema,
    type TranscriptRawAgentContentV1,
    type TranscriptRawAgentEventV1,
    type TranscriptRawRecordV1,
    type TranscriptRawUsageDataV1,
} from '@happier-dev/protocol';

import { MessageMetaSchema } from '../domains/messages/messageMetaTypes';

export const rawRecordSchema = createTranscriptRawRecordV1Schema(z, {
    metaSchema: MessageMetaSchema,
});

export type RawRecord = TranscriptRawRecordV1;
export type RawAgentContent = TranscriptRawAgentContentV1;
export type AgentEvent = TranscriptRawAgentEventV1;
export type UsageData = TranscriptRawUsageDataV1;

export const RawRecordSchema = rawRecordSchema;

