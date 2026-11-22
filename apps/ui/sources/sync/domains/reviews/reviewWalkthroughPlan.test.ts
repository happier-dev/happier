import { describe, expect, it } from 'vitest';
import { ReviewReviewerSelectionV1Schema, ReviewStartInputSchema, reviewReviewersForEngineIdsV1 } from '@happier-dev/protocol/reviews/reviewStart';

import { applyReviewWalkthroughNarrator, buildReviewStartWithWalkthroughInput, resolveReviewWalkthroughPlan, type ReviewWalkthroughEngine } from './reviewWalkthroughPlan';

const CLAUDE: ReviewWalkthroughEngine = { engineId: 'claude', label: 'Claude Code', enabled: true, structuredNarration: true };
const CODEX: ReviewWalkthroughEngine = { engineId: 'codex', label: 'Codex', enabled: true, structuredNarration: true };
const RABBIT: ReviewWalkthroughEngine = { engineId: 'coderabbit', label: 'CodeRabbit', enabled: true, structuredNarration: false };
const ENGINES = [CLAUDE, CODEX, RABBIT];

describe('resolveReviewWalkthroughPlan', () => {
    it('starts a findings-only comparison with a person or Session roster and no engine', () => {
        for (const reviewer of [
            { kind: 'person' as const, principal: { kind: 'account' as const, accountId: 'alice' }, required: true },
            { kind: 'session' as const, session: { serverId: 'home', sessionId: 'reviewer-session' } },
        ].map(reviewer => ReviewReviewerSelectionV1Schema.parse(reviewer))) {
            const input = { engines: [], reviewers: [reviewer], walkthrough: false, narratorEngineId: null };
            const plan = resolveReviewWalkthroughPlan(input);
            expect(plan).toMatchObject({ canStart: true, blocked: null });
            expect(ReviewStartInputSchema.parse(buildReviewStartWithWalkthroughInput({ sessionId: 'source', plan,
                instructions: 'Inspect', comparisonId: 'captured', pending: true })).reviewers).toEqual(input.reviewers);
        }
    });
    it('excludes an unavailable plugin engine from selection and narration using the Review inventory decision', () => {
        const engines = [
            { ...CLAUDE, engineId: 'acme.review/first', enabled: false },
            { ...CODEX, engineId: 'acme.review/second' },
        ];
        const plan = resolveReviewWalkthroughPlan({ engines, reviewers: reviewReviewersForEngineIdsV1(engines.map(engine => engine.engineId)),
            walkthrough: true, narratorEngineId: engines[0]!.engineId });
        expect(plan.selected.map(engine => engine.engineId)).toEqual(['acme.review/second']);
        expect(plan.narrator).toMatchObject({ reason: 'own', engineId: 'acme.review/second' });
        expect(plan.narrator?.candidates.map(engine => engine.engineId)).toEqual(['acme.review/second']);
    });
    it('uses a continuing inventory candidate to narrate an ephemeral reviewer', () => {
        const plan = resolveReviewWalkthroughPlan({ engines: [{ ...CODEX, retentionPolicy: 'ephemeral' }, CLAUDE],
            reviewers: reviewReviewersForEngineIdsV1(['codex']), walkthrough: true, narratorEngineId: 'codex' });
        expect(plan.narrator?.candidates.map(engine => engine.engineId)).toEqual(['claude']);
        expect(plan.narrator?.engineId).toBe('claude');
        expect(plan.canStart).toBe(true);
    });
    it('lets one capable engine write its own walkthrough, still naming it as the narrator a person can change', () => {
        const plan = resolveReviewWalkthroughPlan({ engines: ENGINES, reviewers: reviewReviewersForEngineIdsV1(['codex']), walkthrough: true, narratorEngineId: null });
        expect(plan.narrator).toMatchObject({ reason: 'own', engineId: 'codex' });
        expect(plan.narrator?.candidates.map(engine => engine.engineId)).toEqual(['claude', 'codex']);
        expect(plan.footer).toEqual({ kind: 'review_then_walkthrough' });
        expect(plan.canStart).toBe(true);
        const changed = resolveReviewWalkthroughPlan({ engines: ENGINES, reviewers: reviewReviewersForEngineIdsV1(['codex']), walkthrough: true, narratorEngineId: 'claude' });
        expect(changed.narrator).toMatchObject({ reason: 'own', engineId: 'claude' });
    });

    it('offers the narrator for a roster with no engine while the walkthrough is on, choosing none for the person', () => {
        const reviewer = ReviewReviewerSelectionV1Schema.parse({ kind: 'session', session: { serverId: 'home', sessionId: 'reviewer-session' } });
        const plan = resolveReviewWalkthroughPlan({ engines: ENGINES, reviewers: [reviewer], walkthrough: true, narratorEngineId: null });
        expect(plan.narrator).toMatchObject({ reason: 'own', engineId: null });
        expect(plan.narrator?.candidates.map(engine => engine.engineId)).toEqual(['claude', 'codex']);
        expect(plan.canStart).toBe(true);
        const nobody = resolveReviewWalkthroughPlan({ engines: ENGINES, reviewers: [], walkthrough: true, narratorEngineId: 'codex' });
        expect(nobody).toMatchObject({ canStart: false, blocked: 'no_engine', narrator: { reason: 'own', engineId: 'codex' } });
    });

    it('asks for one narrator when several engines review, defaulting to the first capable one in list order', () => {
        const plan = resolveReviewWalkthroughPlan({ engines: ENGINES, reviewers: reviewReviewersForEngineIdsV1(['coderabbit', 'codex', 'claude']), walkthrough: true, narratorEngineId: null });
        expect(plan.narrator).toMatchObject({ reason: 'several', engineId: 'claude' });
        expect(plan.narrator?.candidates.map((engine) => engine.engineId)).toEqual(['claude', 'codex']);
        expect(plan.footer).toEqual({ kind: 'review_then_walkthrough' });
    });

    it('names the narrator a findings-only engine needs and preselects the first model engine', () => {
        const plan = resolveReviewWalkthroughPlan({ engines: ENGINES, reviewers: reviewReviewersForEngineIdsV1(['coderabbit']), walkthrough: true, narratorEngineId: null });
        expect(plan.narrator).toMatchObject({ reason: 'findings_only', engineId: 'claude' });
        expect(plan.footer).toEqual({ kind: 'reviewer_then_narrator', reviewer: 'CodeRabbit', narrator: 'Claude Code' });
        expect(plan.canStart).toBe(true);
    });

    it('keeps an explicit narrator choice and never offers a findings-only or disabled engine as narrator', () => {
        const engines = [CLAUDE, { ...CODEX, enabled: false }, RABBIT];
        const plan = resolveReviewWalkthroughPlan({ engines, reviewers: reviewReviewersForEngineIdsV1(['coderabbit', 'claude']), walkthrough: true, narratorEngineId: 'coderabbit' });
        expect(plan.narrator?.candidates.map((engine) => engine.engineId)).toEqual(['claude']);
        expect(plan.narrator?.engineId).toBe('claude');
        const chosen = resolveReviewWalkthroughPlan({ engines: ENGINES, reviewers: reviewReviewersForEngineIdsV1(['coderabbit', 'claude']), walkthrough: true, narratorEngineId: 'codex' });
        expect(chosen.narrator?.engineId).toBe('codex');
    });

    it('cannot start a walkthrough nobody can write, and drops the narrator when the walkthrough is off', () => {
        const none = resolveReviewWalkthroughPlan({ engines: [RABBIT], reviewers: reviewReviewersForEngineIdsV1(['coderabbit']), walkthrough: true, narratorEngineId: null });
        expect(none.canStart).toBe(false);
        expect(none.blocked).toBe('no_narrator');
        const off = resolveReviewWalkthroughPlan({ engines: [RABBIT], reviewers: reviewReviewersForEngineIdsV1(['coderabbit']), walkthrough: false, narratorEngineId: null });
        expect(off).toMatchObject({ canStart: true, narrator: null, footer: null });
        expect(resolveReviewWalkthroughPlan({ engines: ENGINES, reviewers: reviewReviewersForEngineIdsV1([]), walkthrough: false, narratorEngineId: null }).blocked).toBe('no_engine');
    });
});

describe('buildReviewStartWithWalkthroughInput', () => {
    it('builds a schema-valid detached review without a Session field', () => {
        const reviewers = [{ kind: 'engine' as const, engineId: 'claude', modelId: 'precise', roleId: 'reviewer' },
            { kind: 'person' as const, principal: { kind: 'account' as const, accountId: 'alice' }, required: true }]
            .map(reviewer => ReviewReviewerSelectionV1Schema.parse(reviewer));
        const plan = resolveReviewWalkthroughPlan({ engines: [CLAUDE], reviewers, walkthrough: false, narratorEngineId: null });
        const input = buildReviewStartWithWalkthroughInput({ sessionId: null, machineId: 'm1', cwd: '/repo',
            plan, instructions: 'Review.', comparisonId: 'cmp-1', pending: true });
        expect(ReviewStartInputSchema.safeParse(input).success).toBe(true);
        expect(input.reviewers).toEqual(reviewers);
        expect(input).not.toHaveProperty('sessionId');
    });

    it('sends the captured comparison, the requested walkthrough and the narrator a several-engine review needs', () => {
        const plan = resolveReviewWalkthroughPlan({ engines: ENGINES, reviewers: reviewReviewersForEngineIdsV1(['claude', 'codex']), walkthrough: true, narratorEngineId: null });
        expect(buildReviewStartWithWalkthroughInput({ sessionId: 's1', plan, instructions: '  Look at the keys. ', comparisonId: 'cmp-1', pending: true })).toEqual({
            sessionId: 's1', reviewers: [{ kind: 'engine', engineId: 'claude' }, { kind: 'engine', engineId: 'codex' }], instructions: 'Look at the keys.', comparisonId: 'cmp-1',
            outputs: ['walkthrough'], narrator: { engineId: 'claude' }, changeType: 'uncommitted',
        });
    });

    it('stays a findings-only review without the walkthrough, and widens the scope off pending changes', () => {
        const plan = resolveReviewWalkthroughPlan({ engines: ENGINES, reviewers: reviewReviewersForEngineIdsV1(['codex']), walkthrough: false, narratorEngineId: null });
        expect(buildReviewStartWithWalkthroughInput({ sessionId: 's1', plan, instructions: 'x', comparisonId: 'cmp-1', pending: false })).toEqual({
            sessionId: 's1', reviewers: [{ kind: 'engine', engineId: 'codex' }], instructions: 'x', comparisonId: 'cmp-1', changeType: 'all',
        });
    });
});

describe('applyReviewWalkthroughNarrator', () => {
    it('sends the narrator the plan names when the person chose none, so a findings-only engine is narrated', () => {
        const reviewers = reviewReviewersForEngineIdsV1(['coderabbit']);
        const plan = resolveReviewWalkthroughPlan({ engines: ENGINES, reviewers, walkthrough: true, narratorEngineId: null });
        const input = { reviewers, outputs: ['walkthrough'] };
        expect(applyReviewWalkthroughNarrator(input, plan)).toEqual({ ...input, narrator: { engineId: 'claude' } });
    });

    it('keeps an explicit narrator and adds none without a walkthrough', () => {
        const reviewers = reviewReviewersForEngineIdsV1(['coderabbit']);
        const plan = resolveReviewWalkthroughPlan({ engines: ENGINES, reviewers, walkthrough: true, narratorEngineId: 'codex' });
        const chosen = { reviewers, outputs: ['walkthrough'], narrator: { engineId: 'codex', modelId: 'fast' } };
        expect(applyReviewWalkthroughNarrator(chosen, plan)).toBe(chosen);
        const off = resolveReviewWalkthroughPlan({ engines: ENGINES, reviewers, walkthrough: false, narratorEngineId: null });
        const input = { reviewers };
        expect(applyReviewWalkthroughNarrator(input, off)).toBe(input);
    });
});
