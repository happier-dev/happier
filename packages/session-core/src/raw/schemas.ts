import * as z from 'zod';

import { createTranscriptRawRecordV1Schema } from '@happier-dev/protocol/sessions/messages/transcriptRawRecordV1';
import type { TranscriptRawAgentContentV1, TranscriptRawAgentEventV1, TranscriptRawRecordV1, TranscriptRawUsageDataV1 } from '@happier-dev/protocol';

import { MessageMetaSchema } from "../messages/messageMetaTypes.js";

export const rawRecordSchema = createTranscriptRawRecordV1Schema(z, {
    metaSchema: MessageMetaSchema,
});

export type RawRecord = TranscriptRawRecordV1;
export type RawAgentContent = TranscriptRawAgentContentV1;
export type AgentEvent = TranscriptRawAgentEventV1;
export type UsageData = TranscriptRawUsageDataV1;

export const RawRecordSchema = rawRecordSchema;
