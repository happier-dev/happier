import {
  MAX_TRIAGE_ROW_FACTS_V1,
  MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1,
  projectTriageDisplayTextV1,
} from '@happier-dev/triage-protocol/v1';

import type {
  GithubTriageKindIdV1,
  GithubTriageRowFactImportanceV1,
  GithubTriageRowFactV1,
} from '../types.js';

/**
 * The GitHub row-fact table. Instantiated values only: no property-path expressions, no
 * raw JSON, no links, no Actions, no layout.
 *
 * Absence is never zero. An OMITTED fact means this provider cannot report it here; a
 * `detailOnly` fact means it exists and is deliberately fetched in the detail surface;
 * a value means observed. Those three must not render alike, which is why the caller
 * passes `null` (cannot report) and `'detailOnly'` (answered elsewhere) as distinct
 * inputs rather than collapsing both into a missing field.
 */

export type GithubReviewDecisionV1 = 'approved' | 'changes-requested' | 'review-required';

export type GithubChecksRowStateV1 =
  | Readonly<{ kind: 'allPassing' }>
  | Readonly<{ kind: 'running' }>
  | Readonly<{ kind: 'failing'; failingCount: number }>;

export type GithubRowFactsInputV1 = Readonly<{
  kindId: GithubTriageKindIdV1;
  /** Native item number, already validated as a positive decimal. */
  number: string;
  /** Provider-cased `owner/name` for display. */
  repositoryLabel: string;
  authorLogin: string | null;
  updatedAtMs: number;
  /** `null` when GitHub did not report a comment count on this response. */
  commentCount: number | null;
  /** Exact PR responses state this; search rows do not. Absence is not zero. */
  changedFiles?: number | null;
  labelNames: readonly string[];
  /** `null` when unresolved: REST cannot always answer this (see `reviews.ts`). */
  reviewDecision: GithubReviewDecisionV1 | null;
  /** `null` when no row verdict is reported; failed reads use `unavailable`. */
  checks: GithubChecksRowStateV1 | 'unavailable' | null;
  mergeability: 'conflicts' | 'blocked' | 'computing' | null;
  /**
   * `'detailOnly'` on a scan row — the cost of the diff stat is a large fraction of
   * first-paint wall clock. A resolved pair is emitted only from a detail read.
   */
  additionsDeletions: 'detailOnly' | Readonly<{ additions: number; deletions: number }> | null;
}>;

export type GithubRowFactsProjectionV1 = Readonly<{
  rowFacts: readonly GithubTriageRowFactV1[];
  truncated: boolean;
}>;

/** Keep actionable facts ahead of labels, then other supplementary facts. */
const IMPORTANCE_RANK: Readonly<Record<GithubTriageRowFactImportanceV1, number>> = Object.freeze({
  primary: 0,
  secondary: 1,
  supplementary: 3,
});

function rowFactPriority(fact: GithubTriageRowFactV1): number {
  // These values already travel as snapshot/observation metadata, unlike labels.
  if (fact.id === 'github/author' || fact.id === 'github/updated') return 4;
  if (fact.id === 'github/labels') return 2;
  return IMPORTANCE_RANK[fact.importance];
}

/** Label names joined by `, `, first three, then `+N`. */
export function formatGithubLabelSummary(labelNames: readonly string[]): string {
  const shown = labelNames.slice(0, 3).join(', ');
  const overflow = labelNames.length - Math.min(3, labelNames.length);
  return overflow > 0 ? `${shown} +${overflow}` : shown;
}

function reviewDecisionFact(decision: GithubReviewDecisionV1): GithubTriageRowFactV1 {
  const projection = {
    approved: { label: 'Approved', tone: 'success' },
    'changes-requested': { label: 'Changes requested', tone: 'danger' },
    'review-required': { label: 'Review required', tone: 'warning' },
  } as const;
  const { label, tone } = projection[decision];
  return Object.freeze({
    id: 'github/review-decision',
    importance: 'primary',
    value: Object.freeze({ kind: 'status', value: label, tone }),
  });
}

function checksFact(state: NonNullable<GithubRowFactsInputV1['checks']>): GithubTriageRowFactV1 {
  const value = state === 'unavailable'
    ? ({ kind: 'status', value: 'Checks unavailable', tone: 'warning' } as const)
    : state.kind === 'failing'
    ? ({ kind: 'status', value: `${state.failingCount} failing`, tone: 'danger' } as const)
    : state.kind === 'running'
      ? ({ kind: 'status', value: 'Running', tone: 'info' } as const)
      : ({ kind: 'status', value: 'All passing', tone: 'success' } as const);
  return Object.freeze({
    id: 'github/checks',
    importance: 'primary',
    value: Object.freeze(value),
  });
}

/**
 * The two pull-request state facts a live detail read can prove, built by the
 * SAME constructors the scan/get row table uses.
 *
 * They exist as their own entry point because the row table and the detail
 * surface learn them at different times and from different reads: a scan row
 * carries whatever its search item proved, while the detail planes read the
 * check surface and the review collection directly. Re-spelling the label and
 * tone at the second site is how one product acquires two vocabularies for
 * "Changes requested" — so the second site calls this instead.
 *
 * A `null` input emits nothing: absence is never a fact, and never a zero.
 */
export function buildGithubStateRowFactsV1(input: Readonly<{
  reviewDecision: GithubReviewDecisionV1 | null;
  checks: GithubRowFactsInputV1['checks'];
}>): readonly GithubTriageRowFactV1[] {
  const facts: GithubTriageRowFactV1[] = [];
  if (input.reviewDecision !== null) facts.push(reviewDecisionFact(input.reviewDecision));
  if (input.checks !== null) facts.push(checksFact(input.checks));
  return Object.freeze(facts);
}

function mergeabilityFact(
  mergeability: NonNullable<GithubRowFactsInputV1['mergeability']>,
): GithubTriageRowFactV1 {
  const projection = {
    conflicts: { label: 'Conflicts', tone: 'danger' },
    blocked: { label: 'Blocked', tone: 'warning' },
    computing: { label: 'Computing', tone: 'info' },
  } as const;
  const { label, tone } = projection[mergeability];
  return Object.freeze({
    id: 'github/mergeability',
    importance: 'secondary',
    value: Object.freeze({ kind: 'status', value: label, tone }),
  });
}

export function buildGithubRowFacts(input: GithubRowFactsInputV1): GithubRowFactsProjectionV1 {
  const facts: GithubTriageRowFactV1[] = [];
  let truncated = false;

  const push = (fact: GithubTriageRowFactV1): void => {
    if (fact.value.kind === 'text' || fact.value.kind === 'actor' || fact.value.kind === 'status') {
      const raw = fact.value.value;
      const bounded = projectTriageDisplayTextV1(raw, MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1);
      if (bounded.truncated) {
        truncated = true;
        const rebound: GithubTriageRowFactV1 = {
          ...fact,
          value: Object.freeze({ ...fact.value, value: bounded.value }),
        };
        facts.push(Object.freeze(rebound));
        return;
      }
    }
    facts.push(Object.freeze(fact));
  };

  push({
    id: 'github/number',
    importance: 'primary',
    value: Object.freeze({ kind: 'text', value: `#${input.number}` }),
  });
  push({
    id: 'github/repository',
    importance: 'primary',
    value: Object.freeze({ kind: 'text', value: input.repositoryLabel }),
  });
  if (input.authorLogin !== null) {
    push({
      id: 'github/author',
      importance: 'secondary',
      value: Object.freeze({ kind: 'actor', value: input.authorLogin }),
    });
  }
  push({
    id: 'github/updated',
    importance: 'secondary',
    value: Object.freeze({ kind: 'timestamp', atMs: input.updatedAtMs, format: 'relative' }),
  });
  if (input.commentCount !== null) {
    push({
      id: 'github/comments',
      importance: 'supplementary',
      value: Object.freeze({ kind: 'number', value: input.commentCount, format: 'compact' }),
    });
  }
  if (input.kindId === 'pull-request' && input.changedFiles != null) {
    push({
      id: 'github/changed-files',
      importance: 'secondary',
      value: Object.freeze({ kind: 'number', value: input.changedFiles, format: 'plain' }),
    });
  }
  if (input.labelNames.length > 0) {
    push({
      id: 'github/labels',
      importance: 'supplementary',
      value: Object.freeze({ kind: 'text', value: formatGithubLabelSummary(input.labelNames) }),
    });
  }
  if (input.kindId === 'pull-request') {
    for (const fact of buildGithubStateRowFactsV1({
      reviewDecision: input.reviewDecision,
      checks: input.checks,
    })) {
      push(fact);
    }
    if (input.mergeability !== null) push(mergeabilityFact(input.mergeability));
    if (input.additionsDeletions === 'detailOnly') {
      push({
        id: 'github/additions-deletions',
        importance: 'supplementary',
        value: Object.freeze({ kind: 'detailOnly' }),
      });
    } else if (input.additionsDeletions !== null) {
      const { additions, deletions } = input.additionsDeletions;
      push({
        id: 'github/additions-deletions',
        importance: 'supplementary',
        value: Object.freeze({ kind: 'text', value: `+${additions} −${deletions}` }),
      });
    }
  }

  if (facts.length > MAX_TRIAGE_ROW_FACTS_V1) {
    // The published fact count is small, so WHICH facts survive is the whole product
    // decision. Emission order is the table's reading order, not an importance order,
    // so a positional slice would drop a pull request's review decision and checks.
    // Labels are the issue's Signal: retain them before author/update facts whose
    // values already travel as snapshot/observation metadata. Their presentation
    // importance remains supplementary; selection must not erase the only signal.
    const ranked = [...facts].sort((left, right) =>
      rowFactPriority(left) - rowFactPriority(right));
    return Object.freeze({
      rowFacts: Object.freeze(ranked.slice(0, MAX_TRIAGE_ROW_FACTS_V1)),
      truncated: true,
    });
  }
  return Object.freeze({ rowFacts: Object.freeze(facts), truncated });
}
