import { z } from 'zod';

/**
 * Source timestamps are converted to JavaScript Dates by transcript owners.
 * Keep the boundary at the inclusive ECMAScript Date millisecond ceiling.
 */
export const SESSION_TRANSCRIPT_SOURCE_TIMESTAMP_MAX_MS = 8_640_000_000_000_000;

export const SessionTranscriptSourceTimestampMsSchema = z.number()
  .int()
  .min(0)
  .max(SESSION_TRANSCRIPT_SOURCE_TIMESTAMP_MAX_MS);
