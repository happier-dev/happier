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
  labelNames: readonly string[];
  /** `null` when unresolved: REST cannot always answer this (see `reviews.ts`). */
  reviewDecision: GithubReviewDecisionV1 | null;
  /** `null` when checks are unavailable, unreadable, or not configured. */
  checks: GithubChecksRowStateV1 | null;
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

/** Bounding order when the published fact count cannot hold the whole table. */
const IMPORTANCE_RANK: Readonly<Record<GithubTriageRowFactImportanceV1, number>> = Object.freeze({
  primary: 0,
  secondary: 1,
  supplementary: 2,
});

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
    value: Object.freeze({ kind: 'status', label, tone }),
  });
}

function checksFact(state: GithubChecksRowStateV1): GithubTriageRowFactV1 {
  const value = state.kind === 'failing'
    ? ({ kind: 'status', label: `${state.failingCount} failing`, tone: 'danger' } as const)
    : state.kind === 'running'
      ? ({ kind: 'status', label: 'Running', tone: 'info' } as const)
      : ({ kind: 'status', label: 'All passing', tone: 'success' } as const);
  return Object.freeze({
    id: 'github/checks',
    importance: 'primary',
    value: Object.freeze(value),
  });
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
    value: Object.freeze({ kind: 'status', label, tone }),
  });
}

export function buildGithubRowFacts(input: GithubRowFactsInputV1): GithubRowFactsProjectionV1 {
  const facts: GithubTriageRowFactV1[] = [];
  let truncated = false;

  const push = (fact: GithubTriageRowFactV1): void => {
    if (fact.value.kind === 'text' || fact.value.kind === 'actor' || fact.value.kind === 'status') {
      const raw = fact.value.kind === 'text' ? fact.value.text : fact.value.label;
      const bounded = projectTriageDisplayTextV1(raw, MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1);
      if (bounded.truncated) {
        truncated = true;
        const rebound: GithubTriageRowFactV1 = fact.value.kind === 'text'
          ? { ...fact, value: Object.freeze({ kind: 'text', text: bounded.value }) }
          : fact.value.kind === 'actor'
            ? { ...fact, value: Object.freeze({ kind: 'actor', label: bounded.value }) }
            : {
              ...fact,
              value: Object.freeze({ kind: 'status', label: bounded.value, tone: fact.value.tone }),
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
    value: Object.freeze({ kind: 'text', text: `#${input.number}` }),
  });
  push({
    id: 'github/repository',
    importance: 'primary',
    value: Object.freeze({ kind: 'text', text: input.repositoryLabel }),
  });
  if (input.authorLogin !== null) {
    push({
      id: 'github/author',
      importance: 'secondary',
      value: Object.freeze({ kind: 'actor', label: input.authorLogin }),
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
  if (input.labelNames.length > 0) {
    push({
      id: 'github/labels',
      importance: 'supplementary',
      value: Object.freeze({ kind: 'text', text: formatGithubLabelSummary(input.labelNames) }),
    });
  }
  if (input.kindId === 'pull-request') {
    if (input.reviewDecision !== null) push(reviewDecisionFact(input.reviewDecision));
    if (input.checks !== null) push(checksFact(input.checks));
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
        value: Object.freeze({ kind: 'text', text: `+${additions} −${deletions}` }),
      });
    }
  }

  if (facts.length > MAX_TRIAGE_ROW_FACTS_V1) {
    // The published fact count is small, so WHICH facts survive is the whole product
    // decision. Emission order is the table's reading order, not an importance order,
    // so a positional slice would drop a pull request's review decision and checks —
    // the two facts a reviewer actually triages on — to keep its comment count.
    const ranked = [...facts].sort((left, right) =>
      IMPORTANCE_RANK[left.importance] - IMPORTANCE_RANK[right.importance]);
    return Object.freeze({
      rowFacts: Object.freeze(ranked.slice(0, MAX_TRIAGE_ROW_FACTS_V1)),
      truncated: true,
    });
  }
  return Object.freeze({ rowFacts: Object.freeze(facts), truncated });
}
