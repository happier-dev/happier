import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

/**
 * The closed set of reasons one Session can be part of one Account's work
 * (Lane 09B §4.3). It is a bounded product domain, not a policy DSL: adding a
 * member is a deliberate contract change that must also gain a relational arm in
 * the server scope predicate.
 *
 * Declaration order is the canonical projection order.
 */
export const SessionPersonalRelevanceReasonV1Schema = lazyZodSchema(() => z.enum([
  'owned_by_me',
  'responsible_for_me',
  'shared_directly_with_me',
  'authored_by_me',
  'mentioned_in_discussion',
  'followed_by_me',
  'pinned_by_me',
  'explicit_attention',
]));
export type SessionPersonalRelevanceReasonV1 = z.infer<
  typeof SessionPersonalRelevanceReasonV1Schema
>;

export const SessionPersonalRelevanceV1Schema = lazyZodSchema(() => z
  .object({
    relevant: z.boolean(),
    reasons: z.array(SessionPersonalRelevanceReasonV1Schema).readonly(),
  })
  .strict());
export type SessionPersonalRelevanceV1 = Readonly<{
  relevant: boolean;
  reasons: readonly SessionPersonalRelevanceReasonV1[];
}>;

/**
 * Content-free relevance inputs.
 *
 * `authoredByMe` is the authenticated **human-origin** authorship fact from the
 * Session-transcript and discussion owners. An Agent row that merely records a
 * requesting or executing Account is not human participation, so this flag is
 * never derived from an author column alone.
 *
 * `explicitAttention` is an explicit positive per-Account standing. The
 * Account-wide attention default is a client presentation rule and never reaches
 * this resolver (L09B-I7).
 */
export type SessionPersonalRelevanceFactsV1 = Readonly<{
  ownedByMe: boolean;
  responsibleForMe: boolean;
  sharedDirectlyWithMe: boolean;
  authoredByMe: boolean;
  mentionedInDiscussion: boolean;
  followedByMe: boolean;
  pinnedByMe: boolean;
  explicitAttention: boolean;
}>;

export const NO_SESSION_PERSONAL_RELEVANCE_FACTS_V1: SessionPersonalRelevanceFactsV1 = Object.freeze({
  ownedByMe: false,
  responsibleForMe: false,
  sharedDirectlyWithMe: false,
  authoredByMe: false,
  mentionedInDiscussion: false,
  followedByMe: false,
  pinnedByMe: false,
  explicitAttention: false,
});

const RELEVANCE_ARMS: readonly (readonly [
  SessionPersonalRelevanceReasonV1,
  keyof SessionPersonalRelevanceFactsV1,
])[] = [
  ['owned_by_me', 'ownedByMe'],
  ['responsible_for_me', 'responsibleForMe'],
  ['shared_directly_with_me', 'sharedDirectlyWithMe'],
  ['authored_by_me', 'authoredByMe'],
  ['mentioned_in_discussion', 'mentionedInDiscussion'],
  ['followed_by_me', 'followedByMe'],
  ['pinned_by_me', 'pinnedByMe'],
  ['explicit_attention', 'explicitAttention'],
];

/**
 * Explains one projected row. Overlapping reasons collapse into one row with one
 * ordered reason list (L09B-I10); the server scope predicate selects the same
 * membership relationally, before pagination.
 */
export function resolveSessionPersonalRelevanceV1(
  facts: SessionPersonalRelevanceFactsV1,
): SessionPersonalRelevanceV1 {
  const reasons = RELEVANCE_ARMS
    .filter(([, key]) => facts[key] === true)
    .map(([reason]) => reason);
  return { relevant: reasons.length > 0, reasons };
}
