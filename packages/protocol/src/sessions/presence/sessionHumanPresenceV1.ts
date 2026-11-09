import { z } from 'zod/mini';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { DiscussionIdSchema } from '../../discussions/references.js';
import { SessionIdSchema } from '../idsV1.js';
import { SessionAccessAccountSummaryV1Schema } from '../access/sessionAccessPrincipalV1.js';

export const SESSION_HUMAN_PRESENCE_VISIBLE_REPLACE_EVENT = 'session-human-presence:visible-replace';
export const SESSION_HUMAN_PRESENCE_TYPING_SET_EVENT = 'session-human-presence:typing-set';
export const SESSION_HUMAN_PRESENCE_SNAPSHOT_EVENT = 'session-human-presence:snapshot';

// V1 is a closed operation epoch, independently negotiated by its first actual
// declaration. Unknown identity/routing/profile fields are never dropped.
const normalizedSessionId = z.pipe(z.string().check(z.trim()), asProtocolZod(SessionIdSchema));
const sessionIds = z.pipe(z.array(normalizedSessionId), z.transform(ids => [...new Set(ids)].sort()));
const normalizedDiscussionId = z.pipe(z.string().check(z.trim()), DiscussionIdSchema);

export const SessionHumanPresenceLocationV1Schema = z.strictObject({
  discussionId: normalizedDiscussionId,
});
export type SessionHumanPresenceLocationV1 = z.infer<typeof SessionHumanPresenceLocationV1Schema>;

const discussionLocations = z.pipe(z.array(SessionHumanPresenceLocationV1Schema), z.transform(locations => {
  const byKey = new Map(locations.map(location => [location.discussionId, location]));
  return [...byKey.values()].sort((left, right) => left.discussionId.localeCompare(right.discussionId));
}));

export const SessionHumanPresencePendingMessageEditV1Schema = z.strictObject({
  sessionId: normalizedSessionId,
  holdId: z.string().check(z.trim(), z.minLength(1)),
});
export type SessionHumanPresencePendingMessageEditV1 = z.infer<typeof SessionHumanPresencePendingMessageEditV1Schema>;
const pendingMessageEdits = z.array(SessionHumanPresencePendingMessageEditV1Schema);

export const SessionHumanPresenceVisibleReplaceV1Schema = z.strictObject({
  v: z.literal(1),
  // This is the complete finite rendered set. A count or byte limit here would
  // make an unrelated transport threshold part of collaboration semantics.
  sessionIds,
  // Optional keeps the released/current Session-only declaration byte-compatible.
  // An older strict server rejects this routing field instead of silently
  // treating discussion visibility as Session visibility.
  locations: z.optional(discussionLocations),
  // Complete desired edit set, independent of visibility. Edits never outlive
  // the socket; only the server's admitted subset becomes live.
  pendingMessageEdits: z.optional(pendingMessageEdits),
});
export type SessionHumanPresenceVisibleReplaceV1 = z.infer<typeof SessionHumanPresenceVisibleReplaceV1Schema>;

export const SessionHumanPresenceVisibleReplaceResultV1Schema = z.discriminatedUnion('ok', [
  z.strictObject({
    v: z.literal(1),
    ok: z.literal(true),
    admittedSessionIds: sessionIds,
    admittedLocations: z.optional(discussionLocations),
    admittedPendingMessageEdits: z.optional(pendingMessageEdits),
  }),
  z.strictObject({
    v: z.literal(1), ok: z.literal(false),
    errorCode: z.enum(['INVALID_REQUEST', 'UNSUPPORTED_VERSION', 'UNAVAILABLE']),
  }),
]);
export type SessionHumanPresenceVisibleReplaceResultV1 = z.infer<typeof SessionHumanPresenceVisibleReplaceResultV1Schema>;

export const SessionHumanPresenceTypingSetV1Schema = z.union([
  z.strictObject({
    v: z.literal(1), sessionId: normalizedSessionId,
    discussionId: z.optional(z.never()), typing: z.boolean(),
  }),
  z.strictObject({
    v: z.literal(1), discussionId: normalizedDiscussionId,
    sessionId: z.optional(z.never()), typing: z.boolean(),
  }),
]);
export type SessionHumanPresenceTypingSetV1 = z.infer<typeof SessionHumanPresenceTypingSetV1Schema>;

export const SessionHumanPresenceViewerV1Schema = z.strictObject({
  account: SessionAccessAccountSummaryV1Schema,
  typing: z.boolean(),
});
export type SessionHumanPresenceViewerV1 = z.infer<typeof SessionHumanPresenceViewerV1Schema>;

const snapshotFields = {
  v: z.literal(1),
  observedAt: z.number().check(z.int(), z.nonnegative()),
  viewers: z.array(SessionHumanPresenceViewerV1Schema),
};
export const SessionHumanPresenceSnapshotV1Schema = z.union([
  z.strictObject({
    ...snapshotFields, sessionId: asProtocolZod(SessionIdSchema),
    discussionId: z.optional(z.never()),
    // Only Session queue observers consume this projection; human viewers do not.
    pendingMessageEditHoldIds: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
  }),
  z.strictObject({
    ...snapshotFields, discussionId: DiscussionIdSchema,
    sessionId: z.optional(z.never()),
  }),
]);
export type SessionHumanPresenceSnapshotV1 = z.infer<typeof SessionHumanPresenceSnapshotV1Schema>;
