import { expect, it, vi } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { ReviewStartInputSchema } from '@happier-dev/plugin-sdk/reviews';
import { prepareTriagePullRequestReviewContinuationV1, continueTriagePullRequestReviewV1 } from './pullRequestReviewContinuation.js';
import type { TriageActionV1 } from '../settings/actions.js';
import type { TriagePendingPullRequestReviewV1 } from './entrySessionStartController.js';
import { testkitConfiguredInstance, TESTKIT_LINK_DISPLAY, TESTKIT_OBSERVED_REVISION, TESTKIT_SELECTED_WORKSPACE } from './testkit/entrySessionTestkit.test-support.js';
import { testkitEntryRef } from '../corpus/testkit/observations.test-support.js';
import { TriageStartPullRequestReviewInputV1Schema } from '../actions/entrySessionProtocol.js';
const reviewAction = { actionId: 'custom-review', label: 'Review', enabled: true, appliesTo: ['pullRequest'],
    profileId: null, workspaceMode: 'pull_request', target: { kind: 'reviewStart', promptInvocationId: null, seededFallbackInstruction: 'Review this pull request.' },
} as const satisfies TriageActionV1;
const pending: TriagePendingPullRequestReviewV1 = { actionId: reviewAction.actionId, sessionId: 'session-a', instructions: 'Review this change', review: {
    instance: testkitConfiguredInstance(), entryRef: testkitEntryRef(), lastKnownLocator: TESTKIT_LINK_DISPLAY.locator,
    observed: TESTKIT_OBSERVED_REVISION, workspace: TESTKIT_SELECTED_WORKSPACE, repositoryPath: '/repo', pullRequest: { number: 17 },
} };
it('keeps the shared composer mixed roster and steps in the selected-PR Action input', async () => {
    const reviewers = [{ kind: 'person' as const, principal: { kind: 'account' as const, accountId: 'requested-person' }, required: true },
        { kind: 'session' as const, session: { serverId: 'server-a', sessionId: 'reviewer-session' } }];
    const input = ReviewStartInputSchema.parse({ reviewers, steps: [{ kind: 'review' as const, reviewers, instructions: 'Double-check this PR' }],
        instructions: 'Review this change', then: 'report' });
    const selections: unknown[] = [];
    const host = { executeAction: async () => ({ v: 1, availability: 'absent', revision: 'absent', actions: [reviewAction] }),
        selectActionInput: async (request: unknown) => {
            selections.push(request);
            return { kind: 'reviewComposition' as const, input };
        } };
    const prepared = await prepareTriagePullRequestReviewContinuationV1(host, pending, undefined);
    expect(prepared).toEqual({ kind: 'ready', draft: input, input: { v: 1, sessionId: pending.sessionId,
        review: pending.review, reviewInput: input } });
    if (prepared.kind !== 'ready') throw new Error('Expected selected composition');
    expect(TriageStartPullRequestReviewInputV1Schema.parse(prepared.input)).toEqual(prepared.input);
    expect(selections).toEqual([{ hostAction: { action: 'review.start', projection: 'composition' },
        sessionId: pending.sessionId, serverId: pending.review.workspace.serverId,
        draft: { instructions: pending.instructions } }]);
});
it('seeds the host Review selector with the canonical ordered reviewer roster', async () => {
    const selectActionInput = vi.fn(async () => ({ kind: 'cancelled' } as const));
    const host = { executeAction: async () => null, selectActionInput };
    await expect(prepareTriagePullRequestReviewContinuationV1(host, pending, { engineIds: ['engine-a', 'engine-b'] }))
        .resolves.toEqual({ kind: 'cancelled' });
    expect(selectActionInput).toHaveBeenCalledWith({
        hostAction: { action: 'review.start', projection: 'executionRunLaunch' },
        sessionId: pending.sessionId,
        serverId: pending.review.workspace.serverId,
        draft: {
            reviewers: [{ kind: 'engine', engineId: 'engine-a' }, { kind: 'engine', engineId: 'engine-b' }],
            instructions: pending.instructions,
        },
    }, undefined);
});
it('projects optional native draft members before crossing the host selection boundary', async () => {
    const selections: unknown[] = [];
    const selectActionInput = async (request: unknown) => {
        selections.push(request);
        return { kind: 'cancelled' } as const;
    };
    const reviewers = [{ kind: 'person' as const, principal: { kind: 'account' as const, accountId: 'requested-person' }, required: true }];
    const expectedDraft = ReviewStartInputSchema.parse({ reviewers, instructions: pending.instructions });
    const draft = { ...expectedDraft, optionalExtension: undefined };
    await prepareTriagePullRequestReviewContinuationV1({ executeAction: async () => null, selectActionInput },
        pending, undefined, { draft });
    expect(selections).toEqual([{
        hostAction: { action: 'review.start', projection: 'composition' },
        sessionId: pending.sessionId, serverId: pending.review.workspace.serverId,
        draft: expectedDraft,
    }]);
    expect(selections[0]).not.toHaveProperty('draft.optionalExtension');
});
it('retains selection refusal diagnostics and keeps cancellation quiet', async () => {
    const error = new PluginError({ code: 'unavailable', details: { requestId: 'review-select-17' } });
    const host = { executeAction: async () => null, selectActionInput: async (): Promise<never> => { throw error; } };
    expect(await prepareTriagePullRequestReviewContinuationV1(host, pending, { engineIds: ['engine-a'] }))
        .toEqual({ kind: 'unavailable', failure: { codes: ['unavailable'], requestId: 'review-select-17' } });
    const controller = new AbortController();
    controller.abort();
    expect(await prepareTriagePullRequestReviewContinuationV1(host, pending, { engineIds: ['engine-a'] }, { signal: controller.signal }))
        .toEqual({ kind: 'cancelled' });
});
it('retains the dispatch refusal while preserving an unknown Review outcome', async () => {
    const error = new PluginError({ code: 'transport_unavailable', details: { requestId: 'review-run-17' } });
    const host = { executeAction: async (id: unknown) => {
        if (typeof id === 'object') return { v: 1, availability: 'absent', revision: 'absent', actions: [reviewAction] };
        throw error;
    }, selectActionInput: async (): Promise<never> => { throw new Error('already selected'); } };
    expect(await continueTriagePullRequestReviewV1(host, pending, { engineIds: ['engine-a'], launchSelection: {} }))
        .toMatchObject({ kind: 'unknown', failure: { codes: ['transport_unavailable'], requestId: 'review-run-17' } });
});

it.each(['engines', 'composition'] as const)('retains a catalog refusal and its authored draft without dispatching a Review (%s)', async mode => {
    const error = new PluginError({ code: 'catalog_unavailable', details: { requestId: 'review-catalog-17' } });
    const draft = ReviewStartInputSchema.parse({ reviewers: [{ kind: 'person',
        principal: { kind: 'account', accountId: 'requested-person' }, required: true }], instructions: pending.instructions });
    const host = { executeAction: async (): Promise<never> => { throw error; },
        selectActionInput: async () => ({ kind: 'reviewComposition' as const, input: draft }) };
    await expect(prepareTriagePullRequestReviewContinuationV1(host, pending,
        mode === 'engines' ? { engineIds: ['engine-a'], launchSelection: {} } : undefined))
        .resolves.toEqual({ kind: 'unavailable', ...(mode === 'composition' ? { draft } : {}),
            failure: { codes: ['catalog_unavailable'], requestId: 'review-catalog-17' } });
});
