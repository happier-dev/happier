import type { TriageSourceViewerFactsV1 } from '@happier-dev/triage-protocol/v1';

import type { CorpusEntryObservationsV1 } from '../fold/projectedObservation.js';

/**
 * The bounded displayed-attention result of one projected entry.
 *
 * It is a display fact, never a score, index, permission or mutation authority:
 * selected detail and every source Action read the winning observation itself.
 */
export type CorpusDisplayedAttentionV1 = Readonly<{
    level: 'required' | 'suggested';
    /** The observation that carried the winning signal. The surface shows a reason, never a number. */
    fromSourceInstanceId: string;
    /** A source-declared `reasonId`, or an aggregate-owned involvement reason id. */
    reasonId: string;
    /** The source-owned `reasonLabel`, or the aggregate's own label for an involvement-derived reason. */
    reasonLabel: string;
}>;

type InvolvementReason = Readonly<{
    level: 'required' | 'suggested';
    reasonId: string;
    reasonLabel: string;
    /** The reason chip's mark, a shared icon token (`PLUGIN_UI_ICON_TOKENS_V1`); words alone when absent. */
    reasonIcon?: string;
}>;

/**
 * The aggregate's own involvement table, used only when a source declared no
 * attention of its own. Involvement values are ordered strongest first, so one
 * pass over this list picks the strongest claim a viewer actually has.
 */
const INVOLVEMENT_REASONS: readonly (readonly [
    TriageSourceViewerFactsV1['involvement'][number],
    InvolvementReason,
])[] = Object.freeze([
    ['reviewRequested', { level: 'required', reasonId: 'involvement/review-requested', reasonLabel: 'Review requested', reasonIcon: 'review' }],
    ['assignee', { level: 'required', reasonId: 'involvement/assignee', reasonLabel: 'Assigned to you', reasonIcon: 'assigned' }],
    ['mentioned', { level: 'suggested', reasonId: 'involvement/mentioned', reasonLabel: 'Mentioned', reasonIcon: 'mention' }],
    ['author', { level: 'suggested', reasonId: 'involvement/author', reasonLabel: 'Opened by you' }],
    ['participating', { level: 'suggested', reasonId: 'involvement/participating', reasonLabel: 'Participating' }],
    ['subscribed', { level: 'suggested', reasonId: 'involvement/subscribed', reasonLabel: 'Subscribed' }],
] as const);

const LEVEL_RANK: Readonly<Record<'required' | 'suggested', number>> = Object.freeze({
    required: 0,
    suggested: 1,
});

function candidateFor(viewer: TriageSourceViewerFactsV1): InvolvementReason | null {
    const declared = viewer.sourceAttention;
    if (declared) {
        // `{ level: 'none' }` is the source's explicit "no meaningful candidate"
        // arm. It is a declaration, so it does not fall through to involvement,
        // and a reason-free declaration never becomes a display winner.
        if (declared.level === 'none') return null;
        return { level: declared.level, reasonId: declared.reasonId, reasonLabel: declared.reasonLabel };
    }
    const involvement = new Set<string>(viewer.involvement);
    for (const [value, reason] of INVOLVEMENT_REASONS) {
        if (involvement.has(value)) return reason;
    }
    return null;
}

/**
 * The one attention derivation. Query ordering, selected-instance routing and
 * Smart ordering all consume this result; none may reread `sourceAttention` or
 * `involvement` to mint a second attention level, reason or winner.
 *
 * Two accounts observing one pull request legitimately disagree about every one
 * of these facts, which is why attention lives on the observations and only the
 * derived result reaches the row.
 */
export function deriveDisplayedAttention(
    observations: CorpusEntryObservationsV1,
): CorpusDisplayedAttentionV1 | null {
    const candidates: CorpusDisplayedAttentionV1[] = [];
    for (const observation of observations) {
        // An unresolved observation is excluded from the derivation rather than
        // scored `none`: a source that failed has said nothing about attention,
        // and scoring it would silently demote an entry the user is assigned to
        // whenever the other connection fails.
        if (observation.outcome.kind !== 'present') continue;
        const candidate = candidateFor(observation.outcome.viewer);
        if (!candidate) continue;
        candidates.push({
        level: candidate.level,
        reasonId: candidate.reasonId,
        reasonLabel: candidate.reasonLabel,
        fromSourceInstanceId: observation.sourceInstanceId,
    });
    }
    if (candidates.length === 0) return null;
    // Level descending, then the stable source-instance id ascending. The one
    // candidate per instance makes that a total order; arrival and pass order
    // are never an authority, because an arrival-order winner later routes
    // detail and mutation authority under the wrong account.
    candidates.sort((left, right) => (
        LEVEL_RANK[left.level] - LEVEL_RANK[right.level]
        || (left.fromSourceInstanceId < right.fromSourceInstanceId ? -1 : left.fromSourceInstanceId > right.fromSourceInstanceId ? 1 : 0)
    ));
    return candidates[0] ?? null;
}

/**
 * A source's "this is a severe security finding": the one source reason Triage draws as a failure (a rose chip with
 * its shield, lab c8-alert) rather than as amber needs-you.
 */
const SECURITY_SEVERITY_REASON_ID = 'github-security-severity';

/** Whether this reason is a failure rather than a request for the reader. */
/** Whether the reason is the reader's own requested review (involvement), which a pull request's reviewers say. */
export function isTriageReviewRequestedReasonV1(reasonId: string): boolean {
    return INVOLVEMENT_REASONS.some(([value, reason]) => value === 'reviewRequested' && reason.reasonId === reasonId);
}

export function readTriageAttentionReasonDangerV1(reasonId: string): boolean {
    return reasonId === SECURITY_SEVERITY_REASON_ID;
}

/**
 * The reason's mark, for the aggregate's involvement reasons and the security severity above. Any other
 * source-declared reason names no mark, so it is drawn as its words alone rather than with a guess from them.
 */
export function readTriageAttentionReasonIconV1(reasonId: string): string | null {
    if (reasonId === SECURITY_SEVERITY_REASON_ID) return 'shield';
    for (const [, reason] of INVOLVEMENT_REASONS) {
        if (reason.reasonId === reasonId) return reason.reasonIcon ?? null;
    }
    return null;
}
