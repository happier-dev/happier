import { describe, expect, it } from 'vitest';
import { ReviewStartInputSchema } from '@happier-dev/protocol/reviews/reviewStart';
import { projectMachineAgent } from '@/agents/machineAgents/machineAgentModel';

import { buildReviewStartWithWalkthroughInput, resolveReviewWalkthroughPlan, type ReviewWalkthroughEngine } from './reviewWalkthroughPlan';

const CLAUDE: ReviewWalkthroughEngine = { engineId: 'claude', label: 'Claude Code', enabled: true, structuredNarration: true };
const CODEX: ReviewWalkthroughEngine = { engineId: 'codex', label: 'Codex', enabled: true, structuredNarration: true };
const RABBIT: ReviewWalkthroughEngine = { engineId: 'coderabbit', label: 'CodeRabbit', enabled: true, structuredNarration: false };
const ENGINES = [CLAUDE, CODEX, RABBIT];

describe('resolveReviewWalkthroughPlan', () => {
    it('excludes an unavailable plugin engine from selection and narration using canonical credential readiness', () => {
        const agent = (id: string, healthy: boolean) => projectMachineAgent({ agentId: id, title: id,
            facts: { agentId: id, title: id, installed: true, version: null, latestVersion: null, update: { supported: false, command: null },
                signIn: { status: 'signedOut', loginSupport: 'login_terminal' }, platform: { supported: true },
                install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null }, dependencies: [] },
            checking: false, stale: false, job: null,
            connectedServices: [{ serviceId: 'acme.accounts/oauth', title: 'Work account', connected: true, healthy,
                profileLabel: null, profiles: [{ profileId: 'work', healthy, profileLabel: null }] }],
            credentialSelection: { credentialBindings: { v: 2, bindingsByServiceId: {
                'acme.accounts/oauth': { source: 'connected', selection: 'profile', profileId: 'work' },
            } } },
        });
        const engines = [
            { ...CLAUDE, engineId: 'acme.review/first', machineAgent: agent('acme.review/first', false) },
            { ...CODEX, engineId: 'acme.review/second', machineAgent: agent('acme.review/second', true) },
        ];
        const plan = resolveReviewWalkthroughPlan({ engines, selectedEngineIds: engines.map(engine => engine.engineId),
            walkthrough: true, narratorEngineId: engines[0]!.engineId });
        expect(plan.selected.map(engine => engine.engineId)).toEqual(['acme.review/second']);
        expect(plan.narrator).toBeNull();
    });
    it('uses the review inventory for enabled engines with no Machine agent row', () => {
        // Orchestrator ruling B: absence from a settled Machine inventory is not a review refusal.
        const available = resolveReviewWalkthroughPlan({ engines: [{ ...RABBIT, machineAgent: null, machineInventoryStatus: 'ready' }],
            selectedEngineIds: [RABBIT.engineId], walkthrough: false, narratorEngineId: null });
        expect(available.canStart).toBe(true);
        expect(available.selected.map(engine => engine.engineId)).toEqual([RABBIT.engineId]);
        const disabled = resolveReviewWalkthroughPlan({ engines: [{ ...RABBIT, enabled: false, machineAgent: null }],
            selectedEngineIds: [RABBIT.engineId], walkthrough: false, narratorEngineId: null });
        expect(disabled.canStart).toBe(false);
        for (const machineInventoryStatus of ['idle', 'loading', 'error', 'offline'] as const) {
            expect(resolveReviewWalkthroughPlan({ engines: [{ ...RABBIT, machineAgent: null, machineInventoryStatus }],
                selectedEngineIds: [RABBIT.engineId], walkthrough: false, narratorEngineId: null }).canStart).toBe(false);
        }
    });
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
    it('builds a schema-valid detached review without a Session field', () => {
        const plan = resolveReviewWalkthroughPlan({ engines: [CLAUDE], selectedEngineIds: ['claude'], walkthrough: false, narratorEngineId: null });
        const input = buildReviewStartWithWalkthroughInput({ sessionId: null, machineId: 'm1', cwd: '/repo',
            plan, instructions: 'Review.', comparisonId: 'cmp-1', pending: true });
        expect(ReviewStartInputSchema.safeParse(input).success).toBe(true);
        expect(input).not.toHaveProperty('sessionId');
    });

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
