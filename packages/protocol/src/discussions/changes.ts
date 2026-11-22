import { z } from '../zodRuntimePolicy.js';

/**
 * The advisory AccountChange hint for discussion writes.
 *
 * `AccountChange` rows are uniquely keyed and coalesced. Message sequences
 * point readers at rows they already hold; content still comes from the exact
 * read. The enclosing cursor belongs to latestSeq. Prior cursors keep unseen
 * resource changes and earlier message changes visible after coalescing.
 */
export const DiscussionChangeHintV1Schema = z.strictObject({
  v: z.literal(1),
  discussions: z.literal(true),
  changes: z.strictObject({
    readState: z.optional(z.literal(true)),
    resource: z.optional(z.literal(true)),
  }).check(z.refine(changes => changes.readState === true || changes.resource === true)),
  messageChanges: z.optional(z.strictObject({
    latestSeq: z.optional(z.number().check(z.int(), z.minimum(1))),
    previousResourceCursor: z.number().check(z.int(), z.minimum(0)),
    previous: z.array(z.strictObject({
      seq: z.number().check(z.int(), z.minimum(1)),
      cursor: z.number().check(z.int(), z.minimum(1)),
    })),
  })),
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

