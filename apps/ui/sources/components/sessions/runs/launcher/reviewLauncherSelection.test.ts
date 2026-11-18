import { describe, expect, it } from 'vitest';
import { ReviewStartInputSchema } from '@happier-dev/protocol/reviews/reviewStart';
import { compileReviewLauncherInput, updateReviewLauncherEngineConfiguration, updateReviewLauncherStepInput } from './reviewLauncherSelection';

describe('review launcher submission', () => {
    it('edits the chosen later-step configuration while retaining repeated engines and the scalar first roster', () => {
        const first = { kind: 'engine', engineId: 'claude', modelId: 'first-model' };
        const input = { reviewers: [first], steps: [
            { kind: 'review', reviewers: [first], instructions: 'Security' },
            { kind: 'verify', reviewers: [{ kind: 'engine', engineId: 'claude', modelId: 'second-model' },
                { kind: 'person', principal: { kind: 'account', accountId: 'alice' }, required: true }], instructions: 'Check fixes' },
        ] };
        const updated = updateReviewLauncherStepInput(input, 1, step => updateReviewLauncherEngineConfiguration(step,
            previous => ({ ...previous, modelId: 'third-model', roleId: 'reviewer' })));
        const parsed = ReviewStartInputSchema.parse(compileReviewLauncherInput(updated, 'Inspect', null));
        expect(parsed.reviewers).toEqual([first]);
        expect(parsed.steps![1]!.reviewers).toEqual([
            { kind: 'engine', engineId: 'claude', modelId: 'third-model', roleId: 'reviewer' },
            { kind: 'person', principal: { kind: 'account', accountId: 'alice' }, required: true },
        ]);
        expect(parsed.steps!.map(step => step.instructions)).toEqual(['Security', 'Check fixes']);
    });
    it('submits authored steps with their own reviewers and focus through the canonical start schema', () => {
        const input = compileReviewLauncherInput({ reviewers: [], steps: [
            { kind: 'review', reviewers: [{ kind: 'engine', engineId: 'claude', includeSessionTranscript: true }], instructions: 'Security' },
            { kind: 'verify', reviewers: [{ kind: 'session', session: { serverId: 'home', sessionId: 'peer' } }], instructions: '' },
        ], then: 'fix' }, 'Inspect changes', { serverId: 'home', sessionId: 'source' });
        const parsed = ReviewStartInputSchema.parse(input);
        expect(parsed.reviewers).toEqual(parsed.steps![0]!.reviewers);
        expect(parsed.steps![0]!.instructions).toBe('Security');
        expect(parsed.steps![1]!.instructions).toBe('Inspect changes');
        expect(parsed.sourceSession).toEqual({ serverId: 'home', sessionId: 'source' });
        expect(parsed.then).toBe('fix');
    });
    it('keeps a step reviewer model edit when compiling the retained draft', () => {
        const reviewer = { kind: 'engine', engineId: 'claude' };
        const updated = updateReviewLauncherEngineConfiguration({ reviewers: [reviewer], steps: [
            { kind: 'review', reviewers: [reviewer], instructions: '' },
        ] }, previous => ({ ...previous, modelId: 'chosen-model' }));
        expect(compileReviewLauncherInput(updated, 'Inspect', null).reviewers).toEqual([
            { ...reviewer, modelId: 'chosen-model' },
        ]);
    });
    it('retains the direct one-step path and does not invent transcript scope for detached starts', () => {
        const parsed = ReviewStartInputSchema.parse(compileReviewLauncherInput({ reviewers: [{ kind: 'engine', engineId: 'claude' }], outputs: [] }, 'Inspect', null));
        expect(parsed.steps).toBeUndefined();
        expect(parsed.sourceSession).toBeUndefined();
    });
});
