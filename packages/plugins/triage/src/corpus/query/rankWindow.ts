import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import { entryReferenceComponents } from '../identity/components.js';
import type { CorpusSmartPolicyV1, CorpusSmartPredicateV1 } from './smartPolicy.js';

/**
 * The one window-local order.
 *
 * **Ordering is window-local, and that is a real product cost stated rather
 * than hidden.** Nothing provider-derived is durable and there is no
 * server-side index to sort against, so an order is exact over the page the
 * user has actually fetched — never over every entry the provider holds. This
 * module therefore consumes rows and returns rows: it cannot fetch a page,
 * change a continuation, compare section heads, or claim one global rank, so a
 * caller cannot accidentally present "the N most recent I fetched" as "the N
 * most recent that exist". The truthful `complete`/`partial` coverage that says
 * which one the user is looking at stays with the window assembler.
 *
 * It is the sole ordering owner for the device-local projection. Newest and
 * oldest are the direct activity comparators; `smart` reads the closed
 * precedence ladder of `smartPolicy.ts`. No score or rank produced here is
 * persisted anywhere, and no row is rewritten on the way through.
 */

/**
 * The minimum a row must expose to be ordered.
 *
 * `attention` is the **one** canonical `deriveDisplayedAttention` result, taken
 * exactly as the fold produced it. This module may not inspect
 * `viewer.sourceAttention` or `viewer.involvement` to mint a second attention
 * level, reason or winner: two connections legitimately disagree about those
 * facts, and a local re-derivation would order a row under one account while
 * detail and mutation route under another.
 */
export type CorpusRankableRowV1 = Readonly<{
    entryRef: TriageEntryRefV1;
    sortAtMs: number;
    attention: Readonly<{ level: 'required' | 'suggested' }> | null;
}>;

/** The three built-in orders. `smart` is a window re-rank, never a persisted score. */
export type CorpusWindowOrderV1 = 'newest' | 'oldest' | 'smart';

/**
 * The attention partition: `required`, then `suggested`, then the rows no
 * canonical attention predicate matched.
 *
 * A `null` result — including an entry whose only observation is `unresolved` —
 * has no synthetic value and no explanation. It is grouped last because it
 * matched no predicate, which is a different statement from scoring it zero:
 * a source outage must never be rendered as "nothing needs you".
 */
const ATTENTION_GROUP: Readonly<Record<'required' | 'suggested' | 'none', number>> = Object.freeze({
    required: 0,
    suggested: 1,
    none: 2,
});

function compareAttention(left: CorpusRankableRowV1, right: CorpusRankableRowV1): number {
    return ATTENTION_GROUP[left.attention?.level ?? 'none'] - ATTENTION_GROUP[right.attention?.level ?? 'none'];
}

/** Activity is `sortAtMs` descending wherever it is read as a Smart predicate. */
function compareActivityDescending(left: CorpusRankableRowV1, right: CorpusRankableRowV1): number {
    return right.sortAtMs - left.sortAtMs;
}

const SMART_PREDICATES: Readonly<Record<
    CorpusSmartPredicateV1,
    (left: CorpusRankableRowV1, right: CorpusRankableRowV1) => number
>> = Object.freeze({
    attention: compareAttention,
    activity: compareActivityDescending,
});

/**
 * The deterministic final tie-break: the ordered canonical reference
 * components, compared position by position.
 *
 * It reuses the one identity tuple every durable Triage reference keys on
 * rather than minting a second spelling, and it compares components rather than
 * a joined string because `U+001F` is representable inside `collisionScope` —
 * a delimiter join would make two contract-valid distinct entries compare
 * equal, and their relative order would then depend on arrival order.
 *
 * Arrival, pass and lane order are never authorities: two lanes legitimately
 * answer in a different order on every pass, and an order that depended on it
 * would reshuffle a list the user is reading.
 */
function compareEntryReferences(left: TriageEntryRefV1, right: TriageEntryRefV1): number {
    const leftComponents = entryReferenceComponents(left);
    const rightComponents = entryReferenceComponents(right);
    for (let index = 0; index < leftComponents.length; index += 1) {
        const leftComponent = leftComponents[index] ?? '';
        const rightComponent = rightComponents[index] ?? '';
        if (leftComponent < rightComponent) return -1;
        if (leftComponent > rightComponent) return 1;
    }
    return 0;
}

/**
 * The one comparator. `smart` reads the two closed predicates in the exact
 * selected order; `newest` and `oldest` read activity alone, so a
 * required-attention row never jumps a newer one in a direct order the user
 * asked for.
 */
export function compareCorpusWindowRows(
    order: CorpusWindowOrderV1,
    policy: CorpusSmartPolicyV1,
): (left: CorpusRankableRowV1, right: CorpusRankableRowV1) => number {
    return (left, right) => {
        if (order === 'smart') {
            for (const predicate of policy.precedence) {
                const decided = SMART_PREDICATES[predicate](left, right);
                if (decided !== 0) return decided;
            }
        }
        const byActivity = order === 'oldest'
            ? left.sortAtMs - right.sortAtMs
            : compareActivityDescending(left, right);
        return byActivity !== 0 ? byActivity : compareEntryReferences(left.entryRef, right.entryRef);
    };
}

/**
 * Re-rank one already-fetched window.
 *
 * The caller's array is never reordered in place — a window a surface is
 * rendering must not shuffle underneath it — and every returned element is the
 * exact row object that came in, so no attention value, score or explanation
 * can be manufactured on the way through.
 */
export function rankCorpusWindow<TRow extends CorpusRankableRowV1>(
    rows: readonly TRow[],
    order: CorpusWindowOrderV1,
    policy: CorpusSmartPolicyV1,
): readonly TRow[] {
    return [...rows].sort(compareCorpusWindowRows(order, policy));
}
