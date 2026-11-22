import {
  defineProtocolArray,
  defineProtocolLiteral,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import { ReviewFindingSeverityProtocolSchema } from '@happier-dev/plugin-sdk/reviews';

import { TriageIdentifierV1ProtocolSchema } from './identity.js';

const nonempty = defineProtocolString({ minLength: 1 });
const patterns = defineProtocolArray(nonempty, { minItems: 1 });
const bool = defineProtocolUnion([
  defineProtocolLiteral(true),
  defineProtocolLiteral(false),
]);

export const PullRequestReviewAuthorKindV1Schema = defineProtocolUnion([
  defineProtocolLiteral('human'),
  defineProtocolLiteral('bot'),
  defineProtocolLiteral('unsupported'),
]);
export type PullRequestReviewAuthorKindV1 = ReturnType<
  typeof PullRequestReviewAuthorKindV1Schema.parse
>;

/** The review step's own options; project trigger filters stay with the Automation event filter. */
export const PULL_REQUEST_REVIEW_STEP_RULE_MEMBERS_V1 = {
  ignorePaths: defineProtocolArray(nonempty).optional(),
  inlineThreshold: ReviewFindingSeverityProtocolSchema.optional(),
} as const;

/** What a repository's `.happier/review-rules.json` at the base commit may say. */
export const PULL_REQUEST_REVIEW_BASE_FILE_RULE_MEMBERS_V1 = {
  ...PULL_REQUEST_REVIEW_STEP_RULE_MEMBERS_V1,
  baseRefs: patterns.optional(),
  authorKinds: defineProtocolArray(PullRequestReviewAuthorKindV1Schema, {
    minItems: 1,
  }).optional(),
  skipDrafts: bool.optional(),
} as const;

const provenance = defineProtocolUnion([
  defineProtocolLiteral('projectAutomation'),
  defineProtocolLiteral('baseCommit'),
]);
/** The rules one Prepare applied, at its verified base revision, with where each field came from. */
export const PullRequestReviewResolvedRulesV1Schema = defineProtocolObject(
  {
    ...PULL_REQUEST_REVIEW_BASE_FILE_RULE_MEMBERS_V1,
    baseRevision: nonempty,
    provenance: defineProtocolObject(
      {
        ignorePaths: provenance.optional(),
        inlineThreshold: provenance.optional(),
        baseRefs: provenance.optional(),
        authorKinds: provenance.optional(),
        skipDrafts: provenance.optional(),
      },
      { policy: 'closed' },
    ),
  },
  { policy: 'closed' },
);
export type PullRequestReviewResolvedRulesV1 = ReturnType<
  typeof PullRequestReviewResolvedRulesV1Schema.parse
>;

export const PullRequestReviewSkipReasonV1Schema = defineProtocolUnion([
  defineProtocolLiteral('baseRef'),
  defineProtocolLiteral('authorKind'),
  defineProtocolLiteral('draft'),
  defineProtocolLiteral('noReviewablePaths'),
]);
export type PullRequestReviewSkipReasonV1 = ReturnType<
  typeof PullRequestReviewSkipReasonV1Schema.parse
>;

/**
 * The rule fields a skip reason can name, with where each was set. The review step's inline
 * severity never decides a skip, so it stays out of the detail input, whose JSON projection every
 * host rehydrates.
 */
export const TriageReviewSkipRulesV1Schema = defineProtocolObject(
  {
    ignorePaths: PULL_REQUEST_REVIEW_STEP_RULE_MEMBERS_V1.ignorePaths,
    baseRefs: PULL_REQUEST_REVIEW_BASE_FILE_RULE_MEMBERS_V1.baseRefs,
    authorKinds: PULL_REQUEST_REVIEW_BASE_FILE_RULE_MEMBERS_V1.authorKinds,
    skipDrafts: PULL_REQUEST_REVIEW_BASE_FILE_RULE_MEMBERS_V1.skipDrafts,
    baseRevision: nonempty,
    provenance: defineProtocolObject(
      {
        ignorePaths: provenance.optional(),
        baseRefs: provenance.optional(),
        authorKinds: provenance.optional(),
        skipDrafts: provenance.optional(),
      },
      { policy: 'closed' },
    ),
  },
  { policy: 'closed' },
);
export type TriageReviewSkipRulesV1 = ReturnType<
  typeof TriageReviewSkipRulesV1Schema.parse
>;

/** Prepare's resolved rules without the fields no skip reason names. */
export function projectTriageReviewSkipRulesV1(
  rules: PullRequestReviewResolvedRulesV1,
): TriageReviewSkipRulesV1 {
  const {
    inlineThreshold: _inline,
    provenance: { inlineThreshold: _inlineSource, ...provenance },
    ...kept
  } = rules;
  return { ...kept, provenance };
}

/**
 * The entry's latest Prepare that skipped its pull-request Review, recorded by Triage from that
 * typed result: the head it judged, the reason and rules, the occurrence facts the rule compared
 * and the Automation whose run asked. A later admitted Review replaces it; a consumer never
 * re-derives a skip from rules or trigger facts.
 */
export const TriageReviewSkipV1Schema = defineProtocolObject(
  {
    headSha: TriageIdentifierV1ProtocolSchema,
    reason: PullRequestReviewSkipReasonV1Schema,
    rules: TriageReviewSkipRulesV1Schema,
    occurrence: defineProtocolObject(
      {
        baseRef: nonempty.optional(),
        authorKind: PullRequestReviewAuthorKindV1Schema.optional(),
      },
      { policy: 'closed' },
    ),
    automationId: TriageIdentifierV1ProtocolSchema.optional(),
  },
  { policy: 'closed' },
);
export type TriageReviewSkipV1 = ReturnType<
  typeof TriageReviewSkipV1Schema.parse
>;
