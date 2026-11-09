import { z } from 'zod/mini';

/**
 * The advisory AccountChange hint for discussion writes.
 *
 * `AccountChange` rows are uniquely keyed and coalesced. This carries no ids,
 * content, titles, cursors, or an allegedly complete discussion list: a client
 * that sees a resource change must still reread canonical state. Only an exact
 * read-state-only hint can avoid resource reads. Coalescing unions the flags;
 * a cursor update cannot hide a pending message, access, or proposal change.
 */
export const DiscussionChangeHintV1Schema = z.strictObject({
  v: z.literal(1),
  discussions: z.literal(true),
  changes: z.strictObject({
    readState: z.optional(z.literal(true)),
    resource: z.optional(z.literal(true)),
  }).check(z.refine(changes => changes.readState === true || changes.resource === true)),
});
export type DiscussionChangeHintV1 = z.infer<typeof DiscussionChangeHintV1Schema>;

export const DISCUSSION_CHANGE_HINT_V1: DiscussionChangeHintV1 = Object.freeze({
  v: 1,
  discussions: true,
  changes: Object.freeze({ resource: true }),
});

export const DISCUSSION_READ_STATE_CHANGE_HINT_V1: DiscussionChangeHintV1 = Object.freeze({
  v: 1,
  discussions: true,
  changes: Object.freeze({ readState: true }),
});

export function readDiscussionChangeHintV1(value: unknown): DiscussionChangeHintV1 | null {
  const parsed = DiscussionChangeHintV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

