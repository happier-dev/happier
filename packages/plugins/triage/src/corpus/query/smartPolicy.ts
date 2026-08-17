/**
 * The bounded Smart precedence policy.
 *
 * Smart is a closed, versioned, source-neutral **precedence ladder** and
 * nothing else (`core/CORPUS.md` §6.3). There are exactly two orderings of
 * exactly two named predicates: no weights, no decay, no named source branches
 * and no dynamically admitted signals. That closure is the whole reason a
 * durable user preference can carry it — an open policy would turn one Settings
 * value into a ranking engine whose stored shape nobody could evolve.
 *
 * The policy decides how a window the caller already fetched is read. It never
 * decides what is fetched, and no score derived from it is persisted anywhere
 * (`rankWindow.ts`).
 */

/** The two closed ladders, in the exact order their predicates are read. */
export const CORPUS_SMART_PRECEDENCE_TUPLES_V1 = Object.freeze([
    Object.freeze(['attention', 'activity'] as const),
    Object.freeze(['activity', 'attention'] as const),
] as const);

export type CorpusSmartPredicateV1 = 'attention' | 'activity';

export type CorpusSmartPrecedenceV1 = (typeof CORPUS_SMART_PRECEDENCE_TUPLES_V1)[number];

export type CorpusSmartPolicyV1 = Readonly<{ v: 1; precedence: CorpusSmartPrecedenceV1 }>;

/**
 * The retained default. It is the policy a view keeps while its order is not
 * `smart`, and the one an absent or unreadable stored policy resolves to — a
 * missing preference is the default preference, never an absent order.
 */
export const CORPUS_DEFAULT_SMART_POLICY_V1: CorpusSmartPolicyV1 = Object.freeze({
    v: 1,
    precedence: CORPUS_SMART_PRECEDENCE_TUPLES_V1[0],
});

function readPrecedence(value: unknown): CorpusSmartPrecedenceV1 | null {
    if (!Array.isArray(value) || value.length !== 2) return null;
    for (const tuple of CORPUS_SMART_PRECEDENCE_TUPLES_V1) {
        if (tuple[0] === value[0] && tuple[1] === value[1]) return tuple;
    }
    return null;
}

/**
 * Parse one stored policy, or `null` when the value is not exactly one of the
 * closed ladders.
 *
 * It is deliberately closed rather than repairing: an unknown member is a
 * policy this build cannot evaluate, and silently dropping it would apply a
 * different order than the one the user saved without saying so. The caller
 * decides what a `null` means for its own value — for a saved view it is a
 * rejected write, and for a read it is the retained default.
 */
export function parseCorpusSmartPolicy(value: unknown): CorpusSmartPolicyV1 | null {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as Readonly<Record<string, unknown>>;
    const keys = Object.keys(candidate);
    if (keys.length !== 2 || !keys.includes('v') || !keys.includes('precedence')) return null;
    if (candidate.v !== 1) return null;
    const precedence = readPrecedence(candidate.precedence);
    return precedence === null ? null : { v: 1, precedence };
}
