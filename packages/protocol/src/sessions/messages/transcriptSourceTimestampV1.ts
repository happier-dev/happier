import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

/**
 * Source timestamps are converted to JavaScript Dates by transcript owners.
 * Keep the boundary at the inclusive ECMAScript Date millisecond ceiling.
 */
export const SESSION_TRANSCRIPT_SOURCE_TIMESTAMP_MAX_MS = 8_640_000_000_000_000;

export const SessionTranscriptSourceTimestampMsSchema = lazyZodSchema(() => z.number().check(z.int(), z.minimum(0), z.maximum(SESSION_TRANSCRIPT_SOURCE_TIMESTAMP_MAX_MS)));
