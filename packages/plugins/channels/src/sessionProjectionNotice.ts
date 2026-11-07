import type { JsonValue } from '@happier-dev/plugin-sdk';
import {
  createProtocolStoredReadSchema, defineProtocolLiteral, defineProtocolNumber,
  defineProtocolObject, defineProtocolString, defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';

export type ConversationSessionProjectionHistoryGapReason =
  | 'cursorRejected'
  | 'frontierCursorInvalid'
  | 'projectionRegression'
  | 'cursorUnavailable';

export type ConversationSessionProjectionHistoryGap = Readonly<{
  kind: 'historyGap';
  reason: ConversationSessionProjectionHistoryGapReason;
  reportedAt: number;
  /** Absent only on a retained notice whose automatic tail recovery has not settled. */
  cursor?: string | null;
}>;

// The opaque frontier keeps the first notice and its progressing cursor
// together. Dismissing it unwraps this cursor; it never selects another tail.
const storedNoticeSchema = createProtocolStoredReadSchema(defineProtocolObject({
  kind: defineProtocolLiteral('historyGap'),
  reason: defineProtocolUnion([
    defineProtocolLiteral('cursorRejected'), defineProtocolLiteral('frontierCursorInvalid'),
    defineProtocolLiteral('projectionRegression'), defineProtocolLiteral('cursorUnavailable'),
  ]),
  reportedAt: defineProtocolNumber({ integer: true, minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  cursor: defineProtocolString().nullable().optional(),
}, { policy: 'closed' }));

export function readConversationSessionProjectionHistoryGap(
  value: JsonValue,
): ConversationSessionProjectionHistoryGap | null {
  const parsed = storedNoticeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
