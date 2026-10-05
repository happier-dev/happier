import { describe, expect, it } from 'vitest';

import { buildReviewStartWithWalkthroughInput, resolveReviewWalkthroughPlan, type ReviewWalkthroughEngine } from './reviewWalkthroughPlan';

const CLAUDE: ReviewWalkthroughEngine = { engineId: 'claude', label: 'Claude Code', enabled: true, structuredNarration: true };
const CODEX: ReviewWalkthroughEngine = { engineId: 'codex', label: 'Codex', enabled: true, structuredNarration: true };
const RABBIT: ReviewWalkthroughEngine = { engineId: 'coderabbit', label: 'CodeRabbit', enabled: true, structuredNarration: false };
const ENGINES = [CLAUDE, CODEX, RABBIT];

describe('resolveReviewWalkthroughPlan', () => {
    it('lets one capable engine write its own walkthrough with no narrator to choose', () => {
        const plan = resolveReviewWalkthroughPlan({ engines: ENGINES, selectedEngineIds: ['codex'], walkthrough: true, narratorEngineId: null });
        expect(plan.narrator).toBeNull();
        expect(plan.footer).toEqual({ kind: 'review_then_walkthrough' });
        expect(plan.canStart).toBe(true);
    });

    it('asks for one narrator when several engines review, defaulting to the first capable one in list order', () => {
        const plan = resolveReviewWalkthroughPlan({ engines: ENGINES, selectedEngineIds: ['coderabbit', 'codex', 'claude'], walkthrough: true, narratorEngineId: null });
        expect(plan.narrator).toMatchObject({ reason: 'several', engineId: 'claude' });
        expect(plan.narrator?.candidates.map((engine) => engine.engineId)).toEqual(['claude', 'codex']);
        expect(plan.footer).toEqual({ kind: 'review_then_walkthrough' });
    });

    it('names the narrator a findings-only engine needs and preselects the first model engine', () => {
        const plan = resolveReviewWalkthroughPlan({ engines: ENGINES, selectedEngineIds: ['coderabbit'], walkthrough: true, narratorEngineId: null });
        expect(plan.narrator).toMatchObject({ reason: 'findings_only', engineId: 'claude' });
        expect(plan.footer).toEqual({ kind: 'reviewer_then_narrator', reviewer: 'CodeRabbit', narrator: 'Claude Code' });
        expect(plan.canStart).toBe(true);
    });

    it('keeps an explicit narrator choice and never offers a findings-only or disabled engine as narrator', () => {
        const engines = [CLAUDE, { ...CODEX, enabled: false }, RABBIT];
        const plan = resolveReviewWalkthroughPlan({ engines, selectedEngineIds: ['coderabbit', 'claude'], walkthrough: true, narratorEngineId: 'coderabbit' });
        expect(plan.narrator?.candidates.map((engine) => engine.engineId)).toEqual(['claude']);
        expect(plan.narrator?.engineId).toBe('claude');
        const chosen = resolveReviewWalkthroughPlan({ engines: ENGINES, selectedEngineIds: ['coderabbit', 'claude'], walkthrough: true, narratorEngineId: 'codex' });
        expect(chosen.narrator?.engineId).toBe('codex');
    });

    it('cannot start a walkthrough nobody can write, and drops the narrator when the walkthrough is off', () => {
        const none = resolveReviewWalkthroughPlan({ engines: [RABBIT], selectedEngineIds: ['coderabbit'], walkthrough: true, narratorEngineId: null });
        expect(none.canStart).toBe(false);
        expect(none.blocked).toBe('no_narrator');
        const off = resolveReviewWalkthroughPlan({ engines: [RABBIT], selectedEngineIds: ['coderabbit'], walkthrough: false, narratorEngineId: null });
        expect(off).toMatchObject({ canStart: true, narrator: null, footer: null });
        expect(resolveReviewWalkthroughPlan({ engines: ENGINES, selectedEngineIds: [], walkthrough: false, narratorEngineId: null }).blocked).toBe('no_engine');
    });
});

describe('buildReviewStartWithWalkthroughInput', () => {
    it('sends the captured comparison, the requested walkthrough and the narrator a several-engine review needs', () => {
        const plan = resolveReviewWalkthroughPlan({ engines: ENGINES, selectedEngineIds: ['claude', 'codex'], walkthrough: true, narratorEngineId: null });
        expect(buildReviewStartWithWalkthroughInput({ sessionId: 's1', plan, instructions: '  Look at the keys. ', comparisonId: 'cmp-1', pending: true })).toEqual({
            sessionId: 's1', engineIds: ['claude', 'codex'], instructions: 'Look at the keys.', comparisonId: 'cmp-1',
            outputs: ['walkthrough'], narrator: { engineId: 'claude' }, changeType: 'uncommitted',
        });
    });

    it('stays a findings-only review without the walkthrough, and widens the scope off pending changes', () => {
        const plan = resolveReviewWalkthroughPlan({ engines: ENGINES, selectedEngineIds: ['codex'], walkthrough: false, narratorEngineId: null });
        expect(buildReviewStartWithWalkthroughInput({ sessionId: 's1', plan, instructions: 'x', comparisonId: 'cmp-1', pending: false })).toEqual({
            sessionId: 's1', engineIds: ['codex'], instructions: 'x', comparisonId: 'cmp-1', changeType: 'all',
        });
    });
});
