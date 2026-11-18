import { expect, it, vi } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { prepareTriagePullRequestReviewContinuationV1, continueTriagePullRequestReviewV1 } from './pullRequestReviewContinuation.js';
import type { TriageActionV1 } from '../settings/actions.js';
import type { TriagePendingPullRequestReviewV1 } from './entrySessionStartController.js';
import { testkitConfiguredInstance, TESTKIT_LINK_DISPLAY, TESTKIT_OBSERVED_REVISION, TESTKIT_SELECTED_WORKSPACE } from './testkit/entrySessionTestkit.test-support.js';
import { testkitEntryRef } from '../corpus/testkit/observations.test-support.js';
const reviewAction = { actionId: 'custom-review', label: 'Review', enabled: true, appliesTo: ['pullRequest'],
    profileId: null, workspaceMode: 'pull_request', target: { kind: 'reviewStart', promptInvocationId: null, seededFallbackInstruction: 'Review this pull request.' },
} as const satisfies TriageActionV1;
const pending: TriagePendingPullRequestReviewV1 = { actionId: reviewAction.actionId, sessionId: 'session-a', instructions: 'Review this change', review: {
    instance: testkitConfiguredInstance(), entryRef: testkitEntryRef(), lastKnownLocator: TESTKIT_LINK_DISPLAY.locator,
    observed: TESTKIT_OBSERVED_REVISION, workspace: TESTKIT_SELECTED_WORKSPACE, repositoryPath: '/repo', pullRequest: { number: 17 },
} };
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

it('retains a catalog refusal at preparation without dispatching a Review', async () => {
    const error = new PluginError({ code: 'catalog_unavailable', details: { requestId: 'review-catalog-17' } });
    const host = { executeAction: async (): Promise<never> => { throw error; },
        selectActionInput: async (): Promise<never> => { throw new Error('already selected'); } };
    await expect(prepareTriagePullRequestReviewContinuationV1(host, pending, { engineIds: ['engine-a'], launchSelection: {} }))
        .resolves.toEqual({ kind: 'unavailable', failure: { codes: ['catalog_unavailable'], requestId: 'review-catalog-17' } });
});
