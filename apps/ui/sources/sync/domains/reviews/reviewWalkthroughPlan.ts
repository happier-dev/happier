import { resolveReviewNarratorPolicy, type ReviewEngineListItem } from '@happier-dev/protocol/reviews/reviewEngines';
import type { ReviewReviewerSelectionV1 } from '@happier-dev/protocol/reviews/reviewStart';

/**
 * A review engine as the Start review dialog shows it, read from the host's `review.engines.list`
 * inventory: `structuredNarration` says whether it can write prose (a findings-only CLI cannot).
 */
export type ReviewWalkthroughEngine = Readonly<{
    engineId: string;
    label: string;
    description?: string | null;
    launchModelId?: string | null;
    enabled: boolean;
    structuredNarration: boolean;
    retentionPolicy?: ReviewEngineListItem['retentionPolicy'];
}>;

export type ReviewWalkthroughNarrator = Readonly<{
    /**
     * several: one model writes from every engine's findings · findings_only: the reviewer writes no prose ·
     * own: no separate narrator is needed (the reviewer writes its own), yet a person may still name one.
     */
    reason: 'several' | 'findings_only' | 'own';
    /** The narrator the start will name; null when no capable engine is available or none is needed and chosen. */
    engineId: string | null;
    candidates: readonly ReviewWalkthroughEngine[];
}>;

export type ReviewWalkthroughFooter =
    | Readonly<{ kind: 'review_then_walkthrough' }>
    | Readonly<{ kind: 'reviewer_then_narrator'; reviewer: string; narrator: string }>;

export type ReviewWalkthroughPlan = Readonly<{
    selected: readonly ReviewWalkthroughEngine[];
    reviewers: readonly ReviewReviewerSelectionV1[];
    walkthrough: boolean;
    /**
     * Present whenever a walkthrough is requested (Start sheet › Advanced › Narrator, U8 R3 E2); `reason` says
     * whether one is needed, and a comparison chip asks only when it is (lab WT5-R4, R7).
     */
    narrator: ReviewWalkthroughNarrator | null;
    footer: ReviewWalkthroughFooter | null;
    canStart: boolean;
    blocked: 'no_engine' | 'no_narrator' | null;
}>;

function isNarrationCapable(engine: ReviewWalkthroughEngine): boolean {
    return engine.enabled && engine.retentionPolicy !== 'ephemeral' && engine.structuredNarration;
}

/**
 * What a review started from a comparison will do: which engines review, whether one narrator must be
 * named and who it is. The narrator need and its default come from the protocol's shared policy, the
 * same one review admission enforces; a findings-only review preselects the first model engine so the
 * dialog names who writes rather than inventing a hidden choice.
 */
export function resolveReviewWalkthroughPlan(params: Readonly<{
    engines: readonly ReviewWalkthroughEngine[];
    reviewers: readonly ReviewReviewerSelectionV1[];
    walkthrough: boolean;
    narratorEngineId: string | null;
}>): ReviewWalkthroughPlan {
    const selected = params.engines.filter((engine) => engine.enabled && params.reviewers.some(reviewer => reviewer.kind === 'engine' && reviewer.engineId === engine.engineId));
    const reviewers = params.reviewers.filter(reviewer => reviewer.kind !== 'engine' || selected.some(engine => engine.engineId === reviewer.engineId));
    if (!params.walkthrough) {
        return { selected, reviewers, walkthrough: false, narrator: null, footer: null, canStart: reviewers.length > 0,
            blocked: reviewers.length > 0 ? null : 'no_engine' };
    }
    const policy = resolveReviewNarratorPolicy({
        selectedEngineIds: selected.map((engine) => engine.engineId),
        engines: params.engines.map((engine) => ({
            value: engine.engineId,
            enabled: engine.enabled,
            retentionPolicy: engine.retentionPolicy,
            capabilities: { structuredNarration: engine.structuredNarration },
        })),
    });
    const candidates = params.engines.filter(isNarrationCapable);
    if (!policy.requiresSeparateNarrator) {
        // The reviewer writes its own walkthrough unless the person names a narrator.
        const own = candidates.find((engine) => engine.engineId === params.narratorEngineId)
            ?? candidates.find((engine) => engine.engineId === policy.defaultNarratorEngineId) ?? null;
        const narrator = { reason: 'own' as const, engineId: own?.engineId ?? null, candidates };
        // Nobody chosen yet: nothing can start, but the narrator stays offered while the walkthrough is on.
        if (reviewers.length === 0) return { selected, reviewers, walkthrough: true, narrator, footer: null, canStart: false, blocked: 'no_engine' };
        return { selected, reviewers, walkthrough: true, narrator, footer: { kind: 'review_then_walkthrough' }, canStart: true, blocked: null };
    }
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
        reviewers,
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
    plan: ReviewWalkthroughPlan;
    instructions: string;
    comparisonId: string;
    /** Pending changes keep the existing uncommitted scope; every other comparison is read whole. */
    pending: boolean;
}> & (Readonly<{ sessionId: string }> | Readonly<{ sessionId: null; machineId: string; cwd: string }>)): Record<string, unknown> {
    const narratorEngineId = params.plan.narrator?.engineId ?? null;
    return {
        ...(params.sessionId !== null ? { sessionId: params.sessionId }
            : { target: { kind: 'detached' }, machineId: params.machineId, cwd: params.cwd }),
        reviewers: params.plan.reviewers,
        instructions: params.instructions.trim(),
        comparisonId: params.comparisonId,
        ...(params.plan.walkthrough ? { outputs: ['walkthrough'] } : {}),
        ...(params.plan.walkthrough && narratorEngineId ? { narrator: { engineId: narratorEngineId } } : {}),
        changeType: params.pending ? 'uncommitted' : 'all',
    };
}

/**
 * A start's own launch input with the narrator its plan names when the person chose none, so the walkthrough the
 * sheet shows is the one the host is asked for (a findings-only reviewer otherwise has no narrator to fall back on).
 */
export function applyReviewWalkthroughNarrator(input: Record<string, unknown>, plan: ReviewWalkthroughPlan): Record<string, unknown> {
    const engineId = plan.walkthrough ? plan.narrator?.engineId ?? null : null;
    if (engineId === null || input.narrator !== undefined) return input;
    return { ...input, narrator: { engineId } };
}
