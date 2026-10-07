import { resolveReviewNarratorPolicy } from '@happier-dev/protocol/reviews/reviewEngines';

/**
 * A review engine as the Start review dialog shows it, read from the host's `review.engines.list`
 * inventory: `structuredNarration` says whether it can write prose (a findings-only CLI cannot).
 */
export type ReviewWalkthroughEngine = Readonly<{
    engineId: string;
    label: string;
    description?: string | null;
    enabled: boolean;
    structuredNarration: boolean;
}>;

export type ReviewWalkthroughNarrator = Readonly<{
    /** several: one model writes from every engine's findings · findings_only: the reviewer writes no prose. */
    reason: 'several' | 'findings_only';
    /** The narrator the start will name; null when no capable engine is available. */
    engineId: string | null;
    candidates: readonly ReviewWalkthroughEngine[];
}>;

export type ReviewWalkthroughFooter =
    | Readonly<{ kind: 'review_then_walkthrough' }>
    | Readonly<{ kind: 'reviewer_then_narrator'; reviewer: string; narrator: string }>;

export type ReviewWalkthroughPlan = Readonly<{
    selected: readonly ReviewWalkthroughEngine[];
    walkthrough: boolean;
    /** Shown only when several engines review or the one reviewer writes no prose (lab WT5-R4, R7). */
    narrator: ReviewWalkthroughNarrator | null;
    footer: ReviewWalkthroughFooter | null;
    canStart: boolean;
    blocked: 'no_engine' | 'no_narrator' | null;
}>;

function isNarrationCapable(engine: ReviewWalkthroughEngine): boolean {
    return engine.enabled && engine.structuredNarration;
}

/**
 * What a review started from a comparison will do: which engines review, whether one narrator must be
 * named and who it is. The narrator need and its default come from the protocol's shared policy, the
 * same one review admission enforces; a findings-only review preselects the first model engine so the
 * dialog names who writes rather than inventing a hidden choice.
 */
export function resolveReviewWalkthroughPlan(params: Readonly<{
    engines: readonly ReviewWalkthroughEngine[];
    selectedEngineIds: readonly string[];
    walkthrough: boolean;
    narratorEngineId: string | null;
}>): ReviewWalkthroughPlan {
    const selected = params.engines.filter((engine) => engine.enabled && params.selectedEngineIds.includes(engine.engineId));
    if (selected.length === 0) {
        return { selected, walkthrough: params.walkthrough, narrator: null, footer: null, canStart: false, blocked: 'no_engine' };
    }
    if (!params.walkthrough) {
        return { selected, walkthrough: false, narrator: null, footer: null, canStart: true, blocked: null };
    }
    const policy = resolveReviewNarratorPolicy({
        selectedEngineIds: selected.map((engine) => engine.engineId),
        engines: params.engines.map((engine) => ({
            value: engine.engineId,
            enabled: engine.enabled,
            capabilities: { structuredNarration: engine.structuredNarration },
        })),
    });
    if (!policy.requiresSeparateNarrator) {
        return { selected, walkthrough: true, narrator: null, footer: { kind: 'review_then_walkthrough' }, canStart: true, blocked: null };
    }
    const candidates = params.engines.filter(isNarrationCapable);
    const chosen = candidates.find((engine) => engine.engineId === params.narratorEngineId)
        ?? candidates.find((engine) => engine.engineId === policy.defaultNarratorEngineId)
        ?? candidates[0]
        ?? null;
    const reason = selected.length > 1 ? 'several' as const : 'findings_only' as const;
    const footer: ReviewWalkthroughFooter | null = !chosen
        ? null
        : reason === 'findings_only'
            ? { kind: 'reviewer_then_narrator', reviewer: selected[0]!.label, narrator: chosen.label }
            : { kind: 'review_then_walkthrough' };
    return {
        selected,
        walkthrough: true,
        narrator: { reason, engineId: chosen?.engineId ?? null, candidates },
        footer,
        canStart: chosen !== null,
        blocked: chosen ? null : 'no_narrator',
    };
}

/**
 * The `review.start` input for a review of one captured comparison. The comparison replaces Change
 * type and Base; the walkthrough and its narrator are requested only when chosen. Callers never send
 * findings or evidence; the host rereads the captured comparison.
 */
export function buildReviewStartWithWalkthroughInput(params: Readonly<{
    sessionId: string;
    plan: ReviewWalkthroughPlan;
    instructions: string;
    comparisonId: string;
    /** Pending changes keep the existing uncommitted scope; every other comparison is read whole. */
    pending: boolean;
}>): Record<string, unknown> {
    const narratorEngineId = params.plan.narrator?.engineId ?? null;
    return {
        sessionId: params.sessionId,
        engineIds: params.plan.selected.map((engine) => engine.engineId),
        instructions: params.instructions.trim(),
        comparisonId: params.comparisonId,
        ...(params.plan.walkthrough ? { outputs: ['walkthrough'] } : {}),
        ...(params.plan.walkthrough && narratorEngineId ? { narrator: { engineId: narratorEngineId } } : {}),
        changeType: params.pending ? 'uncommitted' : 'all',
    };
}
