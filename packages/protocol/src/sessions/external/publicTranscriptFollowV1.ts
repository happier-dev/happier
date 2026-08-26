import { z } from 'zod';

import { measureSerializedValidatedStrictPluginJsonUtf8Bytes } from '../../plugins/contributions/strictJsonValue.js';
import { AgentRuntimeJsonValueV1Schema } from '../../runtime/agentSessionV1.js';
import {
  ExternalSessionTranscriptItemIdV1Schema,
  ExternalSessionTranscriptSourceTimestampV1Schema,
} from './sourceTranscriptItemV1.js';

/**
 * Public Author cursors stay opaque, but must be nonempty and canonical rather
 * than silently normalized. The bound is shared by acquisition, delivery, and
 * the Runner carrier so one public follow event has one cursor contract.
 */
export const MAX_EXTERNAL_SESSION_TRANSCRIPT_FOLLOW_CURSOR_CODE_UNITS = 4_096;

/** A public terminated-event code is diagnostic, not an arbitrary payload. */
export const MAX_EXTERNAL_SESSION_TRANSCRIPT_FOLLOW_CODE_CODE_UNITS = 256;

/**
 * One bounded public event protects the author callback transport without
 * inventing an item-count ceiling. Large valid arrays are admitted until this
 * real aggregate boundary is reached.
 */
export const MAX_EXTERNAL_SESSION_TRANSCRIPT_FOLLOW_EVENT_SERIALIZED_BYTES = 1_048_576;

function canonicalBoundedString(maxCodeUnits: number, description: string) {
  return z.string()
    .min(1)
    .max(maxCodeUnits)
    .refine(
      (value) => value === value.trim(),
      `${description} must already be trimmed.`,
    );
}

export const ExternalSessionTranscriptFollowCursorV1Schema = canonicalBoundedString(
  MAX_EXTERNAL_SESSION_TRANSCRIPT_FOLLOW_CURSOR_CODE_UNITS,
  'External Session transcript follow cursor',
);
export type ExternalSessionTranscriptFollowCursorV1 = z.infer<
  typeof ExternalSessionTranscriptFollowCursorV1Schema
>;

export const ExternalSessionTranscriptFollowCodeV1Schema = canonicalBoundedString(
  MAX_EXTERNAL_SESSION_TRANSCRIPT_FOLLOW_CODE_CODE_UNITS,
  'External Session transcript follow termination code',
);
export type ExternalSessionTranscriptFollowCodeV1 = z.infer<
  typeof ExternalSessionTranscriptFollowCodeV1Schema
>;

/**
 * Public Author projection of one External Session transcript item. Producer
 * routing and raw-record fields intentionally do not cross this boundary.
 */
export const ExternalSessionTranscriptItemV1Schema = z.object({
  id: ExternalSessionTranscriptItemIdV1Schema,
  timestampMs: ExternalSessionTranscriptSourceTimestampV1Schema.optional(),
  kind: z.enum(['user', 'agent', 'system', 'event']),
  data: AgentRuntimeJsonValueV1Schema,
}).strict();
export type ExternalSessionTranscriptItemV1 = z.infer<
  typeof ExternalSessionTranscriptItemV1Schema
>;

const ExternalSessionTranscriptFollowEventTooLargeIssueMessage =
  'External Session transcript follow event exceeds the serialized-byte limit.';

export const ExternalSessionTranscriptFollowEventV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('data'),
    // Count is intentionally unbounded. The event byte ceiling below is the
    // public resource contract and admits any valid collection below it.
    items: z.array(ExternalSessionTranscriptItemV1Schema),
    fromCursor: ExternalSessionTranscriptFollowCursorV1Schema.nullable(),
    nextCursor: ExternalSessionTranscriptFollowCursorV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('resyncRequired'),
    reason: z.literal('cursorDiscontinuity'),
    cursor: ExternalSessionTranscriptFollowCursorV1Schema.nullable(),
  }).strict(),
  z.object({
    kind: z.literal('terminated'),
    reason: z.enum(['disposed', 'aborted', 'retired', 'providerFailure', 'resyncRequired']),
    cursor: ExternalSessionTranscriptFollowCursorV1Schema.nullable(),
    code: ExternalSessionTranscriptFollowCodeV1Schema.optional(),
  }).strict(),
]).superRefine((event, context) => {
  try {
    if (measureSerializedValidatedStrictPluginJsonUtf8Bytes(
      event,
      'External Session transcript follow event',
      MAX_EXTERNAL_SESSION_TRANSCRIPT_FOLLOW_EVENT_SERIALIZED_BYTES,
    ) > MAX_EXTERNAL_SESSION_TRANSCRIPT_FOLLOW_EVENT_SERIALIZED_BYTES) {
      context.addIssue({
        code: 'custom',
        message: ExternalSessionTranscriptFollowEventTooLargeIssueMessage,
      });
    }
  } catch (error) {
    context.addIssue({
      code: 'custom',
      message: error instanceof Error
        ? error.message
        : 'External Session transcript follow event must contain strict JSON data.',
    });
  }
});
export type ExternalSessionTranscriptFollowEventV1 = z.infer<
  typeof ExternalSessionTranscriptFollowEventV1Schema
>;

/**
 * Canonical parse result for host boundaries that retain the established
 * invalid-versus-byte-exceeded error projection. It delegates to the schema;
 * it does not independently parse or measure the event.
 */
export type ExternalSessionTranscriptFollowEventValidationV1 =
  | Readonly<{ ok: true; event: ExternalSessionTranscriptFollowEventV1 }>
  | Readonly<{
      ok: false;
      errorCode: 'invalid' | 'serialized_bytes_exceeded';
    }>;

export function validateExternalSessionTranscriptFollowEventV1(
  value: unknown,
): ExternalSessionTranscriptFollowEventValidationV1 {
  const parsed = ExternalSessionTranscriptFollowEventV1Schema.safeParse(value);
  if (parsed.success) return { ok: true, event: parsed.data };
  return {
    ok: false,
    errorCode: parsed.error.issues.some(
      (issue) => issue.message === ExternalSessionTranscriptFollowEventTooLargeIssueMessage,
    )
      ? 'serialized_bytes_exceeded'
      : 'invalid',
  };
}
