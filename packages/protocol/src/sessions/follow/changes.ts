import { z } from 'zod/mini';
import { SessionIdSchema } from '../idsV1.js';

/**
 * Follow configuration reuses the existing `account` AccountChange kind. A new
 * kind would make current planners treat the entry as unsupported and block
 * safe cursor advancement. Configuration keeps one Account-scoped identity;
 * receiver demand below has a separate key from ordinary Session projection.
 */
export const ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID = 'session-follows';

const SESSION_FOLLOW_RECEIVER_CHANGE_PREFIX_V1 = 'session-follow-receiver:';

/** Receiver demand must survive a later, unrelated write to the Session row. */
export function buildSessionFollowReceiverChangeEntityIdV1(sessionId: string): string {
  return `${SESSION_FOLLOW_RECEIVER_CHANGE_PREFIX_V1}${SessionIdSchema.parse(sessionId)}`;
}

/** A wake selects one resource to re-admit; it grants no receiver authority. */
export function readSessionFollowReceiverChangeV1(change: Readonly<{ kind: string; entityId: string }>): string | null {
  if (change.kind !== 'account' || !change.entityId.startsWith(SESSION_FOLLOW_RECEIVER_CHANGE_PREFIX_V1)) return null;
  const sessionId = SessionIdSchema.safeParse(change.entityId.slice(SESSION_FOLLOW_RECEIVER_CHANGE_PREFIX_V1.length));
  return sessionId.success ? sessionId.data : null;
}

/**
 * A Session-scoped Follow change. The V1 consumer reloads the complete exact-Home
 * Follow snapshot, so this hint is truthfully coarse rather than carrying a
 * Session-id list no reader narrows by. A targeted hint belongs here only with a
 * measured consumer landed in the same change.
 */
export const SessionFollowChangeHintV1Schema = z.strictObject({
    sessionFollows: z.literal(true),
    full: z.literal(true),
  });
export type SessionFollowChangeHintV1 = z.infer<typeof SessionFollowChangeHintV1Schema>;

export function buildSessionFollowChangeHintV1(): SessionFollowChangeHintV1 {
  return { sessionFollows: true, full: true };
}

/**
 * Reads a Follow invalidation out of an Account change entry. Callers use it to
 * refresh the complete exact-Home Follow projection; an unrecognized hint
 * shape is not a Follow change.
 */
export function readSessionFollowChangeHintV1(value: unknown): SessionFollowChangeHintV1 | null {
  const parsed = SessionFollowChangeHintV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
